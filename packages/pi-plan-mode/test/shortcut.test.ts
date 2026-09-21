import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CustomEditor,
  DefaultResourceLoader,
  type ExtensionContext,
  ExtensionRunner,
  getSelectListTheme,
  InteractiveMode,
  initTheme,
  type KeybindingsManager,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type KeyId, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import planMode from "../src/plan-mode.js";
import * as settingsModule from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

const KEY = "ctrl+alt+p";
const NEXT_KEY = "ctrl+alt+y";
const INPUT = "\u001b[112;7u";
const NEXT_INPUT = "\u001b[121;7u";

type AppKeybindings = KeybindingsManager & {
  getEffectiveConfig(): Parameters<ExtensionRunner["getShortcuts"]>[0];
};

async function withShortcut(
  initial: KeyId | undefined,
  run: (fixture: Awaited<ReturnType<typeof createShortcutFixture>>) => Promise<void>,
) {
  const fixture = await createShortcutFixture(initial);
  try {
    await run(fixture);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.dispose();
    setKittyProtocolActive(false);
  }
}

async function createShortcutFixture(initial: KeyId | undefined) {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-shortcut-"));
  const settingsPath = join(root, "pi-plan-mode.json");
  const tui = createTuiHarness();
  const sessionManager = SessionManager.inMemory(root);
  const context = createMockContext({ cwd: root, mode: "tui", hasUI: true, sessionManager, custom: tui.custom });
  const ctx = context.ctx as ExtensionContext;
  const mock = createMockPi({ activeTools: ["read", "write"], thinkingLevel: "low" });
  const errors: unknown[] = [];
  const reads: settingsModule.PlanModeSettingsLoadResult[] = [];
  const readSettings = settingsModule.readPlanModeSettings;
  vi.spyOn(settingsModule, "readPlanModeSettings").mockImplementation(async (path) => {
    const result = await readSettings(path);
    reads.push(result);
    return result;
  });
  await writeFile(settingsPath, JSON.stringify({ toggleShortcut: initial }));
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => planMode(pi, { settingsPath })],
  });
  // Pi exports the UI keybinding type, but not its app keybinding constructor.
  // This test-only import uses the installed implementation, including reserved-key conflicts.
  const { KeybindingsManager: AppKeys } = (await import(
    new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
  )) as { KeybindingsManager: new () => AppKeybindings };
  const keybindings = new AppKeys();
  initTheme("dark");
  const editor = new CustomEditor(
    { requestRender() {} } as never,
    { borderColor: (text) => text, selectList: getSelectListTheme() },
    keybindings,
  );
  let runner: ExtensionRunner;
  const bind = async (reason: "startup" | "reload") => {
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sessionManager, ctx.modelRegistry as never);
    runner.bindCore({ ...mock.rawPi, refreshTools() {}, getCommands: () => [], setLabel() {} } as never, {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => false,
      getSignal: () => undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
      getSystemPromptOptions: () => ({ cwd: root }),
    });
    runner.setUIContext(ctx.ui, "tui");
    runner.onError((error) => errors.push(error));
    await runner.emit({ type: "session_start", reason });
    const host = {
      keybindings,
      defaultEditor: editor,
      createExtensionUIContext: () => ctx.ui,
      sessionManager,
      session: { isIdle: true, scopedModels: [], agent: {}, pendingMessageCount: 0 },
      settingsManager: { isProjectTrusted: () => false },
      showError: (error: unknown) => errors.push(error),
    };
    // Exercise Pi's actual snapshot and editor dispatch without starting a terminal or provider.
    const setupShortcuts = Reflect.get(InteractiveMode.prototype, "setupExtensionShortcuts");
    assert.equal(typeof setupShortcuts, "function");
    setupShortcuts.call(host, runner);
  };
  const shutdown = async () => {
    await runner.emit({ type: "session_shutdown", reason: "reload" });
    // InteractiveMode.resetExtensionUI detaches this callback before runtime replacement.
    editor.onExtensionShortcut = undefined;
    runner.invalidate();
  };
  try {
    await bind("startup");
  } catch (error) {
    await shutdown().catch(() => undefined);
    tui.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    tui,
    context,
    errors,
    mock,
    settingsPath,
    get runner() {
      return runner;
    },
    registrations: () => new Map(loader.getExtensions().extensions[0]?.shortcuts),
    active: () => context.statuses.get("plan-mode") === "plan active",
    press: (data: string) => editor.handleInput(data),
    async change(next: KeyId | undefined) {
      reads.length = 0;
      const temporaryPath = join(root, "next.json");
      await writeFile(temporaryPath, JSON.stringify({ toggleShortcut: next, thinkingLevel: "high" }));
      await rename(temporaryPath, settingsPath);
      await vi.waitFor(() =>
        assert.ok(
          reads.some(
            (result) =>
              result.kind === "loaded" &&
              result.settings.toggleShortcut === next &&
              result.settings.thinkingLevel === "high",
          ),
        ),
      );
    },
    async reload() {
      await shutdown();
      await bind("reload");
    },
    async dispose() {
      await shutdown();
      tui.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const [name, initial, next] of [
  ["enable", undefined, KEY],
  ["change", KEY, NEXT_KEY],
  ["disable", KEY, undefined],
] as const) {
  test(`watched shortcut ${name} stays pending until runtime reload`, async () => {
    await withShortcut(initial, async (f) => {
      const startup = f.registrations();
      await f.change(next);
      assert.deepEqual(f.registrations(), startup, "settings reload must not change Pi's registered shortcuts");
      f.press(INPUT);
      assert.equal(f.active(), initial !== undefined);
      if (initial) f.press(INPUT);
      f.press(NEXT_INPUT);
      assert.equal(f.active(), false);
      // Other settings still reload: the next Plan workflow uses the new thinking default.
      await f.runner.getCommand("plan")?.handler("start", f.runner.createCommandContext());
      assert.equal(f.mock.thinkingLevel, "high");
      await f.runner.getCommand("plan")?.handler("off", f.runner.createCommandContext());
      // Older hosts can reuse a factory on session start; only a fresh runtime may rebind.
      await f.runner.emit({ type: "session_start", reason: "new" });
      assert.deepEqual(f.registrations(), startup);
      await f.reload();
      assert.deepEqual([...f.registrations().keys()], next ? [next] : []);
      f.press(next === NEXT_KEY ? NEXT_INPUT : INPUT);
      assert.equal(f.active(), next !== undefined);
    });
  });
}

for (const boundary of ["shutdown", "replacement"] as const) {
  test(`delayed startup settings cannot register a shortcut after ${boundary}`, async () => {
    let resolveRead!: (result: settingsModule.PlanModeSettingsLoadResult) => void;
    const pendingRead = new Promise<settingsModule.PlanModeSettingsLoadResult>((resolve) => {
      resolveRead = resolve;
    });
    let reads = 0;
    const mock = createMockPi();
    planMode(mock.pi, {
      readSettings: () =>
        ++reads === 1
          ? pendingRead
          : Promise.resolve({
              kind: "loaded",
              settings: { thinkingLevel: "inherit", toggleShortcut: NEXT_KEY },
            }),
    });
    const oldContext = createMockContext({ mode: "tui", hasUI: true });
    const start = mock.events.get("session_start")?.[0];
    const shutdown = mock.events.get("session_shutdown")?.[0];
    assert.ok(start);
    assert.ok(shutdown);
    const pendingStart = start({ reason: "startup" }, oldContext.ctx);
    const nextContext = createMockContext({ mode: "tui", hasUI: true });
    if (boundary === "replacement") await start({ reason: "new" }, nextContext.ctx);
    else await shutdown({ reason: "quit" }, oldContext.ctx);
    resolveRead({ kind: "loaded", settings: { thinkingLevel: "inherit", toggleShortcut: KEY } });
    await pendingStart;
    assert.deepEqual([...mock.shortcuts.keys()], boundary === "replacement" ? [NEXT_KEY] : []);
    if (boundary === "replacement") await shutdown({ reason: "quit" }, nextContext.ctx);
  });
}

for (const kitty of [false, true]) {
  test(`startup shortcut survives tree and compaction events (Kitty=${kitty})`, async () => {
    await withShortcut(KEY, async (f) => {
      setKittyProtocolActive(kitty);
      const startup = f.registrations();
      for (let cycle = 0; cycle < 3; cycle += 1) {
        f.press(INPUT);
        assert.equal(f.active(), true);
        f.press(INPUT);
        assert.equal(f.active(), false);
        await f.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
        await f.runner.emit({
          type: "session_compact",
          reason: "manual",
          fromExtension: false,
          willRetry: false,
          compactionEntry: {} as never,
        });
      }
      assert.deepEqual(f.registrations(), startup);
    });
  });
}

test("saving a shortcut in Plan Settings preserves registration until reload", async () => {
  await withShortcut(KEY, async (f) => {
    const startup = f.registrations();
    const command = f.runner.getCommand("plan");
    assert.ok(command);
    const running = command.handler("settings", f.runner.createCommandContext());
    await f.tui.waitForOpen();
    for (let index = 0; index < 6; index += 1) f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await f.tui.waitForPending();
    await f.tui.waitForOpen();
    assert.match(f.tui.render().join("\n"), /Loaded at startup: ctrl\+alt\+p/);
    f.tui.type(NEXT_KEY);
    f.tui.press("tui.input.submit");
    await f.tui.waitForPending();
    await f.tui.waitForOpen();
    f.tui.press("ctrl+c");
    await running;
    assert.deepEqual(f.registrations(), startup);
    assert.match(f.context.notifications.at(-1)?.message ?? "", /saved.*\/reload/i);
    f.press(INPUT);
    assert.equal(f.active(), true);
  });
});
