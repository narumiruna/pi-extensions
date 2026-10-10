import assert from "node:assert/strict";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  isKittyProtocolActive,
  matchesKey,
  setKittyProtocolActive,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness } from "../../../test/support.js";
import { createSyncConfirmation, type SyncConfirmationChoice } from "../src/ui/sync-confirmation.js";

function componentHarness(lines: readonly string[], rows: number, confirmationLabel = "apply changes") {
  let component!: ReturnType<typeof createSyncConfirmation>;
  const harness = createCustomSelectorHarness(
    (tui: TUI, theme: Theme, keybindings: KeybindingsManager, complete: (choice: SyncConfirmationChoice) => void) => {
      component = createSyncConfirmation({
        title: "Apply changes?",
        lines,
        confirmationLabel,
        tui,
        theme,
        keybindings,
        complete,
      });
      return component;
    },
    80,
    undefined,
    rows,
  );
  return { harness, component };
}

const mouse = (y: number): TuiMouseEvent => ({
  type: "click",
  button: "left",
  x: 3,
  y,
  screenX: 3,
  screenY: y,
  width: 80,
  height: 13,
  shift: false,
  alt: false,
  ctrl: false,
});

test("mouse cannot approve hidden facts but can open optional details", () => {
  const { harness, component } = componentHarness(
    Array.from({ length: 30 }, (_, index) => `Fact ${index}`),
    16,
  );
  try {
    const frame = harness.render();
    component.handleMouse(mouse(frame.findIndex((line) => line.includes("Yes,"))));
    assert.equal(harness.result, undefined);
    component.handleMouse(mouse(frame.findIndex((line) => line.includes("View details"))));
    assert.equal(harness.result, "details");
  } finally {
    harness.dispose();
  }
});

test("mouse wheel scrolls summary and resets selection to No", () => {
  const { harness, component } = componentHarness(
    Array.from({ length: 30 }, (_, index) => `Fact ${index}`),
    16,
  );
  try {
    const frame = harness.render();
    component.handleMouse({
      ...mouse(frame.findIndex((line) => line.includes("Fact 0"))),
      type: "wheel",
      button: "none",
      wheelDelta: 1,
    });
    const scrolled = harness.render().join("\n");
    assert.match(scrolled, /Summary 2-/);
    assert.match(scrolled, /→ No, cancel/);
  } finally {
    harness.dispose();
  }
});

test("confirmation sanitizes raw display text without changing source lines", () => {
  const lines = ["Private\u001b[31m content\u202e"];
  const { harness } = componentHarness(lines, 40, "apply\u001b[31m changes");
  try {
    const frame = harness.render().join("\n");
    assert.equal(frame.includes("\u001b"), false);
    assert.equal(frame.includes("\u202e"), false);
    assert.equal(lines[0], "Private\u001b[31m content\u202e");
  } finally {
    harness.dispose();
  }
});

for (const scenario of [
  { name: "matcher alias", kitty: false, confirm: ["return"], cancel: ["escape"], input: "\r", result: "approve" },
  {
    name: "modifier order collision",
    kitty: true,
    confirm: ["ctrl+shift+x"],
    cancel: ["shift+ctrl+x"],
    input: "\u001b[120;6u",
    result: "cancel",
  },
  { name: "legacy Tab collision", kitty: false, confirm: ["ctrl+i"], cancel: ["tab"], input: "\t", result: "cancel" },
  {
    name: "Kitty Ctrl+I",
    kitty: true,
    confirm: ["ctrl+i"],
    cancel: ["tab"],
    input: "\u001b[105;5u",
    result: "approve",
  },
  { name: "Kitty Tab", kitty: true, confirm: ["ctrl+i"], cancel: ["tab"], input: "\u001b[9u", result: "cancel" },
  {
    name: "first usable configured fallback",
    kitty: false,
    confirm: ["not-a-key", "l"],
    cancel: ["escape"],
    input: "l",
    result: "approve",
  },
  {
    name: "invalid configured confirmation",
    kitty: false,
    confirm: ["not-a-key"],
    cancel: ["escape"],
    input: "l",
    result: undefined,
  },
  {
    name: "hard cancellation before confirmation",
    kitty: false,
    confirm: ["ctrl+c"],
    cancel: ["q"],
    input: "\u0003",
    result: "cancel",
  },
  {
    name: "legacy navigation collision",
    kitty: false,
    confirm: ["ctrl+j"],
    cancel: ["escape"],
    down: ["enter"],
    input: "\n",
    result: undefined,
  },
] as const) {
  test(`confirmation respects ${scenario.name}`, () => {
    const previous = isKittyProtocolActive();
    setKittyProtocolActive(scenario.kitty);
    const keys: Record<string, readonly string[]> = {
      "tui.select.up": ["up"],
      "tui.select.down": scenario.down ?? ["down"],
      "tui.select.confirm": scenario.confirm,
      "tui.select.cancel": scenario.cancel,
    };
    const harness = createCustomSelectorHarness(
      (tui: TUI, theme: Theme, keybindings: KeybindingsManager, complete: (choice: SyncConfirmationChoice) => void) =>
        createSyncConfirmation({
          title: "Update 1 local file?",
          lines: ["Local: update APPEND_SYSTEM.md", "Remote publication: no"],
          confirmationLabel: "update local file",
          tui,
          theme,
          keybindings,
          complete,
        }),
      80,
      {
        // Deliberately pass invalid strings and aliases through Pi's authoritative matcher.
        matches: (data, action) => (keys[action] ?? []).some((key) => matchesKey(data, key as never)),
        getKeys: (action) => keys[action] ?? [],
      },
      40,
    );
    try {
      harness.render();
      harness.handleInput("\u001b[B");
      harness.handleInput(scenario.input);
      assert.equal(harness.result, scenario.result);
      assert.doesNotMatch(harness.render().join("\n"), /not-a-key/);
    } finally {
      harness.dispose();
      setKittyProtocolActive(previous);
    }
  });
}
