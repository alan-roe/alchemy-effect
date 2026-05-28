import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { ProxmoxAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { fromProfile } from "./Environment.ts";
import { Container, ContainerProvider } from "./LXC/Container.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Proxmox",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all Proxmox resource providers, the Proxmox
 * `AuthProvider`, and the resolved `Credentials`. Include this from your stack
 * alongside other cloud `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Proxmox from "alchemy/Proxmox";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Proxmox.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const container = yield* Proxmox.LXC.Container("db", {
 *       template: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst",
 *     });
 *     return { ip: container.ipv4 };
 *   }),
 * );
 * ```
 */
export const providers = () => {
  // ProxmoxEnvironment is derived from Credentials, so compose them together.
  const credentialsAndEnv = fromProfile().pipe(
    Layer.provide(Credentials.fromAuthProvider()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
  );
  return Layer.effect(Providers, Provider.collection([Container])).pipe(
    Layer.provide(ContainerProvider()),
    Layer.provideMerge(credentialsAndEnv),
    Layer.provideMerge(ProxmoxAuth),
    Layer.orDie,
  );
};
