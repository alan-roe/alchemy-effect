import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { ProxmoxAuth } from "./AuthProvider.ts";
import { fromProfile } from "./Environment.ts";
import { Container, ContainerProvider } from "./LXC/Container.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Proxmox",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all Proxmox resource providers, the Proxmox
 * `AuthProvider`, and the resolved `ProxmoxEnvironment`. Include this from your
 * stack alongside other cloud `providers()` layers.
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
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Container])).pipe(
    Layer.provide(ContainerProvider()),
    Layer.provideMerge(fromProfile()),
    Layer.provideMerge(ProxmoxAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
