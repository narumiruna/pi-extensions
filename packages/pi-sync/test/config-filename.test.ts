import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
  activeLocalConfigPath,
  consumeLocalConfigMigrationNotice,
  createLocalConfigDocument,
  legacyLocalConfigPath,
  localConfigPath,
  quarantineAndRemoveConfigIfMatches,
  readActiveLocalConfigDocumentForRepair,
  readMigratingLocalConfigDocument,
  withConfigFilePublicationForTest,
  withConfigPublicationReadyHookForTest,
  withConfigQuarantinedHookForTest,
  withConfigReplacementInstalledHookForTest,
  withLocalConfigFileLock,
  withMissingConfigReadProbeHookForTest,
} from "../src/settings/config-file.js";
import { readLocalConfigObject, updateLocalConfig, writeLocalConfigObject } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

test("missing pi-sync settings load without materializing the agent directory", async () => {
  await withTempHome(async (agentDir) => {
    assert.equal(existsSync(agentDir), false);
    assert.equal(await readLocalConfigObject(), undefined);
    assert.equal(existsSync(agentDir), false);
  });
});

test("missing pi-sync read fast paths wait for an existing first-save mutation lock", async () => {
  const cases: Array<{
    name: string;
    read: () => Promise<unknown>;
    verify: (result: unknown) => void;
  }> = [
    {
      name: "active path",
      read: () => activeLocalConfigPath(),
      verify: (result: unknown) => assert.equal(result, localConfigPath()),
    },
    {
      name: "repair read",
      read: () => readActiveLocalConfigDocumentForRepair(),
      verify: (result: unknown) =>
        assert.equal((result as { parsed?: { version?: number } } | undefined)?.parsed?.version, 3),
    },
    {
      name: "migrating read",
      read: () => readMigratingLocalConfigDocument(validateSettingsDocument),
      verify: (result: unknown) =>
        assert.equal((result as { parsed?: { version?: number } } | undefined)?.parsed?.version, 3),
    },
  ];

  for (const readCase of cases) {
    await withTempHome(async () => {
      let reportLockHeld = () => {};
      let releaseLock = () => {};
      const lockHeld = new Promise<void>((resolve) => {
        reportLockHeld = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const blocker = withLocalConfigFileLock(async () => {
        reportLockHeld();
        await release;
      });
      await lockHeld;

      let reportMissingProbe = () => {};
      let resumeMissingProbe = () => {};
      const missingProbeReached = new Promise<void>((resolve) => {
        reportMissingProbe = resolve;
      });
      const resumeProbe = new Promise<void>((resolve) => {
        resumeMissingProbe = resolve;
      });
      let settled = false;
      const read = withMissingConfigReadProbeHookForTest(async () => {
        reportMissingProbe();
        await resumeProbe;
      }, readCase.read).finally(() => {
        settled = true;
      });
      await missingProbeReached;
      resumeMissingProbe();
      writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settledBeforeSaveReleased = settled;
      releaseLock();
      await blocker;
      const result = await read;

      assert.equal(settledBeforeSaveReleased, false, `${readCase.name} did not wait for the first save`);
      readCase.verify(result);
    });
  }
});

test("exclusive first publication preserves settings raced in at the publication boundary", async () => {
  await withTempHome(async (agentDir) => {
    const concurrent = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "concurrent" }))}\n`);
    await assert.rejects(
      withConfigPublicationReadyHookForTest(
        async () => {
          writeFileSync(localConfigPath(), concurrent, { mode: 0o600 });
        },
        () => createLocalConfigDocument(v3S3Settings({ path: "first-save" })),
      ),
      /created concurrently/u,
    );
    assert.deepEqual(readFileSync(localConfigPath()), concurrent);
    assert.equal(
      readdirSync(agentDir).some((name) => name.endsWith(".migrate")),
      false,
    );
  });
});

test("failed replacement retains quarantine without replacing raced-in settings", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "before" }))}\n`);
    const concurrent = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "concurrent" }))}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    await assert.rejects(
      withConfigFilePublicationForTest(
        async (_source, destination) => {
          writeFileSync(destination, concurrent, { mode: 0o600 });
          throw Object.assign(new Error("concurrent publication"), { code: "EEXIST" });
        },
        () => updateLocalConfig((settings) => ({ ...settings, onSwitch: "switch-only" })),
      ),
      /changed concurrently/u,
    );
    assert.deepEqual(readFileSync(localConfigPath()), concurrent);
    const quarantines = readdirSync(agentDir).filter((name) => name.endsWith(".schema-migration-source"));
    assert.equal(quarantines.length, 1);
    assert.deepEqual(readFileSync(path.join(agentDir, quarantines[0])), before);
  });
});

test("quarantine cleanup never restores over settings raced in after removal", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "before" }))}\n`);
    const changedQuarantine = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "changed-quarantine" }))}\n`);
    const concurrent = Buffer.from(`${JSON.stringify(v3S3Settings({ path: "concurrent" }))}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const identity = statSync(localConfigPath());
    const removed = await withConfigQuarantinedHookForTest(
      async () => {
        const quarantine = readdirSync(agentDir).find((name) => name.endsWith(".migration-retired"));
        assert.ok(quarantine);
        writeFileSync(path.join(agentDir, quarantine), changedQuarantine, { mode: 0o600 });
        writeFileSync(localConfigPath(), concurrent, { mode: 0o600 });
      },
      () => quarantineAndRemoveConfigIfMatches(localConfigPath(), { dev: identity.dev, ino: identity.ino }, before),
    );
    assert.equal(removed, false);
    assert.deepEqual(readFileSync(localConfigPath()), concurrent);
    const quarantines = readdirSync(agentDir).filter((name) => name.endsWith(".migration-retired"));
    assert.equal(quarantines.length, 1);
    assert.deepEqual(readFileSync(path.join(agentDir, quarantines[0])), changedQuarantine);
  });
});

test("pi-sync uses the canonical private settings filename", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    await writeLocalConfigObject(v3S3Settings());
    assert.equal(existsSync(localConfigPath()), true);
    assert.equal(path.basename(localConfigPath()), "pi-sync.json");
    if (process.platform !== "win32") {
      assert.equal(statSync(localConfigPath()).mode & 0o777, 0o600);
    }
  });
});

test("a private legacy filename containing version 3 bytes migrates without reinterpretation", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const bytes = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(legacyLocalConfigPath(), bytes, { mode: 0o600 });
    assert.equal((await readLocalConfigObject())?.version, 3);
    assert.deepEqual(readFileSync(localConfigPath()), bytes);
    assert.deepEqual(readFileSync(legacyLocalConfigPath()), bytes);
    assert.match(consumeLocalConfigMigrationNotice() ?? "", /recovery copy/u);
  });
});

test("canonical settings take precedence over a retained legacy recovery copy", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const canonical = v3S3Settings({ path: "canonical/home" });
    const legacy = v3S3Settings({ path: "legacy/home" });
    writeFileSync(localConfigPath(), JSON.stringify(canonical), { mode: 0o600 });
    writeFileSync(legacyLocalConfigPath(), JSON.stringify(legacy), { mode: 0o600 });
    assert.equal((await readLocalConfigObject())?.syncSetups.home.storage.path, "canonical/home");
    assert.equal(existsSync(legacyLocalConfigPath()), true);
  });
});

test("malformed, unsupported, and symlinked settings are never overwritten", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const malformed = Buffer.from('{"version":3');
    writeFileSync(localConfigPath(), malformed, { mode: 0o600 });
    await assert.rejects(readLocalConfigObject(), /Invalid JSON/u);
    assert.deepEqual(readFileSync(localConfigPath()), malformed);

    const unsupported = Buffer.from('{"version":2,"secret":"hidden"}\n');
    writeFileSync(localConfigPath(), unsupported, { mode: 0o600 });
    await assert.rejects(readLocalConfigObject(), /version 3 is required/u);
    assert.deepEqual(readFileSync(localConfigPath()), unsupported);
  });

  if (process.platform !== "win32") {
    await withTempHome(async (agentDir) => {
      mkdirSync(agentDir, { recursive: true });
      const outside = path.join(path.dirname(agentDir), "outside.json");
      writeFileSync(outside, JSON.stringify(v3S3Settings()), { mode: 0o600 });
      symlinkSync(outside, localConfigPath());
      await assert.rejects(readLocalConfigObject(), /symlinked/u);
    });
  }
});

test("logical no-op updates retain exact bytes and file identity", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`  ${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const identity = statSync(localConfigPath()).ino;
    await updateLocalConfig((settings) => settings);
    assert.deepEqual(readFileSync(localConfigPath()), before);
    assert.equal(statSync(localConfigPath()).ino, identity);
  });
});

test("failed atomic publication restores the exact previous private document", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    await assert.rejects(
      withConfigFilePublicationForTest(
        async () => {
          const error = new Error("injected publication failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
        () => updateLocalConfig((settings) => ({ ...settings, onSwitch: "switch-only" })),
      ),
      /injected publication failure/u,
    );
    assert.deepEqual(readFileSync(localConfigPath()), before);
    if (process.platform !== "win32") assert.equal(statSync(localConfigPath()).mode & 0o777, 0o600);
  });
});

test("post-install publication failure rolls back to exact prior bytes", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    await assert.rejects(
      withConfigReplacementInstalledHookForTest(
        async () => {
          throw new Error("injected post-install failure");
        },
        () => updateLocalConfig((settings) => ({ ...settings, onSwitch: "switch-only" })),
      ),
      /injected post-install failure/u,
    );
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("atomic updates preserve unknown fields at retained v3 boundaries", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const settings = v3S3Settings() as ReturnType<typeof v3S3Settings> & {
      futureTop: string;
    };
    settings.futureTop = "keep";
    (settings.storageConnections.r2 as Record<string, unknown>).futureConnection = { keep: true };
    (settings.syncSetups.home as Record<string, unknown>).futureSetup = ["keep"];
    (settings.syncSetups.home.sync as Record<string, unknown>).futurePolicy = 42;
    writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
    await updateLocalConfig((current) => ({ ...current, onSwitch: "switch-only" }));
    const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
    assert.equal(saved.futureTop, "keep");
    assert.deepEqual(saved.storageConnections.r2.futureConnection, { keep: true });
    assert.deepEqual(saved.syncSetups.home.futureSetup, ["keep"]);
    assert.equal(saved.syncSetups.home.sync.futurePolicy, 42);
  });
});
