import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { ScopedPlanStatusSession } from "../Cli/Cli.ts";
import { ProxmoxApiError, request } from "./client.ts";
import type { ProxmoxEnvironment } from "./Environment.ts";
import { ProxmoxTaskError, waitForTask } from "./Tasks.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ClusterResource {
  vmid: number;
  name: string;
  node: string;
  status: string;
  type: string;
  maxdisk?: number;
  maxmem?: number;
  tags?: string;
}

export interface LxcStatus {
  status: "running" | "stopped" | "paused";
  uptime?: number;
  name?: string;
}

export interface LxcConfig {
  hostname?: string;
  cores?: number;
  memory?: number;
  swap?: number;
  rootfs?: string;
  storage?: string;
  net0?: string;
  description?: string;
  tags?: string;
  unprivileged?: boolean;
}

export interface NodeInfo {
  node: string;
  status: "online" | "offline" | "unknown";
  maxcpu?: number;
  maxmem?: number;
  mem?: number;
  cpu?: number;
}

export interface LxcInterface {
  name: string;
  inet?: string;
  inet6?: string;
  hwaddr: string;
}

// ---------------------------------------------------------------------------
// Cluster queries
// ---------------------------------------------------------------------------

/**
 * GET /cluster/nextid
 * Returns the next available VMID.
 */
export const nextVmid = (): Effect.Effect<
  number,
  ProxmoxApiError,
  ProxmoxEnvironment
> =>
  Effect.gen(function* () {
    const data = yield* request("GET", "/cluster/nextid");
    return Number(data);
  });

/**
 * GET /cluster/resources
 * Returns a list of cluster resources optionally filtered by type.
 */
export const listClusterResources = (params?: {
  type?: "vm" | "storage" | "node" | "sdn";
}): Effect.Effect<ClusterResource[], ProxmoxApiError, ProxmoxEnvironment> =>
  Effect.gen(function* () {
    const data = yield* request("GET", "/cluster/resources", {
      type: params?.type,
    });
    if (!Array.isArray(data)) return [];
    return data as ClusterResource[];
  });

/**
 * GET /nodes
 * Returns a list of cluster nodes.
 */
export const listNodes = (): Effect.Effect<
  NodeInfo[],
  ProxmoxApiError,
  ProxmoxEnvironment
> =>
  Effect.gen(function* () {
    const data = yield* request("GET", "/nodes");
    if (!Array.isArray(data)) return [];
    return data as NodeInfo[];
  });

// ---------------------------------------------------------------------------
// LXC container queries
// ---------------------------------------------------------------------------

/**
 * GET /nodes/{node}/lxc/{vmid}/status/current
 * Returns the current status of an LXC container, or `undefined` if not found.
 */
export const getLxcStatus = (
  node: string,
  vmid: number,
): Effect.Effect<LxcStatus | undefined, ProxmoxApiError, ProxmoxEnvironment> =>
  request("GET", `/nodes/${node}/lxc/${vmid}/status/current`).pipe(
    Effect.map((data) => data as LxcStatus),
    Effect.catchIf(
      (e): e is ProxmoxApiError =>
        e instanceof ProxmoxApiError && e.status === 404,
      () => Effect.succeed(undefined),
    ),
  );

/**
 * GET /nodes/{node}/lxc/{vmid}/config
 * Returns the configuration of an LXC container, or `undefined` if not found.
 */
export const getLxcConfig = (
  node: string,
  vmid: number,
): Effect.Effect<LxcConfig | undefined, ProxmoxApiError, ProxmoxEnvironment> =>
  request("GET", `/nodes/${node}/lxc/${vmid}/config`).pipe(
    Effect.map((data) => data as LxcConfig),
    Effect.catchIf(
      (e): e is ProxmoxApiError =>
        e instanceof ProxmoxApiError && e.status === 404,
      () => Effect.succeed(undefined),
    ),
  );

/**
 * GET /nodes/{node}/lxc/{vmid}/interfaces
 * Returns the network interfaces of a running LXC container.
 */
export const getLxcInterfaces = (
  node: string,
  vmid: number,
): Effect.Effect<LxcInterface[], ProxmoxApiError, ProxmoxEnvironment> =>
  request("GET", `/nodes/${node}/lxc/${vmid}/interfaces`).pipe(
    Effect.map((data) => (Array.isArray(data) ? (data as LxcInterface[]) : [])),
  );

// ---------------------------------------------------------------------------
// LXC container mutations (task-aware)
// ---------------------------------------------------------------------------

/**
 * POST /nodes/{node}/lxc
 * Creates an LXC container. Waits for the create task to finish (default timeout: 5 min).
 */
export const createLxc = (
  node: string,
  params: {
    vmid: number;
    ostemplate: string;
    hostname?: string;
    cores?: number;
    memory?: number;
    swap?: number;
    storage?: string;
    rootfs?: string;
    net0?: string;
    "ssh-public-keys"?: string;
    unprivileged?: boolean;
    description?: string;
    start?: boolean;
    [k: string]: unknown;
  },
  options?: { session?: ScopedPlanStatusSession },
): Effect.Effect<
  void,
  ProxmoxApiError | ProxmoxTaskError,
  ProxmoxEnvironment
> =>
  Effect.gen(function* () {
    // Build a serializable params record; skip unknown-typed keys
    const apiParams: Record<string, string | number | boolean | undefined> = {};
    for (const [k, v] of Object.entries(params)) {
      if (
        v === undefined ||
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        apiParams[k] = v as string | number | boolean | undefined;
      }
    }

    const upid = (yield* request(
      "POST",
      `/nodes/${node}/lxc`,
      apiParams,
    )) as string;
    yield* waitForTask(upid, node, {
      timeout: Duration.minutes(5),
      session: options?.session,
    });
  });

/**
 * DELETE /nodes/{node}/lxc/{vmid}
 * Destroys an LXC container. Idempotent: 404 / "does not exist" errors are swallowed.
 * Default timeout: 2 min.
 */
export const destroyLxc = (
  node: string,
  vmid: number,
  options?: {
    force?: boolean;
    purge?: boolean;
    session?: ScopedPlanStatusSession;
  },
): Effect.Effect<
  void,
  ProxmoxApiError | ProxmoxTaskError,
  ProxmoxEnvironment
> =>
  Effect.gen(function* () {
    const result = yield* request("DELETE", `/nodes/${node}/lxc/${vmid}`, {
      force: options?.force,
      purge: options?.purge,
    }).pipe(
      Effect.catchIf(
        (e): e is ProxmoxApiError =>
          e instanceof ProxmoxApiError &&
          (e.status === 404 ||
            e.status === 500 ||
            (typeof e.message === "string" &&
              e.message.toLowerCase().includes("does not exist"))),
        () => Effect.succeed(null),
      ),
    );

    if (result === null) {
      // Already gone — nothing to wait for
      return;
    }

    const upid = result as string;
    yield* waitForTask(upid, node, {
      timeout: Duration.minutes(2),
      session: options?.session,
    });
  });

/**
 * PUT /nodes/{node}/lxc/{vmid}/config
 * Updates mutable LXC configuration synchronously (no task). Default timeout: 30s.
 * Pass `delete` as a key with a comma-separated list of fields to remove.
 */
export const setLxcConfig = (
  node: string,
  vmid: number,
  params: Record<string, string | number | boolean | undefined>,
): Effect.Effect<void, ProxmoxApiError, ProxmoxEnvironment> =>
  request("PUT", `/nodes/${node}/lxc/${vmid}/config`, params).pipe(
    Effect.as(undefined),
  );

/**
 * POST /nodes/{node}/lxc/{vmid}/status/start
 * Starts an LXC container. Waits for the task to finish (default timeout: 60s).
 */
export const startLxc = (
  node: string,
  vmid: number,
  options?: { session?: ScopedPlanStatusSession },
): Effect.Effect<
  void,
  ProxmoxApiError | ProxmoxTaskError,
  ProxmoxEnvironment
> =>
  Effect.gen(function* () {
    const upid = (yield* request(
      "POST",
      `/nodes/${node}/lxc/${vmid}/status/start`,
    )) as string;
    yield* waitForTask(upid, node, {
      timeout: Duration.seconds(60),
      session: options?.session,
    });
  });

/**
 * POST /nodes/{node}/lxc/{vmid}/status/stop
 * Stops an LXC container. Idempotent: ignores "already stopped" errors.
 * Default timeout: 60s.
 */
export const stopLxc = (
  node: string,
  vmid: number,
  options?: { session?: ScopedPlanStatusSession },
): Effect.Effect<
  void,
  ProxmoxApiError | ProxmoxTaskError,
  ProxmoxEnvironment
> =>
  Effect.gen(function* () {
    const upid = (yield* request(
      "POST",
      `/nodes/${node}/lxc/${vmid}/status/stop`,
    )) as string;
    yield* waitForTask(upid, node, {
      timeout: Duration.seconds(60),
      session: options?.session,
    });
  }).pipe(
    Effect.catchIf(
      (e): e is ProxmoxApiError =>
        e instanceof ProxmoxApiError &&
        typeof e.message === "string" &&
        (e.message.toLowerCase().includes("already stopped") ||
          e.message.toLowerCase().includes("not running")),
      () => Effect.void,
    ),
  );

/**
 * POST /nodes/{node}/lxc/{vmid}/resize
 * Resizes a disk on an LXC container. Waits for the task (default timeout: 2 min).
 * Use `{ disk: "rootfs", size: "+1G" }` for relative growth, or `"10G"` for absolute.
 */
export const resizeLxc = (
  node: string,
  vmid: number,
  params: { disk: string; size: string },
  options?: { session?: ScopedPlanStatusSession },
): Effect.Effect<
  void,
  ProxmoxApiError | ProxmoxTaskError,
  ProxmoxEnvironment
> =>
  Effect.gen(function* () {
    const upid = (yield* request(
      "PUT",
      `/nodes/${node}/lxc/${vmid}/resize`,
      params,
    )) as string;
    yield* waitForTask(upid, node, {
      timeout: Duration.minutes(2),
      session: options?.session,
    });
  });
