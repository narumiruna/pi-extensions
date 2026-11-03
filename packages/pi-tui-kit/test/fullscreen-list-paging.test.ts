import assert from "node:assert/strict";
import type { Component, KeybindingsConfig } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { plainTuiText } from "../../../test/tui-text.js";
import { createMenuScreenComponent } from "../src/components/index.js";
import { type CustomInteractionComponent, runCustomInteraction } from "../src/custom-interaction.js";
import { runLiveChoice } from "../src/live-choice.js";
import { runThinkingSelector } from "../src/pi-selectors.js";
import type { MenuScreen } from "../src/types.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

const items = Array.from({ length: 24 }, (_, index) => ({ id: `item-${index}`, label: `Item ${index}` }));

const screens: Array<{ screen: MenuScreen<string, string>; pageDownIndex: number }> = [
  {
    screen: { kind: "actions", title: "Actions", items: items.map((item) => ({ ...item, action: "apply" })) },
    pageDownIndex: 10,
  },
  { screen: { kind: "choice", title: "Choice", items, action: "apply", viewportSize: 6 }, pageDownIndex: 6 },
  {
    screen: {
      kind: "settings",
      title: "Settings",
      items: items.map((item) => ({ ...item, currentValue: "Off", values: ["Off", "On"], action: "apply" })),
    },
    pageDownIndex: 23,
  },
  {
    screen: {
      kind: "multiSelect",
      title: "Multi-select",
      items: items.map((item) => ({ ...item, selected: false })),
      action: "apply",
      viewportSize: 6,
    },
    pageDownIndex: 6,
  },
  {
    screen: {
      kind: "browse",
      title: "Browse",
      items: items.map((item) => ({ ...item, details: [item.label] })),
      viewportSize: 6,
    },
    pageDownIndex: 6,
  },
];

for (const mode of ["regular", "fullscreen"] as const) {
  for (const remapped of [false, true]) {
    for (const { screen, pageDownIndex } of screens) {
      test(`${mode} ${screen.kind} captures ${remapped ? "Ctrl+V" : "default"} paging without activation`, async (t) => {
        const fixture = createRendererHost(mode, rendererTheme(), {
          bindings: {
            "tui.select.cancel": "ctrl+q",
            ...(remapped
              ? {
                  "tui.select.pageUp": "ctrl+u",
                  "tui.select.pageDown": "ctrl+v",
                  "tui.altScreen.pageUp": "ctrl+u",
                  "tui.altScreen.pageDown": "ctrl+v",
                }
              : {}),
          },
        });
        t.onTestFinished(() => fixture.stop());
        let selected: string | undefined;
        let writes = 0;
        const running = runCustomInteraction(fixture.ctx, {
          create: ({ tui, theme, keybindings, complete }) =>
            createMenuScreenComponent({
              screen,
              tui,
              theme,
              keybindings,
              onSelectionChange: (itemId) => {
                selected = itemId;
              },
              onSettingChange: async () => {
                writes++;
                return true;
              },
              onMultiSelectChange: async () => {
                writes++;
                return true;
              },
              onEvent: (event) => complete(event.kind),
            }),
        });
        await fixture.waitForOpen();
        assert.equal(fixture.component.capturesViewportInput, true);
        const before = fixture.scroll.scrollTop;
        const down = remapped ? "\u0016" : "\u001b[6~";
        const up = remapped ? "\u0015" : "\u001b[5~";
        if (remapped) assert.equal(fixture.keys.matches(down, "app.clipboard.pasteImage"), true);
        fixture.send(down);
        assert.equal(selected, `item-${pageDownIndex}`);
        fixture.send(up);
        assert.equal(selected, "item-0");
        assert.equal(writes, 0);
        assert.equal(fixture.scroll.scrollTop, before);
        assert.equal(fixture.editor.getValue(), "main draft");
        fixture.send("\u0003"); // Hard cancel remains independent of the configured cancel key.
        assert.deepEqual(await running, { kind: "completed", value: "close" });
        fixture.send(up);
        if (mode === "fullscreen") assert.ok(fixture.scroll.scrollTop < before);
      });
    }

    test(`${mode} native selector preserves ${remapped ? "configured" : "default"} paging through both wrappers`, async (t) => {
      const fixture = createRendererHost(mode, rendererTheme(), {
        bindings: remapped ? { "tui.select.pageDown": "ctrl+v", "tui.altScreen.pageDown": "ctrl+v" } : {},
      });
      t.onTestFinished(() => fixture.stop());
      const running = runThinkingSelector(fixture.ctx, {
        availableLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        currentLevel: "off",
      });
      await fixture.waitForOpen();
      const before = fixture.scroll.scrollTop;
      fixture.send(remapped ? "\u0016" : "\u001b[6~");
      assert.equal(fixture.component.capturesViewportInput, true);
      assert.equal(fixture.scroll.scrollTop, before);
      fixture.send("\r");
      assert.deepEqual(await running, { kind: "selected", level: "xhigh" });
    });
  }
}

for (const scenario of [
  {
    name: "default",
    page: ["pageDown"],
    hostAction: "tui.altScreen.pageDown",
    host: "pageDown",
    input: "\u001b[6~",
    hint: "pagedown page",
  },
  {
    name: "Ctrl+V clipboard collision",
    page: ["ctrl+v"],
    hostAction: "tui.altScreen.pageDown",
    host: "ctrl+v",
    input: "\u0016",
    hint: "ctrl+v page",
  },
  {
    name: "matcher alias",
    page: ["RETURN"],
    hostAction: "tui.altScreen.pageDown",
    host: "enter",
    input: "\r",
    hint: "enter page",
  },
  {
    name: "modifier order",
    page: ["shift+ctrl+v"],
    hostAction: "tui.altScreen.pageDown",
    host: "ctrl+shift+v",
    input: "\u001b[118;6u",
    hint: "shift+ctrl+v page",
    kitty: true,
  },
  {
    name: "legacy search collision",
    page: ["ctrl+i", "ctrl+v"],
    hostAction: "tui.altScreen.search",
    host: "tab",
    input: "\u0016",
    hint: "ctrl+v page",
    blocked: "ctrl+i",
  },
  {
    name: "Kitty search distinction",
    page: ["ctrl+i"],
    hostAction: "tui.altScreen.search",
    host: "tab",
    input: "\u001b[105;5u",
    hint: "ctrl+i page",
    kitty: true,
  },
  {
    name: "modifyOtherKeys search distinction",
    page: ["ctrl+i"],
    hostAction: "tui.altScreen.search",
    host: "tab",
    input: "\u001b[27;5;105~",
    hint: "ctrl+i page",
    modify: true,
  },
  {
    name: "search modifier collision fallback",
    page: ["shift+ctrl+v", "ctrl+v"],
    hostAction: "tui.altScreen.search",
    host: "ctrl+shift+v",
    input: "\u0016",
    hint: "ctrl+v page",
    blocked: "shift+ctrl+v",
    kitty: true,
  },
  {
    name: "invalid strings before usable fallback",
    page: ["ctrl+ctrl+v", "shift+escape", "not-a-key", "ctrl+v"],
    hostAction: "tui.altScreen.pageDown",
    host: "ctrl+v",
    input: "\u0016",
    hint: "ctrl+v page",
    blocked: "ctrl+ctrl+v",
  },
]) {
  test(`fullscreen live-choice paging hints and dispatch: ${scenario.name}`, async (t) => {
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      kitty: scenario.kitty ?? false,
      bindings: {
        "tui.select.pageUp": [],
        "tui.select.pageDown": scenario.page,
        "tui.select.confirm": "ctrl+s",
        [scenario.hostAction]: scenario.host,
      } as KeybindingsConfig,
    });
    if (scenario.modify) Object.defineProperty(fixture.host.terminal, "modifyOtherKeysActive", { value: true });
    t.onTestFinished(() => fixture.stop());
    const running = runLiveChoice(fixture.ctx, { title: "Choice", items, viewportSize: 6 });
    await fixture.waitForOpen();
    const frame = plainTuiText(fixture.frame().join("\n"));
    assert.ok(frame.includes(scenario.hint), frame);
    if (scenario.blocked) assert.ok(!frame.includes(scenario.blocked), frame);
    const before = fixture.scroll.scrollTop;
    fixture.send(scenario.input);
    assert.equal(fixture.scroll.scrollTop, before);
    fixture.send("\u0013");
    assert.deepEqual(await running, { kind: "selected", itemId: "item-6" });
  });
}

test("fullscreen list Ctrl+V paging does not turn bracketed-paste chunks into shortcuts", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme(), {
    bindings: { "tui.select.pageDown": "ctrl+v", "tui.altScreen.pageDown": "ctrl+v", "tui.select.cancel": "ctrl+q" },
  });
  t.onTestFinished(() => fixture.stop());
  const running = runLiveChoice(fixture.ctx, { title: "Search", items, viewportSize: 6, enableSearch: true });
  await fixture.waitForOpen();
  const before = fixture.scroll.scrollTop;
  fixture.send("\u0016");
  assert.equal(fixture.scroll.scrollTop, before);
  assert.match(plainTuiText(fixture.frame().join("\n")), /→ Item 6/u);
  for (const chunk of ["\u001b[200~", "Item 0", "\u0016", "\u0003", "\u001b[201~"]) fixture.send(chunk);
  assert.match(plainTuiText(fixture.frame().join("\n")), /Search:.*Item 0/u);
  fixture.send("\u007f");
  assert.match(plainTuiText(fixture.frame().join("\n")), /Search:.*Item /u);
  assert.equal(fixture.scroll.isFollowingEnd, true); // Filtering changes dock height, not transcript ownership.
  fixture.send("\u0003");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
  assert.equal(fixture.editor.getValue(), "main draft");
});

for (const action of ["copy", "local search"] as const) {
  test(`fullscreen browse detail receives viewport-conflicting ${action} keys`, async (t) => {
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      bindings: { "tui.altScreen.lineUp": action === "copy" ? "ctrl+x" : "space", "app.message.copy": "ctrl+x" },
    });
    t.onTestFinished(() => fixture.stop());
    let copied: string | undefined;
    const running = runCustomInteraction(fixture.ctx, {
      create: ({ tui, theme, keybindings, complete }) =>
        createMenuScreenComponent({
          screen: {
            kind: "browse",
            title: "Browser",
            enableDetailSearch: true,
            items: [
              {
                id: "entry",
                label: "Entry",
                detailDocument: {
                  content: "Exact source",
                  copy: {
                    label: "Copy source",
                    onCopy: ({ content }) => {
                      copied = content;
                    },
                  },
                },
              },
            ],
          },
          tui,
          theme,
          keybindings,
          onEvent: (event) => complete(event.kind),
        }),
    });
    await fixture.waitForOpen();
    fixture.send("\r");
    const before = fixture.scroll.scrollTop;
    if (action === "copy") {
      assert.match(plainTuiText(fixture.frame().join("\n")), /ctrl\+x Copy source/u);
      fixture.send("\u0018");
      await (fixture.component as CustomInteractionComponent).waitForPending?.();
      assert.equal(copied, "Exact source");
    } else {
      assert.match(plainTuiText(fixture.frame().join("\n")), /space search/u);
      fixture.send(" ");
      assert.match(plainTuiText(fixture.frame().join("\n")), /Find:/u);
    }
    if (action === "copy") assert.equal(fixture.scroll.scrollTop, before);
    assert.equal(fixture.scroll.isFollowingEnd, true);
    fixture.send("\u0003");
    assert.deepEqual(await running, { kind: "completed", value: "close" });
  });
}

test("custom interaction forwards live capture without capturing arbitrary components or unrelated overlays", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme());
  t.onTestFinished(() => fixture.stop());
  let capture: boolean | undefined;
  const inputs: string[] = [];
  const running = runCustomInteraction(fixture.ctx, {
    create: ({ complete }) => ({
      get capturesViewportInput() {
        return capture;
      },
      render: () => ["Custom"],
      invalidate() {},
      handleInput(data) {
        inputs.push(data);
        if (data === "\u0003") complete("closed");
      },
    }),
  });
  await fixture.waitForOpen();
  assert.equal(fixture.component.capturesViewportInput, undefined);
  let before = fixture.scroll.scrollTop;
  fixture.send("\u001b[5~");
  assert.ok(fixture.scroll.scrollTop < before);
  assert.deepEqual(inputs, []);
  capture = true;
  assert.equal(fixture.component.capturesViewportInput, true);
  before = fixture.scroll.scrollTop;
  fixture.send("\u001b[5~");
  assert.equal(fixture.scroll.scrollTop, before);
  assert.deepEqual(inputs, ["\u001b[5~"]);
  const overlayInputs: string[] = [];
  const overlay: Component = {
    render: () => ["Other owner"],
    invalidate() {},
    handleInput: (data) => {
      overlayInputs.push(data);
    },
  };
  const overlayHandle = fixture.host.showOverlay(overlay, { width: 30 });
  fixture.send("\u001b[6~");
  assert.deepEqual(overlayInputs, ["\u001b[6~"]);
  assert.deepEqual(inputs, ["\u001b[5~"]);
  assert.equal(overlayHandle.isFocused(), true);
  overlayHandle.hide(); // Only the test's own raw overlay is released.
  capture = false;
  assert.equal(fixture.component.capturesViewportInput, false);
  fixture.send("\u001b[5~");
  assert.ok(fixture.scroll.scrollTop < before);
  fixture.send("\u0003");
  assert.deepEqual(await running, { kind: "completed", value: "closed" });
});
