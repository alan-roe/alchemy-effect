import { buildAppConnection } from "@/Proxmox/Postgres";
import { expect, test } from "vitest";
import * as Redacted from "effect/Redacted";

test("builds app database origin and URL", () => {
  const password = Redacted.make("p@ss/word");
  const result = buildAppConnection({
    host: "10.0.0.5",
    port: 5432,
    database: "app/db",
    user: "app role",
    password,
    ssl: true,
  });

  expect(result.origin).toEqual({
    scheme: "postgres",
    host: "10.0.0.5",
    port: 5432,
    database: "app/db",
    user: "app role",
    password,
  });
  expect(Redacted.value(result.connectionUrl)).toBe(
    "postgres://app%20role:p%40ss%2Fword@10.0.0.5:5432/app%2Fdb?sslmode=require",
  );
});
