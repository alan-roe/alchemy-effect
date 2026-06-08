import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
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
  ssl?: boolean;
}): string => {
  const auth = `${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}`;
  const path = encodeURIComponent(parts.database);
  const search = parts.ssl ? "?sslmode=require" : "";
  return `postgres://${auth}@${parts.host}:${parts.port}/${path}${search}`;
};

const TRANSIENT_CONNECTION_CODES = new Set<string>([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
]);

/**
 * Whether `error` is a transient connection-level failure worth retrying — a
 * refused/timed-out/reset TCP connect, not a query or auth error. Used to
 * absorb the brief window between a freshly-(re)started Postgres reporting
 * local readiness and actually accepting remote TCP.
 */
export const isTransientConnectionError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CONNECTION_CODES.has(code)) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: unknown }).message ?? "");
  return /connection terminated unexpectedly/i.test(message);
};

/**
 * Retry an admin-connection effect while it fails with a transient
 * connection-level error (see {@link isTransientConnectionError}), using
 * bounded exponential backoff. Query/auth errors are not retried — they
 * surface immediately. This absorbs the brief race between a freshly-restarted
 * Postgres reporting local readiness and accepting remote TCP.
 */
export const connectWithRetry = <A>(
  connect: Effect.Effect<A, PostgresError>,
): Effect.Effect<A, PostgresError> =>
  connect.pipe(
    Effect.retry({
      while: (error) => isTransientConnectionError(error.cause),
      schedule: Schedule.both(
        Schedule.exponential(Duration.millis(500), 1.5),
        Schedule.recurs(6),
      ),
    }),
  );

/**
 * Open a one-shot admin connection, run `fn`, and always close it. The connect
 * is retried on transient connection errors (see {@link connectWithRetry}); the
 * client is acquired/released so `fn` runs exactly once and the socket is always
 * closed even on failure. Mirrors the `withClient` idiom in `Neon/Migrations.ts`.
 */
export const withAdminClient = <A>(
  conn: PostgresConnection,
  fn: (client: Client) => Promise<A>,
): Effect.Effect<A, PostgresError> =>
  Effect.acquireUseRelease(
    connectWithRetry(
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
          return client;
        },
        catch: (cause) =>
          new PostgresError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    ),
    (client) =>
      Effect.tryPromise({
        try: () => fn(client),
        catch: (cause) =>
          new PostgresError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    (client) => Effect.promise(() => client.end().catch(() => {})),
  );
