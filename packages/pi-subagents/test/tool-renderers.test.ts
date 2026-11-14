import assert from "node:assert/strict";
import {
  convertToLlm,
  initTheme,
  type Theme,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  KeybindingsManager,
  Markdown,
  setKeybindings,
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { subagentToolRenderers } from "../src/tool-renderers.js";
import { registerSubagentTools } from "../src/tools.js";
import { JOB_STATES } from "../src/types.js";

initTheme("dark", false);

type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type RenderResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

function createTheme() {
  const roles: string[] = [];
  let color = "";
  const theme = {
    fg(role: string, text: string) {
      roles.push(role);
      return `${color}${text}`;
    },
    bold: (text: string) => text,
  } as unknown as Theme;
  return {
    theme,
    roles,
    color: (value: string) => {
      color = value;
    },
  };
}

function context(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
  return {
    args: {},
    toolCallId: "call_1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 1,
    keyText: () => "ctrl+shift+o",
    keyHint: () => "unused",
    ...overrides,
  };
}

function result(payload: unknown): RenderResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

function resultView(
  action: Parameters<typeof subagentToolRenderers>[0],
  value: RenderResult,
  expanded = false,
  overrides: Partial<ToolRenderContext> = {},
) {
  const { theme, roles } = createTheme();
  const renderer = subagentToolRenderers(action).renderResult;
  assert.ok(renderer);
  const message = {
    ...value,
    role: "toolResult" as const,
    toolCallId: "call_1",
    toolName: `subagent_${action}`,
    isError: overrides.isError ?? false,
    timestamp: 0,
  };
  const before = JSON.stringify(message);
  const modelBefore = JSON.stringify(convertToLlm([message]));
  const component = renderer(value, { expanded, isPartial: false }, theme, context(overrides));
  const text = component.render(160).join("\n");
  assert.equal(JSON.stringify(message), before);
  assert.equal(JSON.stringify(convertToLlm([message])), modelBefore);
  return { component, roles, text };
}

for (const action of ["spawn", "inspect", "cancel", "wait", "send"] as const) {
  test(`${action} is registered with both conversation renderers`, () => {
    const mock = createMockPi();
    registerSubagentTools(mock.pi);
    const tool = mock.tools.find((tool) => tool.name === `subagent_${action}`);
    assert.equal(typeof tool?.renderCall, "function");
    assert.equal(typeof tool?.renderResult, "function");
    assert.notEqual(tool?.renderShell, "self");
  });

  test(`${action} handles streaming arguments, pending results, and observable errors`, () => {
    const renderers = subagentToolRenderers(action);
    const { theme } = createTheme();
    for (const args of [
      undefined,
      null,
      [],
      {},
      { task: null, message: null, recipient: 1, jobId: [] },
      { tools: ["read"], extensions: [{ path: "/trusted", tools: [] }], timeoutMs: 1_000 },
    ]) {
      const view = renderers.renderCall?.(args, theme, context({ argsComplete: false }));
      assert.ok(view);
      assert.match(view.render(80).join("\n"), /Subagent/u);
      assert.doesNotMatch(view.render(80).join("\n"), /undefined|null|\[object Object\]/u);
    }
    const pending = renderers.renderResult?.(result({}), { expanded: false, isPartial: true }, theme, context());
    assert.ok(pending);
    assert.match(pending.render(80).join("\n"), /…/u);
    assert.doesNotMatch(pending.render(80).join("\n"), /accepted|completed|to expand/u);
    for (const expanded of [false, true]) {
      const view = resultView(
        action,
        { content: [{ type: "text", text: "Unknown job.\nRetry later." }], details: undefined },
        expanded,
        {
          isError: true,
        },
      );
      assert.match(view.text, /failed/u);
      assert.match(view.text, /Unknown job/u);
      assert.ok(view.roles.includes("error"));
      assert.doesNotMatch(view.text, /accepted|completed/u);
    }
  });
}

test("call summaries show targets and previews, while expanded pending calls preserve full arguments", () => {
  const { theme } = createTheme();
  const fixtures = [
    {
      action: "spawn",
      args: {
        task: "Review files\n  preserve indentation",
        tools: ["read"],
        provider: "provider-a",
        model: "model-a",
        timeout: 300,
      },
    },
    { action: "send", args: { recipient: "job_a", message: "Question\n  exact message" } },
    { action: "send", args: { requestId: "req_a", message: "Answer\n  exact message" } },
    { action: "wait", args: { jobId: "job_a", timeout: 3 } },
    { action: "cancel", args: { jobId: "job_a" } },
  ] as const;
  for (const { action, args } of fixtures) {
    const renderer = subagentToolRenderers(action).renderCall;
    assert.ok(renderer);
    const before = JSON.stringify(args);
    const collapsed = renderer(args, theme, context()).render(120).join("\n");
    assert.doesNotMatch(collapsed, /recipient=|task=|timeout|provider|undefined/u);
    const expanded = renderer(args, theme, context({ expanded: true, isPartial: true }))
      .render(120)
      .join("\n");
    for (const key of Object.keys(args)) assert.ok(expanded.includes(`${key}:`));
    if (action === "spawn" || action === "send") assert.ok(expanded.includes("\n  "));
    assert.equal(JSON.stringify(args), before);
  }
});

test.each(JOB_STATES)("job state %s is visible with its semantic theme role", (state) => {
  const { text, roles } = resultView("wait", result({ jobId: "job_a", state, timedOut: false }));
  assert.ok(text.includes(`job_a · ${state.replaceAll("_", " ")}`));
  const role =
    state === "failed" || state === "timed_out"
      ? "error"
      : state === "partial" || state === "cancelled"
        ? "warning"
        : state === "completed"
          ? "success"
          : state === "running"
            ? "accent"
            : "muted";
  assert.ok(roles.includes(role));
});

test("wait timeout and message interruption do not imply job termination", () => {
  const timeout = resultView("wait", result({ jobId: "job_a", state: "running", timedOut: true }));
  assert.match(timeout.text, /running · wait timed out \(job not cancelled\)/u);
  assert.ok(timeout.roles.includes("warning"));
  const raced = resultView(
    "wait",
    result({ jobId: "job_a", state: "failed", timedOut: false, interrupted: true, reason: "subagent_message" }),
  );
  assert.match(raced.text, /failed · interrupted/u);
  assert.ok(raced.roles.includes("error"));
  const interrupted = resultView(
    "wait",
    result({ jobId: "job_a", state: "queued", timedOut: false, interrupted: true, reason: "subagent_message" }),
  );
  assert.match(interrupted.text, /queued · interrupted by subagent message/u);
});

test("wait expansion decodes Markdown and preserves errors, limitations, and metadata", () => {
  const payload = {
    jobId: "job_a",
    state: "partial",
    timedOut: false,
    error: "Line one\n  line two",
    limitations: ["Not verified\n  details"],
    result: "# Findings\n\n- First\n- Second",
  };
  const value = result(payload);
  const before = JSON.stringify(value);
  const collapsed = resultView("wait", value);
  assert.match(collapsed.text, /partial · Line one line two · 1 limitation/u);
  assert.doesNotMatch(collapsed.text, /First|Second/u);
  const expanded = resultView("wait", value, true);
  assert.match(expanded.text, /Error: Line one\n {2}line two/u);
  assert.match(expanded.text, /Limitation: Not verified\n {2}details/u);
  assert.match(expanded.text, /Findings/u);
  assert.match(expanded.text, /First/u);
  assert.match(expanded.text, /Second/u);
  assert.doesNotMatch(expanded.text, /\\n|"result"|to expand/u);
  assert.match(expanded.text, /"timedOut": false/u);
  assert.equal(JSON.stringify(value), before);
});

test("expanded wait results retain Markdown caches and forward invalidation", () => {
  const render = vi.spyOn(Markdown.prototype, "render");
  const invalidate = vi.spyOn(Markdown.prototype, "invalidate");
  try {
    const value = result({
      jobId: "job_a",
      state: "completed",
      timedOut: false,
      result: "Body marker\n\n```ts\nconst count = 1;\n```",
    });
    const { component } = resultView("wait", value, true);
    const first = component.render(160);
    assert.deepEqual(component.render(160), first);
    assert.equal(new Set(render.mock.contexts).size, 1);
    component.invalidate();
    assert.equal(invalidate.mock.calls.length, 1);
    assert.deepEqual(component.render(160), first);
    assert.equal(new Set(render.mock.contexts).size, 1);
  } finally {
    render.mockRestore();
    invalidate.mockRestore();
  }
});

test("inspect shows counts and prioritizes failures instead of previewing JSON timestamps", () => {
  const jobs = [
    ...Array.from({ length: 7 }, (_, i) => ({
      jobId: `job_completed_${i}`,
      state: "completed",
      createdAt: 1794547526185,
    })),
    { jobId: "job_failed", state: "failed", createdAt: 1794547526186, finishedAt: 1794547526187 },
    { jobId: "job_running", state: "running", createdAt: 1794547526188 },
    { jobId: "job_queued", state: "queued", createdAt: 1794547526189 },
  ];
  const value = result({ jobs, omitted: { jobs: 3 } });
  const before = JSON.stringify(value);
  const { text, component } = resultView("inspect", value);
  assert.match(text, /10 jobs.*1 queued.*1 running.*7 completed.*1 failed/u);
  assert.match(text, /job_failed · failed/u);
  assert.match(text, /job_running · running/u);
  assert.match(text, /5 more jobs/u);
  assert.match(text, /3 expired or removed jobs/u);
  assert.doesNotMatch(text, /createdAt|1794547526185/u);
  assert.ok(component.render(80).length <= 9);
  const expanded = resultView("inspect", value, true).text;
  for (const job of jobs) assert.ok(expanded.includes(job.jobId));
  assert.match(expanded, /1794547526185/u);
  assert.equal(JSON.stringify(value), before);
  assert.match(resultView("inspect", result({ jobs: [], omitted: { jobs: 0 } })).text, /No retained jobs/u);
});

test.each([
  { accepted: true, duplicate: false, expected: "Request accepted" },
  { accepted: true, duplicate: true, expected: "Request accepted · duplicate" },
  { accepted: false, duplicate: false, expected: "Request not accepted" },
  { accepted: false, duplicate: true, expected: "Request not accepted · duplicate" },
])("send renders acknowledgement accurately: $expected", ({ accepted, duplicate, expected }) => {
  const value = result({ requestId: "req_a", accepted, duplicate });
  assert.ok(resultView("send", value).text.includes(`${expected} · req_a`));
  assert.match(resultView("send", value, false, { args: { requestId: "req_a" } }).text, /Reply/u);
  assert.match(resultView("send", value, true).text, /"duplicate"/u);
});

test("missing or invalid details use valid JSON content; malformed results remain observable", () => {
  for (const details of [undefined, null, [], { jobId: "wrong", state: "unknown" }]) {
    const value = { ...result({ jobId: "job_a", state: "completed", result: "# Decoded\n\nResult" }), details };
    const text = resultView("wait", value, true).text;
    assert.match(text, /job_a · completed/u);
    assert.match(text, /Decoded/u);
    assert.doesNotMatch(text, /\\n/u);
  }
  for (const raw of [
    "{not JSON\n  raw body",
    '["array body"]',
    '{"jobId":"job_a","state":"future"}',
    '{"jobId":"job_a","state":"completed","result":42}',
    "",
  ]) {
    const value: RenderResult = {
      content: [
        { type: "text", text: raw },
        { type: "image", data: "hidden image", mimeType: "image/png" },
      ],
      details: { invalid: true },
    };
    const text = resultView("wait", value, true).text;
    assert.ok(text.includes(raw || "No result returned."));
    assert.doesNotMatch(text, /hidden image/u);
  }
});

test.each(["ctrl+o/ctrl+shift+o", "", undefined])("tool hints use only host-injected keys: %s", (key) => {
  const { text } = resultView("wait", result({ jobId: "job_a", state: "completed", timedOut: false }), false, {
    keyText: key === undefined ? undefined : () => key,
    executionStarted: false,
    argsComplete: false,
  });
  assert.match(text, /job_a · completed/u);
  if (key) assert.ok(text.includes(`${key} to expand`));
  else assert.doesNotMatch(text, /to expand/u);
});

test("spawn acknowledgement remains queued and does not infer child completion or defaults", () => {
  for (const timeout of [undefined, 300]) {
    const value = result({ jobId: "job_a", state: "queued", ...(timeout === undefined ? {} : { timeout }) });
    const collapsed = resultView("spawn", value).text;
    assert.match(collapsed, /job_a · queued/u);
    assert.doesNotMatch(collapsed, /completed|provider|model|tools/u);
    const expanded = resultView("spawn", value, true).text;
    if (timeout !== undefined) assert.match(expanded, /"timeout": 300/u);
  }
});

test.each(JOB_STATES.filter((state) => state !== "queued" && state !== "running"))(
  "cancel preserves an already-terminal %s result",
  (state) => {
    const { text } = resultView("cancel", result({ jobId: "job_a", state }));
    assert.ok(text.includes(`job_a · ${state.replaceAll("_", " ")}`));
    if (state !== "cancelled") assert.doesNotMatch(text, /cancelled/u);
  },
);

test("structured details survive truncated or conflicting result content", () => {
  const cases = [
    {
      action: "inspect",
      payload: { jobs: JOB_STATES.map((state) => ({ jobId: `job_${state}`, state })), omitted: { jobs: 1 } },
      expected: "job_cancelled",
    },
    { action: "send", payload: { requestId: "req_real", accepted: true, duplicate: false }, expected: "req_real" },
    {
      action: "wait",
      payload: { jobId: "job_real", state: "completed", result: "# Decoded\n\nComplete result" },
      expected: "Complete result",
    },
  ] as const;
  for (const { action, payload, expected } of cases) {
    for (const raw of ['{"truncated', '{"jobId":"job_wrong","state":"failed"}']) {
      const value = { content: [{ type: "text" as const, text: raw }], details: payload };
      const { text } = resultView(action, value, true);
      assert.ok(text.includes(expected));
      assert.doesNotMatch(text, /job_wrong|truncated/u);
    }
  }
});

test("inspect counts every state and keeps snapshot privacy", () => {
  const value = result({ jobs: JOB_STATES.map((state) => ({ jobId: `job_${state}`, state })), omitted: { jobs: 0 } });
  const { text } = resultView("inspect", value);
  for (const state of JOB_STATES) assert.ok(text.includes(`1 ${state.replaceAll("_", " ")}`));
  assert.doesNotMatch(text, /task|result|tools|credentials/u);
});

test("every renderer is safe at narrow widths, sanitizes before wrapping, and refreshes theme styles", () => {
  const raw = "日本語 👩‍💻 e\u0301\u001b]0;PRIVATE\u0007\u001b[31m\u202e\u2066\n  body\tend";
  const { theme, color } = createTheme();
  const views: Component[] = [];
  for (const action of ["spawn", "inspect", "cancel", "wait", "send"] as const) {
    const renderers = subagentToolRenderers(action);
    for (const expanded of [false, true]) {
      const ctx = context({ expanded, args: { jobId: raw }, keyText: () => "ctrl+y" });
      const call = renderers.renderCall?.({ task: raw, message: raw, recipient: raw, jobId: raw }, theme, ctx);
      assert.ok(call);
      views.push(call);
      for (const value of [
        result(
          action === "inspect"
            ? { jobs: [{ jobId: raw, state: "failed", error: raw }], omitted: { jobs: 0 } }
            : action === "send"
              ? { requestId: raw, accepted: true, duplicate: false }
              : { jobId: raw, state: "failed", error: raw, result: raw },
        ),
        { content: [{ type: "text" as const, text: raw }], details: undefined },
      ]) {
        const view = renderers.renderResult?.(value, { expanded, isPartial: false }, theme, ctx);
        assert.ok(view);
        views.push(view);
      }
    }
  }
  for (const view of views) {
    for (const width of [0, 1, 2, 4, 8, 20, 80, Number.NaN]) {
      const lines = view.render(width);
      if (width === 0 || Number.isNaN(width)) assert.deepEqual(lines, []);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
      const text = lines.join("\n");
      assert.doesNotMatch(text, /PRIVATE|\p{Bidi_Control}/u);
      assert.equal(text.includes("\u001b[31m"), false);
      assert.equal(text.includes("\u001b]"), false);
    }
    color("\u001b[31m");
    assert.ok(view.render(80).join("\n").includes("\u001b[31m"));
    color("\u001b[32m");
    view.invalidate();
    assert.ok(view.render(80).join("\n").includes("\u001b[32m"));
    assert.ok(!view.render(80).join("\n").includes("\u001b[31m"));
    color("");
  }
});

test.each([
  { keys: "ctrl+o", input: "\u000f" },
  { keys: "ctrl+y", input: "\u0019" },
  { keys: [], input: undefined },
] as const)("native Pi tool rows supply the configured expansion binding: $keys", ({ keys, input }) => {
  const previous = getKeybindings();
  const bindings = new KeybindingsManager(
    { "app.tools.expand": { defaultKeys: "ctrl+o" } },
    { "app.tools.expand": typeof keys === "string" ? keys : [...keys] },
  );
  setKeybindings(bindings);
  try {
    const renderers: ToolRenderers = subagentToolRenderers("inspect");
    const value = result({
      jobs: [{ jobId: "job_a", state: "failed", createdAt: 1794547526185 }],
      omitted: { jobs: 0 },
    });
    const before = JSON.stringify(value);
    const component = new ToolExecutionComponent(
      "subagent_inspect",
      "inspect_1",
      {},
      undefined,
      renderers,
      { requestRender() {} } as TUI,
      process.cwd(),
    );
    component.updateResult({ ...value, isError: false });
    const collapsed = stripTerminalSequences(component.render(120).join("\n"));
    assert.match(collapsed, /Subagent · Inspect/u);
    assert.match(collapsed, /job_a · failed/u);
    assert.doesNotMatch(collapsed, /createdAt/u);
    if (input) {
      assert.ok(bindings.matches(input, "app.tools.expand"));
      assert.ok(collapsed.includes(`${keys} to expand`));
    } else {
      assert.doesNotMatch(collapsed, /to expand/u);
    }
    for (const width of [3, 4, 8, 20, 80]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    // Widths below three are bounded by the host shell, not by a tool renderer.
    component.setExpanded(true);
    const expanded = stripTerminalSequences(component.render(120).join("\n"));
    assert.match(expanded, /createdAt/u);
    assert.doesNotMatch(expanded, /to expand/u);
    assert.equal(JSON.stringify(value), before);
  } finally {
    setKeybindings(previous);
  }
});
