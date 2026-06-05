import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { exec, execOrFail, quoteArg, type RemoteHost } from "./Remote.ts";

/**
 * Properties for an apt package on a Debian-family Linux host.
 */
export interface PackageProps {
  /** How to reach the host (Proxmox node + container vmid). */
  host: RemoteHost;
  /**
   * Package name. Statically known (used in diff); identity of the resource.
   */
  name: string;
  /**
   * Desired state of the package.
   * @default "present"
   */
  ensure?: "present" | "absent";
  /**
   * Run `apt-get update` before installing. Disable once the cache is warm to
   * skip the network round-trip on every reconcile.
   * @default true
   */
  update?: boolean;
}

/**
 * Output attributes of a managed apt package.
 */
export interface PackageAttributes {
  /** The package name. */
  name: string;
  /**
   * Installed version as reported by `dpkg-query`, or `undefined` when the
   * package is absent (e.g. `ensure: "absent"`).
   */
  version: string | undefined;
}

/**
 * An apt package installed on a Debian-family host you control, managed over
 * SSH + `pct exec`. The provider observes with `dpkg-query` and converges with
 * `apt-get`.
 *
 * @section Installing Packages
 * @example Install PostgreSQL
 * ```typescript
 * const pg = yield* Linux.Package("postgresql", {
 *   host: { node: "pve", vmid: container.vmid },
 *   name: "postgresql",
 * });
 * ```
 */
export type Package = Resource<
  "Linux.Package",
  PackageProps,
  PackageAttributes,
  never,
  Providers
>;

export const Package = Resource<Package>("Linux.Package");

// dpkg-query format string. Kept out of a template literal so `${Status}` is
// passed to dpkg verbatim (it is the dpkg field syntax, not JS interpolation).
const DPKG_FORMAT = "${Status}|${Version}";

/**
 * Observe a package via `dpkg-query`. Returns the installed version, or
 * `undefined` when the package is not in the "installed" state. Shared by
 * `read`, `reconcile`, and `delete`.
 */
const queryPackage = (host: RemoteHost, name: string) =>
  exec(
    host,
    `dpkg-query -W -f=${quoteArg(DPKG_FORMAT)} ${quoteArg(name)}`,
  ).pipe(
    Effect.map((result) => {
      if (result.exitCode !== 0) return undefined;
      const [status, version] = result.stdout.split("|");
      const installed = status?.trim().split(/\s+/).at(-1) === "installed";
      return installed ? (version?.trim() ?? "") : undefined;
    }),
  );

export const PackageProvider = () =>
  Provider.effect(
    Package,
    Effect.succeed({
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news)) return undefined;
        // The package name is the identity; renaming means a different package.
        if (news.name !== olds?.name) return { action: "replace" } as const;
        return undefined;
      }),

      read: Effect.fn(function* ({ olds, output }) {
        if (!output) return undefined;
        const version = yield* queryPackage(olds.host, output.name);
        return version === undefined
          ? undefined
          : { name: output.name, version };
      }),

      reconcile: Effect.fn(function* ({ news, session }) {
        const ensure = news.ensure ?? "present";
        const observed = yield* queryPackage(news.host, news.name);

        if (ensure === "absent") {
          if (observed !== undefined) {
            yield* session.note(`Removing ${news.name}`);
            yield* execOrFail(
              news.host,
              `DEBIAN_FRONTEND=noninteractive apt-get remove -y ${quoteArg(news.name)}`,
            );
          }
          return { name: news.name, version: undefined };
        }

        if (observed !== undefined) {
          return { name: news.name, version: observed };
        }

        yield* session.note(`Installing ${news.name}`);
        const install = `DEBIAN_FRONTEND=noninteractive apt-get install -y ${quoteArg(news.name)}`;
        yield* execOrFail(
          news.host,
          (news.update ?? true) ? `apt-get update && ${install}` : install,
        );
        const version = yield* queryPackage(news.host, news.name);
        return { name: news.name, version: version ?? "" };
      }),

      delete: Effect.fn(function* ({ olds, output, session }) {
        const version = yield* queryPackage(olds.host, output.name);
        if (version !== undefined) {
          yield* session.note(`Removing ${output.name}`);
          yield* execOrFail(
            olds.host,
            `DEBIAN_FRONTEND=noninteractive apt-get remove -y ${quoteArg(output.name)}`,
          );
        }
      }),
    }),
  );
