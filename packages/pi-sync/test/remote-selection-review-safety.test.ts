import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import type { PiSyncSettingsV3, StorageConnectionType } from "../src/settings/settings-types.js";
import type { RemoteSelectionDecision } from "../src/sync/sync-policy.js";
import { showRemoteSelectionReview } from "../src/ui/remote-selection-ui.js";
import { snapshot, v3S3Settings, v3WebDavSettings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

initTheme("dark", false);

const remoteInclude = ["settings.json", "AGENTS.md"];

function settingsFor(kind: StorageConnectionType): PiSyncSettingsV3 {
  if (kind === "s3") return v3S3Settings() as PiSyncSettingsV3;
  if (kind === "webdav") return v3WebDavSettings() as PiSyncSettingsV3;
  return {
    version: 3,
    activeSyncSetup: "home",
    onSwitch: "ask-before-pull",
    storageConnections: { origin: { type: "git", remote: "https://example.com/a.git" } },
    syncSetups: {
      home: {
        storage: { connection: "origin", branch: "pi-sync/home", path: "pi-sync/home" },
        sync: { include: ["settings.json"], automatic: false },
      },
    },
  };
}

async function configured(kind: StorageConnectionType, run: () => Promise<void>) {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(settingsFor(kind)), { mode: 0o600 });
    await run();
  });
}

async function decision(): Promise<RemoteSelectionDecision> {
  const config = await loadConfig("home");
  return {
    setupName: "home",
    configIdentity: syncConfigReviewFingerprint(config),
    localInclude: [...config.include],
    remoteInclude,
  };
}

async function publishSelection(backend: MemorySyncBackend) {
  await backend.publishSnapshot(
    { ...snapshot([]), selection: { version: 1, include: remoteInclude } },
    { kind: "missing" },
  );
}

for (const [kind, field] of [
  ["s3", "endpoint"],
  ["s3", "region"],
  ["s3", "access-key"],
  ["s3", "secret-key"],
  ["s3", "session-token"],
  ["git", "remote"],
  ["webdav", "url"],
  ["webdav", "username"],
  ["webdav", "password"],
  ["s3", "storage-path"],
  ["s3", "bucket"],
  ["git", "branch"],
  ["s3", "agent-mode"],
  ["s3", "automatic"],
  ["s3", "secret-scan"],
] as const) {
  test(`adoption rejects changed ${kind} ${field} inside the settings mutation`, async () => {
    await configured(kind, async () => {
      let expected: Buffer | undefined;
      const backend = new MutatingSnapshotBackend(async () => {
        await updateLocalConfig((settings) => {
          const setup = settings.syncSetups.home;
          assert.ok(setup);
          const connection = settings.storageConnections[setup.storage.connection];
          assert.ok(connection);
          if (field === "storage-path") setup.storage.path = "other/home";
          if (field === "bucket") setup.storage.bucket = "other-bucket";
          if (field === "branch") setup.storage.branch = "pi-sync/other";
          if (field === "agent-mode") setup.sync.agentMode = true;
          if (field === "automatic") setup.sync.automatic = true;
          if (field === "secret-scan") settings.skipSecretScan = true;
          if (connection.type === "s3") {
            if (field === "endpoint") connection.endpoint = "https://other.example.com";
            if (field === "region") connection.region = "us-east-1";
            if (field === "access-key") connection.credentials.accessKeyId = "new-private-key";
            if (field === "secret-key") connection.credentials.secretAccessKey = "new-private-secret";
            if (field === "session-token") connection.credentials.sessionToken = "new-private-token";
          }
          if (connection.type === "git" && field === "remote") connection.remote = "https://example.com/b.git";
          if (connection.type === "webdav") {
            if (field === "url") connection.url = "https://other.example.com/dav";
            if (field === "username") connection.credentials.username = "new-private-user";
            if (field === "password") connection.credentials.password = "new-private-password";
          }
          return settings;
        });
        expected = readFileSync(localConfigPath());
      });
      await publishSelection(backend);
      const tui = createTuiHarness({ width: 80, rows: 24 });
      const owner = new AbortController();
      const context = createMockContext({ mode: "tui", custom: tui.custom });
      let resolved = 0;
      const running = showRemoteSelectionReview(context.ctx, "home", owner.signal, () => backend, {
        decision: await decision(),
        onSelectionResolved: () => (resolved += 1),
      });
      try {
        await tui.waitForOpen();
        tui.press("tui.select.down");
        tui.press("tui.select.confirm");
        await waitForSelectionScreen(tui);
        assert.match(tui.render().join("\n"), /Synced content differs/u);
        assert.ok(expected);
        assert.deepEqual(readFileSync(localConfigPath()), expected);
        assert.deepEqual((await loadConfig("home")).include, ["settings.json"]);
        assert.equal(resolved, 0);
        assert.match(context.notifications.at(-1)?.message ?? "", /changed.*Refreshing the comparison/su);
        assert.doesNotMatch(context.notifications.map((item) => item.message).join("\n"), /new-private/u);
        tui.press("tui.select.cancel");
        assert.deepEqual(await running, { kind: "back" });
      } finally {
        owner.abort();
        tui.dispose();
        await running;
      }
    });
  });
}

for (const change of ["connection", "agent-mode"] as const) {
  test(`saved-list continuation refuses a changed ${change}`, async () => {
    await configured("s3", async () => {
      const backend = new MemorySyncBackend();
      await publishSelection(backend);
      const tui = createTuiHarness({ width: 80, rows: 24 });
      const owner = new AbortController();
      const context = createMockContext({ mode: "tui", custom: tui.custom });
      let routes = 0;
      const running = showRemoteSelectionReview(context.ctx, "home", owner.signal, () => backend, {
        decision: await decision(),
        runRoute: async () => {
          routes += 1;
          return { kind: "completed" };
        },
      });
      try {
        await tui.waitForOpen();
        tui.press("tui.select.down");
        tui.press("tui.select.confirm");
        await waitForSelectionScreen(tui);
        assert.match(tui.render().join("\n"), /Remote content list saved/u);
        await updateLocalConfig((settings) => {
          const setup = settings.syncSetups.home;
          const connection = settings.storageConnections.r2;
          assert.ok(setup && connection?.type === "s3");
          if (change === "connection") connection.endpoint = "https://other.example.com";
          else setup.sync.agentMode = true;
          return settings;
        });
        tui.press("tui.select.confirm");
        await waitForSelectionScreen(tui);
        assert.equal(routes, 0);
        assert.match(context.notifications.at(-1)?.message ?? "", /changed after the remote content list was saved/u);
        assert.deepEqual((await loadConfig("home")).include, remoteInclude);
        tui.press("tui.select.down");
        tui.press("tui.select.confirm");
        assert.deepEqual(await running, { kind: "done" });
      } finally {
        owner.abort();
        tui.dispose();
        await running;
      }
    });
  });
}

type Phase = "initial" | "adoption-head" | "adoption-snapshot" | "revalidation-head" | "revalidation-snapshot";
type Cancellation = "remapped-back" | "ctrl+c" | "disposal" | "session-replacement" | "shutdown";

for (const phase of [
  "initial",
  "adoption-head",
  "adoption-snapshot",
  "revalidation-head",
  "revalidation-snapshot",
] as const) {
  for (const cancellation of ["remapped-back", "ctrl+c", "disposal", "session-replacement", "shutdown"] as const) {
    test(`${phase} ${cancellation} aborts and drains work without saving settings`, async () => {
      await configured("s3", async () => {
        const before = readFileSync(localConfigPath());
        const backend = new GatedSelectionBackend(phase);
        await publishSelection(backend);
        const owner = new AbortController();
        const tui = createTuiHarness({ width: 60, rows: 16, keybindings: remappedBack() });
        const context = createMockContext({ mode: "tui", custom: tui.custom });
        let resolved = 0;
        let settled = false;
        const running = showRemoteSelectionReview(context.ctx, "home", owner.signal, () => backend, {
          ...(phase === "initial" ? {} : { decision: await decision() }),
          onSelectionResolved: () => (resolved += 1),
        });
        void running.then(() => (settled = true));
        try {
          if (phase !== "initial") {
            await tui.waitForOpen();
            tui.press("tui.select.down");
            tui.press("tui.select.confirm");
          }
          const signal = await backend.started.promise;
          await tui.waitForOpen();
          assert.ok(signal);
          assert.match(tui.render().join("\n"), /ctrl\+q\/ctrl\+c cancel/u);
          cancelWork(cancellation, tui, owner);
          await Promise.resolve();
          assert.equal(signal.aborted, true);
          assert.equal(settled, false);
          assert.equal(backend.drained, false);
          assert.deepEqual(readFileSync(localConfigPath()), before);
          backend.release.resolve();
          if (phase !== "initial" && (cancellation === "remapped-back" || cancellation === "ctrl+c")) {
            await tui.waitForOpen();
            tui.press("ctrl+c");
          }
          await running;
          assert.equal(backend.drained, true);
          assert.equal(resolved, 0);
          assert.deepEqual(readFileSync(localConfigPath()), before);
          assert.equal(
            context.notifications.some((item) => item.level === "error"),
            false,
          );
        } finally {
          owner.abort();
          backend.release.resolve();
          tui.dispose();
          await running;
        }
      });
    });
  }
}

class MutatingSnapshotBackend extends MemorySyncBackend {
  private reads = 0;
  constructor(private readonly mutate: () => Promise<void>) {
    super();
  }
  override async readSnapshot(reference: string, signal?: AbortSignal) {
    if (++this.reads === 2) await this.mutate();
    return super.readSnapshot(reference, signal);
  }
}

class GatedSelectionBackend extends MemorySyncBackend {
  readonly started = deferred<AbortSignal | undefined>();
  readonly release = deferred<void>();
  drained = false;
  private headReads = 0;
  private snapshotReads = 0;
  constructor(private readonly phase: Phase) {
    super();
  }
  override async readHead(signal?: AbortSignal) {
    this.headReads += 1;
    if (
      ((this.phase === "initial" || this.phase === "adoption-head") && this.headReads === 1) ||
      (this.phase === "revalidation-head" && this.headReads === 2)
    )
      await this.wait(signal);
    return super.readHead(signal);
  }
  override async readSnapshot(reference: string, signal?: AbortSignal) {
    this.snapshotReads += 1;
    if (
      (this.phase === "adoption-snapshot" && this.snapshotReads === 1) ||
      (this.phase === "revalidation-snapshot" && this.snapshotReads === 2)
    )
      await this.wait(signal);
    return super.readSnapshot(reference, signal);
  }
  private async wait(signal?: AbortSignal) {
    this.started.resolve(signal);
    await this.release.promise;
    this.drained = true;
    signal?.throwIfAborted();
  }
}

function cancelWork(cancellation: Cancellation, tui: ReturnType<typeof createTuiHarness>, owner: AbortController) {
  if (cancellation === "remapped-back") tui.send("\u0011");
  else if (cancellation === "ctrl+c") tui.press("ctrl+c");
  else if (cancellation === "disposal") tui.dispose();
  else owner.abort(new DOMException(cancellation, "AbortError"));
}

function remappedBack(): Pick<KeybindingsManager, "matches" | "getKeys"> {
  return {
    matches(data, action) {
      if (action === "tui.select.cancel") return data === "\u0011";
      if (action === "tui.select.confirm" || action === "tui.input.submit") return data === "\r";
      if (action === "tui.select.down") return data === "\u001b[B";
      if (action === "tui.select.up") return data === "\u001b[A";
      return false;
    },
    getKeys(action) {
      if (action === "tui.select.cancel") return ["ctrl+q"];
      if (action === "tui.select.confirm" || action === "tui.input.submit") return ["enter"];
      if (action === "tui.select.down") return ["down"];
      if (action === "tui.select.up") return ["up"];
      return [];
    },
  };
}

async function waitForSelectionScreen(tui: ReturnType<typeof createTuiHarness>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await tui.waitForOpen();
    if (
      !/Checking remote content list|Checking and saving remote content list|Refreshing remote content list/u.test(
        tui.render().join("\n"),
      )
    )
      return;
    await tui.waitForPending();
  }
  assert.fail("Remote content-list inspection did not finish");
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}
