import assert from "node:assert/strict";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext, driveCustomSelector } from "../../../test/support.js";
import { defineMenu, type MenuDefinition, type MenuScreen, type RunMenuResult, runMenu } from "../src/index.js";

initTheme("dark", false);

type State = { count: number };
type ScreenId = "main" | "status" | "settings";
type ActionId = "run" | "automatic";

function runtimeMenu(
  options: { busy?: boolean; run?: MenuDefinition<State, ScreenId, ActionId>["actions"]["run"] } = {},
) {
  return defineMenu<State, ScreenId, ActionId>({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: `Main ${state.count}`,
        items: [
          {
            id: "run",
            label: "Run",
            action: "run",
            ...(options.busy ? { busyLabel: "Running…" } : {}),
          },
          { id: "status", label: "Status", to: "status" },
          { id: "settings", label: "Settings", to: "settings" },
        ],
        hint: "close",
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Status",
        lines: [`Count ${state.count}`],
        hint: "back",
      }),
      settings: () => ({
        kind: "settings",
        title: "Settings",
        items: [
          {
            id: "automatic",
            label: "Automatic",
            currentValue: "Off",
            values: ["Off", "On"],
            action: "automatic",
          },
        ],
      }),
    },
    actions: {
      run: options.run ?? (async () => ({ kind: "stay" })),
      automatic: async () => ({ kind: "stay" }),
    },
  });
}

function terminalDetailMenu(hint: "back" | "close") {
  return defineMenu<undefined, "main", "unused">({
    start: "main",
    screens: {
      main: () => ({ kind: "detail", title: "Terminal result", lines: [], hint }),
    },
    actions: { unused: async () => ({ kind: "stay" }) },
  });
}

test("TUI root Back, hinted Close, and Ctrl+C preserve distinct close reasons", async () => {
  async function drive(hint: "back" | "close", input: string) {
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 40);
        harness.handleInput(input);
        return harness.result;
      },
    });
    return runMenu(context.ctx, terminalDetailMenu(hint), { getState: () => undefined });
  }

  assert.deepEqual(await drive("back", "tui.select.cancel"), {
    kind: "closed",
    reason: "back",
  });
  assert.deepEqual(await drive("close", "tui.select.cancel"), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(await drive("back", "\u0003"), { kind: "closed", reason: "close" });
});

test("TUI action Close, close rows, and implicit current-owner closure report Close", async () => {
  async function drive(target: "action" | "row" | "implicit") {
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 40);
        if (target !== "implicit") harness.handleInput("tui.select.confirm");
        return target === "implicit" ? undefined : harness.result;
      },
    });
    const menu = defineMenu<undefined, "main", "finish">({
      start: "main",
      screens: {
        main: () => ({
          kind: "actions",
          title: "Finish",
          items: [
            target === "row"
              ? { id: "finish", label: "Finish", close: true }
              : { id: "finish", label: "Finish", action: "finish" },
          ],
        }),
      },
      actions: { finish: async () => ({ kind: "close" }) },
    });
    return runMenu(context.ctx, menu, { getState: () => undefined });
  }

  for (const target of ["action", "row", "implicit"] as const) {
    assert.deepEqual(await drive(target), { kind: "closed", reason: "close" }, target);
  }
});

test("RPC preserves generic Back and hint-driven input/review terminal reasons", async () => {
  const generic = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => undefined,
  });
  assert.deepEqual(await runMenu(generic.ctx, terminalDetailMenu("close"), { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });

  async function driveInput(hint: "back" | "close") {
    const context = createMockContext({ mode: "rpc", hasUI: true, input: async () => undefined });
    const menu = defineMenu<undefined, "input", "submit">({
      start: "input",
      screens: {
        input: () => ({ kind: "input", title: "Value", action: "submit", hint }),
      },
      actions: { submit: async () => ({ kind: "close" }) },
    });
    return runMenu(context.ctx, menu, { getState: () => undefined });
  }
  assert.deepEqual(await driveInput("back"), { kind: "closed", reason: "back" });
  assert.deepEqual(await driveInput("close"), { kind: "closed", reason: "close" });

  const review = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => undefined,
  });
  const reviewMenu = defineMenu<undefined, "review", "apply">({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Review",
        content: "content",
        hint: "close",
      }),
    },
    actions: { apply: async () => ({ kind: "close" }) },
  });
  assert.deepEqual(await runMenu(review.ctx, reviewMenu, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
});

test("runMenu navigates, refreshes dynamic state, restores selection, and closes", async () => {
  let count = 0;
  let customCalls = 0;
  const screens: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      const inputs =
        customCalls === 1
          ? ["tui.select.down", "tui.select.confirm"]
          : customCalls === 2
            ? ["tui.select.cancel"]
            : customCalls === 3
              ? ["tui.select.up", "tui.select.confirm"]
              : ["\u0003", "\u0003"];
      const driven = driveCustomSelector(factory, inputs, 40);
      screens.push(driven.renders.flat().join(" "));
      return driven.result;
    },
  });
  const menu = runtimeMenu({
    run: async () => {
      count += 1;
      return { kind: "stay" };
    },
  });

  const result = await runMenu(context.ctx, menu, { getState: () => ({ count }) });
  assert.deepEqual(result, { kind: "closed", reason: "close" });
  assert.equal(count, 1);
  assert.equal(customCalls, 4);
  assert.match(screens[1] ?? "", /Count 0/);
  assert.match(screens[3] ?? "", /Main 1/);
});

test("Escape back restores the cursor on the parent row", async () => {
  let customCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      const harness = createCustomSelectorHarness(factory, 80);
      if (customCalls === 1) {
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.confirm");
      } else if (customCalls === 2) harness.handleInput("tui.select.cancel");
      else {
        assert.match(harness.render().join("\n"), /→ Status/);
        harness.handleInput("\u0003");
      }
      return harness.result;
    },
  });

  assert.deepEqual(await runMenu(context.ctx, runtimeMenu(), { getState: () => ({ count: 0 }) }), {
    kind: "closed",
    reason: "close",
  });
  assert.equal(customCalls, 3);
});

test("RPC uses dialog adaptation without custom TUI and print mode delegates unsupported behavior", async () => {
  let count = 0;
  let customCalls = 0;
  const choices = ["Run", undefined];
  const rpc = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => choices.shift(),
    custom: async () => {
      customCalls += 1;
    },
  });
  const menu = runtimeMenu({
    busy: true,
    run: async () => {
      count += 1;
    },
  });
  assert.deepEqual(await runMenu(rpc.ctx, menu, { getState: () => ({ count }) }), {
    kind: "closed",
    reason: "back",
  });
  assert.equal(count, 1);
  assert.equal(customCalls, 0);

  let unsupportedMode = "";
  const print = createMockContext({ mode: "print", hasUI: false });
  assert.deepEqual(
    await runMenu(print.ctx, menu, {
      getState: () => ({ count }),
      onUnsupportedMode: (_ctx, mode) => {
        unsupportedMode = mode;
      },
    }),
    { kind: "unsupported", mode: "print" },
  );
  assert.equal(unsupportedMode, "print");

  const unavailableTui = createMockContext({
    mode: "tui",
    hasUI: false,
    custom: async () => {
      throw new Error("custom UI must not open without UI support");
    },
  });
  assert.deepEqual(
    await runMenu(unavailableTui.ctx, menu, {
      getState: () => ({ count }),
      onUnsupportedMode: (_ctx, mode) => {
        unsupportedMode = mode;
      },
    }),
    { kind: "unsupported", mode: "tui" },
  );
  assert.equal(unsupportedMode, "tui");
});

test("browse stays read-only across TUI detail navigation and RPC pagination", async () => {
  const items = [
    {
      id: "first-raw",
      label: "Same",
      statusText: "Empty",
      description: "First item",
      details: ["Preview: first"],
    },
    {
      id: "second-raw",
      label: "Same\u001b]8;;unsafe\u0007",
      statusText: "Empty\u001b[31m",
      description: "Second item",
      searchText: "must stay private in RPC",
      details: Array.from({ length: 12 }, (_, index) => `Detail ${index}`),
    },
  ];
  const menu = defineMenu<undefined, "browse", "unused">({
    start: "browse",
    screens: {
      browse: () => ({
        kind: "browse",
        title: "Resources",
        items,
        hint: "back",
      }),
    },
    actions: {
      unused: async () => {
        throw new Error("browse must not invoke an action");
      },
    },
  });

  const tuiContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 50);
      harness.handleInput("tui.select.down");
      harness.handleInput("tui.select.confirm");
      assert.match(harness.render().join("\n"), /Status: Empty/u);
      harness.handleInput("tui.select.cancel");
      assert.match(harness.render().join("\n"), /Same.*\[Empty\]/u);
      harness.handleInput("tui.select.cancel");
      return harness.result;
    },
  });
  assert.deepEqual(await runMenu(tuiContext.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });

  let rpcCall = 0;
  const rpcContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, choices: string[]) => {
      rpcCall += 1;
      assert.equal(title.includes("\u001b"), false);
      assert.equal(choices.join("\n").includes("must stay private"), false);
      if (rpcCall === 1) {
        assert.equal(new Set(choices).size, choices.length);
        return choices[1];
      }
      if (rpcCall === 2) {
        assert.match(title, /Status: Empty[\s\S]*Detail 0/u);
        return choices.find((choice) => choice.startsWith("Next"));
      }
      if (rpcCall === 3) {
        assert.match(title, /Detail 11/u);
        return choices.find((choice) => choice.startsWith("Back"));
      }
      return choices.find((choice) => choice.startsWith("Back"));
    },
  });
  assert.deepEqual(await runMenu(rpcContext.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });
  assert.equal(rpcCall, 4);
});

test("RPC review keeps Markdown, LaTeX, and Mermaid as bounded sanitized source", async () => {
  let calls = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, choices: string[]) => {
      calls += 1;
      assert.match(title, /# Formula/u);
      assert.match(title, /\$x\^2\$/u);
      assert.match(title, /```mermaid[\s\S]*flowchart LR/u);
      assert.doesNotMatch(title, /[┌╭].*[┐╮]/u);
      assert.doesNotMatch(title, /https:\/\/unsafe\.example/u);
      assert.equal(title.includes("\u001b"), false);
      assert.match(title, /unsafetext/u);
      assert.ok(title.split("\n").every((line) => line.length <= 120));
      return choices.find((choice) => choice.startsWith("Back"));
    },
    custom: async () => {
      throw new Error("RPC Markdown review must not open custom TUI");
    },
  });
  const menu = defineMenu<undefined, "review", "unused">({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Formula",
        content:
          "# Formula\n\n$x^2$\n\n```mermaid\nflowchart LR\n A[unsafe\u001b]8;;https://unsafe.example\u0007text] --> B\n```",
        format: { kind: "markdown" },
      }),
    },
    actions: { unused: async () => ({ kind: "close" }) },
  });

  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });
  assert.equal(calls, 1);
});

test("RPC browse keeps Markdown source private until bounded detail pages", async () => {
  let calls = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, choices: string[]) => {
      calls += 1;
      if (calls === 1) {
        assert.deepEqual(choices, ["Guide", "Back"]);
        assert.doesNotMatch(choices.join("\n"), /private-markdown|flowchart/u);
        return "Guide";
      }
      if (calls === 2) {
        assert.match(title, /private-markdown/u);
        assert.match(title, /\$x\^2\$/u);
        assert.match(title, /```mermaid[\s\S]*flowchart LR/u);
        assert.doesNotMatch(title, /[┌╭].*[┐╮]/u);
        assert.equal(title.includes("\u001b"), false);
        assert.ok(title.split("\n").every((line) => line.length <= 120));
        return choices.find((choice) => choice.startsWith("Back"));
      }
      return choices.find((choice) => choice.startsWith("Back"));
    },
    custom: async () => {
      throw new Error("RPC Markdown browse must not open custom TUI");
    },
  });
  const menu = defineMenu<undefined, "browse", "unused">({
    start: "browse",
    screens: {
      browse: () => ({
        kind: "browse",
        title: "Guides",
        items: [
          {
            id: "guide",
            label: "Guide",
            detailDocument: {
              content: "private-markdown\n\n$x^2$\n\n```mermaid\nflowchart LR\n A --> B\n```",
              format: { kind: "markdown" },
            },
          },
        ],
        hint: "back",
      }),
    },
    actions: { unused: async () => ({ kind: "close" }) },
  });

  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });
  assert.equal(calls, 3);
});

test("RPC browse exact details preserve documents, bounds, identity, and Back behavior", async () => {
  const longLine = `${"x".repeat(120)}y`;
  const items = [
    {
      id: "first-raw",
      label: "Same",
      statusText: "Ready",
      searchText: "first metadata",
      detailDocument: { content: "private-document-token" },
    },
    {
      id: "second-raw",
      label: "Same",
      statusText: "Ready",
      description: "Legacy description",
      searchText: "second metadata",
      details: ["legacy detail must not render"],
      detailDocument: {
        content: [
          "  two spaces",
          "    four spaces",
          "\ttabbed",
          "unsafe\u001b]8;;https://unsafe.example\u0007text",
          longLine,
          ...Array.from({ length: 6 }, (_, index) => `tail ${index + 1}`),
        ].join("\n"),
        format: { kind: "code" as const, language: "json" },
      },
    },
  ];
  const menu = defineMenu<undefined, "browse", "unused">({
    start: "browse",
    screens: {
      browse: () => ({
        kind: "browse",
        title: "Documents",
        items,
        enableDetailSearch: true,
        hint: "back",
      }),
    },
    actions: { unused: async () => ({ kind: "close" }) },
  });
  let call = 0;
  const titles: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    custom: async () => {
      throw new Error("RPC browse must not open custom TUI");
    },
    select: async (title: string, choices: string[]) => {
      call += 1;
      titles.push(title);
      assert.equal(new Set(choices).size, choices.length);
      if (call === 1) {
        assert.deepEqual(choices, ["Same [Ready]", "Same [Ready] [2]", "Back"]);
        assert.doesNotMatch(choices.join("\n"), /private-document-token|first metadata|second metadata|two spaces/u);
        return "Same [Ready] [2]";
      }
      if (call === 2) {
        assert.match(title, /\n {2}two spaces\n {4}four spaces\n {4}tabbed\n/u);
        assert.equal(title.includes("\u001b"), false);
        assert.equal(title.includes("https://unsafe.example"), false);
        assert.match(title, new RegExp(`\\n${"x".repeat(120)}\\ny\\n`, "u"));
        assert.doesNotMatch(title, /Status: Ready|Legacy description|legacy detail must not render/u);
        return choices.find((choice) => choice.startsWith("Next"));
      }
      if (call === 3) {
        assert.match(title, /tail 6/u);
        return choices.find((choice) => choice.startsWith("Back"));
      }
      return choices.find((choice) => choice.startsWith("Back"));
    },
  });

  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });
  assert.equal(call, 4);
  assert.equal(
    titles.every((title) => title.length < 2000),
    true,
  );
});

test("RPC browse legacy details retain exact labels, normalized ordering, and fallback", async () => {
  const menu = defineMenu<undefined, "browse", "unused">({
    start: "browse",
    screens: {
      browse: () => ({
        kind: "browse",
        title: "Legacy",
        items: [
          {
            id: "legacy",
            label: " Item ",
            statusText: " Ready   state ",
            description: " Legacy\tdescription ",
            details: ["  nested   prose  "],
          },
          { id: "empty", label: "Empty" },
        ],
        hint: "back",
      }),
    },
    actions: { unused: async () => ({ kind: "close" }) },
  });
  let call = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, choices: string[]) => {
      call += 1;
      if (call === 1) {
        assert.deepEqual(choices, ["Item [Ready state]", "Empty", "Back"]);
        return choices[0];
      }
      if (call === 2) {
        assert.equal(title, "Item [Ready state]\nStatus: Ready state\nLegacy description\nnested prose");
        return "Back";
      }
      if (call === 3) return choices[1];
      if (call === 4) {
        assert.equal(title, "Empty\nNo details available.");
        return "Back";
      }
      return "Back";
    },
  });
  assert.deepEqual(await runMenu(context.ctx, menu, { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });
  assert.equal(call, 5);
});

test("TUI and RPC preserve the eight-screen semantic action matrix", async () => {
  type MatrixScreen = MenuScreen<"main", "act">;
  type MatrixPayload = { itemId: string; value?: string; selected?: boolean };
  const cases: Array<{
    name: string;
    screen: MatrixScreen;
    expected?: MatrixPayload;
  }> = [
    {
      name: "actions",
      screen: {
        kind: "actions",
        title: "Actions",
        items: [{ id: "action-raw", label: "Run", action: "act" }],
      },
      expected: { itemId: "action-raw", value: undefined, selected: undefined },
    },
    {
      name: "detail",
      screen: { kind: "detail", title: "Detail", lines: ["Read only"] },
    },
    {
      name: "browse",
      screen: {
        kind: "browse",
        title: "Browse",
        items: [{ id: "browse-raw", label: "Browse item", details: ["Read only"] }],
      },
    },
    {
      name: "choice",
      screen: {
        kind: "choice",
        title: "Choice",
        items: [{ id: "choice-raw", label: "Choose" }],
        action: "act",
      },
      expected: { itemId: "choice-raw", value: undefined, selected: undefined },
    },
    {
      name: "settings",
      screen: {
        kind: "settings",
        title: "Settings",
        items: [
          {
            id: "setting-raw",
            label: "Setting",
            currentValue: "Off",
            values: ["Off", "On\u0007raw"],
            action: "act",
          },
        ],
      },
      expected: { itemId: "setting-raw", value: "On\u0007raw", selected: undefined },
    },
    {
      name: "input",
      screen: { kind: "input", title: "Input", action: "act" },
      expected: { itemId: "input", value: "input raw", selected: undefined },
    },
    {
      name: "review",
      screen: {
        kind: "review",
        title: "Review",
        content: "Content",
        confirm: { id: "confirm-raw", label: "Apply", action: "act" },
      },
      expected: { itemId: "confirm-raw", value: undefined, selected: undefined },
    },
    {
      name: "multi-select toggle",
      screen: {
        kind: "multiSelect",
        title: "Multi-select",
        items: [{ id: "toggle-raw", label: "Toggle", selected: false }],
        action: "act",
      },
      expected: { itemId: "toggle-raw", value: undefined, selected: true },
    },
    {
      name: "multi-select action",
      screen: {
        kind: "multiSelect",
        title: "Multi-select action",
        items: [],
        action: "act",
        actions: [{ id: "bulk-raw", label: "Save", action: "act" }],
      },
      expected: { itemId: "bulk-raw", value: undefined, selected: undefined },
    },
  ];

  for (const entry of cases) {
    for (const mode of ["tui", "rpc"] as const) {
      const invoked: MatrixPayload[] = [];
      const menu = defineMenu<undefined, "main", "act">({
        start: "main",
        screens: { main: () => entry.screen },
        actions: {
          act: async ({ itemId, value, selected }) => {
            invoked.push({ itemId, value, selected });
            return { kind: "close" };
          },
        },
      });
      let rpcCalls = 0;
      const context = createMockContext(
        mode === "tui"
          ? {
              mode,
              hasUI: true,
              custom: async (factory: unknown) => {
                const harness = createCustomSelectorHarness(factory, 80);
                if (entry.name === "detail") {
                  harness.handleInput("tui.select.cancel");
                } else if (entry.name === "browse") {
                  harness.handleInput("tui.select.confirm");
                  harness.handleInput("tui.select.cancel");
                  harness.handleInput("tui.select.cancel");
                } else if (entry.name === "settings") {
                  harness.handleInput("tui.select.confirm");
                } else if (entry.name === "input") {
                  harness.setFocused(true);
                  harness.handleInput("input raw");
                  harness.handleInput("tui.input.submit");
                } else {
                  harness.handleInput("tui.select.confirm");
                }
                await harness.waitForPending();
                return harness.result;
              },
            }
          : {
              mode,
              hasUI: true,
              input: async () => "input raw",
              select: async (_title: string, choices: string[]) => {
                rpcCalls += 1;
                if (entry.name === "review") {
                  return choices.find((choice) => choice.startsWith("Apply"));
                }
                if (entry.name === "browse") return rpcCalls === 1 ? choices[0] : choices.at(-1);
                return choices[0];
              },
            },
      );

      const result = await runMenu(context.ctx, menu, { getState: () => undefined });
      assert.deepEqual(
        result,
        entry.name === "detail" || entry.name === "browse"
          ? { kind: "closed", reason: "back" }
          : { kind: "closed", reason: "close" },
        `${mode} ${entry.name} result`,
      );
      assert.deepEqual(invoked, entry.expected ? [entry.expected] : [], `${mode} ${entry.name}`);
    }
  }
});

test("TUI and RPC ordinary action failures report once and leave the menu usable", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const actionError = new Error(`${mode} action failed`);
    let actionCalls = 0;
    let reporterCalls = 0;
    let customCalls = 0;
    let selectCalls = 0;
    const context = createMockContext(
      mode === "tui"
        ? {
            mode,
            hasUI: true,
            custom: async (factory: unknown) => {
              customCalls += 1;
              const harness = createCustomSelectorHarness(factory, 40);
              harness.handleInput(customCalls === 1 ? "tui.select.confirm" : "\u0003");
              return harness.result;
            },
          }
        : {
            mode,
            hasUI: true,
            select: async (_title: string, choices: string[]) => {
              selectCalls += 1;
              return selectCalls === 1 ? choices[0] : undefined;
            },
          },
    );
    const menu = defineMenu<undefined, "main", "run">({
      start: "main",
      screens: {
        main: () => ({
          kind: "actions",
          title: "Retry",
          items: [{ id: "run", label: "Run", action: "run" }],
        }),
      },
      actions: {
        run: async () => {
          actionCalls += 1;
          throw actionError;
        },
      },
    });

    assert.deepEqual(
      await runMenu(context.ctx, menu, {
        getState: () => undefined,
        onError: (_ctx, error) => {
          reporterCalls += 1;
          assert.equal(error, actionError);
        },
      }),
      mode === "tui" ? { kind: "closed", reason: "close" } : { kind: "closed", reason: "back" },
    );
    assert.equal(actionCalls, 1, mode);
    assert.equal(reporterCalls, 1, mode);
  }
});

test("choice TUI prefers initial over current and invokes the confirmed raw item id", async () => {
  const invoked: string[] = [];
  let customCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      assert.equal(customCalls, 1);
      const harness = createCustomSelectorHarness(factory, 80);
      const rendered = harness.render().join("\n");
      assert.match(rendered, /Safe.*✓ current/);
      assert.match(rendered, /→ Balanced/);
      harness.handleInput(" ");
      return harness.result;
    },
  });
  const definition = defineMenu<undefined, "profile", "choose">({
    start: "profile",
    screens: {
      profile: () => ({
        kind: "choice",
        title: "Profile",
        items: [
          { id: "safe", label: "Safe" },
          { id: "balanced", label: "Balanced", details: ["Recommended"] },
        ],
        action: "choose",
        currentItemId: "safe",
        initialItemId: "balanced",
      }),
    },
    actions: {
      choose: async ({ itemId }) => {
        invoked.push(itemId);
        return { kind: "close" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(invoked, ["balanced"]);
});

test("choice TUI falls back from a missing initial id to the current item", async () => {
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 80);
      assert.match(harness.render().join("\n"), /→ Safe.*✓ current/);
      harness.handleInput("\u0003");
      return harness.result;
    },
  });
  const definition = defineMenu<undefined, "profile", "choose">({
    start: "profile",
    screens: {
      profile: () => ({
        kind: "choice",
        title: "Profile",
        items: [
          { id: "balanced", label: "Balanced" },
          { id: "safe", label: "Safe" },
        ],
        action: "choose",
        currentItemId: "safe",
        initialItemId: "missing",
      }),
    },
    actions: { choose: async () => ({ kind: "close" }) },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
});

test("choice rejection restores remembered selection and falls back when that item disappears", async () => {
  let includeFast = true;
  let customCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      const harness = createCustomSelectorHarness(factory, 80);
      if (customCalls === 1) {
        assert.match(harness.render().join("\n"), /→ Balanced/);
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.confirm");
      } else {
        assert.match(harness.render().join("\n"), /→ Balanced/);
        assert.doesNotMatch(harness.render().join("\n"), /Fast/);
        harness.handleInput("\u0003");
      }
      return harness.result;
    },
  });
  const definition = defineMenu<undefined, "profile", "choose">({
    start: "profile",
    screens: {
      profile: () => ({
        kind: "choice",
        title: "Profile",
        items: [
          { id: "safe", label: "Safe" },
          { id: "balanced", label: "Balanced" },
          ...(includeFast ? [{ id: "fast", label: "Fast" }] : []),
        ],
        action: "choose",
        currentItemId: "safe",
        initialItemId: "balanced",
      }),
    },
    actions: {
      choose: async ({ itemId }) => {
        assert.equal(itemId, "fast");
        includeFast = false;
        return { kind: "rejected" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.equal(customCalls, 2);
});

test("choice actions receive owner abort and drain before stale exit", async () => {
  const owner = new AbortController();
  let reportStarted: (() => void) | undefined;
  let observedAbort = false;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => driveCustomSelector(factory, ["tui.select.confirm"], 40).result,
  });
  const definition = defineMenu<undefined, "choice", "choose">({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "choice",
        title: "Choose",
        items: [{ id: "safe", label: "Safe" }],
        action: "choose",
      }),
    },
    actions: {
      choose: async ({ signal }) => {
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
  const running = runMenu(context.ctx, definition, {
    getState: () => undefined,
    signal: owner.signal,
  });
  await started;
  owner.abort(new DOMException("Session replaced", "AbortError"));

  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(observedAbort, true);
});

test("choice RPC preserves duplicate-label identity and keeps disabled rows inert", async () => {
  const invoked: string[] = [];
  let selectCalls = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      selectCalls += 1;
      assert.equal(new Set(choices).size, choices.length);
      if (selectCalls === 1) return choices.find((choice) => choice.startsWith("[-]"));
      return choices.find((choice) => choice === "Same [2]");
    },
  });
  const definition = defineMenu<undefined, "choice", "choose">({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "choice",
        title: "Choose",
        items: [
          { id: "raw-one", label: "Same" },
          { id: "raw-two", label: "Same" },
          {
            id: "disabled",
            label: "Same",
            disabled: true,
            disabledReason: "Policy",
          },
        ],
        action: "choose",
        hint: "close",
      }),
    },
    actions: {
      choose: async ({ itemId }) => {
        invoked.push(itemId);
        return { kind: "close" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(invoked, ["raw-two"]);
  assert.equal(selectCalls, 2);
});

test("RPC explains disabled action rows and never invokes their targets", async () => {
  let selectCalls = 0;
  let invoked = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      selectCalls += 1;
      if (selectCalls === 1) {
        assert.match(choices[0] ?? "", /^\[-\].*unavailable: Policy blocks it/i);
        return choices[0];
      }
      return choices.at(-1);
    },
  });
  const definition = defineMenu<undefined, "main", "run">({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Actions",
        items: [
          {
            id: "blocked-raw",
            label: "Blocked action",
            disabled: true,
            disabledReason: "Policy\u0007 blocks it",
            action: "run",
          },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
    },
    actions: {
      run: async ({ itemId }) => {
        assert.equal(itemId, "blocked-raw");
        invoked += 1;
        return { kind: "stay" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.equal(invoked, 0);
  assert.equal(selectCalls, 2);
});

test("searchable multi-select TUI dispatches the filtered raw item id", async () => {
  const invoked: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 60);
      harness.handleInput("f");
      harness.handleInput("s");
      harness.handleInput("tui.select.confirm");
      await harness.waitForPending();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return harness.result;
    },
  });
  const definition = defineMenu<undefined, "tools", "toggle">({
    start: "tools",
    screens: {
      tools: () => ({
        kind: "multiSelect",
        title: "Tools",
        enableSearch: true,
        items: [
          { id: "raw-one", label: "Same", searchText: "alpha", selected: false },
          { id: "raw-two", label: "Same", searchText: "filesystem", selected: false },
        ],
        action: "toggle",
      }),
    },
    actions: {
      toggle: async ({ itemId }) => {
        invoked.push(itemId);
        return { kind: "close" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(invoked, ["raw-two"]);
});

test("searchable multi-select RPC keeps the full unfiltered unique row list", async () => {
  const invoked: string[] = [];
  let choicesSeen: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      choicesSeen = choices;
      return choices[1];
    },
  });
  const definition = defineMenu<undefined, "tools", "toggle">({
    start: "tools",
    screens: {
      tools: () => ({
        kind: "multiSelect",
        title: "Tools",
        enableSearch: true,
        items: [
          { id: "raw-one", label: "Same", searchText: "alpha", selected: false },
          { id: "raw-two", label: "Same", searchText: "filesystem", selected: false },
        ],
        action: "toggle",
        hint: "close",
      }),
    },
    actions: {
      toggle: async ({ itemId }) => {
        invoked.push(itemId);
        return { kind: "close" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(invoked, ["raw-two"]);
  assert.equal(new Set(choicesSeen).size, choicesSeen.length);
  assert.match(choicesSeen[0] ?? "", /Same/);
  assert.match(choicesSeen[1] ?? "", /Same/);
  assert.doesNotMatch(choicesSeen.join("\n"), /alpha|filesystem/);
});

test("RPC choices preserve item identity across duplicate and exit labels", async () => {
  let selectCalls = 0;
  const invoked: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      selectCalls += 1;
      assert.equal(new Set(choices).size, choices.length);
      if (selectCalls === 1) return choices[1];
      if (selectCalls === 2) return choices[2];
      return choices.at(-1);
    },
  });
  const definition = defineMenu<undefined, "tools", "toggle" | "bulk">({
    start: "tools",
    screens: {
      tools: () => ({
        kind: "multiSelect",
        title: "Tools",
        items: [],
        action: "toggle",
        actions: [
          { id: "first", label: "Same", action: "bulk" },
          { id: "second", label: "Same", action: "bulk" },
          { id: "done-action", label: "Done", action: "bulk" },
        ],
        hint: "close",
        doneLabel: "Done",
      }),
    },
    actions: {
      toggle: async () => ({ kind: "stay" }),
      bulk: async ({ itemId }) => {
        invoked.push(itemId);
        return { kind: "stay" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.deepEqual(invoked, ["second", "done-action"]);
  assert.equal(selectCalls, 3);
});

test("RPC exposes disabled multi-select reasons and never invokes toggle actions", async () => {
  let selectCalls = 0;
  let toggles = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      selectCalls += 1;
      if (selectCalls === 1) {
        assert.match(choices[0] ?? "", /unavailable.*policy blocks it/i);
        return choices[0];
      }
      return choices.at(-1);
    },
  });
  const definition = defineMenu<undefined, "tools", "toggle">({
    start: "tools",
    screens: {
      tools: () => ({
        kind: "multiSelect",
        title: "Tools",
        items: [
          {
            id: "blocked-raw",
            label: "Blocked",
            selected: false,
            disabled: true,
            disabledReason: "Policy blocks it",
          },
        ],
        action: "toggle",
      }),
    },
    actions: {
      toggle: async ({ itemId }) => {
        assert.equal(itemId, "blocked-raw");
        toggles += 1;
        return { kind: "stay" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });
  assert.equal(toggles, 0);
  assert.equal(selectCalls, 2);
});

test("RPC explains disabled multi-select action rows and keeps them inert", async () => {
  let selectCalls = 0;
  let invoked = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      selectCalls += 1;
      if (selectCalls === 1) {
        assert.match(choices[0] ?? "", /^\[-\].*unavailable: Policy blocks bulk changes/i);
        return choices[0];
      }
      return choices.at(-1);
    },
  });
  const definition = defineMenu<undefined, "tools", "toggle" | "bulk">({
    start: "tools",
    screens: {
      tools: () => ({
        kind: "multiSelect",
        title: "Tools",
        items: [],
        action: "toggle",
        actions: [
          {
            id: "blocked-bulk-raw",
            label: "Enable all",
            disabled: true,
            disabledReason: "Policy blocks bulk changes",
            action: "bulk",
          },
        ],
      }),
    },
    actions: {
      toggle: async () => ({ kind: "stay" }),
      bulk: async ({ itemId }) => {
        assert.equal(itemId, "blocked-bulk-raw");
        invoked += 1;
        return { kind: "stay" };
      },
    },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "back",
  });
  assert.equal(invoked, 0);
  assert.equal(selectCalls, 2);
});

test("lifecycle ExtensionContext menus retain runtime cancellation behavior", async () => {
  const owner = new AbortController();
  let reportOpened: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    reportOpened = resolve;
  });
  const commandContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 40);
      reportOpened?.();
      await new Promise<void>((resolve) => {
        owner.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return harness.result;
    },
  });
  const ctx: ExtensionContext = commandContext.ctx;
  const definition = defineMenu<undefined, "main", "run", ExtensionContext>({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Lifecycle",
        items: [{ id: "run", label: "Run", action: "run" }],
      }),
    },
    actions: { run: async () => ({ kind: "stay" }) },
  });
  const running = runMenu(ctx, definition, {
    getState: () => undefined,
    signal: owner.signal,
  });
  await opened;
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await running, { kind: "stale" });
});

test("an owner signal dismisses an unanswered RPC selector", async () => {
  const owner = new AbortController();
  let releaseFallback: (() => void) | undefined;
  let reportOpened: (() => void) | undefined;
  let selectorSettled = false;
  const fallback = new Promise<void>((resolve) => {
    releaseFallback = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    reportOpened = resolve;
  });
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, _choices: string[], dialogOptions?: { signal?: AbortSignal }) => {
      reportOpened?.();
      if (dialogOptions?.signal) {
        await new Promise<void>((resolve) => {
          if (dialogOptions.signal?.aborted) resolve();
          else dialogOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } else await fallback;
      selectorSettled = true;
      return undefined;
    },
  });
  const running = runMenu(context.ctx, runtimeMenu(), {
    getState: () => ({ count: 0 }),
    signal: owner.signal,
  });
  await opened;
  owner.abort(new DOMException("Session replaced", "AbortError"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeFallback = selectorSettled;
  releaseFallback?.();

  assert.equal(settledBeforeFallback, true);
  assert.deepEqual(await running, { kind: "stale" });
});

test("a stale action continuation cannot render another screen or report success", async () => {
  let current = true;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let customCalls = 0;
  let errorCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      return driveCustomSelector(factory, ["tui.select.confirm"], 40).result;
    },
  });
  const running = runMenu(
    context.ctx,
    runtimeMenu({
      run: async () => {
        await gate;
        return { kind: "stay" };
      },
    }),
    {
      getState: () => ({ count: 0 }),
      isCurrent: () => current,
      onError: () => {
        errorCalls += 1;
      },
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  current = false;
  release?.();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(customCalls, 1);
  assert.equal(errorCalls, 0);
});

test("an owner signal aborts in-flight state loading", async () => {
  const owner = new AbortController();
  let releaseState: (() => void) | undefined;
  let reportStarted: (() => void) | undefined;
  let observedAbort = false;
  const stateGate = new Promise<void>((resolve) => {
    releaseState = resolve;
  });
  const stateStarted = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const context = createMockContext({ mode: "tui", hasUI: true });
  const options = {
    signal: owner.signal,
    getState: async ({ signal }: { signal: AbortSignal }) => {
      reportStarted?.();
      signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
        },
        { once: true },
      );
      await stateGate;
      return { count: 0 };
    },
  };
  const running = runMenu(context.ctx, runtimeMenu(), options);
  await stateStarted;
  owner.abort(new DOMException("Session replaced", "AbortError"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const observedBeforeRelease = observedAbort;
  releaseState?.();

  assert.equal(observedBeforeRelease, true);
  assert.deepEqual(await running, { kind: "stale" });
});

test("an owner signal closes an idle custom screen", async () => {
  const owner = new AbortController();
  let reportOpened: (() => void) | undefined;
  let closedByOwner = false;
  const opened = new Promise<void>((resolve) => {
    reportOpened = resolve;
  });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 40);
      reportOpened?.();
      await new Promise<void>((resolve) => {
        owner.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      closedByOwner = harness.result !== undefined;
      return harness.result;
    },
  });
  const running = runMenu(context.ctx, runtimeMenu(), {
    getState: () => ({ count: 0 }),
    signal: owner.signal,
  });
  await opened;
  owner.abort(new DOMException("Session replaced", "AbortError"));

  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(closedByOwner, true);
});

test("an owner signal aborts and drains an in-flight non-busy action", async () => {
  const owner = new AbortController();
  let reportStarted: (() => void) | undefined;
  let observedAbort = false;
  const actionStarted = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => driveCustomSelector(factory, ["tui.select.confirm"], 40).result,
  });
  const running = runMenu(
    context.ctx,
    runtimeMenu({
      run: async ({ signal }) => {
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
    }),
    { getState: () => ({ count: 0 }), signal: owner.signal },
  );
  await actionStarted;
  owner.abort(new DOMException("Session replaced", "AbortError"));

  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(observedAbort, true);
});

test("a cancellable busy action receives abort, drains, and leaves the menu usable", async () => {
  let aborted = false;
  let settled = false;
  let release: (() => void) | undefined;
  const drainGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let customCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      const harness = createCustomSelectorHarness(factory, 40);
      if (customCalls === 1) harness.handleInput("tui.select.confirm");
      else if (customCalls === 2) {
        harness.handleInput("\u001b");
        harness.dispose();
        setImmediate(() => release?.());
      } else {
        assert.equal(settled, true);
        harness.handleInput("\u0003");
      }
      return harness.result;
    },
  });
  const result = await runMenu(
    context.ctx,
    runtimeMenu({
      busy: true,
      run: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        aborted = signal.aborted;
        await drainGate;
        settled = true;
        return { kind: "stay" };
      },
    }),
    { getState: () => ({ count: 0 }) },
  );
  assert.deepEqual(result, { kind: "closed", reason: "close" });
  assert.equal(aborted, true);
  assert.equal(customCalls, 3);
});

test("external busy-view disposal drains without reopening the obsolete menu", async () => {
  let customCalls = 0;
  let reportStarted: (() => void) | undefined;
  let releaseAction: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const actionGate = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      const harness = createCustomSelectorHarness(factory, 40);
      if (customCalls === 1) harness.handleInput("tui.select.confirm");
      else if (customCalls === 2) {
        await started;
        harness.dispose();
        releaseAction?.();
      } else throw new Error("Disposed busy UI must not reopen its old menu");
      return harness.result;
    },
  });

  const result = await runMenu(
    context.ctx,
    runtimeMenu({
      busy: true,
      run: async () => {
        reportStarted?.();
        await actionGate;
        return { kind: "stay" };
      },
    }),
    { getState: () => ({ count: 0 }) },
  );

  assert.deepEqual(result, { kind: "stale" });
  assert.equal(customCalls, 2);
});

test("a rejecting error reporter cannot strand a busy action", async () => {
  let customCalls = 0;
  let reporterCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      const harness = createCustomSelectorHarness(factory, 40);
      if (customCalls === 1) harness.handleInput("tui.select.confirm");
      else if (customCalls === 2) {
        for (let turn = 0; harness.result === undefined && turn < 100; turn += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.notEqual(harness.result, undefined);
        harness.dispose();
      } else harness.handleInput("\u0003");
      return harness.result;
    },
  });

  const result = await runMenu(
    context.ctx,
    runtimeMenu({
      busy: true,
      run: async () => {
        throw new Error("Action failed");
      },
    }),
    {
      getState: () => ({ count: 0 }),
      onError: async () => {
        reporterCalls += 1;
        throw new Error("Reporter failed");
      },
    },
  );

  assert.deepEqual(result, { kind: "closed", reason: "close" });
  assert.equal(customCalls, 3);
  assert.equal(reporterCalls, 1);
});

test("a rejecting error reporter preserves the documented state-load error result", async () => {
  const stateError = new Error("State failed");
  const context = createMockContext({ mode: "tui", hasUI: true });

  const result = await runMenu(context.ctx, runtimeMenu(), {
    getState: () => {
      throw stateError;
    },
    onError: async () => {
      throw new Error("Reporter failed");
    },
  });

  assert.deepEqual(result, { kind: "error", error: stateError });
});

test("component disposal aborts and drains pending setting work before returning", async () => {
  let releaseAction: (() => void) | undefined;
  let reportStarted: (() => void) | undefined;
  const actionGate = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  const actionStarted = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 80);
      harness.handleInput("m");
      harness.handleInput("tui.select.confirm");
      await actionStarted;
      harness.dispose();
      return undefined;
    },
  });
  const running = runMenu(context.ctx, runtimeMenu(), { getState: () => undefined });
  let settled = false;
  const completion = running.then((result) => {
    settled = true;
    return result;
  });
  await actionStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeRelease = settled;
  releaseAction?.();
  const result = await completion;

  assert.equal(settledBeforeRelease, false);
  assert.deepEqual(result, { kind: "stale" });

  function runtimeMenu() {
    return defineMenu<undefined, "settings", "save">({
      start: "settings",
      screens: {
        settings: () => ({
          kind: "settings",
          title: "Settings",
          items: [
            {
              id: "mode",
              label: "Mode",
              currentValue: "Off",
              values: ["Off", "On"],
              action: "save",
            },
          ],
        }),
      },
      actions: {
        save: async () => {
          reportStarted?.();
          await actionGate;
          return { kind: "stay" };
        },
      },
    });
  }
});

test("settings refreshes preserve the changed row cursor", async () => {
  let customCalls = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      const harness = createCustomSelectorHarness(factory, 80);
      if (customCalls === 1) {
        for (const input of ["m", "a", "n"]) harness.handleInput(input);
        assert.doesNotMatch(harness.render().join("\n"), /Automatic mode/);
        harness.handleInput("tui.select.confirm");
      } else {
        assert.match(harness.render().join("\n"), /→ .*Manual mode/);
        harness.handleInput("\u0003");
      }
      for (let turn = 0; harness.result === undefined && turn < 100; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.notEqual(harness.result, undefined);
      return harness.result;
    },
  });
  const definition = defineMenu<undefined, "settings", "save">({
    start: "settings",
    screens: {
      settings: () => ({
        kind: "settings",
        title: "Settings",
        items: [
          {
            id: "automatic",
            label: "Automatic mode",
            currentValue: "Off",
            values: ["Off", "On"],
            action: "save",
          },
          {
            id: "manual",
            label: "Manual mode",
            currentValue: "Off",
            values: ["Off", "On"],
            action: "save",
          },
        ],
      }),
    },
    actions: { save: async () => ({ kind: "stay" }) },
  });

  assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
    kind: "closed",
    reason: "close",
  });
  assert.equal(customCalls, 2);
});

test("stale settings saves are rejected and drained before the runtime exits", async () => {
  let current = true;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let customCalls = 0;
  const definition = runtimeMenu();
  definition.actions.automatic = async () => {
    await gate;
    return { kind: "stay" };
  };
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      customCalls += 1;
      const inputs =
        customCalls === 1
          ? ["tui.select.down", "tui.select.down", "tui.select.confirm"]
          : ["tui.select.confirm", "tui.select.cancel"];
      const harness = createCustomSelectorHarness(factory, 40);
      for (const input of inputs) harness.handleInput(input);
      while (harness.result === undefined) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return harness.result;
    },
  });
  const running: Promise<RunMenuResult> = runMenu(context.ctx, definition, {
    getState: () => ({ count: 0 }),
    isCurrent: () => current,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  current = false;
  release?.();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(customCalls, 2);
});
