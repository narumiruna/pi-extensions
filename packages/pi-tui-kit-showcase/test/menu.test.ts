import { resolveMenuScreen, runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createInitialShowcaseState, createShowcaseMenu } from "../src/menu.js";

const reviewCases = [
  { screen: "reviewText", kind: "text", content: "Leading spaces stay visible." },
  { screen: "reviewCode", kind: "code", content: "interface DemoNote" },
  { screen: "review", kind: "diff", content: "diff --git" },
  { screen: "reviewMarkdownRich", kind: "markdown", content: "# Review example" },
  { screen: "reviewMarkdownSource", kind: "markdown", content: "# Review example" },
] as const;

test.each(reviewCases)(
  "$screen preserves its format in non-interactive rendering",
  async ({ screen, kind, content }) => {
    const state = createInitialShowcaseState();
    const menu = createShowcaseMenu({ requestStandalone() {} });
    const review = resolveMenuScreen(menu, screen, state);
    expect(review.kind).toBe("review");
    if (review.kind !== "review") throw new Error("Expected review");
    expect(review.enableSearch).toBe(true);
    expect(review.format?.kind).toBe(kind);
    const rpc = createRpcHarness([{ kind: "select", response: undefined }]);
    const context = createMockContext({ mode: "rpc", hasUI: true, select: rpc.ui.select });
    await runMenu(context.ctx, { ...menu, start: screen }, { getState: () => state });
    expect(rpc.dialogs[0]?.title).toContain(content);
    const actions = rpc.dialogs[0]?.options?.filter((label) => label !== "Next" && label !== "Previous");
    expect(actions).toEqual(screen === "review" ? ["Apply demo", "Back"] : ["Back"]);
    rpc.assertConsumed();
  },
);

test("Markdown variants explicitly select rich or source rendering", () => {
  const state = createInitialShowcaseState();
  const menu = createShowcaseMenu({ requestStandalone() {} });
  for (const [id, enabled] of [
    ["reviewMarkdownRich", true],
    ["reviewMarkdownSource", false],
  ] as const) {
    const screen = resolveMenuScreen(menu, id, state);
    expect(screen.kind === "review" ? screen.format : undefined).toEqual({
      kind: "markdown",
      renderLatex: enabled,
      renderMermaid: enabled,
    });
  }
  expect(resolveMenuScreen(menu, "browse", state)).toMatchObject({ enableDetailSearch: true });
});

test.each(["", " ", "x".repeat(81)])("input validation leaves state unchanged for invalid text", async (value) => {
  const state = createInitialShowcaseState();
  const original = structuredClone(state);
  const menu = createShowcaseMenu({ requestStandalone() {} });
  const context = createMockContext({ mode: "tui", hasUI: true });
  const result = await menu.actions.submitInput({
    ctx: context.ctx,
    state,
    signal: new AbortController().signal,
    itemId: "input",
    value,
  });
  expect(result).toEqual({ kind: "rejected" });
  expect(state).toEqual(original);
  expect(context.notifications.at(-1)?.level).toBe("warning");
});
