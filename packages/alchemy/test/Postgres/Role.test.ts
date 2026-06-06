import * as Postgres from "@/Postgres";
import {
  type PostgresConnection,
  withAdminClient,
} from "@/Postgres/Connection";
import {
  commentOnRoleSql,
  commentOnDatabaseSql,
  createDatabaseSql,
  createRoleSql,
  dropDatabaseSql,
  dropRoleSql,
} from "@/Postgres/sql";
import * as Test from "@/Test/Vitest";
import { createInternalTags } from "@/Tags";
import { expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
const OWNED_RETRY_DB = "alchemy_test_owned_retry_db";
const COLLISION_ROLE = "alchemy_test_collision_role";
const COLLISION_DB = "alchemy_test_collision_db";
const COLLISION_DB_OWNER = "alchemy_test_collision_owner";
const COLLISION_DB_NEW_OWNER = "alchemy_test_collision_new_owner";

const OWNED_RETRY_ROLE = "alchemy_test_owned_retry_role";
const FOREIGN_PASSWORD_ROLE = "alchemy_test_foreign_password_role";
const LOST_STATE_ROLE = "alchemy_test_lost_state_role";

const roleOwnershipComment = Effect.fnUntraced(function* (id: string) {
  const tags = yield* createInternalTags(id);
  return `alchemy:${JSON.stringify(tags)}`;
});

const cleanupCollisionObjects = (connection: PostgresConnection) =>
  withAdminClient(connection, async (client) => {
    await client.query(dropDatabaseSql(COLLISION_DB));
    await client.query(dropDatabaseSql(OWNED_RETRY_DB));
    await client.query(dropRoleSql(COLLISION_DB_NEW_OWNER));
    await client.query(dropRoleSql(COLLISION_DB_OWNER));
    await client.query(dropRoleSql(COLLISION_ROLE));
    await client.query(dropRoleSql(LOST_STATE_ROLE));
    await client.query(dropRoleSql(FOREIGN_PASSWORD_ROLE));
    await client.query(dropRoleSql(OWNED_RETRY_ROLE));
  });

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

      const dbComment = yield* withAdminClient(connection, (client) =>
        client
          .query<{ comment: string | null }>(
            "SELECT pg_catalog.shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
            [DB],
          )
          .then((r) => r.rows[0]?.comment),
      );
      expect(dbComment).toBe(
        `alchemy:${JSON.stringify(yield* createInternalTags("Database"))}`,
      );

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

provider(
  "refuses an existing role with no recoverable password on first deploy",
  (stack) => {
    const connection = adminConnection();
    return Effect.gen(function* () {
      yield* cleanupCollisionObjects(connection);
      yield* withAdminClient(connection, (client) =>
        client.query(createRoleSql(COLLISION_ROLE, { login: true })),
      );

      const exit = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Postgres.Role("CollisionRole", {
              connection,
              name: COLLISION_ROLE,
            });
          }),
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          `Postgres role "${COLLISION_ROLE}" already exists`,
        );
      }
    }).pipe(
      Effect.ensuring(cleanupCollisionObjects(connection).pipe(Effect.ignore)),
      logLevel,
    );
  },
  { timeout: 120_000 },
);

provider(
  "recovers an owned explicit-password role after state write failure",
  (stack) => {
    const connection = adminConnection();
    return Effect.gen(function* () {
      yield* cleanupCollisionObjects(connection);
      const comment = yield* roleOwnershipComment("OwnedRetryRole");
      yield* withAdminClient(connection, async (client) => {
        await client.query(
          createRoleSql(OWNED_RETRY_ROLE, {
            login: true,
            password: ROLE_PW,
          }),
        );
        await client.query(commentOnRoleSql(OWNED_RETRY_ROLE, comment));
      });

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Postgres.Role("OwnedRetryRole", {
            connection,
            name: OWNED_RETRY_ROLE,
            password: Redacted.make(ROLE_PW),
          });
        }),
      );

      expect(out.name).toBe(OWNED_RETRY_ROLE);

      const outAgain = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Postgres.Role("OwnedRetryRole", {
            connection,
            name: OWNED_RETRY_ROLE,
            password: Redacted.make(ROLE_PW),
          });
        }),
      );
      expect(outAgain.name).toBe(OWNED_RETRY_ROLE);

      const whoami = yield* withAdminClient(
        {
          ...connection,
          user: OWNED_RETRY_ROLE,
          password: Redacted.make(ROLE_PW),
        },
        (client) =>
          client
            .query<{ current_user: string }>("SELECT current_user")
            .then((r) => r.rows[0]?.current_user),
      );
      expect(whoami).toBe(OWNED_RETRY_ROLE);
    }).pipe(
      Effect.ensuring(cleanupCollisionObjects(connection).pipe(Effect.ignore)),
      logLevel,
    );
  },
  { timeout: 120_000 },
);

provider(
  "recovers an owned existing database on first deploy",
  (stack) => {
    const connection = adminConnection();
    return Effect.gen(function* () {
      yield* cleanupCollisionObjects(connection);
      const marker = `alchemy:${JSON.stringify(
        yield* createInternalTags("OwnedRetryDatabase"),
      )}`;
      yield* withAdminClient(connection, async (client) => {
        await client.query(createDatabaseSql(OWNED_RETRY_DB));
        await client.query(commentOnDatabaseSql(OWNED_RETRY_DB, marker));
      });

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Postgres.Database("OwnedRetryDatabase", {
            connection,
            name: OWNED_RETRY_DB,
          });
        }),
      );
      expect(out.name).toBe(OWNED_RETRY_DB);
      expect(out.owner).toBe(connection.user);

      const outAgain = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Postgres.Database("OwnedRetryDatabase", {
            connection,
            name: OWNED_RETRY_DB,
          });
        }),
      );
      expect(outAgain.name).toBe(OWNED_RETRY_DB);
      expect(outAgain.owner).toBe(connection.user);
    }).pipe(
      Effect.ensuring(cleanupCollisionObjects(connection).pipe(Effect.ignore)),
      logLevel,
    );
  },
  { timeout: 120_000 },
);

provider(
  "refuses a foreign role even when an explicit password is supplied",
  (stack) => {
    const connection = adminConnection();
    return Effect.gen(function* () {
      yield* cleanupCollisionObjects(connection);
      yield* withAdminClient(connection, (client) =>
        client.query(
          createRoleSql(FOREIGN_PASSWORD_ROLE, {
            login: true,
            password: "foreign_pw_123",
          }),
        ),
      );

      const exit = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Postgres.Role("ForeignPasswordRole", {
              connection,
              name: FOREIGN_PASSWORD_ROLE,
              password: Redacted.make(ROLE_PW),
            });
          }),
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          `Postgres role "${FOREIGN_PASSWORD_ROLE}" already exists`,
        );
      }

      const whoami = yield* withAdminClient(
        {
          ...connection,
          user: FOREIGN_PASSWORD_ROLE,
          password: Redacted.make("foreign_pw_123"),
        },
        (client) =>
          client
            .query<{ current_user: string }>("SELECT current_user")
            .then((r) => r.rows[0]?.current_user),
      );
      expect(whoami).toBe(FOREIGN_PASSWORD_ROLE);
    }).pipe(
      Effect.ensuring(cleanupCollisionObjects(connection).pipe(Effect.ignore)),
      logLevel,
    );
  },
  { timeout: 120_000 },
);

provider(
  "fails clearly for lost generated-password state, then recovers with a supplied password",
  (stack) => {
    const connection = adminConnection();
    return Effect.gen(function* () {
      yield* cleanupCollisionObjects(connection);
      const comment = yield* roleOwnershipComment("LostStateRole");
      yield* withAdminClient(connection, async (client) => {
        await client.query(createRoleSql(LOST_STATE_ROLE, { login: true }));
        await client.query(commentOnRoleSql(LOST_STATE_ROLE, comment));
      });

      const exit = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Postgres.Role("LostStateRole", {
              connection,
              name: LOST_STATE_ROLE,
            });
          }),
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          `generated password cannot be recovered`,
        );
      }

      const recovered = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Postgres.Role("LostStateRole", {
            connection,
            name: LOST_STATE_ROLE,
            password: Redacted.make(ROLE_PW),
          });
        }),
      );
      expect(recovered.name).toBe(LOST_STATE_ROLE);

      const whoami = yield* withAdminClient(
        {
          ...connection,
          user: LOST_STATE_ROLE,
          password: Redacted.make(ROLE_PW),
        },
        (client) =>
          client
            .query<{ current_user: string }>("SELECT current_user")
            .then((r) => r.rows[0]?.current_user),
      );
      expect(whoami).toBe(LOST_STATE_ROLE);
    }).pipe(
      Effect.ensuring(cleanupCollisionObjects(connection).pipe(Effect.ignore)),
      logLevel,
    );
  },
  { timeout: 120_000 },
);

provider(
  "refuses an existing database instead of changing ownership on first deploy",
  (stack) => {
    const connection = adminConnection();
    return Effect.gen(function* () {
      yield* cleanupCollisionObjects(connection);
      yield* withAdminClient(connection, async (client) => {
        await client.query(createRoleSql(COLLISION_DB_OWNER, { login: false }));
        await client.query(
          createRoleSql(COLLISION_DB_NEW_OWNER, { login: false }),
        );
        await client.query(
          createDatabaseSql(COLLISION_DB, { owner: COLLISION_DB_OWNER }),
        );
      });

      const exit = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Postgres.Database("CollisionDatabase", {
              connection,
              name: COLLISION_DB,
              owner: COLLISION_DB_NEW_OWNER,
            });
          }),
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);

      const owner = yield* withAdminClient(connection, (client) =>
        client
          .query<{ owner: string }>(
            "SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
            [COLLISION_DB],
          )
          .then((r) => r.rows[0]?.owner),
      );
      expect(owner).toBe(COLLISION_DB_OWNER);
    }).pipe(
      Effect.ensuring(cleanupCollisionObjects(connection).pipe(Effect.ignore)),
      logLevel,
    );
  },
  { timeout: 120_000 },
);
