import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { S3Client } from "../src/backends/s3/s3-client.js";
import { loadPartialConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { configuredSessionDir } from "../src/snapshot/session-paths.js";
import { lockFileExists, readLock, withLock } from "../src/state/lock.js";
import { ensureStateDir, lockPath, readState } from "../src/state/sync-state-store.js";
import { backupLocal } from "../src/sync/sync-operations.js";
import sync, {
  appliedFileHashMap,
  canPullRemoteSessionsOnFirstSync,
  canPullRemoteSettingsOnFirstSync,
  filterSnapshotForConfigPolicy,
  hasRemoteChanges,
  isCloudflareR2Endpoint,
  isEnabled,
  isExplicitlyEnabled,
  mergeRemotePreservedFiles,
  mergeRemoteSessionFiles,
  protectSnapshotApplyPlan,
  scanSnapshot,
  sessionTokenWarnings,
  settingsHashesMatchState,
  settingsHashMap,
  snapshotWithoutSessions,
} from "../src/sync.js";

import { requiredConfig, snapshot, v3S3Settings, withEnv, withTempHome, writeOldLock } from "./helpers.js";

initTheme("dark", false);

test("unconfigured extra top-level files are filtered locally and preserved on upload", () => {
  const settings = { path: "settings.json", content: Buffer.from("settings") };
  const custom = { path: "LOCAL.md", content: Buffer.from("custom") };
  const configured = { path: "CONFIGURED.md", content: Buffer.from("configured") };
  const session = { path: "sessions/--project--/session.jsonl", content: Buffer.from("session") };
  const unsafeSession = { path: "sessions/../evil.jsonl", content: Buffer.from("evil") };
  const reservedExtra = { path: "skills", content: Buffer.from("reserved") };
  const builtInCaseExtra = { path: "Settings.json", content: Buffer.from("duplicate") };
  const remote = {
    ...snapshot([custom, configured, session, unsafeSession, reservedExtra, builtInCaseExtra, settings]),
    syncSessions: true,
  };
  const config = {
    ...requiredConfig(),
    region: "auto",
    profile: "default",
    prefix: "pi-sync",
    syncSessions: false,
    extraFiles: ["CONFIGURED.md"],
  };

  const filtered = filterSnapshotForConfigPolicy(remote, config);
  assert.deepEqual(filtered.files.map((file) => file.path).sort(), ["CONFIGURED.md", "settings.json"]);
  assert.deepEqual(
    filterSnapshotForConfigPolicy(
      snapshot([{ path: "append_system.md", content: Buffer.from("append") }]),
      config,
    ).files.map((file) => file.path),
    ["APPEND_SYSTEM.md"],
  );
  assert.notEqual(filterSnapshotForConfigPolicy(remote, config, { regenerateId: true }).id, remote.id);
  assert.deepEqual(
    filterSnapshotForConfigPolicy(remote, { ...config, syncSessions: true })
      .files.map((file) => file.path)
      .sort(),
    ["CONFIGURED.md", "sessions/--project--/session.jsonl", "settings.json"],
  );
  const lowerCaseRemoteExtra = filterSnapshotForConfigPolicy(
    snapshot([{ path: "local.md", content: Buffer.from("local") }]),
    {
      ...config,
      extraFiles: ["LOCAL.md"],
    },
  );
  assert.deepEqual(
    lowerCaseRemoteExtra.files.map((file) => file.path),
    ["LOCAL.md"],
  );
  assert.equal(
    hasRemoteChanges(
      lowerCaseRemoteExtra,
      {
        version: 1,
        profile: "default",
        lastAppliedSnapshot: lowerCaseRemoteExtra.id,
        lastFileHashes: Object.fromEntries(
          snapshot([{ path: "local.md", content: Buffer.from("local") }]).files.map((file) => [file.path, file.sha256]),
        ),
        extraFiles: ["LOCAL.md"],
      },
      { ...config, extraFiles: ["LOCAL.md"] },
    ),
    false,
  );
  assert.deepEqual(
    mergeRemotePreservedFiles(snapshot([settings]), remote, config).files.map((file) => file.path),
    ["LOCAL.md", "sessions/--project--/session.jsonl", "settings.json"],
  );
  assert.deepEqual(
    mergeRemotePreservedFiles(snapshot([settings]), remote, {
      ...config,
      extraFiles: ["CONFIGURED.md", "LOCAL.md"],
    }).files.map((file) => file.path),
    ["sessions/--project--/session.jsonl", "settings.json"],
  );
  assert.deepEqual(
    mergeRemotePreservedFiles(
      snapshot([settings, { path: "local.md", content: Buffer.from("local") }]),
      remote,
      config,
    ).files.map((file) => file.path),
    ["local.md", "sessions/--project--/session.jsonl", "settings.json"],
  );
  assert.equal(
    hasRemoteChanges(
      filtered,
      {
        version: 1,
        profile: "default",
        lastAppliedSnapshot: remote.id,
        lastFileHashes: Object.fromEntries(snapshot([settings]).files.map((file) => [file.path, file.sha256])),
        extraFiles: [],
      },
      config,
    ),
    true,
  );
});

test("settings-only uploads preserve remote session files", () => {
  const settings = { path: "settings.json", content: Buffer.from("local") };
  const remoteSession = {
    path: "sessions/--project--/session.jsonl",
    content: Buffer.from("remote"),
  };
  const invalidSession = {
    path: "sessions/--project--/notes.txt",
    content: Buffer.from("skip"),
  };
  const deniedSession = {
    path: "sessions/--project--/token.jsonl",
    content: Buffer.from("skip"),
  };
  const local = snapshot([settings]);

  const merged = mergeRemoteSessionFiles(local, snapshot([remoteSession, invalidSession, deniedSession]));

  assert.notEqual(merged.id, local.id);
  assert.deepEqual(
    merged.files.map((file) => file.path),
    ["sessions/--project--/session.jsonl", "settings.json"],
  );
  assert.equal(merged.syncSessions, true);

  const emptySessionSet = mergeRemoteSessionFiles(local, { ...snapshot([]), syncSessions: true });
  assert.notEqual(emptySessionSet.id, local.id);
  assert.deepEqual(
    emptySessionSet.files.map((file) => file.path),
    ["settings.json"],
  );
  assert.equal(emptySessionSet.syncSessions, true);
});

test("sync state tracks selection-policy changes without treating deselection as remote deletion", () => {
  const remote = snapshot([
    { path: "settings.json", content: Buffer.from("settings") },
    { path: "keybindings.json", content: Buffer.from("keys") },
  ]);
  const selectedSettings = {
    ...requiredConfig(),
    region: "auto",
    profile: "default",
    prefix: "pi-sync",
    syncFiles: ["settings.json"],
    syncSessions: false,
    extraFiles: [],
  };
  const legacyState = {
    version: 1,
    profile: "default",
    lastAppliedSnapshot: remote.id,
    lastFileHashes: Object.fromEntries(remote.files.map((file) => [file.path, file.sha256])),
  };
  assert.equal(hasRemoteChanges(remote, legacyState, selectedSettings), false);

  const previouslyEmptyState = {
    ...legacyState,
    lastFileHashes: {},
    syncFiles: [],
  };
  assert.equal(hasRemoteChanges(remote, previouslyEmptyState, selectedSettings), true);
});

test("settings hash maps ignore session differences for first sync checks", () => {
  const local = snapshot([
    { path: "settings.json", content: Buffer.from("settings") },
    { path: "sessions/--project--/local.jsonl", content: Buffer.from("local") },
  ]);
  const remote = snapshot([
    { path: "settings.json", content: Buffer.from("settings") },
    { path: "sessions/--project--/remote.jsonl", content: Buffer.from("remote") },
  ]);

  assert.deepEqual(settingsHashMap(local), settingsHashMap(remote));
  const state = {
    version: 1,
    profile: "default",
    lastAppliedSnapshot: "old",
    lastFileHashes: Object.fromEntries(local.files.map((file) => [file.path, file.sha256])),
  };
  const config = {
    ...requiredConfig(),
    region: "auto",
    profile: "default",
    prefix: "pi-sync",
    syncSessions: false,
  };

  assert.equal(settingsHashesMatchState(remote, state), true);
  assert.equal(hasRemoteChanges(remote, state, config), false);
  assert.equal(hasRemoteChanges(remote, state, { ...config, syncSessions: true }), true);
  assert.equal(
    hasRemoteChanges(snapshot([{ path: "settings.json", content: Buffer.from("changed") }]), state, config),
    true,
  );
});

test("first sync only auto-pulls remote files when local files are not at risk", () => {
  const settings = { path: "settings.json", content: Buffer.from("settings") };
  const appendSystem = { path: "APPEND_SYSTEM.md", content: Buffer.from("append") };
  const changedSettings = { path: "settings.json", content: Buffer.from("changed") };
  const remoteOnly = snapshot([{ path: "sessions/--project--/remote.jsonl", content: Buffer.from("r") }]);
  const shared = { path: "sessions/--project--/shared.jsonl", content: Buffer.from("same") };
  const changed = { path: "sessions/--project--/shared.jsonl", content: Buffer.from("changed") };

  assert.equal(canPullRemoteSettingsOnFirstSync(snapshot([settings]), snapshot([settings, appendSystem])), true);
  assert.equal(canPullRemoteSettingsOnFirstSync(snapshot([settings]), snapshot([changedSettings])), false);
  assert.equal(canPullRemoteSettingsOnFirstSync(snapshot([appendSystem]), snapshot([settings])), false);
  assert.equal(canPullRemoteSessionsOnFirstSync(snapshot([]), remoteOnly), true);
  assert.equal(canPullRemoteSessionsOnFirstSync(snapshot([shared]), snapshot([shared])), true);
  assert.equal(canPullRemoteSessionsOnFirstSync(snapshot([shared]), remoteOnly), false);
  assert.equal(canPullRemoteSessionsOnFirstSync(snapshot([changed]), snapshot([shared])), false);
});

test("snapshotWithoutSessions clears session opt-in even when no session files exist", () => {
  const source = {
    ...snapshot([{ path: "settings.json", content: Buffer.from("{}") }]),
    syncSessions: true,
    selection: { version: 1 as const, include: ["settings.json", "sessions"] },
  };
  const filtered = snapshotWithoutSessions(source);

  assert.equal(filtered.syncSessions, false);
  assert.deepEqual(filtered.selection, { version: 1, include: ["settings.json"] });
  assert.notEqual(filtered.id, source.id);
  assert.deepEqual(
    filtered.files.map((file) => file.path),
    ["settings.json"],
  );
});

test("protected session apply plans keep the live session file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-protect-"));
  const live = path.join(root, "sessions", "--project--", "live.jsonl");
  const old = path.join(root, "sessions", "--project--", "old.jsonl");
  const plan = protectSnapshotApplyPlan(
    root,
    {
      writes: [
        { target: live, content: Buffer.from("remote") },
        { target: path.join(root, "settings.json"), content: Buffer.from("{}") },
      ],
      deletes: [live, old],
    },
    new Set(["sessions/--project--/live.jsonl"]),
  );

  assert.deepEqual(
    plan.writes.map((item) => item.target),
    [path.join(root, "settings.json")],
  );
  assert.deepEqual(plan.deletes, [old]);

  const current = snapshot([
    { path: "sessions/--project--/live.jsonl", content: Buffer.from("local") },
    { path: "sessions/--project--/old.jsonl", content: Buffer.from("old") },
  ]);
  const remote = snapshot([
    { path: "settings.json", content: Buffer.from("{}") },
    { path: "sessions/--project--/live.jsonl", content: Buffer.from("remote") },
  ]);
  const hashes = appliedFileHashMap(remote, current, new Set(["sessions/--project--/live.jsonl"]));

  assert.equal(
    hashes["sessions/--project--/live.jsonl"],
    current.files.find((file) => file.path === "sessions/--project--/live.jsonl")?.sha256,
  );
  assert.equal(hashes["settings.json"], remote.files.find((file) => file.path === "settings.json")?.sha256);
  const config = {
    ...requiredConfig(),
    region: "auto",
    profile: "default",
    prefix: "pi-sync",
    syncSessions: true,
  };
  const protectedState = {
    version: 1,
    profile: "default",
    lastAppliedSnapshot: remote.id,
    lastFileHashes: hashes,
    syncSessions: true,
    extraFiles: [],
  };
  assert.equal(hasRemoteChanges(remote, protectedState, config), false);

  const advancedRemote = { ...remote, id: "advanced" };
  assert.equal(hasRemoteChanges(advancedRemote, protectedState, config), true);
  assert.equal(
    hasRemoteChanges(advancedRemote, protectedState, config, new Set(["sessions/--project--/live.jsonl"])),
    false,
  );
});

test("session backups include session jsonl files when enabled", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(path.join(agentDir, "sessions", "--project--"), { recursive: true });
    writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
    writeFileSync(path.join(agentDir, "sessions", "--project--", "session.jsonl"), "{}\n");

    const backupPath = await backupLocal("default", { syncSessions: true });
    const backup = JSON.parse(gunzipSync(readFileSync(backupPath)).toString("utf8"));

    assert.ok(backup.files.some((file: { path: string }) => file.path === "sessions/--project--/session.jsonl"));
  });
});

test("snapshot backups expand a tilde-configured agent directory", async () => {
  await withTempHome(async (defaultAgentDir) => {
    const home = path.resolve(defaultAgentDir, "../../");
    const tildeAgentDir = path.join(home, ".pi", "agent-tilde");
    mkdirSync(tildeAgentDir, { recursive: true });
    writeFileSync(path.join(tildeAgentDir, "settings.json"), '{"tilde":true}\n');

    await withEnv({ PI_CODING_AGENT_DIR: "~/.pi/agent-tilde" }, async () => {
      const backupPath = await backupLocal("tilde");
      const backup = JSON.parse(gunzipSync(readFileSync(backupPath)).toString("utf8"));
      assert.ok(backup.files.some((file: { path: string }) => file.path === "settings.json"));
      assert.equal(backupPath.startsWith(tildeAgentDir), true);
    });
  });
});

test("session backups honor the configured session directory fallback", async () => {
  await withTempHome(async (agentDir) => {
    const sessionDir = path.join(path.dirname(agentDir), "custom-sessions");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(path.join(sessionDir, "--project--"), { recursive: true });
    writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir })}\n`);
    writeFileSync(path.join(sessionDir, "--project--", "configured.jsonl"), "{}\n");

    const backupPath = await backupLocal("configured", { syncSessions: true });
    const backup = JSON.parse(gunzipSync(readFileSync(backupPath)).toString("utf8"));
    assert.ok(backup.files.some((file: { path: string }) => file.path === "sessions/--project--/configured.jsonl"));
  });
});

test("security and configuration helpers detect secrets and R2 session-token warnings", () => {
  const secret = Buffer.from("FIRECRAWL_API_KEY=sk-12345678901234567890");
  assert.deepEqual(scanSnapshot(snapshot([{ path: "settings.json", content: secret }])), ["settings.json"]);
  assert.equal(isCloudflareR2Endpoint("https://abc.r2.cloudflarestorage.com"), true);
  assert.equal(isCloudflareR2Endpoint("https://s3.amazonaws.com"), false);
  assert.equal(sessionTokenWarnings({ endpoint: "https://abc.r2.cloudflarestorage.com", sessionToken: "x" }).length, 1);
  assert.equal(isEnabled("off", true), false);
  assert.equal(isEnabled(undefined, true), true);
  assert.equal(isExplicitlyEnabled("true"), true);
  assert.equal(isExplicitlyEnabled("tru"), false);
  assert.equal(isExplicitlyEnabled(""), false);
});

function s3ClientConfig() {
  const flat = requiredConfig();
  return {
    type: "s3" as const,
    profile: {
      kind: "r2" as const,
      endpoint: flat.endpoint,
      region: "auto",
      accessKeyId: flat.accessKeyId,
      secretAccessKey: flat.secretAccessKey,
    },
    destination: { bucket: flat.bucket, prefix: "pi-sync", namespace: "default" },
  };
}

test("getJson retries on empty R2 response body and eventually succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response("", { status: 200, headers: { etag: "w/empty1" } }),
    new Response("", { status: 200, headers: { etag: "w/empty2" } }),
    new Response(JSON.stringify({ snapshot: "snap-1", sha256: "abc" }), {
      status: 200,
      headers: { etag: "w/ok" },
    }),
  ];
  let calls = 0;
  globalThis.fetch = (async () => {
    const response = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return response;
  }) as typeof globalThis.fetch;
  try {
    const client = new S3Client(s3ClientConfig());
    const result = await client.getJson<{ snapshot: string; sha256: string }>("latest.json");
    assert.equal(result.missing, false);
    assert.equal(result.value?.snapshot, "snap-1");
    assert.equal(result.etag, "w/ok");
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getJson throws after retrying a persistently empty R2 response body", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("", { status: 200, headers: { etag: "w/empty" } });
  }) as typeof globalThis.fetch;
  try {
    const client = new S3Client(s3ClientConfig());
    await assert.rejects(client.getJson("latest.json"), /empty body/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getJson does not retry a non-empty malformed response body", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("{", { status: 200, headers: { etag: "w/malformed" } });
  }) as typeof globalThis.fetch;
  try {
    const client = new S3Client(s3ClientConfig());
    await assert.rejects(client.getJson("latest.json"), SyntaxError);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getBuffer retries on empty R2 response body and eventually succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const payload = Buffer.from("snapshot-payload");
  const responses = [
    new Response("", { status: 200, headers: { etag: "w/empty1" } }),
    new Response("", { status: 200, headers: { etag: "w/empty2" } }),
    new Response(new Uint8Array(payload), { status: 200, headers: { etag: "w/ok" } }),
  ];
  let calls = 0;
  globalThis.fetch = (async () => {
    const response = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return response;
  }) as typeof globalThis.fetch;
  try {
    const client = new S3Client(s3ClientConfig());
    const result = await client.getBuffer("snapshots/snap-1.json.gz");
    assert.equal(result.missing, false);
    assert.deepEqual(result.value, payload);
    assert.equal(result.etag, "w/ok");
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getBuffer throws after retrying a persistently empty R2 response body", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("", { status: 200, headers: { etag: "w/empty" } });
  }) as typeof globalThis.fetch;
  try {
    const client = new S3Client(s3ClientConfig());
    await assert.rejects(client.getBuffer("snapshots/snap-1.json.gz"), /empty body/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("old unreadable locks require explicit stale unlock before recovery", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx } = createMockContext({ hasUI: true });

    for (const contents of ["", "{not valid json"]) {
      writeOldLock(contents);
      let ran = false;
      await assert.rejects(
        withLock("test", async () => {
          ran = true;
        }),
        /unreadable/,
      );
      assert.equal(ran, false);
      assert.equal(await lockFileExists(), true);

      await mock.commands.get("sync")?.handler("unlock --stale", ctx);
      assert.equal(await lockFileExists(), false);
      assert.equal(await withLock("test", async () => "ok"), "ok");
    }
  });
});

test("withLock never reclaims an aged lock that a legacy writer still owns", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    const legacyHandle = await fs.open(lockPath(), "wx");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath(), old, old);
    let ran = false;
    try {
      await assert.rejects(
        withLock("test", async () => {
          ran = true;
        }),
        /unreadable/,
      );
      assert.equal(ran, false);

      await legacyHandle.writeFile(
        JSON.stringify({
          id: "legacy",
          pid: process.pid,
          command: "sync",
          startedAt: new Date().toISOString(),
        }),
      );
      await assert.rejects(
        withLock("test", async () => undefined),
        /already running/,
      );
    } finally {
      await legacyHandle.close();
      await fs.rm(lockPath(), { force: true });
    }
  });
});

test("withLock does not reclaim a lock file that may still be initializing", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    writeFileSync(lockPath(), "");
    let ran = false;
    await assert.rejects(
      withLock("test", async () => {
        ran = true;
      }),
      /unreadable/,
    );
    assert.equal(ran, false);
  });
});

test("unlock keeps a fresh unreadable lock unless stale removal is explicit", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    writeFileSync(lockPath(), "");
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({ hasUI: true });

    await mock.commands.get("sync")?.handler("unlock", ctx);
    assert.equal(await lockFileExists(), true);
    assert.match(notifications.at(-1)?.message ?? "", /unreadable/);

    await mock.commands.get("sync")?.handler("unlock --stale", ctx);
    assert.equal(await lockFileExists(), false);
    assert.match(notifications.at(-1)?.message ?? "", /Removed unreadable/);
  });
});

test("stale unlock rechecks unreadable metadata before removing it", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    writeFileSync(lockPath(), "");
    const originalReadFile = fs.readFile;
    let lockReads = 0;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      const result = await originalReadFile(...args);
      if (args[0] === lockPath() && lockReads++ === 0) {
        await fs.writeFile(
          lockPath(),
          JSON.stringify({
            id: "legacy",
            pid: process.pid,
            command: "sync",
            startedAt: new Date().toISOString(),
          }),
        );
      }
      return result;
    }) as typeof fs.readFile;

    try {
      const mock = createMockPi();
      sync(mock.pi);
      const { ctx, notifications } = createMockContext({ hasUI: true });
      await mock.commands.get("sync")?.handler("unlock --stale", ctx);

      assert.equal(await lockFileExists(), true);
      assert.match(notifications.at(-1)?.message ?? "", /not stale|still live/);
    } finally {
      fs.readFile = originalReadFile;
      await fs.rm(lockPath(), { force: true });
    }
  });
});

test("unlock cannot remove the lock for an active guarded sync", async () => {
  await withTempHome(async () => {
    let releaseRun: (() => void) | undefined;
    const keepRunning = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const running = withLock("test", async () => {
      markStarted?.();
      await keepRunning;
    });
    await started;

    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({ hasUI: true });
    try {
      await mock.commands.get("sync")?.handler("unlock --stale", ctx);
      assert.equal(await lockFileExists(), true);
      assert.match(notifications.at(-1)?.message ?? "", /currently running/);
    } finally {
      releaseRun?.();
      await running;
    }
    assert.equal(await lockFileExists(), false);
  });
});

test("unlock reports when a dead owner's guard is still expiring", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    writeFileSync(
      lockPath(),
      JSON.stringify({
        id: "dead-owner",
        pid: 2_147_483_647,
        command: "sync",
        startedAt: new Date().toISOString(),
      }),
    );
    mkdirSync(`${lockPath()}.guard`);
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({ hasUI: true });

    await mock.commands.get("sync")?.handler("unlock --stale", ctx);
    assert.equal(await lockFileExists(), true);
    assert.match(notifications.at(-1)?.message ?? "", /owner exited.*guard expires/);
  });
});

test("concurrent withLock calls never execute together", async () => {
  await withTempHome(async () => {
    let active = 0;
    let maxActive = 0;
    const run = () =>
      withLock("test", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
      });

    const results = await Promise.allSettled([run(), run()]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(maxActive, 1);
  });
});

test("withLock rejects when a valid foreign lock is held", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    writeFileSync(
      lockPath(),
      JSON.stringify({
        id: "other",
        pid: process.pid,
        command: "push",
        startedAt: new Date().toISOString(),
      }),
    );
    await assert.rejects(
      withLock("test", async () => "ok"),
      /already running/,
    );
  });
});

test("readLock treats empty, whitespace, and corrupt lock files as absent", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    for (const contents of [
      "",
      "  \n  ",
      "{broken",
      "{}",
      "[]",
      "null",
      "1",
      JSON.stringify({
        id: "invalid-pid",
        pid: 2_147_483_648,
        command: "sync",
        startedAt: new Date().toISOString(),
      }),
    ]) {
      writeFileSync(lockPath(), contents);
      assert.equal(await readLock(), undefined, `expected undefined for ${JSON.stringify(contents)}`);
    }
  });
});

test("doctor warns when lock metadata is unreadable", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    writeFileSync(lockPath(), "{broken");
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({ hasUI: true });

    await mock.commands.get("sync")?.handler("doctor", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /lock: unreadable/);
    assert.equal(notifications.at(-1)?.level, "warning");
  });
});

test("doctor warns when a lock guard is active without metadata", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    mkdirSync(`${lockPath()}.guard`);
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({ hasUI: true });

    await mock.commands.get("sync")?.handler("doctor", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /lock: guard active.*metadata/);
    assert.equal(notifications.at(-1)?.level, "warning");
  });
});

test("doctor warns when a valid lock owner has exited", async () => {
  await withTempHome(async () => {
    await ensureStateDir();
    writeFileSync(
      lockPath(),
      JSON.stringify({
        id: "dead-owner",
        pid: 2_147_483_647,
        command: "sync",
        startedAt: new Date().toISOString(),
      }),
    );
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({ hasUI: true });

    await mock.commands.get("sync")?.handler("doctor", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /lock: stale.*\/sync unlock --stale/);
    assert.equal(notifications.at(-1)?.level, "warning");
  });
});

test("doctor reports live and free lock states", async () => {
  using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  await withTempHome(async () => {
    await ensureStateDir();
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()));
    writeFileSync(
      lockPath(),
      JSON.stringify({
        id: "live-owner",
        pid: process.pid,
        command: "sync",
        startedAt: new Date().toISOString(),
      }),
    );
    const mock = createMockPi();
    sync(mock.pi);
    const { ctx, notifications } = createMockContext({ hasUI: true });

    await mock.commands.get("sync")?.handler("doctor", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /lock: held by pid/);
    assert.equal(notifications.at(-1)?.level, "info");

    await fs.rm(lockPath());
    await mock.commands.get("sync")?.handler("doctor", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /lock: free/);
    assert.equal(notifications.at(-1)?.level, "info");
  });
});

test("malformed non-lock JSON remains an explicit error", async () => {
  await withTempHome(async (agentDir) => {
    await ensureStateDir();

    writeFileSync(localConfigPath(), "{broken");
    await assert.rejects(loadPartialConfig(), SyntaxError);

    writeFileSync(path.join(agentDir, "pi-sync", "default.state.json"), "{broken");
    await assert.rejects(readState("default"), SyntaxError);

    writeFileSync(path.join(agentDir, "settings.json"), "{broken");
    await assert.rejects(configuredSessionDir(), SyntaxError);
  });
});
