import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterAll, expect, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const previous = process.env.PI_CODING_AGENT_DIR;
const root = await mkdtemp(join(tmpdir(), "pi-files-owner-"));
process.env.PI_CODING_AGENT_DIR = root;
const { registerFileContext } = await import("../src/context-service.js");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark", false);
afterAll(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a superseded settings refresh never reads its invalidated context", async () => {
  const refreshed = deferred<{ settings: { openShortcut: "f8" } }>();
  const entered = deferred<void>();
  const mock = createMockPi();
  let loads = 0;
  await registerFileContext(mock.pi, {
    settingsPath: join(root, "refresh.json"),
    loadSettings: async () => {
      if (!loads++) return { settings: { openShortcut: "f8" } };
      entered.resolve();
      return refreshed.promise;
    },
  });
  const base = createMockContext({ mode: "json" }).ctx as unknown as ExtensionCommandContext;
  let stale = false;
  const ctx = new Proxy(base, {
    get(target, key, receiver) {
      if (stale) throw new Error(`Stale context property ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
  const starting = Promise.resolve(mock.events.get("session_start")?.[0]?.({}, ctx));
  await entered.promise;
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  stale = true;
  refreshed.resolve({ settings: { openShortcut: "f8" } });
  await expect(starting).resolves.toBeUndefined();
});

test("session disposal cancels shortcut publication even with an unrelated caller signal", async () => {
  const mock = createMockPi();
  let operation: AbortSignal | undefined;
  const service = await registerFileContext(mock.pi, {
    settingsPath: join(root, "cancel.json"),
    loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
    updateSettings: async (_key, options) => {
      operation = options?.signal;
      return new Promise((_resolve, reject) =>
        operation?.addEventListener("abort", () => reject(operation?.reason), { once: true }),
      );
    },
  });
  const ctx = createMockContext({ mode: "json" }).ctx as unknown as ExtensionCommandContext;
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  const saving = service.saveShortcut(ctx, "ctrl+y", new AbortController().signal);
  const rejected = expect(saving).rejects.toMatchObject({ name: "AbortError" });
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  await rejected;
  expect(operation?.aborted).toBe(true);
});

test("shutdown drains cancelled native work even when a widget consumer fails", async () => {
  const mock = createMockPi();
  const scan = deferred<string[]>();
  const entered = deferred<void>();
  let scanSignal: AbortSignal | undefined;
  let failDisplay = false;
  const service = await registerFileContext(mock.pi, {
    settingsPath: join(root, "drain.json"),
    loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
    discoverFiles: async (_root, options) => {
      scanSignal = options?.signal;
      entered.resolve();
      return scan.promise;
    },
    createGit: async () => undefined,
    onChange: () => {
      if (failDisplay) throw new Error("consumer failed");
    },
  });
  const tui = createTuiHarness();
  const base = createMockContext({ mode: "tui" }).ctx as unknown as ExtensionCommandContext;
  const ctx = Object.assign(base, { ui: { ...base.ui, custom: tui.custom } });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  const browsing = service.browse(ctx);
  await entered.promise;
  failDisplay = true;
  let settled = false;
  const shutdown = Promise.resolve(mock.events.get("session_shutdown")?.[0]?.({}, ctx)).finally(() => {
    settled = true;
  });
  const failed = expect(shutdown).rejects.toThrow("consumer failed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(scanSignal?.aborted).toBe(true);
  expect(settled).toBe(false);
  scan.resolve([]);
  await failed;
  await browsing;
  expect(tui.isOpen).toBe(false);
});

test.each(["scan", "git"])("shutdown drains the surviving task after %s initialization fails", async (failing) => {
  const mock = createMockPi();
  const scan = deferred<string[]>();
  const git = deferred<undefined>();
  const service = await registerFileContext(mock.pi, {
    settingsPath: join(root, `sibling-${failing}.json`),
    loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
    discoverFiles: async () => {
      if (failing === "scan") throw new Error("scan failed");
      return scan.promise;
    },
    createGit: async () => {
      if (failing === "git") throw new Error("git failed");
      return git.promise;
    },
  });
  const tui = createTuiHarness();
  const base = createMockContext({ mode: "tui" }).ctx as unknown as ExtensionCommandContext;
  const ctx = Object.assign(base, { ui: { ...base.ui, custom: tui.custom } });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await service.browse(ctx);
  let settled = false;
  const shutdown = Promise.resolve(mock.events.get("session_shutdown")?.[0]?.({}, ctx)).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  scan.resolve([]);
  git.resolve(undefined);
  await shutdown;
  expect(tui.isOpen).toBe(false);
});
