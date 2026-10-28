import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  Input,
  KeybindingsManager,
  renderFakeCursor,
  setKeybindings,
  type TUI,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSafeInput } from "../src/safe-input-render.js";

const [fakeStart = "", fakeEnd = ""] = renderFakeCursor("CELL").split("CELL");
const originalKeys = getKeybindings();
beforeEach(() => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(() => setKeybindings(originalKeys));

function nativeInput(kind: "Input" | "Editor", text: string, before: string) {
  const host = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
  const identity = (text: string) => text;
  const input =
    kind === "Input"
      ? new Input()
      : new Editor(host, {
          borderColor: identity,
          selectList: {
            selectedPrefix: identity,
            selectedText: identity,
            description: identity,
            scrollInfo: identity,
            noMatch: identity,
          },
        });
  if (input instanceof Input) input.setValue(text);
  else input.setText(text);
  input.handleInput("\x01");
  for (const _ of new Intl.Segmenter().segment(before)) input.handleInput("\x1b[C");
  return input;
}

function count(text: string, marker: string) {
  return text.split(marker).length - 1;
}

function expectSafe(lines: string[], hardware: number, fake: number) {
  const frame = lines.join("\n");
  expect(count(frame, CURSOR_MARKER)).toBe(hardware);
  expect(count(frame, fakeStart)).toBe(fake);
  expect(count(frame, fakeEnd)).toBe(fake);
  // No foreign OSC, CSI, APC, BEL, C1 controls or bidi controls can remain.
  const content = frame
    .replaceAll(CURSOR_MARKER, "")
    .replaceAll(fakeStart, "")
    .replaceAll(fakeEnd, "")
    .replaceAll("\n", "");
  expect(content).not.toMatch(/\p{Cc}|\p{Bidi_Control}/u);
}

const attacks = [
  { name: "hardware marker before", before: `left${CURSOR_MARKER}`, cell: "X", after: "right" },
  { name: "hardware marker after", before: "left", cell: "X", after: `${CURSOR_MARKER}right` },
  { name: "fake begin and end", before: `left${fakeStart}`, cell: "X", after: `${fakeEnd}right` },
  {
    name: "complete forged cursor",
    before: `left${CURSOR_MARKER}${renderFakeCursor("FORGED")}`,
    cell: "X",
    after: "right",
  },
  {
    name: "unknown APC prefix followed by clipboard, title and CSI",
    before: "left\x1b_pi:unknown\x07\x1b]52;c;Y2xpcA==\x07\x1b]0;foreign-title\x07\x1b[2J",
    cell: "X",
    after: "right",
  },
  {
    name: "foreign controls after cursor",
    before: "left",
    cell: "X",
    after: "\x1b_pi:unknown\x1b\\\x1b]2;foreign-title\x1b\\\x1b]52;c;Y2xpcA==\x07\x1b[999;999Hright",
  },
  { name: "cursor at marker ESC", before: "left", cell: "\x1b", after: "_pi:c\x07right" },
  { name: "cursor inside hardware marker", before: "left\x1b_pi:", cell: "c", after: "\x07right" },
  { name: "cursor inside fake begin", before: "left\x1b_pi:f", cell: "c", after: `\x07${fakeEnd}right` },
  { name: "cursor inside fake end", before: "left\x1b_pi:/f", cell: "c", after: "\x07right" },
  {
    name: "adjacent repeated hardware and fake markers",
    before: `left${CURSOR_MARKER.repeat(3)}${fakeStart.repeat(2)}${fakeEnd.repeat(2)}`,
    cell: "X",
    after: `${fakeEnd}${CURSOR_MARKER.repeat(3)}${fakeStart}right`,
  },
  {
    name: "C1 APC, clipboard, title and CSI",
    before: "left\x9fpi:c\x9c\x9d52;c;Y2xpcA==\x07",
    cell: "X",
    after: "\x9d0;foreign-title\x9c\x9b2Jright\u202e",
  },
];

for (const kind of ["Input", "Editor"] as const) {
  describe(kind, () => {
    it.each(attacks)("proves cursor provenance with $name", ({ before, cell, after }) => {
      const text = before + cell + after;
      const input = nativeInput(kind, text, before);
      let submitted: string | undefined;
      input.onSubmit = (value) => {
        submitted = value;
      };
      for (const focused of [true, false, true]) {
        input.focused = focused;
        expectSafe(renderSafeInput(input, 400), Number(focused), 1);
        expect(input.focused).toBe(focused);
      }
      expect(input instanceof Input ? input.getValue() : input.getExpandedText()).toBe(text);
      input.handleInput("\r");
      expect(submitted).toBe(text);
    });

    it.each([0, 1, 2, 3, 8])(
      "sanitizes hostile content at width %i without changing native focus or draft",
      (width) => {
        const text = `left${CURSOR_MARKER}${renderFakeCursor("FORGED")}\x1b_pi:unknown\x07\x1b]52;c;YQ==\x07\x1b[2Jright`;
        const input = nativeInput(kind, text, text);
        for (const focused of [true, false]) {
          input.focused = focused;
          const frame = renderSafeInput(input, width);
          const hasCursor = kind === "Editor" || width > 2;
          expectSafe(frame, Number(focused && hasCursor), Number(hasCursor));
          expect(input.focused).toBe(focused);
        }
        expect(input instanceof Input ? input.getValue() : input.getExpandedText()).toBe(text);
      },
    );

    it.each(["", "ab界e\u0301🙂z"])(
      "preserves native hardware position and fake cursor cell after normal editing of %j",
      (text) => {
        const input = nativeInput(kind, text, text);
        if (text) {
          input.handleInput("\x1b[D");
          input.handleInput("\x1b[D");
          input.handleInput("Q");
          input.handleInput("\x7f");
        }
        for (const focused of [true, false]) {
          input.focused = focused;
          const native = input.render(40);
          const safe = renderSafeInput(input, 40);
          expect(safe).toEqual(native);
          expectSafe(safe, Number(focused), 1);
          const row = safe.find((line) => line.includes(fakeStart)) ?? "";
          expect(row).toContain(renderFakeCursor(text ? "🙂" : " "));
          if (focused) {
            const reference = native.find((line) => line.includes(CURSOR_MARKER)) ?? "";
            expect(visibleWidth(row.slice(0, row.indexOf(CURSOR_MARKER)))).toBe(
              visibleWidth(reference.slice(0, reference.indexOf(CURSOR_MARKER))),
            );
          }
        }
      },
    );

    it("handles a long adversarial run of adjacent markers without retaining spoofed cursors", () => {
      const repeated = `${CURSOR_MARKER}${fakeStart}${fakeEnd}${CURSOR_MARKER.repeat(3)}`.repeat(256);
      const text = `left${repeated}right`;
      const input = nativeInput(kind, text, "left");
      for (const position of ["before", "after"]) {
        if (position === "after") {
          input.handleInput("\x05");
          for (let index = 0; index < "right".length; index++) input.handleInput("\x1b[D");
        }
        input.focused = true;
        const first = renderSafeInput(input, 100);
        expectSafe(first, 1, 1);
        if (position === "after") expect(first.join("")).toContain(renderFakeCursor("r"));
        input.invalidate();
        expect(renderSafeInput(input, 100)).toEqual(first);
        input.focused = false;
        expectSafe(renderSafeInput(input, 100), 0, 1);
        expect(input instanceof Input ? input.getValue() : input.getExpandedText()).toBe(text);
      }
    });
  });
}

it.each([
  { focused: true, failingRender: 1 },
  { focused: false, failingRender: 1 },
  { focused: true, failingRender: 2 },
  { focused: false, failingRender: 2 },
])("restores public focus=$focused if native render $failingRender throws", ({ focused, failingRender }) => {
  const input = new Input();
  input.focused = focused;
  const render = input.render.bind(input);
  let calls = 0;
  vi.spyOn(input, "render").mockImplementation((width) => {
    if (++calls === failingRender) throw new Error("render failed");
    return render(width);
  });
  expect(() => renderSafeInput(input, 80)).toThrow("render failed");
  expect(input.focused).toBe(focused);
});
