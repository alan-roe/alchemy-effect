import * as Linux from "@/Linux";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as crypto from "node:crypto";

const { test } = Test.make({ providers: Linux.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The target is a real, reachable Linux box managed via SSH + `pct exec`.
// Point at a running Proxmox LXC: LINUX_TEST_NODE is the node's SSH host and
// LINUX_TEST_VMID the container id. Unset → all tests are no-ops.
const testHost = (): Linux.RemoteHost => ({
  node: process.env.LINUX_TEST_NODE!,
  vmid: Number(process.env.LINUX_TEST_VMID),
  user: process.env.LINUX_TEST_USER,
  identity: process.env.LINUX_TEST_IDENTITY,
});

const provider = test.provider.skipIf(
  !process.env.LINUX_TEST_NODE || !process.env.LINUX_TEST_VMID,
);

provider(
  "installs, observes, and removes an apt package",
  (stack) =>
    Effect.gen(function* () {
      const host = testHost();
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const pkg = yield* Linux.Package("Hello", { host, name: "hello" });
          return { pkg };
        }),
      );
      expect(out.pkg.name).toBe("hello");
      expect(out.pkg.version).toMatch(/\d/);

      // The installed binary actually runs inside the container.
      const run = yield* Linux.Remote.exec(host, "hello");
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("Hello, world!");

      yield* stack.destroy();

      const after = yield* Linux.Remote.exec(
        host,
        "dpkg-query -W -f='${Status}' hello",
      );
      expect(after.stdout.includes("install ok installed")).toBe(false);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

provider(
  "writes, updates, and removes a file",
  (stack) =>
    Effect.gen(function* () {
      const host = testHost();
      const path = "/tmp/alchemy-linux-test/app.conf";
      const contentA = "alchemy linux file test\nv1\n";
      const contentB = "alchemy linux file test\nv2 updated\n";
      yield* stack.destroy();

      const hashA = yield* Effect.sync(() =>
        crypto.createHash("sha256").update(contentA).digest("hex"),
      );
      const out1 = yield* stack.deploy(
        Effect.gen(function* () {
          const file = yield* Linux.File("Conf", {
            host,
            path,
            content: contentA,
            mode: "0600",
          });
          return { file };
        }),
      );
      expect(out1.file.path).toBe(path);
      // The provider's stored hash is the container's own sha256sum, so this
      // also asserts the local and remote hashes agree byte-for-byte.
      expect(out1.file.hash).toBe(hashA);
      expect(out1.file.mode).toBe("600");

      const read1 = yield* Linux.Remote.exec(
        host,
        `cat ${Linux.Remote.quoteArg(path)}`,
      );
      expect(read1.stdout).toBe(contentA);

      // Re-deploy with new content (shared scratch state → update path).
      const hashB = yield* Effect.sync(() =>
        crypto.createHash("sha256").update(contentB).digest("hex"),
      );
      const out2 = yield* stack.deploy(
        Effect.gen(function* () {
          const file = yield* Linux.File("Conf", {
            host,
            path,
            content: contentB,
            mode: "0600",
          });
          return { file };
        }),
      );
      expect(out2.file.hash).toBe(hashB);

      const read2 = yield* Linux.Remote.exec(
        host,
        `cat ${Linux.Remote.quoteArg(path)}`,
      );
      expect(read2.stdout).toBe(contentB);

      yield* stack.destroy();

      const after = yield* Linux.Remote.exec(
        host,
        `test -f ${Linux.Remote.quoteArg(path)}; echo gone:$?`,
      );
      expect(after.stdout.trim()).toBe("gone:1");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

provider(
  "enables, starts, and stops a systemd unit",
  (stack) =>
    Effect.gen(function* () {
      const host = testHost();
      const unitPath = "/etc/systemd/system/alchemy-test.service";
      const unitBody = [
        "[Unit]",
        "Description=Alchemy test unit",
        "[Service]",
        "Type=oneshot",
        "RemainAfterExit=yes",
        "ExecStart=/bin/true",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n");

      // Install the unit out-of-band so the Service resource has something to
      // manage; the unit file itself is not what's under test here.
      yield* Linux.Remote.execOrFail(
        host,
        `cat > ${Linux.Remote.quoteArg(unitPath)} && systemctl daemon-reload`,
        { stdin: unitBody },
      );
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const svc = yield* Linux.Service("Svc", {
            host,
            name: "alchemy-test",
            enabled: true,
            running: true,
          });
          return { svc };
        }),
      );
      expect(out.svc.enabled).toBe(true);
      expect(out.svc.active).toBe(true);

      const active = yield* Linux.Remote.exec(
        host,
        "systemctl is-active alchemy-test",
      );
      expect(active.stdout.trim()).toBe("active");
      const enabled = yield* Linux.Remote.exec(
        host,
        "systemctl is-enabled alchemy-test",
      );
      expect(enabled.stdout.trim()).toBe("enabled");

      yield* stack.destroy();

      const afterActive = yield* Linux.Remote.exec(
        host,
        "systemctl is-active alchemy-test",
      );
      expect(afterActive.stdout.trim()).not.toBe("active");

      yield* Linux.Remote.execOrFail(
        host,
        `rm -f ${Linux.Remote.quoteArg(unitPath)} && systemctl daemon-reload`,
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);
