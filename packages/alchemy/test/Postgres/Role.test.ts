import * as Postgres from "@/Postgres";
import {
  type PostgresConnection,
  withAdminClient,
} from "@/Postgres/Connection";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Postgres.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Admin connection for the throwaway test Postgres. Point at a local docker
// (`docker run -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16`) or any
// reachable instance you don't mind mutating.
const adminConnection = (): PostgresConnection => ({
  host: process.env.PG_TEST_HOST!,
  port: process.env.PG_TEST_PORT ? Number(process.env.PG_TEST_PORT) : undefined,
  user: process.env.PG_TEST_USER ?? "postgres",
  password: Redacted.make(process.env.PG_TEST_PASSWORD ?? ""),
  ssl: process.env.PG_TEST_SSL === "1",
});

// Gate on PG_TEST_HOST. Unset (CI / no DB) → all tests are no-ops.
const provider = test.provider.skipIf(!process.env.PG_TEST_HOST);

const ROLE = "alchemy_test_role";
const DB = "alchemy_test_db";
const ROLE_PW = "test_pw_123";

provider(
  "creates a role + database, the role can log in, then drops both",
  (stack) =>
    Effect.gen(function* () {
      const connection = adminConnection();
      // Clean any leftovers from a prior failed run.
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Postgres.Role("Role", {
            connection,
            name: ROLE,
            password: Redacted.make(ROLE_PW),
          });
          const db = yield* Postgres.Database("Database", {
            connection,
            name: DB,
            owner: role.name,
          });
          return { role, db };
        }),
      );

      expect(out.role.name).toBe(ROLE);
      expect(out.db.name).toBe(DB);
      expect(out.db.owner).toBe(ROLE);

      // The role exists in the catalog.
      const roleExists = yield* withAdminClient(connection, (client) =>
        client
          .query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE])
          .then((r) => (r.rowCount ?? 0) > 0),
      );
      expect(roleExists).toBe(true);

      // The database exists and is owned by the role.
      const dbOwner = yield* withAdminClient(connection, (client) =>
        client
          .query<{ owner: string }>(
            "SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
            [DB],
          )
          .then((r) => r.rows[0]?.owner),
      );
      expect(dbOwner).toBe(ROLE);

      // The freshly-created role can actually authenticate against its database.
      const whoami = yield* withAdminClient(
        {
          ...connection,
          user: ROLE,
          password: Redacted.make(ROLE_PW),
          database: DB,
        },
        (client) =>
          client
            .query<{ current_user: string }>("SELECT current_user")
            .then((r) => r.rows[0]?.current_user),
      );
      expect(whoami).toBe(ROLE);

      // Destroy drops the database first (it depends on the role), then the role.
      yield* stack.destroy();

      const roleGone = yield* withAdminClient(connection, (client) =>
        client
          .query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE])
          .then((r) => (r.rowCount ?? 0) > 0),
      );
      expect(roleGone).toBe(false);

      const dbGone = yield* withAdminClient(connection, (client) =>
        client
          .query("SELECT 1 FROM pg_database WHERE datname = $1", [DB])
          .then((r) => (r.rowCount ?? 0) > 0),
      );
      expect(dbGone).toBe(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
