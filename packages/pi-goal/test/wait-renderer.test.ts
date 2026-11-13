import assert from "node:assert/strict";
import {
  convertToLlm,
  initTheme,
  type Theme,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { GoalRuntime } from "../src/runtime.js";
import { registerGoalTools } from "../src/tools.js";
import { renderGoalWaitCall, renderGoalWaitResult } from "../src/wait-renderer.js";
import { requireGoalTool, requireLastGoal, startGoalForTest } from "./support/goal-fixture.js";
import { WAIT_DEADLINE, WAIT_GOAL_ID, WAIT_REASON, waitRenderFixtures } from "./support/goal-wait-render-fixtures.js";

initTheme("dark", false);

function testTheme() {
  const roles: string[] = [];
  let color = "";
  const theme = {
    fg(role: string, value: string) {
      roles.push(role);
      return `${color}${value}`;
    },
    bold: (value: string) => value,
  } as Theme;
  return {
    theme,
    roles,
    setColor: (value: string) => {
      color = value;
    },
  };
}

function accepted(reason = WAIT_REASON, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: `Goal waiting: ${reason}` }],
    details: { goal: "Verify the workspace", goal_id: WAIT_GOAL_ID, reason, ...extra },
  };
}

function view(result = accepted(), expanded = false) {
  const { theme } = testTheme();
  return renderGoalWaitResult(result, { expanded, isPartial: false }, theme);
}

test("goal_wait registers display-only renderers and retains Pi's default shell", () => {
  const mock = createMockPi();
  registerGoalTools(mock.pi, new GoalRuntime(mock.pi));
  const tool = mock.tools.find((entry) => entry.name === "goal_wait");
  assert.equal(tool?.renderCall, renderGoalWaitCall);
  assert.equal(tool?.renderResult, renderGoalWaitResult);
  assert.equal(tool?.renderShell, undefined);
});

test.each([undefined, null, {}, { goal_id: "partial" }, { reason: WAIT_REASON }])(
  "call rendering accepts partial arguments without echoing them: %j",
  (args) => {
    const { theme, roles } = testTheme();
    const component = renderGoalWaitCall(args, theme);
    assert.deepEqual(component.render(80), ["Goal Wait"]);
    for (const width of [0, 1, 20, 80]) {
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
    assert.ok(roles.includes("toolTitle"));
  },
);

test.each(waitRenderFixtures)("collapsed and expanded outcomes: $name", (fixture) => {
  const { theme } = testTheme();
  const before = JSON.stringify(fixture.result);
  const collapsed = renderGoalWaitResult(fixture.result, { expanded: false, isPartial: false }, theme).render(80);
  const expanded = renderGoalWaitResult(fixture.result, { expanded: true, isPartial: false }, theme).render(80);
  const fullText = expanded.join("\n");
  if (fixture.accepted) {
    assert.equal(collapsed.length >= 3, true);
    assert.match(collapsed.join("\n"), /Resume: external input or \/goal resume/u);
    assert.doesNotMatch(collapsed.join("\n"), /Goal ID|goal_id|64c2162c|Goal waiting:/u);
    assert.ok(fullText.replaceAll("\n", "").includes(fixture.expected));
    assert.ok(fullText.includes(`Goal ID: ${WAIT_GOAL_ID}`));
    assert.equal((fullText.match(/Goal ID:/gu) ?? []).length, 1);
    assert.equal((fullText.match(/Resume:/gu) ?? []).length, 1);
  } else {
    assert.equal(fullText.replaceAll("\n", ""), fixture.expected);
    assert.doesNotMatch(fullText, /Resume:|Safety wake:|Goal ID:/u);
  }
  assert.equal(JSON.stringify(fixture.result), before);
});

test("collapsed reasons have at most two cell-wrapped rows and ellipses only for omitted text", () => {
  for (const reason of ["short reason", "row one\nrow two", "row one\nrow two\nrow three", WAIT_REASON]) {
    const lines = view(accepted(reason)).render(20);
    const reasonLines = lines.slice(
      0,
      lines.findIndex((line) => line.startsWith("Resume:")),
    );
    assert.ok(reasonLines.length <= 2);
    const omitted = reason === WAIT_REASON || reason.includes("row three");
    assert.equal(reasonLines.at(-1)?.endsWith("…"), omitted);
  }
  assert.deepEqual(view(accepted("row one\nrow two\nrow three")).render(20).slice(0, 2), ["row one", "row two…"]);
});

test("deadlines are absolute and expanded clamp metadata preserves both delay values", () => {
  const result = accepted("Wait for the monitor", {
    resume_at: WAIT_DEADLINE,
    requested_resume_after_ms: 1,
    resume_after_ms: 10_000,
  });
  const collapsed = view(result).render(80).join("\n");
  assert.match(collapsed, /Safety wake: 2026-11-13T07:55:00.000Z/u);
  assert.doesNotMatch(collapsed, /Requested delay:|Effective delay:/u);
  const expanded = view(result, true).render(80).join("\n");
  assert.match(expanded, /Requested delay: 1 ms/u);
  assert.match(expanded, /Effective delay: 10000 ms/u);
  assert.equal((expanded.match(/Safety wake:/gu) ?? []).length, 1);
});

test.each([NaN, Infinity, -1, 8_640_000_000_000_001, "tomorrow"])(
  "invalid legacy deadlines fall back to the original result: %s",
  (resumeAt) => {
    const rendered = view(accepted("Original diagnostic", { resume_at: resumeAt }), true)
      .render(80)
      .join("\n");
    assert.equal(rendered, "Goal waiting: Original diagnostic");
  },
);

test.each([
  undefined,
  null,
  [],
  {},
  { reason: "", goal_id: WAIT_GOAL_ID },
  { reason: 42, goal_id: WAIT_GOAL_ID },
  { reason: "reason", goal_id: " " },
  { reason: "reason", goal_id: 42 },
  { reason: "reason", goal_id: WAIT_GOAL_ID, goal: 42 },
  { reason: "reason", goal_id: WAIT_GOAL_ID, requested_resume_after_ms: 0 },
  { reason: "reason", goal_id: WAIT_GOAL_ID, requested_resume_after_ms: "1" },
  { reason: "reason", goal_id: WAIT_GOAL_ID, resume_after_ms: -1 },
  { reason: "reason", goal_id: WAIT_GOAL_ID, resume_after_ms: 1.5 },
])("malformed historical details preserve the original text: %j", (details) => {
  const { theme } = testTheme();
  const result = { content: [{ type: "text", text: "Goal waiting: Original diagnostic" }], details };
  const rendered = renderGoalWaitResult(result, { expanded: true, isPartial: false }, theme).render(80);
  assert.deepEqual(rendered, ["Goal waiting: Original diagnostic"]);
});

test.each([0, 8_640_000_000_000_000])("valid date boundaries remain renderable: %s", (resumeAt) => {
  const rendered = view(accepted("Wait", { resume_at: resumeAt }))
    .render(80)
    .join("\n");
  assert.ok(rendered.includes(`Safety wake: ${new Date(resumeAt).toISOString()}`));
});

test("partial and error results cannot become accepted wait displays", () => {
  const { theme, roles } = testTheme();
  for (const [isPartial, isError] of [
    [true, false],
    [false, true],
  ]) {
    const component = renderGoalWaitResult(accepted("Original text"), { expanded: true, isPartial }, theme, {
      isError,
    });
    assert.deepEqual(component.render(80), ["Goal waiting: Original text"]);
  }
  assert.ok(roles.includes("warning"));
  const rejected = waitRenderFixtures.find((fixture) => fixture.name.startsWith("rejected"));
  assert.ok(rejected);
  renderGoalWaitResult(rejected.result, { expanded: true, isPartial: false }, theme).render(80);
  assert.equal(roles.at(-1), "warning");
});

test("multiple text blocks and empty results retain a safe fallback", () => {
  const { theme } = testTheme();
  const result = accepted("First diagnostic");
  result.content.push({ type: "text", text: "Second diagnostic" });
  assert.deepEqual(renderGoalWaitResult(result, { expanded: true, isPartial: false }, theme).render(80), [
    "Goal waiting: First diagnostic",
    "Second diagnostic",
  ]);
  assert.deepEqual(renderGoalWaitResult({ content: [] }, { expanded: false, isPartial: true }, theme).render(80), [""]);
});

test.each([
  "等候完整驗證結果。請保留所有文字。".repeat(8),
  "👩‍💻 e\u0301 🧪 ".repeat(25),
  "word".repeat(100),
  "first line\n\n  indented line\n\tlast line",
])("cell bounds survive resize and expansion for %s", (reason) => {
  for (const expanded of [false, true]) {
    const component = view(accepted(reason), expanded);
    for (const width of [80, 20, 1, 0, 20, 80]) {
      component.invalidate();
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
  }
  const rendered = view(accepted(reason), true).render(80);
  const body = rendered.slice(
    0,
    rendered.findIndex((line) => line.startsWith("Goal:")),
  );
  if (!reason.includes("\t")) assert.equal(body.join("").replaceAll("\n", ""), reason.replaceAll("\n", ""));
});

test("terminal controls are removed before clipping while raw result payloads stay unchanged", () => {
  const reason = "Visible\u001b]52;c;clipboard\u0007\u001b[31m reason\u001b[0m\u009d52;c;hidden\u009c\u202esafe";
  const result = accepted(reason, { goal_id: "id\u001b]52;c;id-payload\u0007", goal: "goal\u001b[2J" });
  const before = JSON.stringify(result);
  for (const expanded of [false, true]) {
    const text = view(result, expanded).render(80).join("\n");
    assert.match(text, /Visible reasonsafe/u);
    assert.doesNotMatch(text, /clipboard|hidden|id-payload/u);
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      assert.ok(character === "\n" || (code >= 0x20 && (code < 0x7f || code > 0x9f) && code !== 0x202e));
    }
  }
  const { theme } = testTheme();
  const fallback = renderGoalWaitResult(
    { content: [{ type: "text", text: "Rejected\u001b]52;c;clipboard\u0007" }] },
    { expanded: true, isPartial: false },
    theme,
  );
  assert.deepEqual(fallback.render(80), ["Rejected"]);
  assert.equal(JSON.stringify(result), before);
});

test("theme changes rebuild title, body, and muted metadata without stale styled text", () => {
  const { theme, roles, setColor } = testTheme();
  const components = [
    renderGoalWaitCall({}, theme),
    renderGoalWaitResult(accepted(), { expanded: false, isPartial: false }, theme),
  ];
  for (const component of components) {
    setColor("\u001b[31m");
    assert.ok(component.render(80).join("\n").includes("\u001b[31m"));
    setColor("\u001b[32m");
    component.invalidate();
    assert.ok(!component.render(80).join("\n").includes("\u001b[31m"));
    assert.ok(component.render(80).join("\n").includes("\u001b[32m"));
  }
  assert.ok(roles.includes("toolTitle") && roles.includes("toolOutput") && roles.includes("muted"));
});

test.each([
  { key: "ctrl+o", input: "\u000f" },
  { key: "ctrl+y", input: "\u0019" },
  { key: [], input: undefined },
] as const)("native tool rows use the configured expansion hint: $key", ({ key, input }) => {
  const previous = getKeybindings();
  const bindings = new KeybindingsManager(
    { "app.tools.expand": { defaultKeys: "ctrl+o" } },
    { "app.tools.expand": typeof key === "string" ? key : [...key] },
  );
  setKeybindings(bindings);
  try {
    const renderers: ToolRenderers = { renderCall: renderGoalWaitCall, renderResult: renderGoalWaitResult };
    const component = new ToolExecutionComponent(
      "goal_wait",
      "wait-test",
      { goal_id: WAIT_GOAL_ID, reason: WAIT_REASON },
      { outputPad: 0 },
      renderers,
      { requestRender() {} } as TUI,
      process.cwd(),
    );
    component.updateResult({ ...accepted(), isError: false });
    const collapsed = stripTerminalSequences(component.render(80).join("\n"));
    assert.match(collapsed, /Goal Wait/u);
    assert.doesNotMatch(collapsed, /goal_id=|64c2162c|Goal waiting:/u);
    if (input) {
      assert.ok(bindings.matches(input, "app.tools.expand"));
      assert.ok(collapsed.includes(`${key} to expand`));
    } else assert.doesNotMatch(collapsed, /to expand/u);
    component.setExpanded(true);
    const expanded = stripTerminalSequences(component.render(80).join("\n"));
    assert.match(expanded, /Goal ID: 64c2162c/u);
    assert.doesNotMatch(expanded, /to expand/u);
    for (const width of [3, 20, 80]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
  } finally {
    setKeybindings(previous);
  }
});

test.each(["print", "json", "rpc"])(
  "%s execution retains its model and wire result without interactive UI",
  async (mode) => {
    const fixture = await startGoalForTest({
      mode,
      hasUI: mode === "rpc",
      custom() {
        throw new Error("Unexpected interactive UI");
      },
    });
    const goal = requireLastGoal(fixture.mock);
    try {
      const result = await requireGoalTool(fixture.mock, "goal_wait").execute(
        "wait-test",
        { goal_id: goal.id, reason: WAIT_REASON },
        new AbortController().signal,
        () => {},
        fixture.ctx,
      );
      assert.equal(result.terminate, true);
      assert.deepEqual(result.content, [{ type: "text", text: `Goal waiting: ${WAIT_REASON}` }]);
      assert.deepEqual(result.details, { goal: "finish", goal_id: goal.id, reason: WAIT_REASON });
      const message = {
        role: "toolResult" as const,
        toolCallId: "wait-test",
        toolName: "goal_wait",
        isError: false,
        timestamp: 0,
        content: (result.content ?? []).map((block) => ({ type: "text" as const, text: block.text })),
        details: result.details,
      };
      const modelBefore = JSON.stringify(convertToLlm([message]));
      const wireBefore = JSON.stringify(result);
      const { theme } = testTheme();
      for (const expanded of [false, true]) {
        renderGoalWaitResult(message, { expanded, isPartial: false }, theme).render(80);
      }
      assert.equal(JSON.stringify(result), wireBefore);
      assert.equal(JSON.stringify(convertToLlm([message])), modelBefore);
    } finally {
      await fixture.mock.events.get("session_shutdown")?.[0]?.({}, fixture.ctx);
    }
  },
);

test("before and after tool captures use the same recorded result", () => {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
  try {
    const args = { goal_id: WAIT_GOAL_ID, reason: WAIT_REASON };
    const ui = { requestRender() {} } as TUI;
    const before = new ToolExecutionComponent("goal_wait", "capture", args, { outputPad: 0 }, {}, ui, process.cwd());
    const after = new ToolExecutionComponent(
      "goal_wait",
      "capture",
      args,
      { outputPad: 0 },
      { renderCall: renderGoalWaitCall, renderResult: renderGoalWaitResult },
      ui,
      process.cwd(),
    );
    const result = { ...accepted(), isError: false };
    before.updateResult(result);
    after.updateResult(result);
    const capture = (component: ToolExecutionComponent) =>
      stripTerminalSequences(component.render(80).join("\n"))
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
    const collapsed = capture(after);
    after.setExpanded(true);
    expect({ before: capture(before), collapsed, expanded: capture(after) }).toMatchInlineSnapshot(`
      {
        "before": "goal_wait goal_id="64c2162c-9a8a-4911-bd66-f679aa0cc6e9" reason="The unchanged
      mandatory workspace runner i...
      Goal waiting: The unchanged mandatory workspace runner is in progress on the
      final review-fix code. Monitor job_mwenzczj_3h will wake this session on success
      or failure. Commit, publication and thread resolution depend on that result.",
        "collapsed": "Goal Wait
      The unchanged mandatory workspace runner is in progress on the final review-fix
      code. Monitor job_mwenzczj_3h will wake this session on success or failure. Com…
      Resume: external input or /goal resume
      ctrl+o to expand",
        "expanded": "Goal Wait
      The unchanged mandatory workspace runner is in progress on the final review-fix
      code. Monitor job_mwenzczj_3h will wake this session on success or failure. Comm
      it, publication and thread resolution depend on that result.
      Goal: Verify the workspace
      Goal ID: 64c2162c-9a8a-4911-bd66-f679aa0cc6e9
      Resume: external input or /goal resume",
      }
    `);
  } finally {
    setKeybindings(previous);
  }
});
