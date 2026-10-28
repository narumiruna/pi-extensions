import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark");

// Exercise Pi's real screen replacement methods without starting a terminal or session.
function createHost() {
  let focused: Component | undefined;
  const editor = { getText: () => "draft", setText() {} };
  const extensionDialogs: { component: Component }[] = [];
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
    extensionDialogs,
    programStatus: { setBlocked() {} },
    ui: {
      terminal: { rows: 30 },
      setFocus(component: Component) {
        focused = component;
      },
      requestRender() {},
    },
  }) as {
    showExtensionCustom: ExtensionCommandContext["ui"]["custom"];
  };
  return { host, container, editor, extensionDialogs, focused: () => focused };
}

for (const answer of ["save", "escape", "abort", "remapped save", "hard cancel"] as const) {
  test(`settings ${answer} restores the editor without consent or screen remount`, async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-settings-handoff-"));
    const runtime = createUsageSettingsRuntime(join(root, "pi-usage.json"));
    await runtime.reload();
    const { host, container, editor, extensionDialogs, focused } = createHost();
    const controller = new AbortController();

    const bindings = getKeybindings();
    const previousBindings = bindings.getUserBindings();
    const remapped = answer === "remapped save";
    if (remapped)
      bindings.setUserBindings({
        "tui.select.down": "ctrl+n",
        "tui.select.confirm": "ctrl+y",
        "tui.select.cancel": "ctrl+x",
      });

    const confirm = remapped ? "\u0019" : "\r";
    const cancel = remapped ? "\u0018" : "\u001b";
    const accepted = answer === "save" || remapped;
    let applied = 0;
    let screenCount = 0;
    let consentCalls = 0;
    const context = createMockContext({ mode: "tui", hasUI: true });
    const ctx = context.ctx as ExtensionCommandContext;
    Object.assign(ctx.ui, {
      custom: (...args: Parameters<typeof host.showExtensionCustom>) => {
        screenCount++;
        return host.showExtensionCustom(...args);
      },
      confirm: async () => {
        consentCalls++;
        return true;
      },
    });
    const operation = showUsageSettings(
      ctx,
      runtime,
      controller.signal,
      () => true,
      () => {
        applied++;
      },
    );
    try {
      await vi.waitFor(() => assert.ok(focused()?.handleInput));
      assert.deepEqual(
        extensionDialogs.map((dialog) => dialog.component),
        [focused()],
      );
      assert.match(focused()?.render(100).join("\n") ?? "", /Use Codex login for OpenAI usage/);
      if (accepted) {
        focused()?.handleInput?.(confirm);
        await vi.waitFor(() => assert.equal(runtime.get().settings.codexFastMode, true));
      }
      if (answer === "abort") controller.abort();
      else focused()?.handleInput?.(answer === "hard cancel" ? "\u0003" : cancel);
      assert.equal(await operation, accepted);
      assert.equal(consentCalls, 0);
      assert.equal(screenCount, 1);
      assert.deepEqual(container.children, [editor]);
      assert.equal(focused(), editor);
      assert.deepEqual(extensionDialogs, []);

      assert.equal(applied, accepted ? 1 : 0);
      assert.equal(runtime.get().settings.codexFastMode, accepted);
    } finally {
      controller.abort();
      await operation;
      bindings.setUserBindings(previousBindings);
      await runtime.flush();
      await rm(root, { recursive: true, force: true });
    }
  });
}
