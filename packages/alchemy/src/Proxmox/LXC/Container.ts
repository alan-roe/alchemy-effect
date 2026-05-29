import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import type { ProxmoxEnvironment } from "../Environment.ts";
import {
  type LxcConfig,
  type LxcInterface,
  type LxcStatus,
  createLxc,
  destroyLxc,
  getLxcConfig,
  getLxcInterfaces,
  getLxcStatus,
  listClusterResources,
  listNodes,
  nextVmid,
  resizeLxc,
  setLxcConfig,
  startLxc,
  stopLxc,
} from "../api.ts";
import { ProxmoxApiError } from "../client.ts";
import { ProxmoxTaskError } from "../Tasks.ts";
import type { Providers } from "../Providers.ts";

// ---------------------------------------------------------------------------
// Prop / Attribute interfaces
// ---------------------------------------------------------------------------

export interface ContainerProps {
  /**
   * Path to the LXC template to use (e.g. "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst").
   * This is a replace-trigger: changing the template destroys and recreates the container.
   */
  template: string;

  /**
   * Hostname of the container. Defaults to a deterministic name derived from
   * the stack, logical ID, and stage via `createPhysicalName`. Acts as the
   * discovery key when state is lost.
   * This is a replace-trigger.
   */
  hostname?: string;

  /**
   * The cluster node to place the container on (e.g. "proxmox"). Uses a
   * sticky-default: once created, the node from output is reused if this
   * prop is omitted, so a brief node outage does not trigger replacement.
   * This is a replace-trigger when explicitly changed.
   */
  node?: string;

  /**
   * Storage pool for the container's rootfs (e.g. "local-lvm").
   * This is a replace-trigger.
   * @default "local-lvm"
   */
  storage?: string;

  /**
   * Root filesystem size in GB. Growing the disk is supported in-place;
   * shrinking triggers a replacement.
   * @default 8
   */
  disk?: number;

  /**
   * Number of CPU cores allocated to the container.
   * Mutable without replacement.
   * @default 2
   */
  cores?: number;

  /**
   * Memory in MB allocated to the container.
   * Mutable without replacement.
   * @default 2048
   */
  memory?: number;

  /**
   * Network bridge to attach the container's eth0 interface to.
   * Mutable without replacement.
   * @default "vmbr0"
   */
  bridge?: string;

  /**
   * List of SSH public key strings to inject into the container at create
   * time. PVE only accepts these at provisioning — this is a replace-trigger.
   * @default []
   */
  sshKeys?: string[];

  /**
   * Whether the container should be running. When `true`, a stopped container
   * is started. When `false`, a running container is stopped.
   * Mutable without replacement.
   * @default true
   */
  start?: boolean;
}

export interface ContainerAttributes {
  /**
   * The numeric VMID assigned by Proxmox to this container.
   * Allocated via `/cluster/nextid` on first create.
   */
  vmid: number;

  /**
   * Hostname of the container.
   */
  hostname: string;

  /**
   * The cluster node the container is running on.
   */
  node: string;

  /**
   * IPv4 address of the container's primary interface, or `undefined` when
   * the container was just created and the guest agent has not yet reported
   * an address (typically within ~30s of first start).
   */
  ipv4: string | undefined;

  /**
   * Current power state of the container.
   */
  status: "running" | "stopped";
}

/**
 * A Proxmox LXC container provisioned on a cluster node.
 *
 * The container is always unprivileged. Disk, cores, memory, bridge, and
 * power state are mutable in-place. Template, hostname, node, storage, SSH
 * keys, and disk shrinks trigger a full replacement (destroy + recreate).
 *
 * The container's identity is tracked via its VMID (output attribute) and
 * hostname (discovery key when state is lost). Ownership is recorded in the
 * container's PVE `description` field as a JSON marker block so that read
 * can verify this stack/stage/logical-id owns it.
 *
 * @section Creating a Container
 * @example Basic container with defaults
 * ```typescript
 * const container = yield* Container("my-service", {
 *   template: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst",
 * });
 * console.log(container.ipv4); // may be undefined for ~30s after first create
 * ```
 *
 * @section Sizing and placement
 * @example Custom cores, memory, and node
 * ```typescript
 * const container = yield* Container("db", {
 *   template: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst",
 *   node: "pve1",
 *   cores: 4,
 *   memory: 4096,
 *   disk: 20,
 * });
 * ```
 *
 * @section SSH access
 * @example Bootstrap SSH keys
 * ```typescript
 * const container = yield* Container("secure-box", {
 *   template: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst",
 *   sshKeys: [
 *     "ssh-ed25519 AAAA... user@host",
 *   ],
 * });
 * ```
 */
export interface Container
  extends Resource<
    "Proxmox.LXC.Container",
    ContainerProps,
    ContainerAttributes,
    never,
    Providers
  > {}

export const Container = Resource<Container>("Proxmox.LXC.Container");

// ---------------------------------------------------------------------------
// Internal sentinel errors for retry loops
// ---------------------------------------------------------------------------

class ContainerNotRunning extends Data.TaggedError("ContainerNotRunning")<{
  vmid: number;
  status: string;
}> {}

class ContainerNoIpv4 extends Data.TaggedError("ContainerNoIpv4")<{
  vmid: number;
}> {}

// ---------------------------------------------------------------------------
// Ownership marker helpers (ADR 0002)
// ---------------------------------------------------------------------------

export interface OwnershipMarker {
  stack: string;
  stage: string;
  id: string;
}

const MARKER_OPEN = "#__alchemy__";
const MARKER_CLOSE = "#__/alchemy__";

/**
 * Parse the alchemy ownership marker out of a PVE `description` field.
 * Returns `undefined` when no marker is present or when the JSON is invalid.
 */
export const parseOwnershipMarker = (
  description: string | undefined,
): OwnershipMarker | undefined => {
  if (!description) return undefined;
  const start = description.indexOf(MARKER_OPEN);
  const end = description.indexOf(MARKER_CLOSE);
  if (start === -1 || end === -1 || end <= start) return undefined;
  const jsonBlock = description.slice(start + MARKER_OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(jsonBlock);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.stack === "string" &&
      typeof parsed.stage === "string" &&
      typeof parsed.id === "string"
    ) {
      return { stack: parsed.stack, stage: parsed.stage, id: parsed.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Produce the ownership marker block string for a given triple.
 */
export const formatOwnershipMarker = (marker: OwnershipMarker): string =>
  `${MARKER_OPEN}\n${JSON.stringify(marker)}\n${MARKER_CLOSE}`;

/**
 * Merge a new ownership marker into an existing description string,
 * preserving any user prose. If a marker is already present it is replaced;
 * if not, the marker is prepended.
 */
export const mergeDescription = (
  observed: string | undefined,
  marker: string,
): string => {
  if (!observed) return marker;
  const start = observed.indexOf(MARKER_OPEN);
  const end = observed.indexOf(MARKER_CLOSE);
  if (start !== -1 && end !== -1 && end > start) {
    // Replace existing marker block
    const before = observed.slice(0, start);
    const after = observed.slice(end + MARKER_CLOSE.length);
    return `${marker}${after.startsWith("\n") ? after : "\n" + after}`.trimEnd();
  }
  // Prepend marker, keep user prose
  const prose = observed.trim();
  return prose ? `${marker}\n\n${prose}` : marker;
};

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first IPv4 address from an array of LXC interfaces,
 * preferring eth0, falling back to the first non-loopback interface.
 */
export const parseIpv4FromInterfaces = (
  ifaces: LxcInterface[],
): string | undefined => {
  const ordered = [
    ifaces.find((i) => i.name === "eth0"),
    ifaces.find((i) => i.name !== "lo"),
  ].filter((i): i is LxcInterface => i != null);

  for (const iface of ordered) {
    if (iface.inet) {
      // inet is "1.2.3.4/24" — strip the prefix length
      const slash = iface.inet.indexOf("/");
      return slash === -1 ? iface.inet : iface.inet.slice(0, slash);
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

/**
 * Poll until the container is in `running` state.
 * Fails after ~60s with a descriptive error.
 */
const waitForRunning = (
  node: string,
  vmid: number,
): Effect.Effect<void, ContainerNotRunning | ProxmoxApiError, ProxmoxEnvironment> =>
  Effect.gen(function* () {
    const status = yield* getLxcStatus(node, vmid);
    const st = (status as LxcStatus | undefined)?.status ?? "stopped";
    if (st === "running") return;
    return yield* new ContainerNotRunning({ vmid, status: st });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof ContainerNotRunning,
      schedule: Schedule.fixed(Duration.seconds(2)).pipe(
        Schedule.both(Schedule.recurs(30)), // max 60s
      ),
    }),
    Effect.catchIf(
      (e): e is ContainerNotRunning => e instanceof ContainerNotRunning,
      (e) =>
        Effect.fail(
          new ContainerNotRunning({
            vmid: e.vmid,
            status: `timed out waiting for running state (last: ${e.status})`,
          }),
        ),
    ),
  );

/**
 * Poll until the container reports an IPv4 address on its primary interface.
 * Gives up after ~120s and returns `undefined` rather than failing.
 */
const waitForIpv4 = (
  node: string,
  vmid: number,
): Effect.Effect<string | undefined, ProxmoxApiError, ProxmoxEnvironment> =>
  Effect.gen(function* () {
    const ifaces = yield* getLxcInterfaces(node, vmid).pipe(
      Effect.catchIf(
        (e): e is ProxmoxApiError => e instanceof ProxmoxApiError,
        () => Effect.succeed([] as LxcInterface[]),
      ),
    );
    const ip = parseIpv4FromInterfaces(ifaces);
    if (ip) return ip;
    return yield* new ContainerNoIpv4({ vmid });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof ContainerNoIpv4,
      schedule: Schedule.fixed(Duration.seconds(4)).pipe(
        Schedule.both(Schedule.recurs(30)), // max 120s
      ),
    }),
    Effect.catchIf(
      (e): e is ContainerNoIpv4 => e instanceof ContainerNoIpv4,
      () => Effect.succeed(undefined as string | undefined),
    ),
  );

// ---------------------------------------------------------------------------
// Node discovery
// ---------------------------------------------------------------------------

/**
 * Find the first online node in the cluster.
 * Used only for greenfield creates when `news.node` is not set and there is
 * no prior `output.node` to inherit (ADR 0003 sticky-default).
 */
const firstOnlineNode = (): Effect.Effect<
  string,
  ProxmoxApiError,
  ProxmoxEnvironment
> =>
  Effect.gen(function* () {
    const nodes = yield* listNodes();
    const online = nodes.find((n) => n.status === "online");
    if (!online) {
      return yield* Effect.fail(
        new ProxmoxApiError({
          status: 0,
          method: "GET",
          path: "/nodes",
          message: "No online nodes found in the cluster",
        }),
      );
    }
    return online.node;
  });

// ---------------------------------------------------------------------------
// net0 string helpers
// ---------------------------------------------------------------------------

/**
 * Parse a PVE net0 string like "name=eth0,bridge=vmbr0,ip=dhcp" into a map.
 */
const parseNet0 = (net0: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const part of net0.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      result[part] = "";
    } else {
      result[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return result;
};

/**
 * Serialize a net0 map back into a PVE net0 string.
 */
const serializeNet0 = (parts: Record<string, string>): string =>
  Object.entries(parts)
    .map(([k, v]) => (v === "" ? k : `${k}=${v}`))
    .join(",");

/**
 * Build the default net0 string for a new container.
 */
const defaultNet0 = (bridge: string): string =>
  `name=eth0,bridge=${bridge},ip=dhcp,ip6=auto`;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const ContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      return {
        stables: ["vmid", "node", "hostname"],

        // -----------------------------------------------------------------
        // diff — decide update vs replace
        // -----------------------------------------------------------------
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return;

          const resolvedNews = news as ContainerProps;

          // Apply defaults for comparison
          const newDisk = resolvedNews.disk ?? 8;
          const oldDisk = olds?.disk ?? 8;

          // Sticky node resolution (ADR 0003): propagate output.node as
          // the implicit default so a re-run without `news.node` never
          // fires a replace purely because a node was offline at query time.
          const effectiveNewNode =
            resolvedNews.node ?? output?.node ?? undefined;
          const effectiveOldNode = olds?.node ?? output?.node ?? undefined;

          // Check replace-triggers
          const oldTemplate = olds?.template;
          const oldHostname = olds?.hostname;
          const oldStorage = olds?.storage ?? "local-lvm";
          const oldSshKeys = JSON.stringify(olds?.sshKeys ?? []);

          const newTemplate = resolvedNews.template;
          const newHostname = resolvedNews.hostname;
          const newStorage = resolvedNews.storage ?? "local-lvm";
          const newSshKeys = JSON.stringify(resolvedNews.sshKeys ?? []);

          const needsReplace =
            (olds !== undefined && newTemplate !== oldTemplate) ||
            (olds !== undefined && newHostname !== oldHostname) ||
            (olds !== undefined && effectiveNewNode !== effectiveOldNode) ||
            (olds !== undefined && newStorage !== oldStorage) ||
            (olds !== undefined && newSshKeys !== oldSshKeys) ||
            (olds !== undefined && newDisk < oldDisk); // shrink

          if (needsReplace) {
            return { action: "replace" as const };
          }

          // Return stables for pure update path
          return {
            action: "update" as const,
            stables: ["vmid", "node", "hostname"] as string[],
          };
        }),

        // -----------------------------------------------------------------
        // read — find by vmid or hostname, verify ownership
        // -----------------------------------------------------------------
        read: Effect.fn(function* ({ id, olds, output }) {
          // 1. If we have a vmid, try a direct lookup first
          if (output?.vmid !== undefined) {
            const node = output.node;
            const vmid = output.vmid;

            const status = yield* getLxcStatus(node, vmid);
            if (status !== undefined) {
              const config = yield* getLxcConfig(node, vmid);
              const ifaces = yield* getLxcInterfaces(node, vmid).pipe(
                Effect.catchIf(
                  (e): e is ProxmoxApiError => e instanceof ProxmoxApiError,
                  () => Effect.succeed([] as LxcInterface[]),
                ),
              );
              const marker = parseOwnershipMarker(config?.description);
              const attrs: ContainerAttributes = {
                vmid,
                hostname: config?.hostname ?? output.hostname,
                node,
                ipv4: parseIpv4FromInterfaces(ifaces),
                status: status.status === "running" ? "running" : "stopped",
              };

              // Verify ownership
              const stack = yield* Stack;
              const stage = yield* Stage;
              if (
                marker &&
                marker.stack === stack.name &&
                marker.stage === stage &&
                marker.id === id
              ) {
                return attrs;
              }

              // Resource exists but marker is absent or mismatched — foreign
              if (marker === undefined) {
                // No marker: could be a manually-created container. Mark unowned.
                return Unowned(attrs);
              }

              // Marker mismatched (different stack/stage/id)
              return Unowned(attrs);
            }
            // 404 — fall through to hostname discovery
          }

          // 2. Discovery by hostname.
          // PVE's `/cluster/resources?type=...` enum is `vm|storage|node|sdn`.
          // `type=vm` returns both qemu and lxc; we filter to lxc client-side.
          const allVmResources = yield* listClusterResources({ type: "vm" });
          const resources = allVmResources.filter((r) => r.type === "lxc");

          // Compute the deterministic expected hostname using the same default
          // logic as reconcile, so a greenfield Read still has a discovery key.
          const expectedHostname =
            olds?.hostname ??
            output?.hostname ??
            (yield* createPhysicalName({
              id,
              maxLength: 63,
              lowercase: true,
              delimiter: "-",
            }));

          for (const resource of resources) {
            if (resource.name !== expectedHostname) {
              continue;
            }

            const node = resource.node;
            const vmid = resource.vmid;

            const config = yield* getLxcConfig(node, vmid);
            if (!config) continue;

            // Only match if hostname matches
            if (config.hostname !== expectedHostname) {
              continue;
            }

            const ifaces = yield* getLxcInterfaces(node, vmid).pipe(
              Effect.catchIf(
                (e): e is ProxmoxApiError => e instanceof ProxmoxApiError,
                () => Effect.succeed([] as LxcInterface[]),
              ),
            );

            const marker = parseOwnershipMarker(config.description);
            const statusResult = yield* getLxcStatus(node, vmid);
            const attrs: ContainerAttributes = {
              vmid,
              hostname: config.hostname ?? resource.name,
              node,
              ipv4: parseIpv4FromInterfaces(ifaces),
              status:
                statusResult?.status === "running" ? "running" : "stopped",
            };

            const stack = yield* Stack;
            const stage = yield* Stage;

            if (
              marker &&
              marker.stack === stack.name &&
              marker.stage === stage &&
              marker.id === id
            ) {
              return attrs;
            }

            // Exists but not ours
            return Unowned(attrs);
          }

          return undefined;
        }),

        // -----------------------------------------------------------------
        // reconcile — observe → ensure → sync
        // -----------------------------------------------------------------
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? ({} as ContainerProps);

          // Apply defaults
          const desiredStorage = props.storage ?? "local-lvm";
          const desiredDisk = props.disk ?? 8;
          const desiredCores = props.cores ?? 2;
          const desiredMemory = props.memory ?? 2048;
          const desiredBridge = props.bridge ?? "vmbr0";
          const desiredSshKeys = props.sshKeys ?? [];
          const desiredStart = props.start ?? true;

          // -----------------------------------------------------------
          // 1. Observe — resolve node and look up live state
          // -----------------------------------------------------------

          // Sticky node per ADR 0003
          const effectiveNode =
            props.node ??
            output?.node ??
            (yield* firstOnlineNode());

          // Compute hostname — use prop or generate deterministic name
          const desiredHostname =
            props.hostname ??
            output?.hostname ??
            (yield* createPhysicalName({
              id,
              maxLength: 63,
              lowercase: true,
              delimiter: "-",
            }));

          // Build ownership marker
          const stack = yield* Stack;
          const stage = yield* Stage;
          const markerPayload: OwnershipMarker = {
            stack: stack.name,
            stage,
            id,
          };
          const markerBlock = formatOwnershipMarker(markerPayload);

          // Try to find the vmid — use output.vmid if available, else discover
          let vmid: number | undefined = output?.vmid;
          let observedStatus: LxcStatus | undefined;
          let observedConfig: LxcConfig | undefined;
          let containerNode: string = effectiveNode;

          if (vmid !== undefined) {
            observedStatus = yield* getLxcStatus(containerNode, vmid);
            observedConfig = yield* getLxcConfig(containerNode, vmid);
          }

          // If we have a vmid but the LXC is missing, fall through to create
          const containerExists =
            vmid !== undefined && observedStatus !== undefined;

          // -----------------------------------------------------------
          // 2. Ensure — create if missing
          // -----------------------------------------------------------

          if (!containerExists) {
            vmid = yield* nextVmid();
            containerNode = effectiveNode;

            yield* session.note(
              `Creating LXC container ${desiredHostname} on ${containerNode} (vmid ${vmid})`,
            );

            const sshKeysStr = desiredSshKeys.join("\n");
            const description = mergeDescription(undefined, markerBlock);

            yield* createLxc(
              containerNode,
              {
                vmid,
                ostemplate: props.template,
                hostname: desiredHostname,
                cores: desiredCores,
                memory: desiredMemory,
                storage: desiredStorage,
                rootfs: `${desiredStorage}:${desiredDisk}`,
                net0: defaultNet0(desiredBridge),
                "ssh-public-keys": sshKeysStr || undefined,
                unprivileged: true,
                description,
                start: desiredStart,
              },
              { session },
            ).pipe(
              // Tolerate vmid-in-use race: reallocate and retry once
              Effect.catchIf(
                (e): e is ProxmoxApiError =>
                  e instanceof ProxmoxApiError &&
                  (e.status === 500 ||
                    (typeof e.message === "string" &&
                      e.message.toLowerCase().includes("already exists"))),
                () =>
                  Effect.gen(function* () {
                    vmid = yield* nextVmid();
                    const desc2 = mergeDescription(undefined, markerBlock);
                    yield* createLxc(
                      containerNode,
                      {
                        vmid: vmid!,
                        ostemplate: props.template,
                        hostname: desiredHostname,
                        cores: desiredCores,
                        memory: desiredMemory,
                        storage: desiredStorage,
                        rootfs: `${desiredStorage}:${desiredDisk}`,
                        net0: defaultNet0(desiredBridge),
                        "ssh-public-keys": sshKeysStr || undefined,
                        unprivileged: true,
                        description: desc2,
                        start: desiredStart,
                      },
                      { session },
                    );
                  }),
              ),
            );

            if (desiredStart) {
              yield* waitForRunning(containerNode, vmid!);
            }

            // Re-observe after create
            observedStatus = yield* getLxcStatus(containerNode, vmid!);
            observedConfig = yield* getLxcConfig(containerNode, vmid!);
          }

          // From here vmid is definitely set
          const finalVmid = vmid!;

          // -----------------------------------------------------------
          // 3. Sync — diff observed vs desired for each mutable aspect
          // -----------------------------------------------------------

          // 3a. cores + memory
          const observedCores = observedConfig?.cores ?? desiredCores;
          const observedMemory = observedConfig?.memory ?? desiredMemory;

          if (
            observedCores !== desiredCores ||
            observedMemory !== desiredMemory
          ) {
            yield* setLxcConfig(containerNode, finalVmid, {
              cores: desiredCores,
              memory: desiredMemory,
            });
            yield* session.note(
              `Updated cores=${desiredCores} memory=${desiredMemory}`,
            );
          }

          // 3b. disk — grow only (shrink is a replace-trigger, never reaches here)
          const observedRootfs = observedConfig?.rootfs ?? "";
          const observedDiskGb = parseRootfsDiskGb(observedRootfs);
          if (observedDiskGb !== undefined && desiredDisk > observedDiskGb) {
            const growBy = desiredDisk - observedDiskGb;
            yield* resizeLxc(
              containerNode,
              finalVmid,
              { disk: "rootfs", size: `+${growBy}G` },
              { session },
            );
            yield* session.note(`Grew rootfs by ${growBy}G`);
          }

          // 3c. bridge — rewrite net0 preserving any IP assignment
          const observedNet0 = observedConfig?.net0 ?? defaultNet0(desiredBridge);
          const net0Parts = parseNet0(observedNet0);
          const observedBridge = net0Parts["bridge"];
          if (observedBridge !== desiredBridge) {
            net0Parts["bridge"] = desiredBridge;
            yield* setLxcConfig(containerNode, finalVmid, {
              net0: serializeNet0(net0Parts),
            });
            yield* session.note(`Updated bridge to ${desiredBridge}`);
          }

          // 3d. description / ownership marker — re-stamp if cleared or stale
          const observedDescription = observedConfig?.description;
          const existingMarker = parseOwnershipMarker(observedDescription);
          const markerIsCorrect =
            existingMarker &&
            existingMarker.stack === markerPayload.stack &&
            existingMarker.stage === markerPayload.stage &&
            existingMarker.id === markerPayload.id;

          if (!markerIsCorrect) {
            const newDescription = mergeDescription(
              observedDescription,
              markerBlock,
            );
            yield* setLxcConfig(containerNode, finalVmid, {
              description: newDescription,
            });
          }

          // 3e. power state
          const currentStatus =
            (yield* getLxcStatus(containerNode, finalVmid))?.status ?? "stopped";

          if (desiredStart && currentStatus === "stopped") {
            yield* startLxc(containerNode, finalVmid, { session });
            yield* waitForRunning(containerNode, finalVmid);
            yield* session.note(`Container ${finalVmid} started`);
          } else if (!desiredStart && currentStatus === "running") {
            yield* stopLxc(containerNode, finalVmid, { session });
            yield* session.note(`Container ${finalVmid} stopped`);
          }

          // -----------------------------------------------------------
          // 4. Return — read final state
          // -----------------------------------------------------------
          const finalStatus = yield* getLxcStatus(containerNode, finalVmid);
          const finalConfig = yield* getLxcConfig(containerNode, finalVmid);

          const ipv4 = desiredStart
            ? yield* waitForIpv4(containerNode, finalVmid)
            : undefined;

          return {
            vmid: finalVmid,
            hostname: finalConfig?.hostname ?? desiredHostname,
            node: containerNode,
            ipv4,
            status:
              finalStatus?.status === "running" ? "running" : ("stopped" as const),
          } satisfies ContainerAttributes;
        }),

        // -----------------------------------------------------------------
        // delete — idempotent destroy
        // -----------------------------------------------------------------
        delete: Effect.fn(function* ({ output, session }) {
          const { vmid, node } = output;
          yield* session.note(`Deleting LXC container ${vmid} on ${node}`);

          // Stop first if running, then destroy
          const status = yield* getLxcStatus(node, vmid);
          if (status?.status === "running") {
            yield* stopLxc(node, vmid, { session }).pipe(
              Effect.catchIf(
                (e): e is ProxmoxApiError | ProxmoxTaskError =>
                  e instanceof ProxmoxApiError || e instanceof ProxmoxTaskError,
                () => Effect.void,
              ),
            );
          }

          yield* destroyLxc(node, vmid, { force: true, purge: true, session });
          yield* session.note(`Container ${vmid} deleted`);
        }),
      };
    }),
  );

// ---------------------------------------------------------------------------
// Helper: parse rootfs disk size from PVE rootfs string
// ---------------------------------------------------------------------------

/**
 * PVE rootfs strings look like "local-lvm:vm-100-disk-0,size=8G" or
 * "local-lvm:8". Extract the GB value, returning undefined on parse failure.
 */
export const parseRootfsDiskGb = (rootfs: string): number | undefined => {
  const sizeMatch = rootfs.match(/size=(\d+(?:\.\d+)?)G/i);
  if (sizeMatch) return parseFloat(sizeMatch[1]);

  // Some storage types show just "pool:amount" like "local-lvm:8"
  const simpleMatch = rootfs.match(/:(\d+)$/);
  if (simpleMatch) return parseInt(simpleMatch[1], 10);

  return undefined;
};
