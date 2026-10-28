import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  type Focusable,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { plainTuiText } from "../../../test/tui-text.js";
import type { MenuScreenComponentOptions, MenuScreenEvent } from "../src/components/contracts.js";
import { createMenuScreenComponent } from "../src/components/index.js";
import { runCustomInteraction } from "../src/custom-interaction.js";
import type { MenuScreen } from "../src/types.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const label = "Balanced profile for daily development";
const choices: MenuScreen<"main", "apply"> = {
  kind: "choice",
  title: "Deployment profile",
  action: "apply",
  currentItemId: "balanced",
  enableSearch: true,
  items: [
    { id: "balanced", label, description: "Recommended for interactive work" },
    { id: "verbose", label: "Verbose profile with full diagnostics", description: "Keep all diagnostic output" },
    { id: "minimal", label: "Minimal profile for low-bandwidth sessions" },
  ],
};
const settings: MenuScreen<"main", "apply"> = {
  kind: "settings",
  title: "Display settings",
  lines: ["Changes save immediately."],
  items: [
    {
      id: "density",
      label: "Information density for session output",
      currentValue: "Comfortable",
      values: ["Comfortable", "Compact"],
      description: "Set the amount of detail in each session.",
      action: "apply",
    },
    { id: "theme", label: "Theme", currentValue: "System", values: ["System", "Light"], action: "apply" },
  ],
};

function create(
  screen: MenuScreen<"main", "apply">,
  options: Partial<MenuScreenComponentOptions<"main", "apply">> = {},
) {
  const events: MenuScreenEvent[] = [];
  const component = createMenuScreenComponent({
    screen,
    theme: plainTheme,
    keybindings: keys,
    tui: { terminal: { rows: 40 }, requestRender() {} },
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { component, events, frame: (width = 80) => component.render(width).map(plainTuiText) };
}
const normalized = (lines: readonly string[]) => lines.join(" ").replace(/\s+/gu, " ");

for (const width of [20, 32, 40, 41, 79, 80, 120]) {
  test(`choice names and current state remain readable at ${width} columns`, () => {
    const { component, frame } = create(choices);
    const lines = frame(width);
    const selected = lines.find((line) => line.startsWith("→ ")) ?? "";
    assert.match(selected, /✓ current/u);
    assert.ok(normalized(lines).includes(`${label} ✓ current`));
    assert.ok(normalized(lines).includes("Recommended for interactive work"));
    if (width <= 41) assert.match(selected, /…/u);
    else assert.ok(selected.includes(label));
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    component.dispose?.();
  });
}

test("short wide choices do not repeat their full selected label", () => {
  const { component, frame } = create({ ...choices, items: [{ id: "balanced", label: "Balanced" }] });
  assert.equal(frame().filter((line) => line.includes("Balanced ✓ current")).length, 1);
  assert.ok(frame().includes("1 choice"));
  component.dispose?.();
});

test("action truncation reveals the complete selected label without making context activatable", () => {
  const { component, events, frame } = create({
    kind: "actions",
    title: "Actions",
    items: [{ id: "raw-id", label, action: "apply" }],
  });
  const lines = frame(20);
  assert.match(lines.find((line) => line.startsWith("→ ")) ?? "", /…/u);
  assert.ok(normalized(lines).includes(label));
  assert.deepEqual(events, []);
  component.handleInput("\r");
  assert.deepEqual(events, [{ kind: "activate", itemId: "raw-id" }]);
  component.dispose?.();
});

test("empty action and choice labels never fall back to terminal-unsafe raw IDs", () => {
  for (const kind of ["actions", "choice"] as const) {
    const id = "raw\x1b]52;c;secret\x07";
    const screen: MenuScreen<"main", "apply"> =
      kind === "actions"
        ? { kind, title: "Actions", items: [{ id, label: "", action: "apply" }] }
        : { kind, title: "Choices", items: [{ id, label: "" }], action: "apply" };
    const { component, events, frame } = create(screen);
    const rendered = frame().join("\n");
    assert.match(rendered, /\(unnamed\)/u);
    assert.ok(!rendered.includes("secret"));
    assert.ok(!component.render(80).join("\n").includes("\x1b]52"));
    component.handleInput("\r");
    assert.deepEqual(events, [{ kind: "activate", itemId: id }]);
    component.dispose?.();
  }
});

test("search counts distinguish filtered results from cursor position and clear with native editing", () => {
  const previous = getKeybindings();
  setKeybindings(keys);
  const { component, frame } = create(choices);
  try {
    assert.ok(frame().includes("3 choices"));
    component.handleInput("\x1b[200~diagnostics\x1b[201~");
    assert.ok(frame().includes("1 of 3 choices"));
    component.handleInput("\x15");
    component.handleInput("no-such-profile");
    assert.ok(frame().includes("0 of 3 choices"));
    assert.match(frame().join("\n"), /No matching choices; edit search/u);
    component.handleInput("\x15");
    assert.ok(frame().includes("3 choices"));
  } finally {
    component.dispose?.();
    setKeybindings(previous);
  }
});

for (const width of [32, 40, 80, 120]) {
  test(`settings columns keep values aligned and visible at ${width} columns`, () => {
    const { component, frame } = create(settings);
    const lines = frame(width);
    const density = lines.find((line) => line.startsWith("→ ")) ?? "";
    const theme = lines.find((line) => line.startsWith("  Theme")) ?? "";
    if (width <= 40) assert.match(density, /Information.*…\s+Comfortable$/u);
    else assert.match(density, /Information density for session output\s+Comfortable$/u);
    assert.match(theme, /Theme\s+System$/u);
    assert.equal(density.indexOf("Comfortable"), theme.indexOf("System"));
    assert.ok(normalized(lines).includes("Information density for session output"));
    assert.ok(normalized(lines).includes("Set the amount of detail in each session."));
    assert.ok(!normalized(lines).includes("Value: Comfortable"));
    component.dispose?.();
  });
}

test("clipped settings values and disabled state remain available in selected context", () => {
  const value = "A long value with important ending";
  const { component, events, frame } = create({
    ...settings,
    items: [{ id: "long", label: "Mode", currentValue: value, disabled: true, action: "apply" }],
  });
  const lines = frame(20);
  assert.match(lines.find((line) => line.startsWith("→ ")) ?? "", /…/u);
  assert.ok(normalized(lines).includes(`Value: (unavailable) ${value}`));
  component.handleInput("\r");
  assert.deepEqual(events, []);
  component.dispose?.();
});

test("responsive settings show the committed value after ordered acceptance and rejection", async () => {
  const changes: { itemId: string; value: string; previousValue: string }[] = [];
  const { component, frame } = create(settings, {
    onSettingChange: async (change) => {
      changes.push(change);
      return changes.length === 1;
    },
  });
  component.handleInput("\r");
  component.handleInput("\r");
  assert.match(frame(32).find((line) => line.startsWith("→ ")) ?? "", /Comfortable$/u);
  await component.waitForPending();
  assert.deepEqual(changes, [
    { itemId: "density", value: "Compact", previousValue: "Comfortable" },
    { itemId: "density", value: "Comfortable", previousValue: "Compact" },
  ]);
  assert.match(frame(32).find((line) => line.startsWith("→ ")) ?? "", /Compact$/u);
  component.dispose?.();
});

for (const screen of [choices, settings]) {
  test(`${screen.kind} keeps focused rows, framing and bounds through narrow and short resizes`, () => {
    let rows = 40;
    const { component } = create(screen, {
      tui: {
        terminal: {
          get rows() {
            return rows;
          },
        },
        requestRender() {},
      },
    });
    for (rows of [4, 5, 6, 8, 10, 24, 40]) {
      for (const width of [0, 1, 2, 5, 6, 20, 32, 40, 41, 80, 120]) {
        component.invalidate();
        const lines = component.render(width);
        assert.ok(lines.length <= Math.max(1, rows - 3));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        if (width === 0) assert.deepEqual(lines, []);
        else {
          assert.match(lines.map(plainTuiText).join("\n"), /→/u);
          if (rows >= 8) {
            assert.equal(plainTuiText(lines[0] ?? ""), "─".repeat(width));
            assert.equal(plainTuiText(lines.at(-1) ?? ""), "─".repeat(width));
          }
        }
      }
    }
    component.dispose?.();
  });
}

test("wide-character labels and values are bounded by terminal cells, not string length", () => {
  for (const screen of [
    { ...choices, items: [{ id: "balanced", label: "界面 👩‍💻 é ".repeat(6) }] },
    {
      ...settings,
      items: [{ id: "wide", label: "界面 👩‍💻 é ".repeat(6), currentValue: "開啟", action: "apply" as const }],
    },
  ]) {
    const { component } = create(screen);
    for (const width of [1, 6, 20, 32, 80])
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    component.dispose?.();
  }
});

test("responsive context and result counts use callback themes after invalidation", () => {
  let active = rendererTheme("dark");
  const theme = {
    fg: (role: Parameters<Theme["fg"]>[0], text: string) => active.fg(role, text),
    bold: (text: string) => text,
  };
  for (const screen of [choices, settings]) {
    const { component } = create(screen, { theme });
    const before = component.render(32).map(plainTuiText);
    for (const next of [rendererTheme("light"), rendererTheme("light", true)]) {
      active = next;
      component.invalidate();
      const after = component.render(32);
      assert.deepEqual(after.map(plainTuiText), before);
      assert.equal(after[0], active.fg("border", "─".repeat(32)));
      if (screen.kind === "choice") assert.ok(after.includes(active.fg("dim", "3 choices")));
    }
    component.dispose?.();
  }
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} native input keeps search editing, remapped navigation, and raw choice identity`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      width: 32,
      rows: 30,
      bindings: {
        "tui.select.up": "ctrl+p",
        "tui.select.down": "ctrl+n",
        "tui.select.confirm": "alt+enter",
        "tui.select.cancel": "ctrl+q",
      },
    });
    t.onTestFinished(() => fixture.stop());
    const running = runCustomInteraction(fixture.ctx, {
      create: ({ tui, theme, keybindings, complete }) =>
        createMenuScreenComponent({
          screen: choices,
          tui,
          theme,
          keybindings,
          onEvent: complete,
        }),
    });
    await fixture.waitForOpen();
    assert.equal((fixture.component as unknown as Focusable).focused, true);
    assert.ok(fixture.frame().join("\n").includes(CURSOR_MARKER));
    fixture.send("\x1b[200~full diag\x1b[201~");
    fixture.send("\x7f");
    fixture.send("g");
    assert.match(fixture.frame().map(plainTuiText).join("\n"), /1 of 3 choices/u);
    fixture.send("\x15");
    fixture.send("\x0e");
    assert.match(normalized(fixture.frame().map(plainTuiText)), /Verbose profile with full diagnostics/u);
    fixture.send("\x1b\r");
    assert.deepEqual(await running, { kind: "completed", value: { kind: "activate", itemId: "verbose" } });
    assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
    assert.equal(fixture.editor.getValue(), "main draft");
  });
}
