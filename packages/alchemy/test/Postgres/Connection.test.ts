import {
  buildConnectionUrl,
  connectWithRetry,
  isTransientConnectionError,
  PostgresError,
} from "@/Postgres/Connection";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

describe("buildConnectionUrl", () => {
  test("encodes user, password, and database path segment", () => {
    expect(
      buildConnectionUrl({
        host: "db.example.test",
        port: 5432,
        database: "app/db name",
        user: "app user",
        password: "p@ss/w:rd",
      }),
    ).toBe(
      "postgres://app%20user:p%40ss%2Fw%3Ard@db.example.test:5432/app%2Fdb%20name",
    );
  });

  test("requires sslmode when TLS is enabled", () => {
    expect(
      buildConnectionUrl({
        host: "db.example.test",
        port: 5432,
        database: "postgres",
        user: "postgres",
        password: "secret",
        ssl: true,
      }),
    ).toBe(
      "postgres://postgres:secret@db.example.test:5432/postgres?sslmode=require",
    );
  });
});

describe("isTransientConnectionError", () => {
  test("classifies network connection failures as retryable", () => {
    for (const code of [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ECONNRESET",
      "EHOSTUNREACH",
    ]) {
      expect(isTransientConnectionError({ code })).toBe(true);
    }
  });

  test("classifies a mid-connect drop with no code as retryable", () => {
    expect(
      isTransientConnectionError(
        new Error("Connection terminated unexpectedly"),
      ),
    ).toBe(true);
  });

  test("does not retry real database errors or non-errors", () => {
    // SQLSTATE query/constraint + auth errors must surface immediately
    expect(
      isTransientConnectionError({
        code: "42710",
        message: 'role "x" already exists',
      }),
    ).toBe(false);
    expect(
      isTransientConnectionError({
        code: "28P01",
        message: "password authentication failed",
      }),
    ).toBe(false);
    expect(
      isTransientConnectionError(new Error("syntax error at or near")),
    ).toBe(false);
    // non-error / nullish inputs never crash and are not retryable
    expect(isTransientConnectionError(undefined)).toBe(false);
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError("ECONNREFUSED")).toBe(false);
    expect(isTransientConnectionError({})).toBe(false);
  });
});

describe("connectWithRetry", () => {
  test("survives a transient connection failure and then succeeds", async () => {
    let attempts = 0;
    const flaky = Effect.suspend(() => {
      attempts++;
      // The PostgresError's own message is non-matching; only its `cause` is
      // transient, so succeeding proves the policy inspects `error.cause`.
      return attempts === 1
        ? Effect.fail(
            new PostgresError({
              message: "admin connect failed",
              cause: { code: "ECONNREFUSED" },
            }),
          )
        : Effect.succeed("connected");
    });

    const result = await Effect.runPromise(connectWithRetry(flaky));
    expect(result).toBe("connected");
  });
});
