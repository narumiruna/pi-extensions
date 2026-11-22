import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { test, vi } from "vitest";
import { planFromDraftContextMessage } from "../src/draft-context.js";
import { restorePlanModeState } from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

const FIRST = "# First draft\n\nOriginal text";
const SECOND = "# Second draft\n\nRevised text";
const UPDATE = "plan_mode_update";
const COMPLETE = "plan_mode_complete";
const ENTRY = "plan-mode-state";

async function withPlan(run: (fixture: Awaited<ReturnType<typeof createPlanFixture>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "plan-draft-tools-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let fixture: Awaited<ReturnType<typeof createPlanFixture>> | undefined;
  try {
    fixture = await createPlanFixture(directory);
    await run(fixture);
  } finally {
    try {
      await fixture?.emit("session_shutdown");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function createPlanFixture(directory: string) {
  vi.resetModules();
  const { default: planMode } = await import("../src/plan-mode.js");
  const mock = createMockPi({ activeTools: ["read"] });
  let failAppend = false;
  let branch: unknown[] = [];
  const { appendEntry } = mock.rawPi;
  mock.rawPi.appendEntry = (customType, data) => {
    appendEntry(customType, data);
    branch.push({ type: "custom", customType, data });
    if (failAppend) {
      failAppend = false;
      throw new Error("append failed after publication");
    }
  };
  const context = createMockContext({
    mode: "rpc",
    cwd: directory,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
  });
  planMode(mock.pi, { settingsPath: join(directory, "pi-plan-mode.json") });
  async function emit(name: string, event: unknown = {}, ctx = context.ctx) {
    let result: unknown;
    for (const handler of mock.events.get(name) ?? []) result = await handler(event, ctx);
    return result;
  }
  async function command(args: string) {
    return mock.commands.get("plan")?.handler(args, context.ctx);
  }
  function tool(name: string, params: unknown, id = name, signal?: AbortSignal, ctx = context.ctx) {
    const execute = mock.tools.find((candidate) => candidate.name === name)?.execute;
    assert.equal(typeof execute, "function");
    return (execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; terminate?: boolean }>)(
      id,
      params,
      signal,
      undefined,
      ctx,
    );
  }
  await emit("session_start", { reason: "startup" });
  await command("start");
  return {
    directory,
    context,
    mock,
    emit,
    command,
    tool,
    branch: () => [...branch],
    state: () => restorePlanModeState(branch, ENTRY),
    failNextAppend: () => {
      failAppend = true;
    },
    async restore(entries: unknown[]) {
      branch = [...entries];
      await emit("session_tree");
    },
    async complete(params: unknown = {}) {
      await emit("message_end", { message: fauxAssistantMessage(fauxToolCall(COMPLETE, {}, { id: COMPLETE })) });
      return tool(COMPLETE, params);
    },
    async requestContext(messages: unknown[]) {
      const result = (await emit("context", { messages })) as { messages: unknown[] };
      return result.messages;
    },
  };
}

test("draft updates replace the full Markdown without enabling ready actions", async () => {
  await withPlan(async (f) => {
    await assert.rejects(() => f.complete(), /No plan draft/);
    assert.deepEqual(await f.tool(UPDATE, { plan: FIRST }), {
      content: [{ type: "text", text: "Plan draft updated." }],
      details: { version: 1, source: UPDATE },
    });
    await f.tool(UPDATE, { plan: SECOND });
    const draft = f.state();
    assert.equal(draft.draftPlan, SECOND);
    assert.equal(draft.latestPlan, undefined);
    assert.equal(draft.awaitingAction, false);
    await f.command("show");
    assert.match(JSON.stringify(f.mock.sentMessages.at(-1)), /Draft Plan/u);
    await f.command("save");
    await f.command("export draft.md");
    await f.command("implement");
    assert.equal(f.mock.sentUserMessages.length, 0);
    assert.deepEqual(await readdir(f.directory), []);
    assert.deepEqual(f.state(), draft);

    const completed = await f.complete();
    assert.equal(completed.terminate, true);
    assert.ok(completed.content[0]?.text.endsWith(SECOND));
    assert.equal(f.state().draftPlan, undefined);
    assert.equal(f.state().latestPlan, SECOND);
    assert.equal(f.state().awaitingAction, true);
    await f.emit("before_agent_start");
    assert.equal(f.state().draftPlan, SECOND);
    assert.equal(f.state().awaitingAction, false);
    assert.deepEqual(await f.complete(), completed);
  });
});

test("invalid, aborted, and failed updates preserve the previous branch draft", async () => {
  await withPlan(async (f) => {
    await f.tool(UPDATE, { plan: FIRST });
    for (const plan of ["  ", "a".repeat(50_001), "漢".repeat(18_000), "line\n".repeat(2_000)]) {
      await assert.rejects(() => f.tool(UPDATE, { plan }), /empty|50000|50 KB/u);
    }
    await assert.rejects(() => f.tool(UPDATE, { plan: SECOND, extra: true }), /only the plan/);
    await assert.rejects(() => f.tool(UPDATE, { plan: SECOND }, UPDATE, AbortSignal.abort()), /abort/i);
    await assert.rejects(() => f.complete({ plan: SECOND }), /accepts no arguments/);
    f.failNextAppend();
    await assert.rejects(() => f.tool(UPDATE, { plan: SECOND }), /Unable to save the Plan snapshot/);
    assert.equal(f.state().draftPlan, FIRST);
    f.failNextAppend();
    await assert.rejects(() => f.complete(), /Unable to save the Plan snapshot/);
    assert.equal(f.state().draftPlan, FIRST);
    assert.equal(f.state().awaitingAction, false);
    assert.ok((await f.complete()).content[0]?.text.endsWith(FIRST));
  });
});

test("completion rejects parallel, nested, and stale calls before committing", async () => {
  await withPlan(async (f) => {
    await f.tool(UPDATE, { plan: FIRST });
    const completeCall = fauxToolCall(COMPLETE, {}, { id: COMPLETE });
    await f.emit("message_end", {
      message: fauxAssistantMessage([completeCall, fauxToolCall(UPDATE, { plan: SECOND })]),
    });
    const policy = { toolName: COMPLETE, toolCallId: COMPLETE, input: {} };
    assert.deepEqual(await f.emit("tool_call", policy), {
      block: true,
      reason: "Call plan_mode_complete alone in a top-level assistant message, after plan_mode_update has finished.",
    });
    await assert.rejects(() => f.tool(COMPLETE, {}), /alone in a top-level/);
    await f.emit("message_end", { message: fauxAssistantMessage(completeCall) });
    assert.equal(await f.emit("tool_call", policy), undefined);
    assert.equal(
      ((await f.emit("tool_call", { ...policy, parentToolCallId: "parent" })) as { block: boolean }).block,
      true,
    );
    const prior = f.branch();
    await f.restore(prior);
    await assert.rejects(() => f.tool(COMPLETE, {}), /alone in a top-level/);
    await assert.rejects(
      () => f.tool(UPDATE, { plan: SECOND }, UPDATE, undefined, createMockContext().ctx),
      /current session/,
    );
    assert.equal(f.state().draftPlan, FIRST);
    await f.command("exit");
    assert.equal(f.state().draftPlan, undefined);
    await assert.rejects(() => f.tool(UPDATE, { plan: SECOND }), /only available while Plan mode is active/);
    await assert.rejects(() => f.complete(), /only available while Plan mode is active/);
  });
});

test("drafts follow the branch and restore model-visible Markdown only when needed", async () => {
  await withPlan(async (f) => {
    await f.tool(UPDATE, { plan: FIRST });
    const firstBranch = f.branch();
    const assistant = fauxAssistantMessage(fauxToolCall(UPDATE, { plan: SECOND }, { id: "new-draft" }));
    const updated = await f.tool(UPDATE, { plan: SECOND }, "new-draft");
    const visible = await f.requestContext([
      assistant,
      { role: "toolResult", toolName: UPDATE, toolCallId: "new-draft", ...updated },
    ]);
    assert.deepEqual(visible.map(planFromDraftContextMessage).filter(Boolean), []);
    await f.restore(firstBranch);
    assert.equal(f.state().draftPlan, FIRST);
    assert.equal(f.state().awaitingAction, false);
    const summary = { role: "compactionSummary", summary: "Earlier discussion" };
    const context = await f.requestContext([summary]);
    assert.equal(context[0], summary);
    assert.equal(planFromDraftContextMessage(context.at(-1)), FIRST);
    const after = { role: "user", content: "What about tests?" };
    const more = await f.requestContext([summary, after]);
    assert.deepEqual(more.slice(0, context.length), context);
    assert.equal(more.at(-1), after);
    await f.command("exit");
    const inactive = await f.requestContext([
      ...context,
      assistant,
      { role: "toolResult", toolName: UPDATE, toolCallId: "new-draft", ...updated },
    ]);
    assert.doesNotMatch(JSON.stringify(inactive), /First draft|Second draft/u);
    assert.ok(f.state().interactionRestorations?.every((entry) => entry.mode !== "draft"));
    await f.command("start");
    assert.equal(f.state().draftPlan, undefined);
    const nextWorkflow = await f.requestContext([
      ...context,
      assistant,
      { role: "toolResult", toolName: UPDATE, toolCallId: "new-draft", ...updated },
      inactive.at(-1),
    ]);
    assert.doesNotMatch(JSON.stringify(nextWorkflow), /First draft|Second draft/u);
  });
});
