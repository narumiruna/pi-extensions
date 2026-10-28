import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  type Focusable,
  Input,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { plainTuiText } from "../../../test/tui-text.js";
import { createMenuScreenComponent, type MenuScreenComponent, type MenuScreenEvent } from "../src/components/index.js";
import { runCustomInteraction } from "../src/custom-interaction.js";
import type { MenuBrowseItem, MenuScreen } from "../src/types.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

initTheme("dark", false);
const defaultKeys = new KeybindingsManager(TUI_KEYBINDINGS);
setKeybindings(defaultKeys);

const longStatus = "Waiting for the complete provider response and additional configuration ".repeat(3).trim();
const rawSecondId = "second\n\u001b]8;;raw-id\u0007";

for (const label of ["Identifiable module ".repeat(8).trim(), "你🙂e\u0301".repeat(30)]) {
  test(`browse balances long label/status cells for ${label.startsWith("你") ? "wide" : "ASCII"} text`, () => {
    const statusText = label.startsWith("你") ? "状態🙂応答待ち".repeat(30) : longStatus;
    const harness = componentHarness([{ id: "raw", label, statusText }]);
    for (const width of [0, 1, 20, 32, 80]) {
      const frame = harness.component.render(width);
      assert.ok(
        frame.every((line) => visibleWidth(line) <= width),
        `width ${width}`,
      );
      if (width === 0) {
        assert.deepEqual(frame, []);
        continue;
      }
      if (width === 1) continue;
      const item = plainFrame(harness.component, width).find((line) => line.startsWith("› "));
      assert.ok(item);
      const [shownLabel, shownStatus] = item.slice(2).split("  [");
      assert.ok(shownLabel?.startsWith(label.startsWith("你") ? "你" : "Identif"));
      assert.ok(shownLabel.endsWith("…"));
      assert.ok(visibleWidth(shownLabel) >= Math.ceil((width - 2) / 2) - 1);
      assert.ok(shownStatus?.endsWith("…]"));
      assert.ok(visibleWidth(shownStatus) <= Math.floor((width - 2) / 2) - 3);
      assert.equal(item.includes("\ufffd"), false);
    }
  });
}

test("browse retains short inline layouts and gives labels priority when status cannot fit", () => {
  const harness = componentHarness([
    { id: "model", label: "Model", statusText: "Ready" },
    { id: "plain", label: "Plain" },
  ]);
  for (const width of [20, 32, 80]) {
    const frame = plainFrame(harness.component, width);
    assert.ok(frame.includes("› Model  [Ready]"));
    assert.ok(frame.includes("  Plain"));
  }
  for (const width of [1, 2, 3, 4, 5, 8]) {
    const frame = harness.component.render(width);
    assert.ok(frame.every((line) => visibleWidth(line) <= width));
    const selected = plainFrame(harness.component, width).find((line) => line.startsWith("›"));
    assert.ok(selected);
    assert.equal(selected.includes("["), false);
    if (width >= 3 && width < 7) assert.ok(selected.endsWith("…"));
    if (width === 8) assert.equal(selected, "› Model");
  }

  const clipped = componentHarness([{ id: "long", label: "Identifiable module ".repeat(8), statusText: "OK" }]);
  assert.ok(plainFrame(clipped.component, 20).includes("› Identifiabl…  [OK]"));
  const noStatus = componentHarness([{ id: "long", label: "Identifiable module ".repeat(8) }]);
  assert.ok(plainFrame(noStatus.component, 20).includes("› Identifiable modu…"));
});

test("browse keeps full legacy status in details and preserves the filtered raw selection on Back", () => {
  const harness = componentHarness(
    [
      { id: "first", label: "First", searchText: "shared" },
      {
        id: rawSecondId,
        label: "Second",
        searchText: "shared",
        statusText: longStatus,
        description: "Legacy description",
        details: ["Legacy body"],
      },
    ],
    { selectedItemId: rawSecondId, rows: 40 },
  );
  harness.component.focused = true;
  harness.component.render(32);
  harness.component.handleInput("shared");
  const before = plainFrame(harness.component, 32);
  assert.ok(before.some((line) => line.startsWith("› Second  [") && line.endsWith("…]")));
  harness.component.handleInput("\r");
  const detail = plainFrame(harness.component, 32).join("\n");
  assert.ok(detail.replace(/\s+/gu, " ").includes(`Status: ${longStatus}`));
  assert.match(detail, /Legacy description\nLegacy body/u);
  assert.equal(harness.component.render(32).join("\n").includes(CURSOR_MARKER), false);
  harness.component.handleInput("\u001b");
  assert.deepEqual(plainFrame(harness.component, 32), before);
  assert.equal(harness.selectionChanges.at(-1), rawSecondId);
  assert.equal(harness.component.render(32).join("\n").includes(CURSOR_MARKER), true);
  assert.deepEqual(harness.events, []);
});

for (const content of ["  exact document\n    exact body  ", ""]) {
  test(`browse retains exact-document precedence for ${content ? "nonempty" : "empty"} bodies`, () => {
    const harness = componentHarness([
      {
        id: "exact",
        label: "Exact",
        statusText: longStatus,
        description: "Legacy description",
        details: ["Legacy body"],
        detailDocument: { content },
      },
    ]);
    harness.component.render(20);
    harness.component.handleInput("\r");
    const detail = plainFrame(harness.component, 80);
    assert.doesNotMatch(detail.join("\n"), /Status:|Waiting|Legacy|No details available/u);
    if (content) {
      assert.ok(detail.includes("  exact document"));
      assert.ok(detail.includes("    exact body  "));
    }
    harness.component.handleInput("\u001b");
    assert.ok(plainFrame(harness.component, 20).some((line) => line.startsWith("› Exact")));
  });
}

test("browse recovers an empty search after shrinking without focusing the hidden Input", (t) => {
  const input = vi.spyOn(Input.prototype, "handleInput");
  t.onTestFinished(() => input.mockRestore());
  const harness = componentHarness(
    [
      { id: "first", label: "Alpha" },
      { id: rawSecondId, label: "Beta" },
    ],
    { selectedItemId: rawSecondId, rows: 18 },
  );
  harness.component.focused = true;
  assert.ok(harness.component.render(32).join("\n").includes(CURSOR_MARKER));
  harness.component.handleInput("zzzz");
  assert.match(plainFrame(harness.component, 32).join("\n"), /No matching items/u);
  const nativeInput = input.mock.contexts.at(-1);
  assert.ok(nativeInput instanceof Input);
  harness.host.terminal.rows = 4;
  assert.deepEqual(plainFrame(harness.component, 32), ["  No matching items; edit search"]);
  assert.equal(nativeInput.focused, false);
  harness.component.focused = false;
  harness.component.focused = true;
  assert.equal(nativeInput.focused, false);
  for (let index = 0; index < 4; index += 1) {
    harness.component.handleInput("\u007f");
    assert.equal(nativeInput.focused, false);
    assert.equal(harness.component.render(32).join("\n").includes(CURSOR_MARKER), false);
  }
  assert.deepEqual(plainFrame(harness.component, 32), ["› Beta"]);
  assert.equal(harness.selectionChanges.at(-1), rawSecondId);
  harness.host.terminal.rows = 18;
  assert.ok(harness.component.render(32).join("\n").includes(CURSOR_MARKER));
  assert.equal(nativeInput.focused, true);
  assert.equal(nativeInput.getValue(), "");
  harness.component.dispose?.();
  assert.equal(nativeInput.focused, false);
  const calls = input.mock.calls.length;
  harness.component.handleInput("ignored");
  assert.equal(input.mock.calls.length, calls);
});

test("browse hidden-query editing uses native Input cursor, deletion, and paste behavior", (t) => {
  const input = vi.spyOn(Input.prototype, "handleInput");
  t.onTestFinished(() => input.mockRestore());
  const reference = new Input();
  const harness = componentHarness([{ id: "item", label: "Item" }], { rows: 4 });
  harness.component.focused = true;
  harness.component.render(32);
  const chunks = [
    "\u001b[200~alp\nha\tbeta gamma\u001b[201~",
    "\u0017",
    "\u001b[D",
    "\u007f",
    "\u001b[3~",
    "\u0001",
    "Z",
    "\u0005",
    "\u001b[200~",
    " wide 你",
    "🙂 \u001b[201~",
    "\u001b[D",
    "\u007f",
  ];
  for (const chunk of chunks) {
    reference.handleInput(chunk);
    harness.component.handleInput(chunk);
    const nativeInput = input.mock.contexts.at(-1);
    assert.ok(nativeInput instanceof Input);
    assert.equal(nativeInput.getValue(), reference.getValue());
    assert.equal(nativeInput.focused, false);
    assert.equal(harness.component.render(32).join("\n").includes(CURSOR_MARKER), false);
  }
  harness.host.terminal.rows = 18;
  const search = plainFrame(harness.component, 160).find((line) => line.startsWith("Search: "));
  assert.ok(search?.startsWith(`Search: > ${reference.getValue()}`));
  assert.ok(harness.renderRequests() >= chunks.length);
  assert.deepEqual(harness.events, []);
});

for (const scenario of [
  { name: "default", config: {}, down: "\u001b[B", confirm: "\r", cancel: "\u001b" },
  {
    name: "remapped printable",
    config: { "tui.select.down": "j", "tui.select.confirm": "y", "tui.select.cancel": "q" },
    down: "j",
    confirm: "y",
    cancel: "q",
  },
] satisfies { name: string; config: KeybindingsConfig; down: string; confirm: string; cancel: string }[]) {
  test(`browse compact ${scenario.name} actions keep priority over query editing`, () => {
    const harness = componentHarness(
      [
        { id: "first", label: "First", details: ["First body"] },
        { id: rawSecondId, label: "Second", details: ["Second body"] },
        { id: "third", label: "Third", details: ["Third body"] },
      ],
      { rows: 4, keybindings: new KeybindingsManager(TUI_KEYBINDINGS, scenario.config) },
    );
    harness.component.focused = true;
    harness.component.render(32);
    harness.component.handleInput(scenario.down);
    assert.equal(harness.selectionChanges.at(-1), rawSecondId);
    assert.deepEqual(plainFrame(harness.component, 32), ["› Second"]);
    harness.component.handleInput(scenario.confirm);
    assert.deepEqual(plainFrame(harness.component, 32), ["Second body"]);
    harness.component.handleInput(scenario.cancel);
    assert.deepEqual(plainFrame(harness.component, 32), ["› Second"]);
    harness.component.handleInput("\u001b[H");
    assert.equal(harness.selectionChanges.at(-1), "first");
    harness.component.handleInput("\u001b[F");
    assert.equal(harness.selectionChanges.at(-1), "third");
    harness.host.terminal.rows = 18;
    assert.doesNotMatch(plainFrame(harness.component, 80).join("\n"), /No matching items/u);
    harness.component.handleInput(scenario.cancel);
    assert.deepEqual(harness.events, [{ kind: "back" }]);

    const close = componentHarness([{ id: "only", label: "Only" }], {
      rows: 4,
      keybindings: new KeybindingsManager(TUI_KEYBINDINGS, scenario.config),
    });
    close.component.render(32);
    close.component.handleInput("\u0003");
    assert.deepEqual(close.events, [{ kind: "close" }]);
  });
}

for (const rows of [4, 5]) {
  test(`browse retains a hidden query and raw selection through detail/Back at ${rows} terminal rows`, () => {
    const harness = componentHarness(
      [
        { id: "first", label: "Alpha", searchText: "shared" },
        { id: rawSecondId, label: "Beta", searchText: "shared", details: ["Beta body"] },
      ],
      { rows, selectedItemId: rawSecondId },
    );
    harness.component.focused = true;
    harness.component.render(32);
    harness.component.handleInput("\u001b[200~shared\u001b[201~");
    const before = plainFrame(harness.component, 32);
    assert.ok(before.includes("› Beta"));
    harness.component.handleInput("\r");
    assert.ok(plainFrame(harness.component, 32).includes("Beta body"));
    harness.component.handleInput("\u001b");
    assert.deepEqual(plainFrame(harness.component, 32), before);
    assert.equal(harness.component.render(32).join("\n").includes(CURSOR_MARKER), false);
    assert.equal(harness.selectionChanges.at(-1), rawSecondId);
    harness.host.terminal.rows = 18;
    const restored = plainFrame(harness.component, 80).join("\n");
    assert.match(restored, /Search: > shared/u);
    assert.match(restored, /› Beta/u);
    assert.ok(harness.component.render(80).join("\n").includes(CURSOR_MARKER));
  });
}

test("browse responsive rows keep press/click raw identity when selection moves the viewport", () => {
  const harness = componentHarness(
    ["First", "Second", "Third", "Fourth"].map((label, index) => ({
      id: index === 1 ? rawSecondId : label,
      label: `${label} ${"long label ".repeat(8)}`,
      statusText: longStatus,
      detailDocument: { content: `${label} exact body` },
    })),
    { rows: 11, selectedItemId: "Third" },
  );
  let frame = plainFrame(harness.component, 32);
  assert.equal(frame.filter((line) => line.includes("  [")).length, 2);
  const row = frame.findIndex((line) => line.startsWith("  Second"));
  assert.ok(row >= 0);
  assert.deepEqual(mouse(harness.component, frame, "press", row, 32), { handled: true, focus: true, render: true });
  assert.equal(harness.selectionChanges.at(-1), rawSecondId);
  frame = plainFrame(harness.component, 32);
  assert.ok(frame[row]?.startsWith("  First"));
  assert.equal(frame.filter((line) => line.includes("  [")).length, 2);
  mouse(harness.component, frame, "click", row, 32);
  assert.match(plainFrame(harness.component, 32).join("\n"), /Second exact body/u);
  assert.equal(harness.selectionChanges.at(-1), rawSecondId);
  assert.deepEqual(harness.events, []);
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`native ${mode} browse recovers a compact query without taking host input`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      width: 32,
      rows: 14,
      bindings: { "tui.altScreen.lineUp": "ctrl+x", "tui.select.cancel": "ctrl+q" },
    });
    t.onTestFinished(() => fixture.stop());
    const running = runCustomInteraction(fixture.ctx, {
      create: ({ tui, theme, keybindings, complete }) =>
        createMenuScreenComponent({
          screen: {
            kind: "browse",
            title: "Browser",
            items: [
              { id: "first", label: "Alpha" },
              { id: rawSecondId, label: "Beta", details: ["Beta exact body"] },
            ],
          },
          selectedItemId: rawSecondId,
          tui,
          theme,
          keybindings,
          onEvent: (event) => complete(event.kind),
        }),
    });
    await fixture.waitForOpen();
    fixture.send("zz");
    fixture.resize(32, 4);
    assert.match(plainTuiText(fixture.frame().join("\n")), /No matching items/u);
    fixture.send("\u007f");
    fixture.send("\u007f");
    assert.deepEqual(fixture.frame().map(plainTuiText), ["› Beta"]);
    assert.equal(fixture.frame().join("\n").includes(CURSOR_MARKER), false);
    const received: string[] = [];
    const handleInput = fixture.component.handleInput?.bind(fixture.component);
    fixture.component.handleInput = (data) => {
      received.push(data);
      handleInput?.(data);
    };
    const before = fixture.scroll.scrollTop;
    fixture.send("\u0018");
    assert.equal(received.includes("\u0018"), mode === "regular");
    if (mode === "fullscreen") assert.ok(fixture.scroll.scrollTop < before);
    fixture.send("\r");
    assert.deepEqual(fixture.frame().map(plainTuiText), ["Beta exact body"]);
    fixture.send("\u0011");
    assert.deepEqual(fixture.frame().map(plainTuiText), ["› Beta"]);
    fixture.resize(32, 14);
    assert.ok(fixture.frame().join("\n").includes(CURSOR_MARKER));
    fixture.send("\u0003");
    assert.deepEqual(await running, { kind: "completed", value: "close" });
  });
}

function plainFrame(component: MenuScreenComponent, width: number) {
  return component.render(width).map(plainTuiText);
}

function mouse(component: MenuScreenComponent, frame: string[], type: "press" | "click", y: number, width: number) {
  return component.handleMouse?.({
    type,
    button: "left",
    x: 3,
    y,
    screenX: 3,
    screenY: y,
    width,
    height: frame.length,
    shift: false,
    alt: false,
    ctrl: false,
  });
}

function componentHarness(
  items: MenuBrowseItem[],
  options: { rows?: number; selectedItemId?: string; keybindings?: KeybindingsManager } = {},
) {
  const events: MenuScreenEvent[] = [];
  const selectionChanges: string[] = [];
  let renderRequests = 0;
  const host = {
    terminal: { rows: options.rows ?? 24 },
    requestRender() {
      renderRequests += 1;
    },
  };
  const screen: MenuScreen<"browse", "unused"> = { kind: "browse", title: "Browser", items, hint: "back" };
  const component = createMenuScreenComponent({
    screen,
    selectedItemId: options.selectedItemId,
    tui: host,
    theme: { fg: (_role: string, text: string) => text, bold: (text: string) => text },
    keybindings: options.keybindings ?? defaultKeys,
    onEvent: (event) => events.push(event),
    onSelectionChange: (id) => selectionChanges.push(id),
  }) as MenuScreenComponent & Focusable;
  return { component, host, events, selectionChanges, renderRequests: () => renderRequests };
}
