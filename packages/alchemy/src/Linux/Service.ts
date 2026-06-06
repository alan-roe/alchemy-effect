import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import {
  exec,
  execOrFail,
  quoteArg,
  RemoteCommandError,
  type RemoteHost,
} from "./Remote.ts";

/**
 * Properties for a systemd service on a Linux host.
 */
export interface ServiceProps {
  /** How to reach the host (Proxmox node + container vmid). */
  host: RemoteHost;
  /**
   * systemd unit name (without the `.service` suffix). Statically known (used
   * in diff); identity of the resource. The unit must already exist — install
   * it with `Linux.Package` first.
   */
  name: string;
  /**
   * Whether the unit is enabled at boot.
   * @default true
   */
  enabled?: boolean;
  /**
   * Whether the unit is running.
   * @default true
   */
  running?: boolean;
  /**
   * Opaque token; when it changes between deploys the unit is restarted. Wire a
   * config file's `hash` output here to restart the service on config drift.
   */
  restartTrigger?: string;
}

/**
 * Output attributes of a managed systemd service.
 */
export interface ServiceAttributes {
  /** The unit name. */
  name: string;
  /** Whether the unit is enabled at boot. */
  enabled: boolean;
  /** Whether the unit is running. */
  active: boolean;
  /** The `restartTrigger` value last applied. */
  restartTrigger: string | undefined;
}

/**
 * A systemd service on a Linux host you control, managed over SSH + `pct exec`.
 * Observes with `systemctl is-enabled`/`is-active` and converges with
 * `enable`/`disable`/`start`/`stop`/`restart`.
 *
 * @section Managing Services
 * @example Keep PostgreSQL enabled and running, restart on config change
 * ```typescript
 * const svc = yield* Linux.Service("postgresql", {
 *   host: { node: "pve", vmid: container.vmid },
 *   name: "postgresql",
 *   restartTrigger: pgHbaFile.hash,
 * });
 * ```
 */
export type Service = Resource<
  "Linux.Service",
  ServiceProps,
  ServiceAttributes,
  never,
  Providers
>;

export const Service = Resource<Service>("Linux.Service");

// Sentinel exit code our read script uses to signal "unit file not found",
// distinct from is-active's own non-zero codes for inactive/failed units.
const NO_UNIT_EXIT = 7;

const sameRemoteTarget = (
  left: RemoteHost | undefined,
  right: RemoteHost | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.node === right.node &&
  left.vmid === right.vmid;

interface ServiceState {
  enabled: boolean;
  active: boolean;
}

/**
 * Observe a unit's enabled/active state in one round-trip. Returns `undefined`
 * when the unit file does not exist on the host.
 */
const statService = (host: RemoteHost, name: string) => {
  const q = quoteArg(name);
  return exec(
    host,
    `systemctl cat ${q} >/dev/null 2>&1 || exit ${NO_UNIT_EXIT}; systemctl is-enabled ${q} 2>/dev/null; systemctl is-active ${q} 2>/dev/null`,
  ).pipe(
    Effect.map((result): ServiceState | undefined => {
      if (result.exitCode === NO_UNIT_EXIT) return undefined;
      const lines = result.stdout.split("\n").filter((l) => l.length > 0);
      return { enabled: lines[0] === "enabled", active: lines[1] === "active" };
    }),
  );
};

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.succeed({
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news)) return undefined;
        // The unit name and container are identity; SSH auth/transport changes
        // only change provider access and must reconcile in-place.
        if (
          news.name !== olds?.name ||
          !sameRemoteTarget(news.host, olds?.host)
        ) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),

      read: Effect.fn(function* ({ olds, output }) {
        if (!output) return undefined;
        const state = yield* statService(olds.host, output.name);
        if (state === undefined) return undefined;
        return {
          name: output.name,
          enabled: state.enabled,
          active: state.active,
          restartTrigger: output.restartTrigger,
        };
      }),

      reconcile: Effect.fn(function* ({ news, output, session }) {
        const q = quoteArg(news.name);
        const enabled = news.enabled ?? true;
        const running = news.running ?? true;
        const observed = (yield* statService(news.host, news.name)) ?? {
          enabled: false,
          active: false,
        };

        if (observed.enabled !== enabled) {
          yield* session.note(
            `${enabled ? "Enabling" : "Disabling"} ${news.name}`,
          );
          yield* execOrFail(
            news.host,
            `systemctl ${enabled ? "enable" : "disable"} ${q}`,
          );
        }

        if (!running) {
          if (observed.active) {
            yield* session.note(`Stopping ${news.name}`);
            yield* execOrFail(news.host, `systemctl stop ${q}`);
          }
        } else if (!observed.active) {
          yield* session.note(`Starting ${news.name}`);
          yield* execOrFail(news.host, `systemctl start ${q}`);
        } else if (
          news.restartTrigger !== undefined &&
          output?.restartTrigger !== news.restartTrigger
        ) {
          yield* session.note(`Restarting ${news.name}`);
          yield* execOrFail(news.host, `systemctl restart ${q}`);
        }

        const final = yield* statService(news.host, news.name);
        const target = `${news.host.node}/${news.host.vmid}`;
        if (final === undefined) {
          return yield* Effect.fail(
            new RemoteCommandError({
              message: `systemd unit ${news.name} not found on ${target} after reconcile; desired enabled=${enabled} active=${running}; observed missing`,
            }),
          );
        }

        if (final.enabled !== enabled) {
          return yield* Effect.fail(
            new RemoteCommandError({
              message: `systemd unit ${news.name} on ${target} did not converge after reconcile; desired enabled=${enabled} active=${running}; observed enabled=${final.enabled} active=${final.active}`,
            }),
          );
        }

        if (final.active !== running) {
          return yield* Effect.fail(
            new RemoteCommandError({
              message: `systemd unit ${news.name} on ${target} did not converge after reconcile; desired enabled=${enabled} active=${running}; observed enabled=${final.enabled} active=${final.active}`,
            }),
          );
        }
        return {
          name: news.name,
          enabled: final.enabled,
          active: final.active,
          restartTrigger: news.restartTrigger,
        };
      }),

      delete: Effect.fn(function* ({ olds, output, session }) {
        // Best-effort: stop + disable. The unit file itself belongs to the
        // package, so a missing unit (package already removed) is not an error.
        yield* session.note(`Disabling ${output.name}`);
        yield* exec(
          olds.host,
          `systemctl disable --now ${quoteArg(output.name)}`,
        );
      }),
    }),
  );
