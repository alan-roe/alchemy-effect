import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as crypto from "node:crypto";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { exec, execOrFail, quoteArg, type RemoteHost } from "./Remote.ts";

/**
 * Properties for a file managed on a Linux host.
 */
export interface FileProps {
  /** How to reach the host (Proxmox node + container vmid). */
  host: RemoteHost;
  /**
   * Absolute path of the file. Statically known (used in diff); identity of
   * the resource.
   */
  path: string;
  /**
   * File contents. Pass a `Redacted` string to mark the file sensitive — the
   * contents are then kept out of logs (they always travel over stdin, never
   * the command line).
   */
  content: string | Redacted.Redacted<string>;
  /**
   * File mode in octal (e.g. `"0644"`). Left untouched when omitted.
   */
  mode?: string;
  /** Owning user. Left untouched when omitted. */
  owner?: string;
  /** Owning group. Left untouched when omitted. */
  group?: string;
}

/**
 * Output attributes of a managed file.
 */
export interface FileAttributes {
  /** The file path. */
  path: string;
  /** SHA-256 (hex) of the on-disk contents. Content itself is never stored. */
  hash: string;
  /** On-disk mode as reported by `stat %a` (e.g. `"644"`). */
  mode: string | undefined;
  /** Owning user. */
  owner: string | undefined;
  /** Owning group. */
  group: string | undefined;
}

/**
 * A file on a Linux host you control, managed over SSH + `pct exec`. Content
 * drift is detected by comparing a local SHA-256 against the on-disk
 * `sha256sum`; only the contents (never the metadata) are stored in state.
 *
 * @section Writing Files
 * @example Write a config file owned by postgres
 * ```typescript
 * const hba = yield* Linux.File("pg_hba", {
 *   host: { node: "pve", vmid: container.vmid },
 *   path: "/etc/postgresql/16/main/pg_hba.conf",
 *   content: "host all all 0.0.0.0/0 scram-sha-256\n",
 *   owner: "postgres",
 *   group: "postgres",
 *   mode: "0640",
 * });
 * ```
 */
export type File = Resource<
  "Linux.File",
  FileProps,
  FileAttributes,
  never,
  Providers
>;

export const File = Resource<File>("Linux.File");

const STAT_FORMAT = "%a|%U|%G";

const sameRemoteTarget = (
  left: RemoteHost | undefined,
  right: RemoteHost | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.node === right.node &&
  left.vmid === right.vmid;

interface FileState {
  hash: string;
  mode: string;
  owner: string;
  group: string;
}

/**
 * Observe a file's content hash and ownership in one round-trip. Returns
 * `undefined` when the file does not exist. Shared by `read`, `reconcile`
 * observation, and the post-write re-stat.
 */
const statFile = (host: RemoteHost, path: string) =>
  exec(
    host,
    `sha256sum ${quoteArg(path)} && stat -c ${quoteArg(STAT_FORMAT)} ${quoteArg(path)}`,
  ).pipe(
    Effect.map((result): FileState | undefined => {
      if (result.exitCode !== 0) return undefined;
      const lines = result.stdout.split("\n").filter((l) => l.length > 0);
      const hash = lines[0]?.split(/\s+/)[0] ?? "";
      const [mode = "", owner = "", group = ""] = (lines[1] ?? "").split("|");
      return { hash, mode, owner, group };
    }),
  );

export const FileProvider = () =>
  Provider.effect(
    File,
    Effect.succeed({
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news)) return undefined;
        // The path and container are identity; SSH auth/transport changes only
        // change provider access and must reconcile in-place.
        if (
          news.path !== olds?.path ||
          !sameRemoteTarget(news.host, olds?.host)
        ) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),

      read: Effect.fn(function* ({ olds, output }) {
        if (!output) return undefined;
        const state = yield* statFile(olds.host, output.path);
        if (state === undefined) return undefined;
        return {
          path: output.path,
          hash: state.hash,
          mode: state.mode,
          owner: state.owner,
          group: state.group,
        };
      }),

      reconcile: Effect.fn(function* ({ news, session }) {
        const content = Redacted.isRedacted(news.content)
          ? Redacted.value(news.content)
          : news.content;
        const desiredHash = yield* Effect.sync(() =>
          crypto.createHash("sha256").update(content).digest("hex"),
        );
        const observed = yield* statFile(news.host, news.path);
        const rewrote = observed?.hash !== desiredHash;

        if (rewrote) {
          yield* session.note(`Writing ${news.path}`);
          const slash = news.path.lastIndexOf("/");
          const dir = slash > 0 ? news.path.slice(0, slash) : undefined;
          const write = `cat > ${quoteArg(news.path)}`;
          yield* execOrFail(
            news.host,
            dir ? `mkdir -p ${quoteArg(dir)} && ${write}` : write,
            { stdin: content },
          );
        }

        if (
          news.mode !== undefined &&
          (rewrote ||
            observed === undefined ||
            parseInt(observed.mode, 8) !== parseInt(news.mode, 8))
        ) {
          yield* execOrFail(
            news.host,
            `chmod ${quoteArg(news.mode)} ${quoteArg(news.path)}`,
          );
        }

        const ownerChanged =
          news.owner !== undefined &&
          (rewrote || observed?.owner !== news.owner);
        const groupChanged =
          news.group !== undefined &&
          (rewrote || observed?.group !== news.group);
        if (ownerChanged || groupChanged) {
          const spec =
            news.group !== undefined
              ? `${news.owner ?? ""}:${news.group}`
              : (news.owner ?? "");
          yield* execOrFail(
            news.host,
            `chown ${quoteArg(spec)} ${quoteArg(news.path)}`,
          );
        }

        const final = yield* statFile(news.host, news.path);
        return {
          path: news.path,
          hash: final?.hash ?? desiredHash,
          mode: final?.mode,
          owner: final?.owner,
          group: final?.group,
        };
      }),

      delete: Effect.fn(function* ({ olds, output, session }) {
        yield* session.note(`Removing ${output.path}`);
        yield* execOrFail(olds.host, `rm -f ${quoteArg(output.path)}`);
      }),
    }),
  );
