import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark", false);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Pi disposal without resolving custom drains a winning credential rename without restoring the old settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kimi-usage-host-disposal-"));
  const path = join(root, "pi-usage.json");
  await writeFile(path, JSON.stringify({ kimiCodingUsageApiKey: "prior-key" }), { mode: 0o600 });
  const entered = gate();
  const release = gate();
  const runtime = createUsageSettingsRuntime({
    path,
    operations: {
      rename: async (from, to) => {
        entered.resolve();
        await release.promise;
        await rename(from, to);
      },
    },
  });
  await runtime.reload();
  let focused: (Component & { dispose?(): void }) | undefined;
  const editor = { getText: () => "draft", setText() {} };
  const dialogs: { component: Component & { dispose?(): void } }[] = [];
  const container = {
    children: [] as Component[],
    clear() {
      this.children = [];
    },
    addChild(component: Component) {
      this.children.push(component);
    },
  };
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    editor,
    editorContainer: container,
    extensionDialogs: dialogs,
    keybindings: getKeybindings(),
    programStatus: { setBlocked() {} },
    ui: {
      terminal: { rows: 30 },
      setFocus(component: Component) {
        focused = component;
      },
      requestRender() {},
    },
  }) as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"]; showTopExtensionDialog(): void };
  let opened = 0;
  let resolved = 0;
  let forceClose: (() => void) | undefined;
  const context = createMockContext({ mode: "tui", hasUI: true });
  const ctx = context.ctx as ExtensionCommandContext;
  ctx.ui.custom = <T>(
    factory: Parameters<typeof host.showExtensionCustom<T>>[0],
    options?: Parameters<typeof host.showExtensionCustom<T>>[1],
  ) =>
    host
      .showExtensionCustom<T>((tui, theme, keybindings, done) => {
        opened++;
        forceClose = () => done(undefined as never);
        return factory(tui, theme, keybindings, done);
      }, options)
      .then((value) => {
        resolved++;
        return value;
      });
  const owner = new AbortController();
  const applied: { id: string; closed: boolean }[] = [];
  let settled = false;
  const running = showUsageSettings(
    ctx,
    runtime,
    owner.signal,
    () => true,
    (id, closed) => {
      applied.push({ id, closed });
    },
  ).finally(() => {
    settled = true;
  });
  t.onTestFinished(async () => {
    owner.abort();
    release.resolve();
    // Test cleanup alone may resolve a host callback that a real reset leaves pending.
    forceClose?.();
    await running;
    await runtime.flush();
    await rm(root, { recursive: true, force: true });
  });
  await vi.waitFor(() => assert.ok(focused?.render(100).join("\n").includes("pi-usage Settings")));
  for (let row = 0; row < 5; row++) focused?.handleInput?.("\u001b[B");
  focused?.handleInput?.("\r");
  focused?.handleInput?.("\r");
  await vi.waitFor(() => assert.ok(focused?.render(100).join("\n").includes("Official Kimi usage key")));
  focused?.handleInput?.("replacement-key");
  focused?.handleInput?.("\r");
  await entered.promise;
  assert.equal(opened, 3);
  assert.equal(resolved, 2);
  focused?.invalidate();
  for (const width of [0, 1, 12, 40, 120]) {
    assert.ok(focused?.render(width).every((line) => visibleWidth(line) <= width));
  }
  // Match resetExtensionUI's dialog branch: dispose and remove without invoking done().
  for (const dialog of dialogs) dialog.component.dispose?.();
  dialogs.splice(0);
  host.showTopExtensionDialog();
  await Promise.resolve();
  assert.equal(settled, false, "disposal must retain disk-task ownership until publication settles");
  release.resolve();
  await vi.waitFor(() => assert.equal(settled, true));
  assert.equal(await running, true);
  assert.equal(resolved, 2, "the save host's custom promise deliberately never settled");
  assert.equal(opened, 3, "disposal must not reopen Settings");
  assert.deepEqual(applied, [{ id: "kimiCodingUsageApiKey", closed: true }]);
  assert.equal(JSON.parse(await readFile(path, "utf8")).kimiCodingUsageApiKey, "replacement-key");
  assert.deepEqual(container.children, [editor]);
  assert.deepEqual(dialogs, []);
});
