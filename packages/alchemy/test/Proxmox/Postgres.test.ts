import {
  buildAppConnection,
  buildHbaAppendCommand,
  buildHbaLines,
  DEFAULT_ALLOW_CIDRS,
} from "@/Proxmox/Postgres";
import { describe, expect, test } from "vitest";
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

/** True when `cidr` falls inside an RFC1918 private IPv4 range. */
const isPrivateV4Cidr = (cidr: string): boolean => {
  const [a, b] = cidr.split("/")[0].split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
};

describe("default network exposure", () => {
  test("never opens the server to the public internet by default", () => {
    expect(DEFAULT_ALLOW_CIDRS.length).toBeGreaterThan(0);
    expect(DEFAULT_ALLOW_CIDRS).not.toContain("0.0.0.0/0");
    expect(DEFAULT_ALLOW_CIDRS.every(isPrivateV4Cidr)).toBe(true);
  });
});

describe("buildHbaLines", () => {
  test("uses hostssl (TLS-enforced) rules when ssl is on", () => {
    expect(buildHbaLines(["192.168.1.0/24", "10.0.0.0/8"], true)).toEqual([
      "hostssl all all 192.168.1.0/24 scram-sha-256",
      "hostssl all all 10.0.0.0/8 scram-sha-256",
    ]);
  });

  test("falls back to plain host rules when ssl is off", () => {
    expect(buildHbaLines(["192.168.1.0/24"], false)).toEqual([
      "host all all 192.168.1.0/24 scram-sha-256",
    ]);
  });
});

describe("buildHbaAppendCommand", () => {
  test("discovers hba_file once and guards each shell-quoted rule idempotently", () => {
    const cmd = buildHbaAppendCommand(["192.168.0.0/16", "10.0.0.0/8"], true);
    // hba_file is resolved exactly once, not per rule
    expect(cmd.match(/SHOW hba_file/g)).toHaveLength(1);
    // each TLS-enforced rule is single-quoted (shell-neutralized) and appended only if absent
    expect(cmd).toContain(
      "grep -qF 'hostssl all all 192.168.0.0/16 scram-sha-256' \"$HBA\"",
    );
    expect(cmd).toContain(
      "grep -qF 'hostssl all all 10.0.0.0/8 scram-sha-256' \"$HBA\"",
    );
    expect(cmd).toContain('>> "$HBA"');
  });
});
