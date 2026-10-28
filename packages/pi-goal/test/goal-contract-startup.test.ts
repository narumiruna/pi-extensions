import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore, type TranscriptContext } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentSession,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

function text(message: { content: unknown }) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => part?.text ?? "").join("");
}

function normalize(context: TranscriptContext) {
  return JSON.parse(
    JSON.stringify({
      messages: context.messages.map((message) =>
        message.role === "system"
          ? {
              role: message.role,
              content: message.content,
              sections: message.sections,
              toolsAdded: message.toolsAdded,
              toolsRemoved: message.toolsRemoved,
            }
          : { role: message.role, content: message.content },
      ),
    }),
  ) as { messages: Array<{ role: string; content: unknown }> };
}

for (const order of ["before", "after"] as const) {
  test(`startup publication is single-copy with a delayed handler ${order} Goal`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-contract-startup-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "work");
    const gatePath = join(root, "gate.ts");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const eventBus = createEventBus();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    eventBus.on("goal-test:entered", markEntered);
    let markCaptured!: () => void;
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    let session: AgentSession | undefined;
    let running: Promise<void> | undefined;
    try {
      await mkdir(cwd, { recursive: true });
      await writeFile(
        gatePath,
        `export default function(pi) {
        let first = true;
        pi.on("before_agent_start", async () => {
          if (!first) return;
          first = false;
          await new Promise(resolve => {
            const unsubscribe = pi.events.on("goal-test:release", () => { unsubscribe(); resolve(); });
            pi.events.emit("goal-test:entered", {});
          });
        });
      }`,
      );
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
      const requests: ReturnType<typeof normalize>[] = [];
      const respond = (context: TranscriptContext) => {
        requests.push(normalize(context));
        if (requests.length < 3) return fauxAssistantMessage(`Incomplete pass ${requests.length}`);
        const goalId = [
          ...context.messages.flatMap((message) => [...text(message).matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)]),
        ].at(-1)?.[1];
        assert.ok(goalId);
        markCaptured();
        return fauxAssistantMessage(
          fauxToolCall("goal_complete", { goal_id: goalId, summary: "All requested work was verified." }),
        );
      };
      faux.setResponses([respond, respond, respond]);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const goalPath = resolve("packages/pi-goal/src/index.ts");
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        eventBus,
        settingsManager,
        noExtensions: true,
        additionalExtensionPaths: order === "before" ? [gatePath, goalPath] : [goalPath, gatePath],
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
      const objective = "write the report end to end";
      running = session.prompt(order === "before" ? "do the long task" : `/goal ${objective}`);
      await entered;
      if (order === "before") await session.prompt(`/goal ${objective}`);
      else await running;
      eventBus.emit("goal-test:release", {});
      await captured;
      await session.waitForIdle();
      await running;

      const activeContracts = session.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "goal-contract" &&
            (entry.details as { state?: string } | undefined)?.state === "active",
        );
      assert.equal(activeContracts.length, 1, "only one active contract should reach the transcript");
      assert.equal(requests.length, 3);
      for (const [index, request] of requests.entries()) {
        const contracts = request.messages.filter((message) =>
          text(message as { content: unknown }).includes(
            "This Goal contract supersedes every earlier goal-contract message.",
          ),
        );
        assert.equal(contracts.length, 1);
        const previous = requests[index - 1];
        if (previous) {
          assert.deepEqual(request.messages.slice(0, previous.messages.length), previous.messages);
          assert.deepEqual(
            request.messages.filter((message) => message.role === "system"),
            previous.messages.filter((message) => message.role === "system"),
          );
        }
      }
      const continuation = requests
        .flatMap((request) => request.messages)
        .map((message) => text(message as { content: unknown }))
        .find((content) => content.startsWith("Continue the active /goal until it is complete:"));
      assert.ok(continuation);
      assert.ok(continuation.includes(objective));
      assert.ok(continuation.includes("Goal-mode rules:"));
    } finally {
      eventBus.emit("goal-test:release", {});
      await session?.abort();
      await running?.catch(() => undefined);
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
