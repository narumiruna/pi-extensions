import assert from "node:assert/strict";
import { type AgentTool, runToolCall } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  convertToLlm,
  initTheme,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { type SubagentToolAction, subagentToolRenderers } from "../src/tool-renderers.js";
import { registerSubagentTools } from "../src/tools.js";

initTheme("dark", false);

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const ui = { requestRender() {} } as TUI;
const fixtures: { action: SubagentToolAction; args: ToolCall["arguments"]; pending: string }[] = [
  {
    action: "spawn",
    args: { task: "Review parser tests", tools: ["read"], timeout: 123 },
    pending: "Starting subagent…",
  },
  { action: "inspect", args: {}, pending: "Inspecting jobs…" },
  { action: "cancel", args: { jobId: "job_a" }, pending: "Cancelling job…" },
  { action: "wait", args: { jobId: "job_a", timeout: 123 }, pending: "Waiting for job or subagent message…" },
  { action: "send", args: { recipient: "job_a", message: "Check empty input" }, pending: "Sending message…" },
];

type HtmlRenderer = {
  renderCall(id: string, name: string, args: ToolCall["arguments"]): string | undefined;
  renderResult(
    id: string,
    name: string,
    content: { type: "text"; text: string }[],
    details: unknown,
    isError: boolean,
  ): { collapsed?: string; expanded: string } | undefined;
};

async function htmlRenderer(action: SubagentToolAction): Promise<HtmlRenderer> {
  // Resolve the installed host implementation without relying on an unexported package subpath.
  const moduleUrl = new URL(
    "./core/export-html/tool-renderer.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const { createToolHtmlRenderer } = await import(moduleUrl.href);
  return createToolHtmlRenderer({
    getToolRenderers: () => subagentToolRenderers(action),
    theme,
    cwd: process.cwd(),
    width: 60,
  }) as HtmlRenderer;
}

for (const { action, args } of [
  ...fixtures,
  { action: "send" as const, args: { requestId: "req_reply", message: "Use the current schema" } },
]) {
  const label = action === "send" && "requestId" in args ? "send reply" : action;
  for (const isError of [false, true]) {
    test(`HTML ${label} retains complete arguments when isError=${isError}`, async () => {
      const input = {
        ...args,
        ...(action === "spawn"
          ? { task: `${"Long task. ".repeat(20)}\n  TASK_TAIL`, model: "model_override", skills: ["/trusted/skill"] }
          : action === "send"
            ? { message: `${"Long message. ".repeat(20)}\n  MESSAGE_TAIL` }
            : {}),
      };
      const before = JSON.stringify(input);
      const renderer = await htmlRenderer(action);
      const header = renderer.renderCall("html_call", `subagent_${action}`, input);
      assert.ok(header);
      assert.doesNotMatch(header, /TASK_TAIL|MESSAGE_TAIL|Starting subagent|Waiting for job/u);
      const payload =
        action === "inspect"
          ? { jobs: [], omitted: { jobs: 0 } }
          : action === "send"
            ? { requestId: "req_a", accepted: true, duplicate: false }
            : { jobId: "job_a", state: "completed" };
      const output = renderer.renderResult(
        "html_call",
        `subagent_${action}`,
        [{ type: "text", text: isError ? "Operation failed" : JSON.stringify(payload) }],
        isError ? undefined : payload,
        isError,
      );
      assert.ok(output);
      const expanded = output.expanded.replace(/<\/div>/gu, "\n").replace(/<[^>]*>/gu, "");
      for (const [key, value] of Object.entries(input)) {
        assert.ok(expanded.includes(`${key}:`), `${key} must remain inspectable in the exported result`);
        if (typeof value === "string") assert.ok(expanded.includes(value.split("\n").at(-1) ?? value));
      }
      if (action === "spawn" || action === "wait") assert.match(expanded, /timeout:\s*123/u);
      if (action === "spawn") {
        assert.match(expanded, /model_override/u);
        assert.match(expanded, /\/trusted\/skill/u);
        assert.match(expanded, /read/u);
      }
      if (label === "send reply" && !isError) assert.match(expanded, /Reply accepted/u);
      if (isError) assert.match(expanded, /Operation failed/u);
      assert.equal(JSON.stringify(input), before);
    });
  }
}

for (const { action, args, pending } of fixtures) {
  test(`${action} execution reaches Pi's pending renderer and settles without duplicate arguments`, async () => {
    const mock = createMockPi();
    const registered = registerSubagentTools(mock.pi);
    const { runtime } = registered;
    vi.spyOn(runtime, "start").mockReturnValue({ jobId: "job_a", state: "queued" });
    vi.spyOn(runtime, "inspectJobs").mockReturnValue({ jobs: [], omitted: 0 });
    vi.spyOn(runtime, "cancel").mockResolvedValue({ jobId: "job_a", state: "cancelled" });
    vi.spyOn(runtime, "wait").mockResolvedValue({ jobId: "job_a", state: "completed", timedOut: false });
    vi.spyOn(runtime, "sendToJob").mockResolvedValue({ requestId: "req_a", accepted: true, duplicate: false });
    const definition = (mock.tools as unknown as ToolDefinition[]).find((tool) => tool.name === `subagent_${action}`);
    assert.ok(definition);
    const ctx = createMockContext({
      model: { provider: "test", id: "test-model" },
      modelRegistry: {
        getRegisteredProviderIds: () => [],
        getProviderAuthStatus: () => ({ source: "env" }),
      },
    }).ctx;
    const row = new ToolExecutionComponent(
      definition.name,
      "execution",
      args,
      undefined,
      definition,
      ui,
      process.cwd(),
    );
    row.setArgsComplete();
    const beforeExecution = stripTerminalSequences(row.render(100).join("\n"));
    row.markExecutionStarted();
    const snapshots: string[] = [];
    const tool: AgentTool = {
      ...definition,
      execute: (id, input, signal, onUpdate) => definition.execute(id, input, signal, onUpdate, ctx),
    };
    const call = { type: "toolCall" as const, id: "execution", name: definition.name, arguments: args };
    const message = { ...fauxAssistantMessage(""), content: [call] };
    try {
      const outcome = await runToolCall(call, {
        tools: [tool],
        assistantMessage: message,
        context: { messages: [message], tools: [tool] },
        onUpdate(update) {
          row.updateResult({ ...update, isError: false }, true);
          snapshots.push(stripTerminalSequences(row.render(100).join("\n")));
        },
      });
      assert.equal(outcome.isError, false);
      assert.ok(!JSON.stringify(outcome.result).includes(pending), "progress must not enter the final tool result");
      assert.ok(!beforeExecution.includes(pending));
      assert.equal(snapshots.length, 1);
      assert.ok(snapshots[0]?.includes(pending));
      assert.doesNotMatch(snapshots[0] ?? "", /to expand/u);
      const stored = {
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: definition.name,
        ...outcome.result,
        isError: outcome.isError,
        timestamp: 0,
      };
      const modelBefore = JSON.stringify(convertToLlm([message, stored]));
      row.updateResult({ ...outcome.result, isError: outcome.isError });
      row.setExpanded(true);
      const expanded = stripTerminalSequences(row.render(100).join("\n"));
      assert.ok(!expanded.includes(pending));
      for (const key of Object.keys(args)) {
        assert.equal(expanded.split(`${key}:`).length - 1, 1, `${key} must appear in exactly one argument block`);
      }
      for (const width of [3, 4, 8, 20, 80]) {
        for (const line of row.render(width)) assert.ok(visibleWidth(line) <= width);
      }
      assert.equal(JSON.stringify(convertToLlm([message, stored])), modelBefore);
    } finally {
      await registered.shutdown();
      vi.restoreAllMocks();
    }
  });
}

for (const error of [new Error("Wait failed"), new DOMException("Wait cancelled", "AbortError")]) {
  test(`wait replaces pending output after ${error.name}`, async () => {
    const mock = createMockPi();
    const registered = registerSubagentTools(mock.pi);
    vi.spyOn(registered.runtime, "wait").mockRejectedValue(error);
    const definition = (mock.tools as unknown as ToolDefinition[]).find((tool) => tool.name === "subagent_wait");
    assert.ok(definition);
    const row = new ToolExecutionComponent(
      definition.name,
      "wait",
      { jobId: "job_a" },
      undefined,
      definition,
      ui,
      process.cwd(),
    );
    const pending: string[] = [];
    row.markExecutionStarted();
    try {
      await assert.rejects(
        definition.execute(
          "wait",
          { jobId: "job_a" },
          undefined,
          (update) => {
            row.updateResult({ ...update, isError: false }, true);
            pending.push(stripTerminalSequences(row.render(100).join("\n")));
          },
          createMockContext().ctx,
        ),
        error,
      );
      assert.equal(pending.length, 1);
      assert.match(pending[0] ?? "", /Waiting for job or subagent message/u);
      row.updateResult({ content: [{ type: "text", text: error.message }], details: undefined, isError: true });
      const output = stripTerminalSequences(row.render(100).join("\n"));
      assert.match(output, /Wait failed/u);
      assert.ok(output.includes(error.message));
      assert.doesNotMatch(output, /Waiting for job/u);
    } finally {
      await registered.shutdown();
      vi.restoreAllMocks();
    }
  });
}
