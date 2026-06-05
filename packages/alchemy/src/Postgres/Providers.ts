import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { PostgresDatabase, PostgresDatabaseProvider } from "./Database.ts";
import { PostgresRole, PostgresRoleProvider } from "./Role.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Postgres",
) {}

/**
 * Register the self-hosted Postgres resource providers. Unlike cloud
 * `providers()`, this needs no auth/environment layer — each resource carries
 * its admin connection in props. Merge it into a stack alongside the provider
 * that owns the server, e.g. `Proxmox.providers()`.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Postgres from "alchemy/Postgres";
 * import * as Proxmox from "alchemy/Proxmox";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Layer.mergeAll(Proxmox.providers(), Postgres.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const role = yield* Postgres.Role("app", { connection });
 *     const db = yield* Postgres.Database("app", { connection, owner: role.name });
 *     return { url: role.connectionUrl };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([PostgresRole, PostgresDatabase]),
  ).pipe(
    Layer.provide(PostgresRoleProvider()),
    Layer.provide(PostgresDatabaseProvider()),
  );
