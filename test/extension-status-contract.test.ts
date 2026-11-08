import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createEventBus, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "./support.js";

// Public wire shapes, not either participant's private implementation types.
const UPDATE = "extension-status:v1:update";
const REQUEST = "extension-status:v1:request";
type Update = {
  version: 1;
  sessionManager: object;
  key: string;
  value: string | undefined;
  activity?: string;
  reason?: string;
  requestId?: object;
};
type Footer = { render(width: number): string[]; dispose(): void };
type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(role: string, text: string): string; bold(text: string): string },
  data: {
    getGitBranch(): undefined;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    onBranchChange(callback: () => void): () => void;
  },
) => Footer;

let root: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let sync: typeof import("../packages/pi-sync/src/index.js").default;
let statusline: typeof import("../packages/pi-statusline/src/index.js").default;
const cleanup: Array<() => void | Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-extension-status-contract-"));
  agentDir = join(root, "agent");
  await mkdir(agentDir);
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  // Sync caches settings paths on import. Set the isolated agent scope first.
  ({ default: sync } = await import("../packages/pi-sync/src/index.js"));
  ({ default: statusline } = await import("../packages/pi-statusline/src/index.js"));
  await writeFile(join(agentDir, "pi-statusline.json"), JSON.stringify({ segments: ["model"] }));
});

afterEach(async () => {
  try {
    const failures: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Extension status cleanup failed");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function configure(showStatus = true) {
  await writeFile(
    join(agentDir, "pi-sync.json"),
    JSON.stringify({
      version: 3,
      activeSyncSetup: "offline",
      onSwitch: "ask-before-pull",
      showStatus,
      storageConnections: {
        offline: { type: "webdav", url: "http://127.0.0.1:1/dav", credentials: { username: "test", password: "test" } },
      },
      syncSetups: {
        offline: {
          storage: { connection: "offline", path: showStatus ? "status-contract" : "status-contract-disabled" },
          sync: { include: ["settings.json"], automatic: false, agentMode: true, continuous: true },
        },
      },
    }),
    { mode: 0o600 },
  );
}

function mockOn(bus: ReturnType<typeof createEventBus>) {
  const mock = createMockPi();
  mock.rawPi.events = bus;
  // The footer's Git probe is unrelated to this contract and must not spawn a child.
  Object.assign(mock.rawPi, { exec: async () => ({ code: 1, stdout: "", stderr: "" }) });
  return mock;
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, ctx: ExtensionContext, reason = "reload") {
  for (const handler of mock.events.get(name) ?? []) await handler({ type: name, reason }, ctx);
}

function mount(context: ReturnType<typeof createMockContext>) {
  assert.equal(typeof context.footer, "function");
  let renders = 0;
  const footer = (context.footer as FooterFactory)(
    { requestRender: () => renders++ },
    { fg: (_role, text) => text, bold: (text) => text },
    {
      getGitBranch: () => undefined,
      getExtensionStatuses: () =>
        new Map([...context.statuses].filter((entry): entry is [string, string] => entry[1] !== undefined)),
      onBranchChange: () => () => undefined,
    },
  );
  cleanup.push(() => footer.dispose());
  return {
    footer,
    text: () => stripVTControlCharacters(footer.render(240).slice(1).join("\n")),
    get renders() {
      return renders;
    },
  };
}

function observe(bus: ReturnType<typeof createEventBus>) {
  const updates: Update[] = [];
  cleanup.push(bus.on(UPDATE, (data) => updates.push(data as Update)));
  return updates;
}

function nextActivity(bus: ReturnType<typeof createEventBus>, activity: string) {
  let unsubscribe = () => {};
  const promise = new Promise<Update>((resolve) => {
    unsubscribe = bus.on(UPDATE, (data) => {
      const update = data as Update;
      if (update.activity === activity && update.requestId === undefined) {
        unsubscribe();
        resolve(update);
      }
    });
  });
  cleanup.push(() => unsubscribe());
  return promise;
}

const unexpectedLoader = async () => {
  throw new Error("Unexpected backend, snapshot, command, or model-work loader");
};
const unusedLoaders = {
  loadSyncOperations: unexpectedLoader,
  loadSnapshot: unexpectedLoader,
  loadSyncState: unexpectedLoader,
  loadSetupSwitch: unexpectedLoader,
  loadCommandHandler: unexpectedLoader,
};

function unchangedInspection(include: string[]) {
  return {
    head: {
      snapshotRef: "offline",
      snapshotId: "offline",
      revision: "offline",
      createdAt: "2026-11-08T00:00:00.000Z",
      machine: "test",
      syncSessions: false,
      selection: { version: 1 as const, include },
    },
    selectionState: { kind: "same" as const, include },
    localFiles: 0,
    localChanged: false,
    remoteChanged: false,
    firstSync: false,
    emptyInclude: false,
    stateIdentity: "offline",
    localIdentity: "offline",
    destination: "offline storage",
    capability: "read-check-write-verify" as const,
  };
}

for (const order of ["sync-first", "statusline-first"] as const) {
  test(`${order}: real factories share live activity and read-only snapshots without hiding raw standby`, async () => {
    await configure();
    const bus = createEventBus();
    const updates = observe(bus);
    const requests: Array<{ requestId: object }> = [];
    cleanup.push(bus.on(REQUEST, (data) => requests.push(data as { requestId: object })));
    const producer = mockOn(bus);
    const consumer = mockOn(bus);
    const release = deferred();
    const entered = deferred();
    let inspections = 0;
    const registerProducer = () =>
      sync(producer.pi, {
        ...unusedLoaders,
        loadSyncInspection: async () => ({
          inspectSync: async (config, _options, signal) => {
            inspections++;
            entered.resolve();
            await Promise.race([
              release.promise,
              new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return unchangedInspection(config.include);
          },
        }),
      });
    if (order === "statusline-first") statusline(consumer.pi);
    registerProducer();
    if (order === "sync-first") statusline(consumer.pi);
    const context = createMockContext({ mode: "tui", cwd: root });
    cleanup.push(() => emit(producer, "session_shutdown", context.ctx));
    cleanup.push(() => emit(consumer, "session_shutdown", context.ctx));
    const checking = nextActivity(bus, "checking");
    let host: ReturnType<typeof mount> | undefined;
    if (order === "statusline-first") {
      await emit(consumer, "session_start", context.ctx);
      host = mount(context);
    }
    await emit(producer, "session_start", context.ctx);
    await checking;
    await entered.promise;
    if (order === "sync-first") await emit(consumer, "session_start", context.ctx);
    host ??= mount(context);
    const consumerRequestId = requests.at(-1)?.requestId;
    assert.ok(consumerRequestId);
    assert.equal(context.statuses.get("sync"), "sync checking");
    assert.match(host.text(), /🔄 …/u);

    const requestId = {};
    const before = updates.length;
    bus.emit(REQUEST, { version: 1, sessionManager: (context.ctx as ExtensionContext).sessionManager, requestId });
    const snapshot = updates.slice(before).find((update) => update.requestId === requestId);
    assert.equal(snapshot?.activity, "checking");
    assert.equal(snapshot?.value, context.statuses.get("sync"));
    assert.equal(inspections, 1, "snapshots do not inspect storage or restart work");

    const idle = nextActivity(bus, "idle");
    release.resolve();
    await idle;
    assert.equal(context.statuses.get("sync"), "sync waiting for changes", "native/RPC raw text is retained");
    assert.equal(host.text(), "");

    context.statuses.set("unrelated", "unrelated raw standby");
    context.statuses.set("reviewer", "reviewer needs attention");
    bus.emit(UPDATE, {
      version: 1,
      sessionManager: (context.ctx as ExtensionContext).sessionManager,
      key: "reviewer",
      value: "reviewer needs attention",
      activity: "review",
    });
    bus.emit(UPDATE, {
      version: 1,
      sessionManager: (context.ctx as ExtensionContext).sessionManager,
      key: "reviewer",
      value: "reviewer needs attention",
      activity: "idle",
      requestId: consumerRequestId,
    });
    assert.match(host.text(), /⇕/u, "a late snapshot cannot replace live review");
    assert.match(host.text(), /raw standby/u);
    assert.doesNotMatch(host.text(), /waiting for changes/u);

    // A raw replacement cannot inherit the former idle annotation.
    context.statuses.set("sync", "sync unannotated replacement");
    assert.match(host.text(), /unannotated replacement/u);
    bus.emit(UPDATE, {
      version: 99,
      sessionManager: (context.ctx as ExtensionContext).sessionManager,
      key: "reviewer",
      value: "reviewer needs attention",
      activity: "idle",
    });
    assert.match(host.text(), /needs attention/u, "unsupported metadata restores raw fallback");
  });
}

test("actual blocked publication retains its reason; Show sync status Off suppresses raw and metadata", async () => {
  await configure();
  const bus = createEventBus();
  const updates = observe(bus);
  const producer = mockOn(bus);
  const consumer = mockOn(bus);
  sync(producer.pi, {
    ...unusedLoaders,
    loadSyncInspection: async () => ({
      inspectSync: async () => {
        throw Object.assign(new Error("synthetic authentication failure"), { status: 401 });
      },
    }),
  });
  statusline(consumer.pi);
  const context = createMockContext({ mode: "tui", cwd: root });
  cleanup.push(() => emit(producer, "session_shutdown", context.ctx));
  cleanup.push(() => emit(consumer, "session_shutdown", context.ctx));
  await emit(consumer, "session_start", context.ctx);
  const host = mount(context);
  const blocked = nextActivity(bus, "blocked");
  await emit(producer, "session_start", context.ctx);
  const update = await blocked;
  assert.equal(update.reason, "auth");
  assert.equal(context.statuses.get("sync"), "sync blocked: authentication");
  assert.match(host.text(), /🔄 ! auth/u);

  // The existing preference is read again on session start; no private settings API is used.
  await emit(producer, "session_shutdown", context.ctx);
  await configure(false);
  const blockedNotice = deferred();
  const disabled = createMockContext({ mode: "tui", cwd: root });
  const disabledCtx = disabled.ctx as ExtensionCommandContext;
  const notify = disabledCtx.ui.notify.bind(disabledCtx.ui);
  disabledCtx.ui.notify = (message, level) => {
    notify(message, level);
    if (message.includes("Continuous sync blocked")) blockedNotice.resolve();
  };
  cleanup.push(() => emit(producer, "session_shutdown", disabled.ctx));
  const before = updates.length;
  await emit(producer, "session_start", disabled.ctx);
  await blockedNotice.promise;
  assert.equal(disabled.statuses.get("sync"), undefined);
  assert.equal(
    updates.slice(before).some((entry) => entry.value !== undefined),
    false,
  );
  const requestId = {};
  bus.emit(REQUEST, { version: 1, sessionManager: disabledCtx.sessionManager, requestId });
  const disabledSnapshot = updates.find((entry) => entry.requestId === requestId);
  assert.ok(disabledSnapshot, "disabled publishers answer with an explicit withdrawal");
  assert.equal(disabledSnapshot.value, undefined);

  await configure();
  const reenabled = nextActivity(bus, "blocked");
  await emit(producer, "session_start", disabled.ctx);
  await reenabled;
  assert.equal(disabled.statuses.get("sync"), "sync blocked: authentication");
});

test("footer disposal, replacement, reload, and shutdown reject old-session metadata and snapshots", async () => {
  const bus = createEventBus();
  const updates = observe(bus);
  const producer = mockOn(bus);
  const consumer = mockOn(bus);
  sync(producer.pi);
  statusline(consumer.pi);
  const first = createMockContext({ mode: "tui", cwd: root });
  cleanup.push(() => emit(producer, "session_shutdown", first.ctx));
  cleanup.push(() => emit(consumer, "session_shutdown", first.ctx));
  await emit(producer, "session_start", first.ctx);
  await emit(consumer, "session_start", first.ctx);
  const old = mount(first);
  const oldManager = (first.ctx as ExtensionContext).sessionManager;
  first.statuses.set("third-party", "third-party active");
  bus.emit(UPDATE, {
    version: 1,
    sessionManager: oldManager,
    key: "third-party",
    value: "third-party active",
    activity: "working",
  });
  assert.match(old.text(), /↻/u);
  old.footer.dispose();
  const disposedRenders = old.renders;
  bus.emit(UPDATE, {
    version: 1,
    sessionManager: oldManager,
    key: "third-party",
    value: "third-party active",
    activity: "idle",
  });
  assert.equal(old.renders, disposedRenders);

  const second = createMockContext({ mode: "tui", cwd: root });
  cleanup.push(() => emit(producer, "session_shutdown", second.ctx));
  cleanup.push(() => emit(consumer, "session_shutdown", second.ctx));
  await emit(producer, "session_start", second.ctx);
  await emit(consumer, "session_start", second.ctx);
  const current = mount(second);
  second.statuses.set("third-party", "third-party active");
  const requestId = {};
  const before = updates.length;
  bus.emit(REQUEST, { version: 1, sessionManager: oldManager, requestId });
  assert.equal(
    updates.slice(before).some((entry) => entry.requestId === requestId),
    false,
  );
  bus.emit(UPDATE, {
    version: 1,
    sessionManager: oldManager,
    key: "third-party",
    value: "third-party active",
    activity: "idle",
  });
  assert.match(current.text(), /active/u, "another session cannot hide matching raw text");

  await emit(producer, "session_shutdown", second.ctx);
  await emit(consumer, "session_shutdown", second.ctx);
  current.footer.dispose();
  assert.equal(second.footer, undefined);
  const afterShutdown = updates.length;
  bus.emit(REQUEST, { version: 1, sessionManager: (second.ctx as ExtensionContext).sessionManager, requestId: {} });
  assert.equal(updates.length, afterShutdown, "shutdown releases the producer snapshot listener");

  const reloaded = mockOn(bus);
  statusline(reloaded.pi);
  cleanup.push(() => emit(reloaded, "session_shutdown", second.ctx));
  await emit(reloaded, "session_start", second.ctx);
  const reloadHost = mount(second);
  assert.match(reloadHost.text(), /active/u, "reload without a participant keeps raw fallback");
});
