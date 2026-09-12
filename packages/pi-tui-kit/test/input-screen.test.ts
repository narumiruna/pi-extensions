import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { createMenuScreenComponent } from "../src/components/index.js";
import { defineMenu, type InputScreen, type MenuTransition, runMenu } from "../src/index.js";

initTheme("dark", false);

type ScreenId = "input";
type ActionId = "submit";

const inputScreen: InputScreen<ActionId> = {
  kind: "input",
  title: "Maximum image count",
  lines: ["Current: 20"],
  placeholder: "Enter a positive integer",
  action: "submit",
  hint: "back",
};

test("input screen is width-safe, forwards focus, and sanitizes pasted controls", () => {
  const harness = inputComponentHarness();
  const focusable = harness.component as typeof harness.component & Focusable;
  assert.equal("focused" in focusable, true);
  focusable.focused = true;
  assert.equal(harness.component.render(40).join("\n").includes(CURSOR_MARKER), true);

  harness.component.handleInput("\u001b[200~  raw\u001b]8;;https://unsafe.example\u0007 value  \u001b[201~");
  const frame = harness.component.render(40);
  const raw = frame.join("\n");
  assert.equal(stripVTControlCharacters(frame[0] ?? ""), "─".repeat(40));
  assert.equal(stripVTControlCharacters(frame.at(-1) ?? ""), "─".repeat(40));
  assert.equal(raw.includes("\u001b]8;;https://unsafe.example"), false);
  assert.match(stripVTControlCharacters(raw), /value/);
  for (const width of [1, 2, 8, 20, 40, 80, 120]) {
    assert.ok(harness.component.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("input rejection preserves the draft and accepted submit transitions", async () => {
  const submissions: string[] = [];
  const transitions: MenuTransition<ScreenId>[] = [];
  const harness = inputComponentHarness({
    onInputSubmit: async ({ value }) => {
      submissions.push(value);
      if (submissions.length === 1) return false;
      return { accepted: true, transition: { kind: "close" } };
    },
    onTransition: (transition) => transitions.push(transition),
  });

  for (const input of [" ", " ", "4", "2", " ", " "]) harness.component.handleInput(input);
  harness.component.handleInput("\r");
  await harness.component.waitForPending();
  assert.deepEqual(submissions, ["  42  "]);
  assert.deepEqual(transitions, []);
  assert.match(stripVTControlCharacters(harness.component.render(40).join("\n")), /42/);

  harness.component.handleInput("\r");
  await harness.component.waitForPending();
  assert.deepEqual(submissions, ["  42  ", "  42  "]);
  assert.deepEqual(transitions, [{ kind: "close" }]);
});

test("compact input screens keep their saving indicator visible while submit is pending", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = inputComponentHarness({
    rows: 8,
    onInputSubmit: async () => {
      await gate;
      return false;
    },
  });
  harness.component.handleInput("x");
  harness.component.handleInput("\r");
  const rendered = stripVTControlCharacters(harness.component.render(32).join("\n"));
  assert.match(rendered, /> x/u);
  assert.match(rendered, /Saving…/u);
  release?.();
  await harness.component.waitForPending();
});

test("input screen drains a pending submit before Back and distinguishes Ctrl+C Close", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const back = inputComponentHarness({
    onInputSubmit: async () => {
      await gate;
      return false;
    },
  });
  back.component.handleInput("x");
  back.component.handleInput("\r");
  back.component.handleInput("\u001b");
  assert.deepEqual(back.events, []);
  release?.();
  await back.component.waitForPending();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(back.events, [{ kind: "back" }]);

  const close = inputComponentHarness();
  close.component.handleInput("\u0003");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(close.events, [{ kind: "close" }]);
});

test("input prefill starts at cursor end and rejection preserves subsequent edits", async () => {
  const submissions: string[] = [];
  const harness = inputComponentHarness({
    screen: { ...inputScreen, initialValue: "12" },
    onInputSubmit: async ({ value }) => {
      submissions.push(value);
      return false;
    },
  });
  harness.component.handleInput("3");
  harness.component.handleInput("\u007f");
  harness.component.handleInput("3");
  assert.match(stripVTControlCharacters(harness.component.render(40).join("\n")), /> 123/u);
  harness.component.handleInput("\r");
  await harness.component.waitForPending();
  harness.component.handleInput("4");
  harness.component.handleInput("\r");
  await harness.component.waitForPending();
  assert.deepEqual(submissions, ["123", "1234"]);
});

test("input prefill preserves single-line paste rules and disarms embedded paste markers", async () => {
  let submitted = "";
  const harness = inputComponentHarness({
    screen: { ...inputScreen, initialValue: "a\tb\r\nc\u001b[201~d\u0007" },
    onInputSubmit: async ({ value }) => {
      submitted = value;
      return false;
    },
  });
  harness.component.handleInput("\r");
  await harness.component.waitForPending();
  assert.equal(submitted, "a    bc [201~d ");
});

test("input prefill sanitizes bidirectional and Unicode line-separator controls", async () => {
  let submitted = "";
  const harness = inputComponentHarness({
    screen: { ...inputScreen, initialValue: "abc\u202eDEF\u2028tail\u2066x\u2029end" },
    onInputSubmit: async ({ value }) => {
      submitted = value;
      return false;
    },
  });
  const rendered = harness.component.render(40).join("\n");
  assert.equal(rendered.includes("\u202e"), false);
  assert.equal(rendered.includes("\u2066"), false);
  assert.equal(rendered.includes("\u2028"), false);
  assert.equal(rendered.includes("\u2029"), false);
  assert.match(stripVTControlCharacters(rendered), /> abcDEF tailx end/u);
  harness.component.handleInput("\r");
  await harness.component.waitForPending();
  assert.equal(submitted, "abcDEF tailx end");
});

test("input screen routes mouse cursor positioning through the framed input row", async () => {
  let submitted = "";
  const harness = inputComponentHarness({
    onInputSubmit: async ({ value }) => {
      submitted = value;
      return false;
    },
  });
  harness.component.handleInput("124");
  let frame = harness.component.render(40);
  const inputRow = frame.map(stripVTControlCharacters).findIndex((line) => line.includes("> 124"));
  assert.notEqual(inputRow, -1);
  harness.component.handleMouse?.({
    type: "press",
    button: "left",
    x: 3,
    y: inputRow,
    screenX: 3,
    screenY: inputRow,
    width: 40,
    height: frame.length,
    shift: false,
    alt: false,
    ctrl: false,
  });
  harness.component.handleInput("X");
  frame = harness.component.render(40);
  assert.match(stripVTControlCharacters(frame.join("\n")), /> 1X24/u);
  harness.component.handleInput("\r");
  await harness.component.waitForPending();
  assert.equal(submitted, "1X24");
});

test("RPC input documents prefill omission by requesting a fresh value with the original placeholder", async () => {
  let requestedPlaceholder = "";
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    input: async (_title: string, placeholder: string) => {
      requestedPlaceholder = placeholder;
      return "typed replacement";
    },
  });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "input",
    screens: { input: () => ({ ...inputScreen, initialValue: "prefilled TUI draft" }) },
    actions: { submit: async () => ({ kind: "close" }) },
  });
  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.equal(requestedPlaceholder, inputScreen.placeholder);
});

test("RPC input retries a rejected value, preserves raw payload, and never opens custom TUI", async () => {
  const responses = [" bad ", " 42 "];
  const values: string[] = [];
  let customCalls = 0;
  let inputCalls = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    input: async (_title: string, _placeholder: string, options?: { signal?: AbortSignal }) => {
      inputCalls += 1;
      assert.equal(options?.signal?.aborted, false);
      return responses.shift();
    },
    custom: async () => {
      customCalls += 1;
    },
  });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "input",
    screens: { input: () => inputScreen },
    actions: {
      submit: async ({ value }) => {
        values.push(value ?? "");
        return value?.trim() === "42" ? { kind: "close" } : { kind: "rejected" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(values, [" bad ", " 42 "]);
  assert.equal(inputCalls, 2);
  assert.equal(customCalls, 0);
});

test("TUI input rejection retains the same draft before a later accepted transition", async () => {
  const values: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 40);
      for (const input of [" ", "x", " "]) harness.handleInput(input);
      harness.handleInput("tui.input.submit");
      await harness.waitForPending();
      assert.match(stripVTControlCharacters(harness.render().join("\n")), /> {2}x/);
      harness.handleInput("tui.input.submit");
      await harness.waitForPending();
      return harness.resultPromise;
    },
  });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "input",
    screens: { input: () => inputScreen },
    actions: {
      submit: async ({ value }) => {
        values.push(value ?? "");
        return values.length === 1 ? { kind: "rejected" } : { kind: "close" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(values, [" x ", " x "]);
});

test("disposing a TUI input aborts and drains its in-flight action", async () => {
  let reportStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  let observedAbort = false;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 40);
      harness.handleInput("x");
      harness.handleInput("tui.input.submit");
      await started;
      harness.dispose();
      return undefined;
    },
  });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "input",
    screens: { input: () => inputScreen },
    actions: {
      submit: async ({ signal }) => {
        reportStarted?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          }
        });
        return { kind: "stay" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "stale",
  });
  assert.equal(observedAbort, true);
});

test("owner abort dismisses an unanswered RPC input and returns stale", async () => {
  const owner = new AbortController();
  let reportOpened: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    reportOpened = resolve;
  });
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    input: async (_title: string, _placeholder: string, options?: { signal?: AbortSignal }) => {
      reportOpened?.();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return undefined;
    },
  });
  const menu = defineMenu<undefined, ScreenId, ActionId>({
    start: "input",
    screens: { input: () => inputScreen },
    actions: { submit: async () => ({ kind: "close" }) },
  });
  const running = runMenu(context.ctx, menu, {
    getState: () => undefined,
    signal: owner.signal,
  });
  await opened;
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await running, { kind: "stale" });
});

function inputComponentHarness(
  overrides: {
    onInputSubmit?: (change: {
      value: string;
    }) => Promise<boolean | { accepted: boolean; transition: MenuTransition<ScreenId> }>;
    onTransition?: (transition: MenuTransition<ScreenId>) => void;
    rows?: number;
    screen?: InputScreen<ActionId>;
  } = {},
) {
  const events: Array<{ kind: "back" | "close" } | { kind: "activate"; itemId: string }> = [];
  const component = createMenuScreenComponent<ScreenId, ActionId>({
    screen: overrides.screen ?? inputScreen,
    tui: { terminal: { rows: overrides.rows ?? 24 }, requestRender() {} },
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    keybindings: {
      matches(data: string, binding: string) {
        if (binding === "tui.select.cancel") return data === "\u001b" || data === "\u0003";
        if (binding === "tui.input.submit") return data === "\r";
        return false;
      },
      getKeys(binding: string) {
        if (binding === "tui.select.cancel") return ["escape", "ctrl+c"];
        if (binding === "tui.input.submit") return ["enter"];
        return [];
      },
    },
    onEvent: (event) => events.push(event),
    onInputSubmit: overrides.onInputSubmit,
    onTransition: overrides.onTransition,
  });
  return { component, events };
}
