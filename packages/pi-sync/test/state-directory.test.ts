import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { isDeniedPath } from "../src/paths.js";
import {
  legacyStateDir,
  migrateLegacyStateDirectory,
  stateDir,
  withStateDirectoryAccess,
} from "../src/state/state-directory.js";
import { withTempHome } from "./helpers.js";

test("new installations select the visible pi-sync state directory", async () => {
  await withTempHome(async (agentDir) => {
    assert.equal(stateDir(), path.join(agentDir, "pi-sync"));
  });
});

test("snapshot policy denies canonical and legacy state directories", () => {
  assert.equal(isDeniedPath("pi-sync/default.state.json"), true);
  assert.equal(isDeniedPath(".pisync/default.state.json"), true);
  assert.equal(isDeniedPath("nested/PI-SYNC/backups/snapshot.json.gz"), true);
  assert.equal(isDeniedPath(".pi-sync-state-migration.lock/owner"), true);
});

test("legacy installations keep using .pisync until migration succeeds", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(path.join(agentDir, ".pisync"), { recursive: true });
    assert.equal(stateDir(), path.join(agentDir, ".pisync"));
  });
});

test("legacy state is atomically migrated with nested contents preserved", async () => {
  await withTempHome(async (agentDir) => {
    const legacy = path.join(agentDir, ".pisync");
    mkdirSync(path.join(legacy, "backups"), { recursive: true });
    writeFileSync(path.join(legacy, "backups", "snapshot.json.gz"), "backup");

    const result = await migrateLegacyStateDirectory();

    assert.equal(result.status, "migrated");
    assert.equal(existsSync(legacy), false);
    assert.equal(stateDir(), path.join(agentDir, "pi-sync"));
    assert.equal(readFileSync(path.join(stateDir(), "backups", "snapshot.json.gz"), "utf8"), "backup");
  });
});

test("a legacy operation lock defers migration and retains the legacy root", async () => {
  await withTempHome(async (agentDir) => {
    const legacy = path.join(agentDir, ".pisync");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      path.join(legacy, "lock"),
      JSON.stringify({
        id: "active-sync",
        pid: process.pid,
        command: "push",
        startedAt: new Date().toISOString(),
      }),
    );

    const result = await migrateLegacyStateDirectory();

    assert.equal(result.status, "deferred");
    assert.match(result.message, /close other Pi sessions/i);
    assert.equal(stateDir(), legacy);
    assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
  });
});

test("a legacy operation guard without metadata defers migration", async () => {
  await withTempHome(async (agentDir) => {
    const legacy = path.join(agentDir, ".pisync");
    mkdirSync(path.join(legacy, "lock.guard"), { recursive: true });

    const result = await migrateLegacyStateDirectory();

    assert.equal(result.status, "deferred");
    assert.equal(stateDir(), legacy);
    assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
  });
});

test("canonical state access does not take the legacy migration lock", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(path.join(agentDir, "pi-sync"), { recursive: true });
    await withStateDirectoryAccess(async () => {
      assert.equal(existsSync(path.join(agentDir, ".pi-sync-state-migration.lock")), false);
    });
  });
});

test("overlapping legacy state users share migration protection without lock contention", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(path.join(agentDir, ".pisync"), { recursive: true });
    let firstStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseUsers: () => void = () => undefined;
    const usersReleased = new Promise<void>((resolve) => {
      releaseUsers = resolve;
    });
    const first = withStateDirectoryAccess(async () => {
      firstStarted();
      await usersReleased;
    });
    await started;

    let secondStarted: () => void = () => undefined;
    const secondEntered = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const second = withStateDirectoryAccess(async () => {
      secondStarted();
      await usersReleased;
    });
    const secondOutcome = second.then(
      () => "completed" as const,
      (error: unknown) => error,
    );

    try {
      const outcome = await Promise.race([
        secondEntered.then(() => "entered" as const),
        secondOutcome,
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
      ]);
      assert.equal(outcome, "entered");
    } finally {
      releaseUsers();
      await first;
      await secondOutcome;
    }
  });
}, 5_000);

test("active state access defers migration without moving or recreating the legacy root", async () => {
  await withTempHome(async (agentDir) => {
    const legacy = path.join(agentDir, ".pisync");
    mkdirSync(path.join(legacy, "git"), { recursive: true });
    let accessStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      accessStarted = resolve;
    });
    let releaseAccess: () => void = () => undefined;
    const accessReleased = new Promise<void>((resolve) => {
      releaseAccess = resolve;
    });
    const access = withStateDirectoryAccess(async () => {
      accessStarted();
      await accessReleased;
    });
    await started;

    try {
      const result = await migrateLegacyStateDirectory();
      assert.equal(result.status, "deferred");
      assert.equal(stateDir(), legacy);
      assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
    } finally {
      releaseAccess();
      await access;
    }
  });
});

test("concurrent upgraded processes serialize one migration", async () => {
  await withTempHome(async (agentDir) => {
    const legacy = path.join(agentDir, ".pisync");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "default.state.json"), "state");

    const results = await Promise.all([migrateLegacyStateDirectory(), migrateLegacyStateDirectory()]);

    assert.deepEqual(results.map((result) => result.status).sort(), ["migrated", "ready"]);
    assert.equal(readFileSync(path.join(stateDir(), "default.state.json"), "utf8"), "state");
  });
});

test("conflicting canonical and legacy roots fail closed", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(path.join(agentDir, ".pisync"), { recursive: true });
    mkdirSync(path.join(agentDir, "pi-sync"), { recursive: true });

    assert.throws(() => stateDir(), /both .*\.pisync.*pi-sync|both .*pi-sync.*\.pisync/i);
    await assert.rejects(migrateLegacyStateDirectory(), /both .*\.pisync.*pi-sync|both .*pi-sync.*\.pisync/i);
  });
});

test("symlinked state roots fail closed", async () => {
  await withTempHome(async (agentDir) => {
    const outside = path.join(agentDir, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, legacyStateDir(), "dir");

    assert.throws(() => stateDir(), /symbolic link/i);
    await assert.rejects(migrateLegacyStateDirectory(), /symbolic link/i);
  });
});
