import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type BrowseDetailDocument,
  type ChoiceScreen,
  createMenuNavigator,
  defineMenu,
  type MenuBrowseItem,
  type MenuDefinition,
  PI_EXTENSION_MENU_API_VERSION,
  type ReviewFormat,
  resolveMenuScreen,
} from "../src/index.js";

type State = { count: number };
type ScreenId = "main" | "status";
type ActionId = "increment";

function testMenu(): MenuDefinition<State, ScreenId, ActionId> {
  return defineMenu<State, ScreenId, ActionId>({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: `Count ${state.count}`,
        items: [
          { id: "increment", label: "Increment", action: "increment" },
          { id: "status", label: "Status", to: "status" },
          { id: "close", label: "Close", close: true },
        ],
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Status",
        lines: [`Count: ${state.count}`],
      }),
    },
    actions: {
      increment: async () => ({ kind: "stay" }),
    },
  });
}

test("package exposes API version 18 and Markdown document types", () => {
  const markdown: ReviewFormat = {
    kind: "markdown",
    renderLatex: false,
    renderMermaid: true,
  };
  const document: BrowseDetailDocument = {
    content: "# Document\n\n$x^2$",
    format: markdown,
  };
  const item: MenuBrowseItem = {
    id: "schema",
    label: "Schema",
    detailDocument: document,
  };
  const apiVersion: 18 = PI_EXTENSION_MENU_API_VERSION;
  assert.equal(item.detailDocument, document);
  assert.equal(apiVersion, 18);
  assert.equal(resolveMenuScreen(testMenu(), "main", { count: 0 }).kind, "actions");
});

test("menu definitions resolve dynamic screens and reject invalid references", () => {
  const definition = testMenu();
  assert.equal(resolveMenuScreen(definition, "main", { count: 2 }).title, "Count 2");
  assert.throws(
    () =>
      resolveMenuScreen(
        {
          ...definition,
          screens: {
            ...definition.screens,
            main: () => ({
              kind: "actions",
              title: "Broken",
              items: [{ id: "missing", label: "Missing", to: "missing" as ScreenId }],
            }),
          },
        },
        "main",
        { count: 0 },
      ),
    /unknown screen.*missing/i,
  );
  assert.throws(
    () =>
      resolveMenuScreen(
        {
          ...definition,
          screens: {
            ...definition.screens,
            main: () => ({
              kind: "actions",
              title: "Broken",
              items: [{ id: "missing", label: "Missing", action: "missing" as ActionId }],
            }),
          },
        },
        "main",
        { count: 0 },
      ),
    /unknown action.*missing/i,
  );
});

test("multi-select viewports must be positive integers", () => {
  const definition = defineMenu<undefined, "tools", "toggle">({
    start: "tools",
    screens: {
      tools: () => ({
        kind: "multiSelect",
        title: "Tools",
        viewportSize: 0,
        items: [],
        action: "toggle",
      }),
    },
    actions: { toggle: async () => ({ kind: "stay" }) },
  });
  assert.throws(() => resolveMenuScreen(definition, "tools", undefined), /viewport.*positive integer/i);
  for (const viewportSize of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        resolveMenuScreen(
          {
            ...definition,
            screens: {
              tools: () => ({
                kind: "multiSelect" as const,
                title: "Tools",
                viewportSize,
                items: [],
                action: "toggle" as const,
              }),
            },
          },
          "tools",
          undefined,
        ),
      /viewport.*positive integer/i,
    );
  }
});

test("choice screens accept stable items and optional missing current and initial ids", () => {
  const screen: ChoiceScreen<"choose"> = {
    kind: "choice",
    title: "Profile",
    items: [
      { id: "safe", label: "Safe", details: ["One", "Two"] },
      { id: "fast", label: "Fast", disabled: true, disabledReason: "Unavailable" },
    ],
    action: "choose",
    currentItemId: "custom",
    initialItemId: "balanced",
    viewportSize: 5,
  };
  const definition = defineMenu<undefined, "choice", "choose">({
    start: "choice",
    screens: { choice: () => screen },
    actions: { choose: async () => ({ kind: "close" }) },
  });
  assert.equal(resolveMenuScreen(definition, "choice", undefined), screen);
});

test("choice screens require a known action and positive integer viewport", () => {
  const definition = defineMenu<undefined, "choice", "choose">({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "choice",
        title: "Profile",
        items: [{ id: "safe", label: "Safe" }],
        action: "missing" as "choose",
      }),
    },
    actions: { choose: async () => ({ kind: "close" }) },
  });
  assert.throws(() => resolveMenuScreen(definition, "choice", undefined), /choice.*unknown action.*missing/i);
  for (const viewportSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        resolveMenuScreen(
          {
            ...definition,
            screens: {
              choice: () => ({
                kind: "choice" as const,
                title: "Profile",
                items: [{ id: "safe", label: "Safe" }],
                action: "choose" as const,
                viewportSize,
              }),
            },
          },
          "choice",
          undefined,
        ),
      /choice.*viewport.*positive integer/i,
    );
  }
});

test("choice screens reject blank and duplicate raw ids", () => {
  const resolve = (ids: readonly string[]) =>
    resolveMenuScreen(
      defineMenu<undefined, "choice", "choose">({
        start: "choice",
        screens: {
          choice: () => ({
            kind: "choice",
            title: "Profile",
            items: ids.map((id) => ({ id, label: "Same" })),
            action: "choose",
          }),
        },
        actions: { choose: async () => ({ kind: "close" }) },
      }),
      "choice",
      undefined,
    );
  assert.throws(() => resolve([" "]), /id must not be empty/i);
  assert.throws(() => resolve(["same", "same"]), /id must be unique.*same/i);
});

test("browse screens accept adaptive viewports and reject invalid viewport sizes", () => {
  const resolve = (viewportSize: unknown) =>
    resolveMenuScreen(
      defineMenu<undefined, "browse", "unused">({
        start: "browse",
        screens: {
          browse: () =>
            ({
              kind: "browse",
              title: "Modules",
              items: [{ id: "model", label: "Model", statusText: "Showing" }],
              viewportSize,
            }) as never,
        },
        actions: { unused: async () => ({ kind: "close" }) },
      }),
      "browse",
      undefined,
    );

  assert.equal((resolve("adaptive") as { kind: string }).kind, "browse");
  assert.equal((resolve(5) as { kind: string }).kind, "browse");
  for (const viewportSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "fluid"]) {
    assert.throws(() => resolve(viewportSize), /browse.*viewport.*adaptive.*positive integer/i);
  }
});

test("input screens require a known action", () => {
  const definition = defineMenu<undefined, "input", "submit">({
    start: "input",
    screens: {
      input: () => ({
        kind: "input",
        title: "Value",
        action: "missing" as "submit",
      }),
    },
    actions: { submit: async () => ({ kind: "close" }) },
  });
  assert.throws(() => resolveMenuScreen(definition, "input", undefined), /input.*unknown action.*missing/i);
});

test("review screens validate viewport and confirmation identity", () => {
  const adaptiveScreen = {
    kind: "review" as const,
    title: "Adaptive review",
    content: "diff",
    viewportSize: "adaptive" as const,
  };
  const adaptiveDefinition = defineMenu<undefined, "review", "apply">({
    start: "review",
    screens: { review: () => adaptiveScreen },
    actions: { apply: async () => ({ kind: "close" }) },
  });
  assert.equal(resolveMenuScreen(adaptiveDefinition, "review", undefined), adaptiveScreen);

  const definition = defineMenu<undefined, "review", "apply">({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title: "Review",
        content: "diff",
        viewportSize: 0,
        confirm: { id: " ", label: "Apply", action: "missing" as "apply" },
      }),
    },
    actions: { apply: async () => ({ kind: "close" }) },
  });
  assert.throws(() => resolveMenuScreen(definition, "review", undefined), /review.*viewport.*positive integer/i);
  for (const viewportSize of [-1, 1.5, 51, Number.NaN, Number.POSITIVE_INFINITY, "fluid"]) {
    assert.throws(
      () =>
        resolveMenuScreen(
          {
            ...definition,
            screens: {
              review: () => ({
                kind: "review" as const,
                title: "Review",
                content: "diff",
                viewportSize: viewportSize as never,
              }),
            },
          },
          "review",
          undefined,
        ),
      /review.*viewport.*positive integer/i,
    );
  }
  const withViewport = {
    ...definition,
    screens: {
      review: () => ({
        kind: "review" as const,
        title: "Review",
        content: "diff",
        confirm: { id: " ", label: "Apply", action: "apply" as const },
      }),
    },
  };
  assert.throws(() => resolveMenuScreen(withViewport, "review", undefined), /review.*confirmation id.*empty/i);
  assert.throws(
    () =>
      resolveMenuScreen(
        {
          ...withViewport,
          screens: {
            review: () => ({
              kind: "review" as const,
              title: "Review",
              content: "diff",
              confirm: { id: "apply", label: " ", action: "apply" as const },
            }),
          },
        },
        "review",
        undefined,
      ),
    /review.*confirmation label.*empty/i,
  );
  assert.throws(
    () =>
      resolveMenuScreen(
        {
          ...withViewport,
          screens: {
            review: () => ({
              kind: "review" as const,
              title: "Review",
              content: "diff",
              confirm: {
                id: "apply",
                label: "Apply",
                action: "missing" as "apply",
              },
            }),
          },
        },
        "review",
        undefined,
      ),
    /review.*unknown action.*missing/i,
  );
});

test("navigator records root Back only after nested Back returns to the parent", () => {
  const navigator = createMenuNavigator<ScreenId>("main");
  assert.equal(navigator.current, "main");
  assert.equal(navigator.closeReason, undefined);
  assert.equal(navigator.apply({ kind: "to", screen: "status" }), "active");
  assert.equal(navigator.current, "status");
  assert.equal(navigator.apply({ kind: "back" }), "active");
  assert.equal(navigator.current, "main");
  assert.equal(navigator.closeReason, undefined);
  assert.equal(navigator.apply({ kind: "back" }), "closed");
  assert.equal(navigator.closed, true);
  assert.equal(navigator.closeReason, "back");
  assert.equal(navigator.apply({ kind: "close" }), "closed");
  assert.equal(navigator.closeReason, "back");
});

test("navigator records explicit Close and never replaces the terminal reason", () => {
  const navigator = createMenuNavigator<ScreenId>("main");
  assert.equal(navigator.apply({ kind: "to", screen: "status" }), "active");
  assert.equal(navigator.apply({ kind: "close" }), "closed");
  assert.equal(navigator.closed, true);
  assert.equal(navigator.closeReason, "close");
  assert.equal(navigator.apply({ kind: "back" }), "closed");
  assert.equal(navigator.closeReason, "close");
});

test("navigator restores stable selections and falls back when an item disappears", () => {
  const navigator = createMenuNavigator<ScreenId>("main");
  navigator.rememberSelection("main", "status");
  assert.equal(navigator.selectionFor("main", ["increment", "status"]), "status");
  assert.equal(navigator.selectionFor("main", ["increment"]), "increment");
  assert.equal(navigator.selectionFor("main", []), undefined);
});
