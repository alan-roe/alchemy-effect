import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { File, FileProvider } from "./File.ts";
import { Package, PackageProvider } from "./Package.ts";
import { Service, ServiceProvider } from "./Service.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Linux",
) {}

/**
 * Register the Linux resource providers (`Package`, `File`, `Service`). Like
 * `Postgres.providers()`, this carries no auth/environment layer — each resource
 * names its `host` (Proxmox node + container vmid) in props. The SSH transport
 * runs through the ambient `ChildProcessSpawner` provided by the runtime, so no
 * extra wiring is needed beyond merging this alongside `Proxmox.providers()`.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Linux from "alchemy/Linux";
 * import * as Proxmox from "alchemy/Proxmox";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Layer.mergeAll(Proxmox.providers(), Linux.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const container = yield* Proxmox.LXC.Container("db", { template });
 *     const host = { node: container.node, vmid: container.vmid };
 *     yield* Linux.Package("postgresql", { host, name: "postgresql" });
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Package, File, Service])).pipe(
    Layer.provide(PackageProvider()),
    Layer.provide(FileProvider()),
    Layer.provide(ServiceProvider()),
  );
