import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Client } from "pg";

/**
 * Admin connection used by the self-hosted Postgres resources to run DDL
 * (`CREATE ROLE`, `CREATE DATABASE`, ...). Every field is plain here; because
 * the Resource constructor wraps props in `Input`, callers may still pass
 * Outputs — e.g. `host: container.ipv4` or a generated `password` secret.
 */
export interface PostgresConnection {
  /** Host or IP of the Postgres server. */
  host: string;
  /**
   * TCP port.
   * @default 5432
   */
  port?: number;
  /**
   * Maintenance database to connect to for running DDL. Role/database
   * statements do not run against this db; it is only the entry point.
   * @default "postgres"
   */
  database?: string;
  /** Admin role with privileges to create roles/databases (e.g. `postgres`). */
  user: string;
  /** Admin role password. */
  password: Redacted.Redacted<string>;
  /**
   * Whether to use TLS. When `true`, the server cert is not verified
   * (homelab default). When `false`, plain TCP.
   * @default false
   */
  ssl?: boolean;
}

/**
 * Structured connection origin, shaped for `Cloudflare.Hyperdrive` and other
 * Postgres consumers. Mirrors the managed providers' `origin` output.
 */
export type PostgresOrigin = {
  scheme: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
};

export class PostgresError extends Data.TaggedError("PostgresError")<{
  message: string;
  cause?: unknown;
}> {}

/** Default Postgres TCP port, applied when `PostgresConnection.port` is unset. */
export const DEFAULT_PORT = 5432;

/** Default maintenance database, applied when `PostgresConnection.database` is unset. */
export const DEFAULT_DATABASE = "postgres";

/** Build a `postgres://user:pass@host:port/database` URL with encoded parts. */
export const buildConnectionUrl = (parts: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): string => {
  const auth = `${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}`;
  return `postgres://${auth}@${parts.host}:${parts.port}/${parts.database}`;
};

/**
 * Open a one-shot admin connection, run `fn`, and always close it. Mirrors the
 * `withClient` idiom in `Neon/Migrations.ts` — a fresh client per lifecycle
 * operation, wrapped in `Effect.tryPromise` so the pg Promise API participates
 * in the Effect runtime.
 */
export const withAdminClient = <A>(
  conn: PostgresConnection,
  fn: (client: Client) => Promise<A>,
): Effect.Effect<A, PostgresError> =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client({
        host: conn.host,
        port: conn.port ?? DEFAULT_PORT,
        database: conn.database ?? DEFAULT_DATABASE,
        user: conn.user,
        password: Redacted.value(conn.password),
        ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
      });
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.end().catch(() => {});
      }
    },
    catch: (cause) =>
      new PostgresError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
