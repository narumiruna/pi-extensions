import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DaemonConnection, findDaemon, stopDaemon } from "@narumitw/pi-sync-daemon";
import { ignorePolicyFingerprint } from "@narumitw/pi-sync-daemon/engine/ignore/ignore-source";
import { configFromSettings } from "@narumitw/pi-sync-daemon/engine/settings/config";
import { validateSettingsDocument } from "@narumitw/pi-sync-daemon/engine/settings/settings-validation";
import { aroundEach, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { readClientDebug } from "./client-debug-records.js";
import { v3WebDavSettings } from "./data-fixtures.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

const faultingOwner = `
const { startServer } = await import(process.argv[2] + 'server.js');
const { createEngineService } = await import(process.argv[2] + 'engine-service.js');
const service = createEngineService(process.argv[1], true);
const execute = (operation, payload, execution) => service.execute(operation, payload, operation !== 'pull.foreground' ? execution : {
  ...execution,
  request: async (kind, ...args) => {
    if (kind === 'queue-acquire') throw new Error('Injected acquire failure');
    if (kind === 'queue-release') return false;
    return execution.request(kind, ...args);
  },
});
const server = await startServer(process.argv[1], execute, { ...service.hooks, stopped: () => process.disconnect() });
service.bind(server);
process.send('ready');
`;

function file(text: string) {
  const bytes = Buffer.from(text);
  return {
    path: "notes.md",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

let verify: () => Promise<void>;
let running: Promise<void> | undefined;

aroundEach(async (runTest, { signal }) => {
  await using cleanup = new AsyncDisposableStack();
  verify = await preparePullAdoption(cleanup, signal);
  await runTest();
});

async function preparePullAdoption(cleanup: AsyncDisposableStack, signal: AbortSignal) {
  const temporary = await mkdtemp(path.join(tmpdir(), "pi-sync-rpc-"));
  cleanup.defer(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const listener = await new MockWebDavServer().start();
  cleanup.defer(() => listener.close());
  signal.throwIfAborted();
  const packageRoot = path.resolve("packages/pi-sync");
  const base = v3WebDavSettings();
  base.storageConnections.dav.url = listener.url;
  const settings = validateSettingsDocument({
    ...base,
    version: 8,
    debug: true,
    syncSetups: {
      home: {
        ...base.syncSetups.home,
        sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
      },
    },
  });
  await writeFile(path.join(root, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 });
  const before = "/private.md\n";
  const rule = path.join(root, ".syncignore");
  await writeFile(rule, before);
  await writeFile(path.join(root, "notes.md"), "local");
  signal.throwIfAborted();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      faultingOwner,
      root,
      pathToFileURL(path.join(packageRoot, "dist", "daemon", "dist") + path.sep).href,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(child, "exit");
  cleanup.defer(async () => {
    try {
      await stopDaemon(root);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });
  const [ready] = await Promise.race([
    once(child, "message", { signal }),
    exited.then(() => assert.fail("Fixture daemon exited before readiness")),
  ]);
  assert.equal(ready, "ready");
  signal.throwIfAborted();
  const previousRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  cleanup.defer(() => {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousRoot;
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [packageRoot],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  cleanup.defer(() => loaded.runtime.invalidate("Pull recovery smoke finished"));
  signal.throwIfAborted();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const command = extension?.commands.get("sync");
  assert.ok(command);
  const owner = await findDaemon(root);
  assert.ok(owner && owner.identity.pid === child.pid && !owner.needsUpgrade);
  const reviews: string[] = [];
  const menus: string[][] = [];
  let reloads = 0;
  let selected = false;
  const { ctx, notifications } = createMockContext({
    mode: "rpc",
    confirm: async (title: string) => {
      reviews.push(title);
      return true;
    },
    select: async (_title: string, choices: string[]) => {
      menus.push(choices);
      if (selected) return undefined;
      selected = true;
      return choices.find((item) => item.includes("Pull from remote"));
    },
    reload: async () => {
      reloads++;
    },
  });
  cleanup.defer(async () => {
    try {
      for (const handler of extension?.handlers.get("session_shutdown") ?? [])
        await handler({ type: "session_shutdown", reason: "reload" }, ctx);
    } finally {
      // A timed-out test can still be draining. Keep its daemon and WebDAV fixtures alive until it settles.
      await running?.catch(() => {});
      running = undefined;
    }
  });
  signal.throwIfAborted();
  for (const handler of extension?.handlers.get("session_start") ?? [])
    await handler({ type: "session_start", reason: "startup" }, ctx);
  signal.throwIfAborted();
  await command.handler("push", ctx);
  signal.throwIfAborted();
  const config = configFromSettings(settings).backend;
  assert.equal(config.type, "webdav");
  const backend = new WebDavSyncBackend(config);
  const starting = await backend.readHead(signal);
  assert.ok(starting, JSON.stringify(notifications));
  const current = await backend.readSnapshot(starting.snapshotRef, signal);
  assert.ok(current.selection?.version === 4);
  const incoming = "# incoming\n/private.md\n";
  const recorded = {
    ...current,
    id: "recorded",
    files: [file("recorded")],
    selection: { ...current.selection, fingerprint: ignorePolicyFingerprint(incoming, false) },
    ignoreRules: { filename: ".syncignore", text: incoming },
  };
  const { head: pinned } = await backend.publishSnapshot(
    recorded,
    { kind: "revision", revision: starting.revision },
    { signal },
  );
  signal.throwIfAborted();
  const peer = new DaemonConnection(
    owner.paths,
    owner.identity,
    {
      id: randomUUID(),
      generation: randomUUID(),
      pid: process.pid,
      cwd: root,
      mode: "rpc",
      hasUI: true,
      idle: true,
    },
    { callback: async () => true },
  );
  cleanup.defer(() => peer.dispose());
  await peer.attach(signal);
  const pullFromMenu = async () => {
    listener.requests.length = 0;
    menus.length = 0;
    selected = false;
    await command.handler("", ctx);
    signal.throwIfAborted();
  };
  return async () => {
    signal.throwIfAborted();
    await pullFromMenu();
    assert.ok(
      notifications.some(({ message }) => /Another live Pi session/u.test(message)),
      JSON.stringify(notifications),
    );
    assert.equal(await readFile(rule, "utf8"), before);
    assert.ok(listener.requests.every(({ method }) => method === "GET"));
    await peer.dispose();
    await backend.publishSnapshot(
      { ...recorded, id: "new-head", files: [file("new head")] },
      { kind: "revision", revision: pinned.revision },
      { signal },
    );
    signal.throwIfAborted();
    await pullFromMenu();
    assert.ok(
      menus.some(
        (choices) =>
          choices.some((item) => item.includes("Pull from remote")) &&
          choices.some((item) => item.includes("Stop daemon for recovery")),
      ),
    );
    assert.ok(reviews.includes("Resume reviewed ignore-rule Pull?"), JSON.stringify(notifications));
    assert.equal(await readFile(rule, "utf8"), incoming);
    assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "recorded");
    const replacement = await findDaemon(root);
    assert.ok(replacement);
    assert.notEqual(replacement.identity.pid, owner.identity.pid);
    assert.equal(reloads, 0);
    assert.ok(listener.requests.length > 0 && listener.requests.every(({ method }) => method === "GET"));
    const jobs = (await readClientDebug(root))
      .filter((entry) => entry.event === "job")
      .filter((entry) => entry.operation === "pull.foreground");
    assert.deepEqual(
      jobs.map((entry) => entry.outcome),
      ["started", "failed", "started", "completed"],
    );
    assert.ok(jobs[0]?.operationId && jobs[2]?.operationId);
    assert.equal(jobs[0].operationId, jobs[1]?.operationId);
    assert.equal(jobs[2].operationId, jobs[3]?.operationId);
    assert.notEqual(jobs[0].operationId, jobs[2].operationId);
    assert.doesNotMatch(JSON.stringify(jobs), /Another live Pi session|notes\.md|recorded/u);
  };
}

test("the built Pull action reselects and resumes a recorded adoption without reloading Pi", () => {
  running = verify();
  return running;
});
