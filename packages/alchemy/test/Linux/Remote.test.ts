import { buildSshArgs, quoteArg, type RemoteHost } from "@/Linux/Remote";
import { describe, expect, test } from "vitest";

const host: RemoteHost = { node: "pve", vmid: 133 };

describe("quoteArg", () => {
  test("wraps a plain token in single quotes", () => {
    expect(quoteArg("postgresql")).toBe("'postgresql'");
  });

  test("escapes embedded single quotes to neutralize injection", () => {
    // The classic break-out attempt: a value that closes the quote and injects
    // a command must come back fully neutralized as a single shell token.
    expect(quoteArg("a'; rm -rf /; '")).toBe("'a'\\''; rm -rf /; '\\'''");
  });

  test("quotes the empty string", () => {
    expect(quoteArg("")).toBe("''");
  });
});

describe("buildSshArgs", () => {
  test("defaults to root@node with batch + host-key options", () => {
    expect(buildSshArgs(host, "echo hi")).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "root@pve",
      "pct exec 133 -- sh -c 'echo hi'",
    ]);
  });

  test("prepends -i when an identity file is given", () => {
    const args = buildSshArgs({ ...host, identity: "/keys/id" }, "echo hi");
    expect(args.slice(0, 2)).toEqual(["-i", "/keys/id"]);
  });

  test("adds -p and honors a custom user", () => {
    const args = buildSshArgs({ ...host, user: "ops", port: 2222 }, "echo hi");
    expect(args).toContain("ops@pve");
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  test("the remote command is a single argv element, quoted for the node shell", () => {
    // A command containing single quotes must survive both the node login
    // shell and the container's `sh -c` as one ssh argument.
    const args = buildSshArgs(host, "echo 'a'");
    expect(args).toHaveLength(6);
    expect(args.at(-1)).toBe("pct exec 133 -- sh -c 'echo '\\''a'\\'''");
  });
});
