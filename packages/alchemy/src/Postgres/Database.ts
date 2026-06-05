import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  DEFAULT_PORT,
  type PostgresConnection,
  withAdminClient,
} from "./Connection.ts";
import type { Providers } from "./Providers.ts";
import {
  alterDatabaseOwnerSql,
  createDatabaseSql,
  dropDatabaseSql,
} from "./sql.ts";

/**
 * Properties for a PostgreSQL database on a self-hosted server.
 */
export interface PostgresDatabaseProps {
  /** Admin connection used to create/alter the database. */
  connection: PostgresConnection;
  /**
   * Database name. Statically known (used in diff); if omitted a deterministic
   * name is generated from the stack/stage/logical id.
   */
  name?: string;
  /**
   * Owning role. Accepts a role name or a `Postgres.Role`'s `name` output.
   * Defaults to the admin connection user.
   */
  owner?: string;
}

/**
 * Output attributes of a deployed PostgreSQL database.
 */
export interface PostgresDatabaseAttributes {
  /** The database name. */
  name: string;
  /** The owning role. */
  owner: string;
  /** Server host. */
  host: string;
  /** Server port. */
  port: number;
}

/**
 * A PostgreSQL database on a server you control. The provider connects with the
 * admin {@link PostgresDatabaseProps.connection} and runs idempotent DDL.
 *
 * @section Creating a Database
 * @example Database owned by a role
 * ```typescript
 * const db = yield* Postgres.Database("app", {
 *   connection: { host: container.ipv4, user: "postgres", password: adminPassword },
 *   owner: role.name,
 * });
 * ```
 */
export type PostgresDatabase = Resource<
  "Postgres.Database",
  PostgresDatabaseProps,
  PostgresDatabaseAttributes,
  never,
  Providers
>;

export const PostgresDatabase = Resource<PostgresDatabase>("Postgres.Database");

const resolveName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true });

/** Read the owner role of a database, or `undefined` if the database is absent. */
const readOwner = (conn: PostgresConnection, name: string) =>
  withAdminClient(conn, (client) =>
    client
      .query<{ owner: string }>(
        "SELECT pg_catalog.pg_get_userbyid(d.datdba) AS owner FROM pg_database d WHERE d.datname = $1",
        [name],
      )
      .then((r) => r.rows[0]?.owner),
  );

export const PostgresDatabaseProvider = () =>
  Provider.effect(
    PostgresDatabase,
    Effect.succeed({
      diff: Effect.fn(function* ({ id, news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const newName = yield* resolveName(id, news.name);
        const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
        // The database name is the identity; renaming means a new database.
        if (newName !== oldName) return { action: "replace" } as const;
        return undefined;
      }),

      read: Effect.fn(function* ({ olds, output }) {
        if (!output) return undefined;
        const owner = yield* readOwner(olds.connection, output.name);
        if (owner === undefined) return undefined;
        return {
          name: output.name,
          owner,
          host: olds.connection.host,
          port: olds.connection.port ?? DEFAULT_PORT,
        };
      }),

      reconcile: Effect.fn(function* ({ id, news }) {
        const name = yield* resolveName(id, news.name);
        const desiredOwner = news.owner ?? news.connection.user;
        const observedOwner = yield* readOwner(news.connection, name);
        yield* withAdminClient(news.connection, async (client) => {
          if (observedOwner === undefined) {
            // CREATE DATABASE cannot run in a transaction block; issue it alone.
            await client.query(createDatabaseSql(name, { owner: news.owner }));
          } else if (observedOwner !== desiredOwner) {
            await client.query(alterDatabaseOwnerSql(name, desiredOwner));
          }
        });
        return {
          name,
          owner: desiredOwner,
          host: news.connection.host,
          port: news.connection.port ?? DEFAULT_PORT,
        };
      }),

      delete: Effect.fn(function* ({ id, olds, output }) {
        const name = output?.name ?? (yield* resolveName(id, olds?.name));
        yield* withAdminClient(olds.connection, (client) =>
          client.query(dropDatabaseSql(name)),
        );
      }),
    }),
  );
