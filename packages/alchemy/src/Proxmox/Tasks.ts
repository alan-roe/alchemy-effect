import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ScopedPlanStatusSession } from "../Cli/Cli.ts";
import { ProxmoxApiError, request } from "./client.ts";
import type { ProxmoxEnvironment } from "./Environment.ts";

export class ProxmoxTaskError extends Data.TaggedError("ProxmoxTaskError")<{
  upid: string;
  node: string;
  exitstatus: string;
  log?: string[];
  message: string;
}> {}

/** Internal sentinel used to drive polling via Effect.retry */
class TaskPending extends Data.TaggedError("TaskPending")<{
  upid: string;
}> {}

interface TaskStatus {
  status: "running" | "stopped";
  exitstatus?: string;
  upid?: string;
  node?: string;
  pid?: number;
  type?: string;
  user?: string;
  starttime?: number;
}

interface TaskLogEntry {
  n: number;
  t: string;
}

const fetchTaskLog = (
  node: string,
  upid: string,
): Effect.Effect<string[], ProxmoxApiError, ProxmoxEnvironment> =>
  Effect.gen(function* () {
    const encodedUpid = encodeURIComponent(upid);
    const entries = (yield* request(
      "GET",
      `/nodes/${node}/tasks/${encodedUpid}/log`,
      { limit: 30, start: 0 },
    )) as TaskLogEntry[];
    if (!Array.isArray(entries)) return [];
    return entries.map((e) => e.t ?? String(e));
  });

/**
 * Polls `GET /nodes/{node}/tasks/{upid}/status` until the task is no longer
 * running. If `exitstatus` is not `"OK"`, fetches the last 30 log lines and
 * raises `ProxmoxTaskError`.
 *
 * Default poll interval: 2 seconds. Default timeout: 5 minutes.
 */
export const waitForTask = (
  upid: string,
  node: string,
  options?: {
    timeout?: Duration.Duration;
    session?: ScopedPlanStatusSession;
  },
): Effect.Effect<
  void,
  ProxmoxTaskError | ProxmoxApiError,
  ProxmoxEnvironment
> => {
  const timeout = options?.timeout ?? Duration.minutes(5);
  const pollInterval = Duration.seconds(2);
  const maxAttempts = Math.ceil(
    Duration.toMillis(timeout) / Duration.toMillis(pollInterval),
  );

  const encodedUpid = encodeURIComponent(upid);
  const shortUpid = upid.slice(0, 30);

  let attempt = 0;

  const poll = Effect.gen(function* () {
    attempt += 1;
    const elapsed = attempt * 2;

    if (options?.session) {
      yield* options.session.note(
        `Waiting for task ${shortUpid}... (${elapsed}s)`,
      );
    }

    const status = (yield* request(
      "GET",
      `/nodes/${node}/tasks/${encodedUpid}/status`,
    )) as TaskStatus;

    if (status.status === "running") {
      return yield* Effect.fail(new TaskPending({ upid }));
    }

    // Task finished — check exit status
    const exitstatus = status.exitstatus ?? "unknown";
    if (exitstatus !== "OK") {
      const log = yield* fetchTaskLog(node, upid).pipe(
        Effect.orElseSucceed(() => [] as string[]),
      );
      return yield* Effect.fail(
        new ProxmoxTaskError({
          upid,
          node,
          exitstatus,
          log,
          message: `Task ${shortUpid} failed with status: ${exitstatus}`,
        }),
      );
    }
  });

  return poll.pipe(
    Effect.retry({
      times: maxAttempts,
      while: (e) => e instanceof TaskPending,
      schedule: Schedule.fixed(pollInterval),
    }),
    // If we exhausted retries the last error is TaskPending — convert to timeout
    Effect.catchIf(
      (e): e is TaskPending => e instanceof TaskPending,
      (e) =>
        Effect.fail(
          new ProxmoxTaskError({
            upid: e.upid,
            node,
            exitstatus: "timeout",
            message: `Task ${shortUpid} did not complete within ${Duration.toSeconds(timeout)}s`,
          }),
        ),
    ),
  );
};
