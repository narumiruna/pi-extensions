import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore, type TranscriptContext } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadGoalStateFromSession } from "../src/persistence.js";
import { registerGoal } from "./support/goal-fixture.js";

function text(message: { content: unknown }) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => part?.text ?? "").join("");
}

test("a running goal writes its objective once and restores it from accounting checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-goal-objective-runtime-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: AgentSession | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    const registry = new ModelRegistry(runtime);
    const faux = createFauxCore({ api: `goal-test-${randomUUID()}`, provider: `goal-test-${randomUUID()}` });
    registry.registerProvider(faux.provider, {
      api: faux.api,
      apiKey: "offline-test",
      baseUrl: "http://localhost",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
    const model = registry.find(faux.provider, faux.getModel().id);
    assert.ok(model);
    let requests = 0;
    const respond = (context: TranscriptContext) => {
      requests += 1;
      if (requests < 3) return fauxAssistantMessage(`Incomplete pass ${requests}`);
      const goalId = [
        ...context.messages.flatMap((message) => [...text(message).matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)]),
      ].at(-1)?.[1];
      assert.ok(goalId);
      return fauxAssistantMessage(fauxToolCall("goal_complete", { goal_id: goalId, summary: "Verified." }));
    };
    faux.setResponses([respond, respond, respond, fauxAssistantMessage("Done.")]);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [resolve("packages/pi-goal/src/index.ts")],
    });
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    });
    assert.deepEqual(result.extensionsResult.errors, []);
    session = result.session;
    await session.bindExtensions({});
    const objective = `write the report end to end ${"and keep every stated requirement ".repeat(40)}`.trim();
    await session.prompt(`/goal ${objective}`);
    await session.waitForIdle();

    const branch = session.sessionManager.getBranch();
    const checkpoints = branch.flatMap((entry, index) =>
      entry.type === "custom" && entry.customType === "goal-state"
        ? [{ index, goal: (entry.data as { goal: Record<string, unknown> | null }).goal }]
        : [],
    );
    assert.ok(checkpoints.length >= 3, `expected several checkpoints, got ${checkpoints.length}`);
    const withObjective = checkpoints.filter((checkpoint) => checkpoint.goal && "text" in checkpoint.goal);
    assert.equal(withObjective.length, 1);
    assert.equal(withObjective[0]?.goal?.text, objective);
    assert.equal(withObjective[0], checkpoints[0]);

    // Every open checkpoint restores the objective with its own status; a completed goal, and the
    // clear after it, restore no goal, as on main.
    const restoreAt = (index: number) =>
      loadGoalStateFromSession({ sessionManager: { getBranch: () => branch.slice(0, index + 1) } }).goal;
    const open = checkpoints.filter((checkpoint) => checkpoint.goal && checkpoint.goal.status !== "complete");
    assert.ok(open.length >= 2);
    for (const checkpoint of open) {
      assert.equal(restoreAt(checkpoint.index)?.text, objective);
      assert.equal(restoreAt(checkpoint.index)?.status, checkpoint.goal?.status);
    }
    const completed = checkpoints.findLast((checkpoint) => checkpoint.goal?.status === "complete");
    assert.ok(completed && !("text" in (completed.goal ?? {})));
    assert.equal(restoreAt(completed.index), undefined);
    const last = checkpoints.at(-1);
    assert.ok(last && last.index > completed.index && last.goal === null);
    assert.equal(restoreAt(last.index), undefined);
  } finally {
    await session?.abort();
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

function startMockSession(sessionManager: (entries: () => Record<string, unknown>[]) => Record<string, unknown>) {
  const mock = createMockPi();
  registerGoal(mock.pi);
  const entries = () => mock.entries.map((entry, index) => ({ type: "custom", id: `entry-${index}`, ...entry }));
  const context = createMockContext({ sessionManager: sessionManager(entries) });
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  const goalCommand = (args: string) => mock.commands.get("goal")?.handler(args, context.ctx);
  const checkpoints = () =>
    entries().flatMap((entry, index) =>
      entry.customType === "goal-state"
        ? [{ index, goal: (entry.data as { goal: Record<string, unknown> | null }).goal }]
        : [],
    );
  return { entries, goalCommand, checkpoints };
}

test("an objective edit writes the new objective and each side of the edit restores its own", async () => {
  const session = startMockSession((entries) => ({ getBranch: entries, getEntries: entries }));
  await session.goalCommand("first objective");
  await session.goalCommand("pause");
  await session.goalCommand("edit second objective");

  const checkpoints = session.checkpoints();
  const edited = checkpoints.findIndex((checkpoint) => checkpoint.goal?.text === "second objective");
  assert.ok(edited > 1, "expected accounting checkpoints before the edit");
  assert.ok(checkpoints.slice(1, edited).some((checkpoint) => checkpoint.goal && !("text" in checkpoint.goal)));
  const restoreAt = (index: number) =>
    loadGoalStateFromSession({ sessionManager: { getBranch: () => session.entries().slice(0, index + 1) } }).goal;
  assert.equal(restoreAt(checkpoints[edited - 1]?.index ?? -1)?.text, "first objective");
  assert.equal(restoreAt(session.entries().length - 1)?.text, "second objective");
});

test("a bound session without a readable branch keeps the objective in every checkpoint", async () => {
  const session = startMockSession((entries) => ({ getEntries: entries }));
  await session.goalCommand("objective without a branch");
  await session.goalCommand("pause");
  await session.goalCommand("resume");

  const checkpoints = session.checkpoints();
  assert.ok(checkpoints.length >= 3, `expected several checkpoints, got ${checkpoints.length}`);
  assert.ok(checkpoints.every((checkpoint) => checkpoint.goal?.text === "objective without a branch"));
});
