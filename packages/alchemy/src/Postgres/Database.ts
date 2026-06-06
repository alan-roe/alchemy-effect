import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  DEFAULT_PORT,
  PostgresError,
  type PostgresConnection,
  withAdminClient,
} from "./Connection.ts";
import type { Providers } from "./Providers.ts";
import { createInternalTags } from "../Tags.ts";
import {
  alterDatabaseOwnerSql,
  commentOnDatabaseSql,
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

const ownershipComment = Effect.fnUntraced(function* (id: string) {
  const tags = yield* createInternalTags(id);
  return `alchemy:${JSON.stringify(tags)}`;
});

/** Read database owner and ownership comment, or `undefined` if absent. */
const readDatabaseState = (conn: PostgresConnection, name: string) =>
  withAdminClient(conn, (client) =>
    client
      .query<{ owner: string; comment: string | null }>(
        "SELECT pg_catalog.pg_get_userbyid(d.datdba) AS owner, pg_catalog.shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = $1",
        [name],
      )
      .then((r) => r.rows[0]),
  );

const buildAttributes = (
  conn: PostgresConnection,
  name: string,
  owner: string,
): PostgresDatabaseAttributes => ({
  name,
  owner,
  host: conn.host,
  port: conn.port ?? DEFAULT_PORT,
});

export const PostgresDatabaseProvider = () =>
  Provider.effect(
    PostgresDatabase,
    Effect.succeed({
      diff: Effect.fn(function* ({ id, news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const newName = yield* resolveName(id, news.name);
        const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
        const newPort = news.connection.port ?? DEFAULT_PORT;
        const oldHost = output?.host ?? olds?.connection.host;
        const oldPort = output?.port ?? olds?.connection.port ?? DEFAULT_PORT;
        // The database name and server location are the identity; admin credentials are not.
        if (
          newName !== oldName ||
          news.connection.host !== oldHost ||
          newPort !== oldPort
        ) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),

      read: Effect.fn(function* ({ id, olds, output }) {
        const name = output?.name ?? (yield* resolveName(id, olds.name));
        const state = yield* readDatabaseState(olds.connection, name);
        if (state === undefined) return undefined;
        const attrs = buildAttributes(olds.connection, name, state.owner);
        if (output || state.comment === (yield* ownershipComment(id))) {
          return attrs;
        }
        return Unowned(attrs);
      }),

      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = yield* resolveName(id, news.name);
        const desiredOwner = news.owner ?? news.connection.user;
        const marker = yield* ownershipComment(id);
        const observed = yield* readDatabaseState(news.connection, name);
        if (
          observed !== undefined &&
          output === undefined &&
          observed.comment !== marker
        ) {
          return yield* Effect.fail(
            new PostgresError({
              message: `Postgres database "${name}" already exists; adopt it or change name`,
            }),
          );
        }
        yield* withAdminClient(news.connection, async (client) => {
          if (observed === undefined) {
            // CREATE DATABASE cannot run in a transaction block; issue it alone.
            await client.query(createDatabaseSql(name, { owner: news.owner }));
            await client.query(commentOnDatabaseSql(name, marker));
          } else {
            if (observed.owner !== desiredOwner) {
              await client.query(alterDatabaseOwnerSql(name, desiredOwner));
            }
            await client.query(commentOnDatabaseSql(name, marker));
          }
        });
        return buildAttributes(news.connection, name, desiredOwner);
      }),

      delete: Effect.fn(function* ({ id, olds, output }) {
        const name = output?.name ?? (yield* resolveName(id, olds?.name));
        yield* withAdminClient(olds.connection, (client) =>
          client.query(dropDatabaseSql(name)),
        );
      }),
    }),
  );
