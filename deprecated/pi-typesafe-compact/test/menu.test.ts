import assert from "node:assert/strict";
import { type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showTypeSafeCompactMenu } from "../src/menu.js";
import type { TypeSafeCompactSettingsRuntime, TypeSafeCompactSettingsState } from "../src/settings.js";

function memoryRuntime(
  initial: Partial<TypeSafeCompactSettingsState> = {},
  saveError?: (value: string) => Error,
  beforeSave?: (value: string, signal?: AbortSignal) => Promise<void>,
): TypeSafeCompactSettingsRuntime & {
  saved: string[];
  removals: number;
  mutationSignals: Array<AbortSignal | undefined>;
} {
  let state: TypeSafeCompactSettingsState = {
    kind: "loaded",
    path: "/agent/pi-typesafe-compact.json",
    settings: {},
    document: {},
    ...initial,
  };
  const runtime = {
    saved: [] as string[],
    removals: 0,
    mutationSignals: [] as Array<AbortSignal | undefined>,
    get: () => structuredClone(state),
    async reload() {
      return structuredClone(state);
    },
    async setApiKey(apiKey: string, signal?: AbortSignal) {
      runtime.mutationSignals.push(signal);
      await beforeSave?.(apiKey, signal);
      const failure = saveError?.(apiKey);
      if (failure) throw failure;
      runtime.saved.push(apiKey);
      state = {
        ...state,
        kind: "loaded",
        settings: { apiKey },
        document: { ...(state.document ?? {}), apiKey },
      };
      return structuredClone(state);
    },
    async removeApiKey(signal?: AbortSignal) {
      runtime.mutationSignals.push(signal);
      runtime.removals += 1;
      const document = { ...(state.document ?? {}) };
      delete document.apiKey;
      state = { ...state, kind: "loaded", settings: {}, document };
      return structuredClone(state);
    },
    async flush() {},
  };
  return runtime;
}

function remappedKeybindings() {
  const mapping: Record<string, string> = {
    "tui.select.up": "u",
    "tui.select.down": "d",
    "tui.select.pageUp": "U",
    "tui.select.pageDown": "D",
    "tui.select.confirm": "c",
    "tui.select.cancel": "q",
    "tui.input.submit": "s",
  };
  return {
    matches: (data: string, binding: string) => mapping[binding] === data,
    getKeys: (binding: string): KeyId[] => {
      const key = mapping[binding];
      return key ? [key as KeyId] : [];
    },
  };
}

async function waitForOpenCount(
  tui: ReturnType<typeof createTuiHarness>,
  count: number,
  running: Promise<unknown>,
): Promise<void> {
  for (let turn = 0; tui.openCount < count && turn < 100; turn += 1) {
    const settled = await Promise.race([
      running.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    if (settled) break;
  }
  assert.equal(tui.openCount, count);
}

async function openSecretInput(tui: ReturnType<typeof createTuiHarness>, running: Promise<unknown>): Promise<void> {
  await tui.waitForOpen();
  tui.send("c");
  await waitForOpenCount(tui, 2, running);
  const settingsFrame = tui.render().join("\n");
  assert.match(settingsFrame, /TypeSafe Compact Settings/u);
  assert.equal(settingsFrame.includes("\u202e"), false);
  tui.send("c");
  await waitForOpenCount(tui, 3, running);
  tui.setFocused(true);
}

test("TUI saves pasted secrets through masked input with remapped keys and narrow rendering", async () => {
  const runtime = memoryRuntime({ path: "/agent/\u001b[31m\u202epi-typesafe-compact.json" });
  const tui = createTuiHarness({ width: 30, rows: 16, keybindings: remappedKeybindings() });
  const { ctx, notifications } = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
  });
  const running = showTypeSafeCompactMenu(runtime, ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  await openSecretInput(tui, running);
  const secret = "pasted-typesafe-secret";
  tui.send(`\u001b[200~${secret}\u001b[201~`);
  const frame = tui.resize({ width: 18 });
  assert.ok(frame.every((line) => visibleWidth(line) <= 18));
  assert.doesNotMatch(frame.join("\n"), new RegExp(secret, "u"));
  assert.match(frame.join("\n"), /•+/u);
  tui.send("s");
  await running;

  assert.deepEqual(runtime.saved, [secret]);
  assert.deepEqual(runtime.mutationSignals, [undefined]);
  assert.equal(runtime.get().settings.apiKey, secret);
  assert.doesNotMatch(JSON.stringify(notifications), new RegExp(secret, "u"));
  assert.equal(JSON.stringify(notifications).includes("\u001b"), false);
  assert.equal(JSON.stringify(notifications).includes("\u202e"), false);
  assert.match(notifications.at(-1)?.message ?? "", /saved to/u);
});

test("a submitted save finishes after UI ownership becomes stale", async () => {
  let markSaveStarted = () => {};
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  let releaseSave = () => {};
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const runtime = memoryRuntime({}, undefined, async () => {
    markSaveStarted();
    await saveGate;
  });
  const tui = createTuiHarness({ keybindings: remappedKeybindings() });
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const controller = new AbortController();
  const running = showTypeSafeCompactMenu(runtime, ctx, {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  });

  await openSecretInput(tui, running);
  tui.type("durable-secret");
  tui.send("s");
  await saveStarted;
  controller.abort();
  releaseSave();
  await running;

  assert.deepEqual(runtime.saved, ["durable-secret"]);
  assert.deepEqual(runtime.mutationSignals, [undefined]);
  assert.equal(runtime.get().settings.apiKey, "durable-secret");
  assert.equal(
    notifications.some(({ message }) => message.includes("saved to")),
    false,
  );
});

test("failed saves preserve state and redact the submitted key from errors", async () => {
  const oldKey = "old-secret";
  const runtime = memoryRuntime(
    { settings: { apiKey: oldKey }, document: { apiKey: oldKey } },
    (value) => new Error(`could not persist ${value}`),
  );
  const tui = createTuiHarness({ keybindings: remappedKeybindings() });
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = showTypeSafeCompactMenu(runtime, ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await openSecretInput(tui, running);
  const rejected = "rejected-secret";
  tui.type(rejected);
  tui.send("s");
  await running;

  assert.equal(runtime.get().settings.apiKey, oldKey);
  assert.deepEqual(runtime.saved, []);
  assert.doesNotMatch(JSON.stringify(notifications), /rejected-secret/u);
  assert.match(notifications.at(-1)?.message ?? "", /\[REDACTED\]/u);
});

test("remove requires confirmation and cancellation or disposal cannot mutate settings", async () => {
  const key = "configured-secret";
  const runtime = memoryRuntime({ settings: { apiKey: key }, document: { apiKey: key } });
  const tui = createTuiHarness({ keybindings: remappedKeybindings() });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = showTypeSafeCompactMenu(runtime, context.ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await tui.waitForOpen();
  tui.send("c");
  await waitForOpenCount(tui, 2, running);
  tui.send("d");
  tui.send("c");
  await waitForOpenCount(tui, 3, running);
  assert.match(tui.render().join("\n"), /Remove TypeSafe API key/u);
  tui.send("q");
  await running;
  assert.equal(runtime.removals, 0);
  assert.equal(runtime.get().settings.apiKey, key);

  const disposedTui = createTuiHarness({ keybindings: remappedKeybindings() });
  const disposedContext = createMockContext({ mode: "tui", hasUI: true, custom: disposedTui.custom });
  const disposed = showTypeSafeCompactMenu(runtime, disposedContext.ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await disposedTui.waitForOpen();
  disposedTui.dispose();
  await disposed;
  assert.equal(runtime.removals, 0);
});

test("confirmed removal clears the key", async () => {
  const key = "configured-secret";
  const runtime = memoryRuntime({ settings: { apiKey: key }, document: { apiKey: key } });
  const tui = createTuiHarness({ keybindings: remappedKeybindings() });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = showTypeSafeCompactMenu(runtime, context.ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await tui.waitForOpen();
  tui.send("c");
  await waitForOpenCount(tui, 2, running);
  tui.send("d");
  tui.send("c");
  await waitForOpenCount(tui, 3, running);
  tui.send("c");
  await running;
  assert.equal(runtime.removals, 1);
  assert.deepEqual(runtime.mutationSignals, [undefined]);
  assert.equal(runtime.get().settings.apiKey, undefined);
});

test("stale ownership after secret entry prevents persistence", async () => {
  const runtime = memoryRuntime();
  const tui = createTuiHarness({ keybindings: remappedKeybindings() });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  let current = true;
  const running = showTypeSafeCompactMenu(runtime, context.ctx, {
    signal: new AbortController().signal,
    isCurrent: () => current,
  });
  await openSecretInput(tui, running);
  tui.type("stale-secret");
  current = false;
  tui.send("s");
  await running;
  assert.deepEqual(runtime.saved, []);
  assert.equal(runtime.get().settings.apiKey, undefined);
});

test("RPC reports only presence and path while print and JSON reject secret collection", async () => {
  const secret = "never-display-this";
  const runtime = memoryRuntime({
    path: "/agent/\u001b[31m\u202epi-typesafe-compact.json",
    settings: { apiKey: secret },
    document: { apiKey: secret },
  });
  const rpc = createMockContext({ mode: "rpc", hasUI: true });
  await showTypeSafeCompactMenu(runtime, rpc.ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assert.match(rpc.notifications[0]?.message ?? "", /configured/u);
  assert.match(rpc.notifications[0]?.message ?? "", /pi-typesafe-compact\.json/u);
  assert.equal(JSON.stringify(rpc.notifications).includes(secret), false);
  assert.equal(JSON.stringify(rpc.notifications).includes("\u001b"), false);
  assert.equal(JSON.stringify(rpc.notifications).includes("\u202e"), false);

  for (const mode of ["print", "json"] as const) {
    const context = createMockContext({ mode, hasUI: false });
    await assert.rejects(
      showTypeSafeCompactMenu(runtime, context.ctx, {
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
      /requires TUI or RPC UI support/u,
    );
  }
});
