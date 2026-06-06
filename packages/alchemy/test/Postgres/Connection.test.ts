import { buildConnectionUrl } from "@/Postgres/Connection";
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
