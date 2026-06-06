import { File as LinuxFile, FileProvider, type FileProps } from "@/Linux/File";
import {
  Package as LinuxPackage,
  PackageProvider,
  type PackageProps,
} from "@/Linux/Package";
import type { RemoteHost } from "@/Linux/Remote";
import {
  Service as LinuxService,
  ServiceProvider,
  type ServiceProps,
} from "@/Linux/Service";
import * as Provider from "@/Provider";
import type { ProviderService } from "@/Provider";
import { expect, test } from "vitest";
import * as Effect from "effect/Effect";

type DiffProvider = ProviderService<any, any, any, any, any, any, any, any>;

const host: RemoteHost = { node: "pve-a", vmid: 101 };
const explicitDefaultHost: RemoteHost = {
  node: "pve-a",
  vmid: 101,
  user: "root",
  port: 22,
};

const targetHostChanges: RemoteHost[] = [
  { node: "pve-b", vmid: 101 },
  { node: "pve-a", vmid: 102 },
];

const accessHostChanges: RemoteHost[] = [
  explicitDefaultHost,
  { node: "pve-a", vmid: 101, user: "ops" },
  { node: "pve-a", vmid: 101, port: 2222 },
  { node: "pve-a", vmid: 101, identity: "/keys/other" },
];

const runTestEffect = <A>(effect: Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(effect);

const loadProvider = (resourceType: string, layer: unknown) =>
  runTestEffect(
    Effect.gen(function* () {
      return yield* Provider.Provider<any>(resourceType);
    }).pipe(Effect.provide(layer as any)) as unknown as Effect.Effect<
      DiffProvider,
      unknown,
      never
    >,
  );

const runDiff = (provider: DiffProvider, olds: unknown, news: unknown) => {
  if (provider.diff === undefined) {
    throw new Error("Provider does not implement diff");
  }

  return runTestEffect(
    provider.diff({
      id: "resource",
      instanceId: "test",
      olds,
      news,
      oldBindings: [],
      newBindings: [],
      output: undefined,
    }) as unknown as Effect.Effect<unknown, unknown, never>,
  );
};

test("Linux.File replaces only when the managed file target changes", async () => {
  const provider = await loadProvider(LinuxFile.Type, FileProvider());
  const olds: FileProps = { host, path: "/etc/example", content: "old" };

  await expect(
    runDiff(provider, olds, {
      ...olds,
      path: "/etc/other",
    } satisfies FileProps),
  ).resolves.toEqual({ action: "replace" });

  for (const changedHost of targetHostChanges) {
    await expect(
      runDiff(provider, olds, {
        ...olds,
        host: changedHost,
      } satisfies FileProps),
    ).resolves.toEqual({ action: "replace" });
  }

  for (const changedHost of accessHostChanges) {
    await expect(
      runDiff(provider, olds, {
        ...olds,
        host: changedHost,
        content: "new",
      } satisfies FileProps),
    ).resolves.toBeUndefined();
  }
});

test("Linux.Package replaces only when the managed package target changes", async () => {
  const provider = await loadProvider(LinuxPackage.Type, PackageProvider());
  const olds: PackageProps = { host, name: "postgresql" };

  await expect(
    runDiff(provider, olds, {
      ...olds,
      name: "nginx",
    } satisfies PackageProps),
  ).resolves.toEqual({ action: "replace" });

  for (const changedHost of targetHostChanges) {
    await expect(
      runDiff(provider, olds, {
        ...olds,
        host: changedHost,
      } satisfies PackageProps),
    ).resolves.toEqual({ action: "replace" });
  }

  for (const changedHost of accessHostChanges) {
    await expect(
      runDiff(provider, olds, {
        ...olds,
        host: changedHost,
      } satisfies PackageProps),
    ).resolves.toBeUndefined();
  }
});

test("Linux.Service replaces only when the managed service target changes", async () => {
  const provider = await loadProvider(LinuxService.Type, ServiceProvider());
  const olds: ServiceProps = { host, name: "postgresql" };

  await expect(
    runDiff(provider, olds, {
      ...olds,
      name: "nginx",
    } satisfies ServiceProps),
  ).resolves.toEqual({ action: "replace" });

  for (const changedHost of targetHostChanges) {
    await expect(
      runDiff(provider, olds, {
        ...olds,
        host: changedHost,
      } satisfies ServiceProps),
    ).resolves.toEqual({ action: "replace" });
  }

  for (const changedHost of accessHostChanges) {
    await expect(
      runDiff(provider, olds, {
        ...olds,
        host: changedHost,
        restartTrigger: "changed",
      } satisfies ServiceProps),
    ).resolves.toBeUndefined();
  }
});
