import {
  alterDatabaseOwnerSql,
  alterRoleSql,
  commentOnDatabaseSql,
  commentOnRoleSql,
  createDatabaseSql,
  createRoleSql,
  dropDatabaseSql,
  dropRoleSql,
  quoteIdent,
  quoteLiteral,
} from "@/Postgres/sql";
import { describe, expect, test } from "vitest";

describe("quoteIdent", () => {
  test("wraps in double quotes", () => {
    expect(quoteIdent("app")).toBe('"app"');
  });

  test("doubles embedded double quotes to neutralize injection", () => {
    // A name trying to break out of the identifier and inject DDL stays inert:
    // the closing quote is doubled, so the whole thing remains one identifier.
    expect(quoteIdent('x"; DROP DATABASE prod; --')).toBe(
      '"x""; DROP DATABASE prod; --"',
    );
  });

  test("preserves case (always quotes)", () => {
    expect(quoteIdent("MixedCase")).toBe('"MixedCase"');
  });
});

describe("quoteLiteral", () => {
  test("wraps in single quotes", () => {
    expect(quoteLiteral("hunter2")).toBe("'hunter2'");
  });

  test("doubles embedded single quotes to neutralize injection", () => {
    // A password trying to terminate the literal and append SQL is neutralized.
    expect(quoteLiteral("a'; DROP ROLE admin; --")).toBe(
      "'a''; DROP ROLE admin; --'",
    );
  });
});

describe("createRoleSql", () => {
  test("renders default options as a login role with no extra privileges", () => {
    expect(createRoleSql("app", {})).toBe(
      'CREATE ROLE "app" WITH LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER',
    );
  });

  test("includes a quoted password literal when provided", () => {
    expect(createRoleSql("app", { password: "s3cret" })).toBe(
      "CREATE ROLE \"app\" WITH LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD 's3cret'",
    );
  });

  test("omits PASSWORD entirely when no password is given", () => {
    expect(createRoleSql("app", {})).not.toContain("PASSWORD");
  });

  test("maps privilege flags to keywords", () => {
    expect(
      createRoleSql("admin", {
        login: false,
        createdb: true,
        createrole: true,
        superuser: true,
      }),
    ).toBe('CREATE ROLE "admin" WITH NOLOGIN CREATEDB CREATEROLE SUPERUSER');
  });

  test("a hostile role name + password cannot escape the statement", () => {
    const sql = createRoleSql('ro"le', { password: "p'w" });
    expect(sql).toBe(
      "CREATE ROLE \"ro\"\"le\" WITH LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD 'p''w'",
    );
  });
});

describe("alterRoleSql", () => {
  test("renders ALTER ROLE with options and password", () => {
    expect(alterRoleSql("app", { createdb: true, password: "new" })).toBe(
      "ALTER ROLE \"app\" WITH LOGIN CREATEDB NOCREATEROLE NOSUPERUSER PASSWORD 'new'",
    );
  });
});

describe("dropRoleSql", () => {
  test("is idempotent via IF EXISTS", () => {
    expect(dropRoleSql("app")).toBe('DROP ROLE IF EXISTS "app"');
  });
});

describe("commentOnRoleSql", () => {
  test("quotes role names and comments", () => {
    expect(commentOnRoleSql('ro"le', "alchemy:'owned'")).toBe(
      "COMMENT ON ROLE \"ro\"\"le\" IS 'alchemy:''owned'''",
    );
  });
});

describe("createDatabaseSql", () => {
  test("renders without an owner", () => {
    expect(createDatabaseSql("appdb")).toBe('CREATE DATABASE "appdb"');
  });

  test("renders with a quoted owner", () => {
    expect(createDatabaseSql("appdb", { owner: "app" })).toBe(
      'CREATE DATABASE "appdb" OWNER "app"',
    );
  });
});

describe("alterDatabaseOwnerSql", () => {
  test("reassigns owner", () => {
    expect(alterDatabaseOwnerSql("appdb", "app")).toBe(
      'ALTER DATABASE "appdb" OWNER TO "app"',
    );
  });
});

describe("commentOnDatabaseSql", () => {
  test("quotes database names and comments", () => {
    expect(commentOnDatabaseSql('app"db', "alchemy:'owned'")).toBe(
      "COMMENT ON DATABASE \"app\"\"db\" IS 'alchemy:''owned'''",
    );
  });
});

describe("dropDatabaseSql", () => {
  test("is idempotent via IF EXISTS", () => {
    expect(dropDatabaseSql("appdb")).toBe('DROP DATABASE IF EXISTS "appdb"');
  });
});
