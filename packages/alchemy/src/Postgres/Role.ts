import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as crypto from "node:crypto";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createInternalTags } from "../Tags.ts";
import {
  buildConnectionUrl,
  DEFAULT_DATABASE,
  DEFAULT_PORT,
  PostgresError,
  type PostgresConnection,
  type PostgresOrigin,
  withAdminClient,
} from "./Connection.ts";
import type { Providers } from "./Providers.ts";
import {
  alterRoleSql,
  commentOnRoleSql,
  createRoleSql,
  dropRoleSql,
} from "./sql.ts";

/**
 * Properties for a PostgreSQL login role on a self-hosted server.
 */
export interface PostgresRoleProps {
  /** Admin connection used to create/alter the role. */
  connection: PostgresConnection;
  /**
   * Role name. Statically known (used in diff); if omitted a deterministic
   * name is generated from the stack/stage/logical id.
   */
  name?: string;
  /**
   * Login password. If omitted, a random 24-byte password is generated and
   * persisted in state.
   */
  password?: Redacted.Redacted<string>;
  /**
   * Whether the role can log in.
   * @default true
   */
  login?: boolean;
  /**
   * Whether the role may create databases.
   * @default false
   */
  createdb?: boolean;
  /**
   * Whether the role may create other roles.
   * @default false
   */
  createrole?: boolean;
  /**
   * Whether the role is a superuser.
   * @default false
   */
  superuser?: boolean;
}

/**
 * Output attributes of a deployed PostgreSQL role.
 */
export interface PostgresRoleAttributes {
  /** The role name. */
  name: string;
  /** Alias of {@link name}, for parity with managed Postgres providers. */
  username: string;
  /** The role password (Redacted). */
  password: Redacted.Redacted<string>;
  /** Server host. */
  host: string;
  /** Server port. */
  port: number;
  /** Database the connection URL targets (the maintenance database). */
  database: string;
  /** Direct connection URL for this role (Redacted). */
  connectionUrl: Redacted.Redacted<string>;
  /** Structured origin, ready to feed into Hyperdrive and friends. */
  origin: PostgresOrigin;
}

/**
 * A PostgreSQL login role on a server you control (Proxmox LXC, bare metal,
 * RDS, Docker — anything reachable over TCP). The provider connects with the
 * admin {@link PostgresRoleProps.connection} and runs idempotent DDL.
 *
 * @section Creating a Role
 * @example Role with a generated password
 * ```typescript
 * const role = yield* Postgres.Role("app", {
 *   connection: { host: container.ipv4, user: "postgres", password: adminPassword },
 * });
 * // role.connectionUrl, role.password are Redacted outputs
 * ```
 */
export type PostgresRole = Resource<
  "Postgres.Role",
  PostgresRoleProps,
  PostgresRoleAttributes,
  never,
  Providers
>;

export const PostgresRole = Resource<PostgresRole>("Postgres.Role");

const resolveName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true });

const roleState = (conn: PostgresConnection, name: string) =>
  withAdminClient(conn, (client) =>
    client
      .query<{ comment: string | null }>(
        "SELECT shobj_description(r.oid, 'pg_authid') AS comment FROM pg_roles r WHERE r.rolname = $1",
        [name],
      )
      .then((r) => r.rows[0]),
  );

const ownershipComment = Effect.fnUntraced(function* (id: string) {
  const tags = yield* createInternalTags(id);
  return `alchemy:${JSON.stringify(tags)}`;
});

const buildAttributes = (
  conn: PostgresConnection,
  name: string,
  password: Redacted.Redacted<string>,
): PostgresRoleAttributes => {
  const port = conn.port ?? DEFAULT_PORT;
  const database = conn.database ?? DEFAULT_DATABASE;
  const origin: PostgresOrigin = {
    scheme: "postgres",
    host: conn.host,
    port,
    database,
    user: name,
    password,
  };
  const url = buildConnectionUrl({
    host: conn.host,
    port,
    database,
    user: name,
    password: Redacted.value(password),
    ssl: conn.ssl,
  });
  return {
    name,
    username: name,
    password,
    host: conn.host,
    port,
    database,
    connectionUrl: Redacted.make(url),
    origin,
  };
};

export const PostgresRoleProvider = () =>
  Provider.effect(
    PostgresRole,
    Effect.succeed({
      diff: Effect.fn(function* ({ id, news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const newName = yield* resolveName(id, news.name);
        const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
        const newPort = news.connection.port ?? DEFAULT_PORT;
        const oldHost = output?.host ?? olds?.connection.host;
        const oldPort = output?.port ?? olds?.connection.port ?? DEFAULT_PORT;
        // The role name and server location are the identity; admin credentials are not.
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
        const state = yield* roleState(olds.connection, name);
        if (!state) return undefined;
        if (output) {
          return buildAttributes(olds.connection, name, output.password);
        }
        const comment = yield* ownershipComment(id);
        if (state.comment === comment) {
          if (olds.password) {
            return buildAttributes(olds.connection, name, olds.password);
          }
          return undefined;
        }
        if (olds.password) {
          return Unowned(buildAttributes(olds.connection, name, olds.password));
        }
        return yield* Effect.fail(
          new PostgresError({
            message: `Postgres role "${name}" already exists but no password is available; supply password or change name`,
          }),
        );
      }),

      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = yield* resolveName(id, news.name);
        const comment = yield* ownershipComment(id);
        const state = yield* roleState(news.connection, name);
        if (state && output === undefined) {
          if (state.comment === comment) {
            if (news.password === undefined) {
              return yield* Effect.fail(
                new PostgresError({
                  message: `Postgres role "${name}" was created by Alchemy but its generated password cannot be recovered; restore state or supply password`,
                }),
              );
            }
          } else {
            return yield* Effect.fail(
              new PostgresError({
                message: `Postgres role "${name}" already exists; supply password and adopt it or change name`,
              }),
            );
          }
        }
        // Password precedence: explicit prop > persisted state > freshly generated.
        const password =
          news.password ??
          output?.password ??
          (yield* Effect.sync(() =>
            Redacted.make(crypto.randomBytes(24).toString("base64url")),
          ));
        const opts = {
          login: news.login,
          createdb: news.createdb,
          createrole: news.createrole,
          superuser: news.superuser,
          password: Redacted.value(password),
        };
        yield* withAdminClient(news.connection, async (client) => {
          await client.query(
            state ? alterRoleSql(name, opts) : createRoleSql(name, opts),
          );
          await client.query(commentOnRoleSql(name, comment));
        });
        return buildAttributes(news.connection, name, password);
      }),

      delete: Effect.fn(function* ({ id, olds, output }) {
        const name = output?.name ?? (yield* resolveName(id, olds?.name));
        yield* withAdminClient(olds.connection, (client) =>
          client.query(dropRoleSql(name)),
        );
      }),
    }),
  );
