import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * A command target reached by SSHing to a Proxmox cluster node and running
 * `pct exec <vmid> -- sh -c '<command>'`. LXC has no exec REST endpoint, so the
 * node is the control plane: `pct exec` runs as root inside the container and
 * does not depend on the container having its own networking or sshd.
 *
 * Every field that varies per deployment is plain data so the resources that
 * carry it can accept Outputs (e.g. `vmid: container.vmid`).
 */
export interface RemoteHost {
  /** SSH host (or alias) of the Proxmox node the container lives on. */
  readonly node: string;
  /** Numeric VMID of the LXC container on that node. */
  readonly vmid: number;
  /**
   * SSH user on the node. Must be able to run `pct exec`.
   * @default "root"
   */
  readonly user?: string;
  /**
   * SSH port on the node.
   * @default 22
   */
  readonly port?: number;
  /**
   * Path to an SSH private key. When omitted, ssh's default resolution applies
   * (`~/.ssh/config`, agent, default identities).
   */
  readonly identity?: string;
}

/** Captured result of a remote command. `exitCode` is the command's own code. */
export interface RemoteResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Options for {@link exec}. */
export interface ExecOptions {
  /**
   * Text piped to the remote command's stdin. Use this — never the command
   * string — to deliver file contents or secrets so they ride the SSH channel
   * instead of appearing in `ps`/argv on the node.
   */
  readonly stdin?: string;
}

/**
 * Failure spawning or running a remote command. A non-zero command exit is not
 * itself a `RemoteCommandError` — {@link exec} returns it in {@link RemoteResult}
 * so callers like `read` can treat "exit 1" as "absent". Use {@link execOrFail}
 * when a non-zero exit should fail.
 */
export class RemoteCommandError extends Data.TaggedError("RemoteCommandError")<{
  message: string;
  exitCode?: number;
  stderr?: string;
  cause?: unknown;
}> {}

/**
 * Quote a single token for a POSIX shell by wrapping it in single quotes and
 * escaping any embedded single quote as `'\''`. The transport double-parses
 * (node login shell, then the container's `sh -c`), so every interpolated value
 * a provider injects into a command must pass through this.
 */
export const quoteArg = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Build the `ssh` argv that runs `command` inside the container via `pct exec`.
 * The whole `pct exec ... sh -c <quoted>` string is a single ssh argument, so
 * it reaches the node verbatim (no local shell) and is parsed once by the node
 * shell and once by the container's `sh`. Exported as the unit-test seam for
 * the quoting/escaping behaviour.
 */
export const buildSshArgs = (host: RemoteHost, command: string): string[] => [
  ...(host.identity ? ["-i", host.identity] : []),
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  ...(host.port ? ["-p", String(host.port)] : []),
  `${host.user ?? "root"}@${host.node}`,
  `pct exec ${host.vmid} -- sh -c ${quoteArg(command)}`,
];

/**
 * Run `command` inside the container and capture stdout/stderr/exit code. Fails
 * with {@link RemoteCommandError} only when ssh itself cannot run (spawn/IO
 * failure); a non-zero command exit is returned, not raised.
 */
export const exec = (
  host: RemoteHost,
  command: string,
  options?: ExecOptions,
): Effect.Effect<
  RemoteResult,
  RemoteCommandError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const args = buildSshArgs(host, command);
    const stdin =
      options?.stdin !== undefined
        ? Stream.fromIterable([
            yield* Effect.sync(() => new TextEncoder().encode(options.stdin)),
          ])
        : ("ignore" as const);
    const handle = yield* ChildProcess.make("ssh", args, { stdin });
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
      ] as const,
      { concurrency: 3 },
    );
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new RemoteCommandError({
          message: `remote exec on ${host.node}/${host.vmid} failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    ),
  );

/**
 * Like {@link exec}, but fails with {@link RemoteCommandError} when the command
 * exits non-zero. Use in `reconcile`/`delete` where the command must succeed.
 */
export const execOrFail = (
  host: RemoteHost,
  command: string,
  options?: ExecOptions,
): Effect.Effect<
  RemoteResult,
  RemoteCommandError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  exec(host, command, options).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new RemoteCommandError({
              message: `command failed (exit ${result.exitCode}) on ${host.node}/${host.vmid}: ${command}${
                result.stderr ? `\n${result.stderr.trim()}` : ""
              }`,
              exitCode: result.exitCode,
              stderr: result.stderr,
            }),
          ),
    ),
  );
