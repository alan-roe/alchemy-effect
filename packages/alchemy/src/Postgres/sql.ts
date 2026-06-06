/**
 * Pure SQL rendering helpers for the self-hosted Postgres resources.
 *
 * PostgreSQL DDL (`CREATE ROLE`, `CREATE DATABASE`, ...) cannot be
 * parameterized — names and the role password must be interpolated into the
 * statement text. The password still rides the encrypted pg wire protocol (not
 * a shell argv), but the statement text itself must be injection-safe, so every
 * identifier and literal goes through the quoting helpers below.
 *
 * These mirror PostgreSQL's own `quote_ident` / `quote_literal`. They are kept
 * pure (no `pg` import, no Effect) so they can be exhaustively unit-tested.
 */

/**
 * Quote a SQL identifier (role name, database name, ...) by wrapping it in
 * double quotes and doubling any embedded double quotes. Always quotes, so
 * mixed-case names and reserved words round-trip correctly.
 */
export const quoteIdent = (name: string): string =>
  `"${name.replace(/"/g, '""')}"`;

/**
 * Quote a SQL string literal by wrapping it in single quotes and doubling any
 * embedded single quotes. Assumes `standard_conforming_strings = on` (the
 * PostgreSQL default since 9.1), under which backslashes are literal.
 */
export const quoteLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

/** Boolean role attributes that map 1:1 to `CREATE/ALTER ROLE` keywords. */
export interface RoleOptions {
  /** Whether the role can log in. @default true */
  login?: boolean;
  /** Whether the role may create databases. @default false */
  createdb?: boolean;
  /** Whether the role may create other roles. @default false */
  createrole?: boolean;
  /** Whether the role is a superuser. @default false */
  superuser?: boolean;
}

const roleOptionKeywords = (opts: RoleOptions): string[] => [
  opts.login === false ? "NOLOGIN" : "LOGIN",
  opts.createdb ? "CREATEDB" : "NOCREATEDB",
  opts.createrole ? "CREATEROLE" : "NOCREATEROLE",
  opts.superuser ? "SUPERUSER" : "NOSUPERUSER",
];

/**
 * Render `CREATE ROLE <name> WITH <options> [PASSWORD <literal>]`.
 * Omitting `password` produces a role with no password set.
 */
export const createRoleSql = (
  name: string,
  opts: RoleOptions & { password?: string },
): string => {
  const parts = roleOptionKeywords(opts);
  if (opts.password !== undefined) {
    parts.push(`PASSWORD ${quoteLiteral(opts.password)}`);
  }
  return `CREATE ROLE ${quoteIdent(name)} WITH ${parts.join(" ")}`;
};

/**
 * Render `ALTER ROLE <name> WITH <options> [PASSWORD <literal>]`, used to
 * converge an existing role's attributes/password to the desired state.
 */
export const alterRoleSql = (
  name: string,
  opts: RoleOptions & { password?: string },
): string => {
  const parts = roleOptionKeywords(opts);
  if (opts.password !== undefined) {
    parts.push(`PASSWORD ${quoteLiteral(opts.password)}`);
  }
  return `ALTER ROLE ${quoteIdent(name)} WITH ${parts.join(" ")}`;
};

/** Render `DROP ROLE IF EXISTS <name>` (idempotent). */
export const dropRoleSql = (name: string): string =>
  `DROP ROLE IF EXISTS ${quoteIdent(name)}`;

/** Render `COMMENT ON ROLE <name> IS <comment>`. */
export const commentOnRoleSql = (name: string, comment: string): string =>
  `COMMENT ON ROLE ${quoteIdent(name)} IS ${quoteLiteral(comment)}`;

/**
 * Render `CREATE DATABASE <name> [OWNER <owner>]`. `CREATE DATABASE` cannot run
 * inside a transaction block, so the provider issues it on its own.
 */
export const createDatabaseSql = (
  name: string,
  opts: { owner?: string } = {},
): string => {
  const suffix =
    opts.owner !== undefined ? ` OWNER ${quoteIdent(opts.owner)}` : "";
  return `CREATE DATABASE ${quoteIdent(name)}${suffix}`;
};

/** Render `ALTER DATABASE <name> OWNER TO <owner>`. */
export const alterDatabaseOwnerSql = (name: string, owner: string): string =>
  `ALTER DATABASE ${quoteIdent(name)} OWNER TO ${quoteIdent(owner)}`;

/** Render `COMMENT ON DATABASE <name> IS <comment>`. */
export const commentOnDatabaseSql = (name: string, comment: string): string =>
  `COMMENT ON DATABASE ${quoteIdent(name)} IS ${quoteLiteral(comment)}`;

/** Render `DROP DATABASE IF EXISTS <name>` (idempotent). */
export const dropDatabaseSql = (name: string): string =>
  `DROP DATABASE IF EXISTS ${quoteIdent(name)}`;
