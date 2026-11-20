import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import type { JsonObject } from "../src/protocol.js";

const model: Model<Api> = {
  id: "context-management-runtime",
  name: "Context Management runtime fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const checkpoint = { type: "compaction", id: "cmp_runtime", encrypted_content: "opaque-runtime-fixture" };
const maintenanceOutput = {
  type: "message",
  id: "msg_maintenance",
  role: "assistant",
  status: "completed",
  content: [
    { type: "output_text", text: "Goal: finish the task. Next: inspect the pending changes.", annotations: [] },
  ],
};

// The hosted model is replaced only at the transport boundary. Pi owns compaction,
// persistence, context projection, provider hooks, continuation, and settlement.
function response(text: string, inputTokens: number, maintenance: boolean): Response {
  const item = maintenance
    ? maintenanceOutput
    : {
        ...maintenanceOutput,
        id: "msg_task",
        content: [{ type: "output_text", text, annotations: [] }],
      };
  const outputIndex = maintenance ? 1 : 0;
  const events = [
    ...(maintenance ? [{ type: "response.output_item.done", output_index: 0, item: checkpoint }] : []),
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: outputIndex, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: outputIndex, item },
    {
      type: "response.completed",
      response: {
        id: "resp_runtime",
        status: "completed",
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 3, total_tokens: inputTokens + 3 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function toolResponse(): Response {
  const item = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    name: "read",
    arguments: JSON.stringify({ path: "pending.txt" }),
  };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_tool",
        status: "completed",
        output: [item],
        usage: { input_tokens: 90_000, output_tokens: 10, total_tokens: 90_010 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

for (const trigger of [
  "overflow",
  "threshold",
  "pre-prompt",
  "queued",
  "boundary",
  "repeat",
  "mid-turn",
  "manual",
  "cancel",
  "context-agent-end",
  "context-compact",
  "queued-custom",
  "context-and-queued",
] as const) {
  test(`real Pi ${trigger} compaction scopes maintenance and preserves ordinary replay`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-management-runtime-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      vi.resetModules();
      const { createCodexCompactExtension } = await import("../src/codex-compact.js");
      const { DEFAULT_CODEX_COMPACT_SETTINGS } = await import("../src/settings.js");
      const specifier = "@earendil-works/pi-ai/providers/openai";
      const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
      const native = openaiProvider();
      const requests: JsonObject[] = [];
      let ordinaryRequests = 0;
      const postRunThreshold = [
        "threshold",
        "queued",
        "boundary",
        "repeat",
        "cancel",
        "context-agent-end",
        "context-compact",
        "queued-custom",
        "context-and-queued",
      ].includes(trigger);
      const fixtureFetch: typeof fetch = async (_input, init) => {
        const payload: JsonObject = JSON.parse(String(init?.body));
        requests.push(payload);
        if (payload.context_management) return response(maintenanceOutput.content[0].text, 20, true);
        ordinaryRequests += 1;
        if (trigger === "overflow" && ordinaryRequests === 1) {
          return Response.json(
            { error: { message: "maximum context length exceeded", code: "context_length_exceeded" } },
            { status: 400 },
          );
        }
        if (trigger === "mid-turn" && ordinaryRequests === 1) return toolResponse();
        const inputTokens =
          (postRunThreshold && ordinaryRequests === 1) || (trigger === "repeat" && ordinaryRequests === 2)
            ? 90_000
            : 20;
        const text =
          trigger === "repeat" && ordinaryRequests === 2 ? `task response ${"detail ".repeat(8000)}` : "task response";
        return response(text, inputTokens, false);
      };
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("openai", async () => ({ type: "api_key", key: "runtime-fixture" }));
      const modelRuntime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStorePath: join(directory, "models-store.json"),
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider({
        ...native,
        streamSimple: (activeModel, context, options) =>
          native.streamSimple(activeModel, context, { ...options, maxRetries: 0, fetch: fixtureFetch }),
      });
      const state = {
        kind: "loaded" as const,
        path: join(directory, "pi-codex-compact.json"),
        document: {},
        settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: "context-management" as const },
      };
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 15_000, keepRecentTokens: 10_000 },
        retry: { enabled: false },
      });
      let companionContinued = false;
      let contextSent = false;
      let cancellation: Promise<void> | undefined;
      const companion = (pi: ExtensionAPI) => {
        const sendContext = () => {
          if (contextSent) return;
          contextSent = true;
          pi.sendMessage(
            { customType: "neutral-runtime-context", content: "Keep this task context.", display: false },
            { triggerTurn: false },
          );
        };
        pi.on("agent_end", () => {
          if (trigger === "context-agent-end") sendContext();
        });
        pi.on("session_compact", async (event) => {
          if (event.reason === "manual") return;
          if (trigger === "context-compact" || trigger === "context-and-queued") sendContext();
          if (trigger === "queued-custom" && !companionContinued) {
            companionContinued = true;
            pi.sendMessage(
              { customType: "neutral-runtime-queued", content: "Continue the pending task.", display: false },
              { deliverAs: "followUp" },
            );
          }
          if ((trigger === "queued" || trigger === "context-and-queued") && !companionContinued) {
            companionContinued = true;
            assert.ok(session);
            await session.followUp("Queued next step");
          }
          if (trigger === "cancel") cancellation = session?.abort();
        });
        pi.on("agent_before_settle", async (event, ctx) => {
          if (trigger === "repeat") {
            // Ensure the next provider response is newer than the persisted
            // compaction timestamp, as required by Pi's stale-usage guard.
            const entry = ctx.sessionManager
              .getBranch()
              .filter((value) => value.type === "compaction")
              .at(-1);
            if (entry)
              while (Date.now() <= new Date(entry.timestamp).getTime())
                await new Promise<void>((resolve) => setImmediate(resolve));
          }
          if (trigger === "boundary" && !companionContinued) {
            companionContinued = true;
            return {
              entries: [
                ...event.entries,
                {
                  type: "custom_message",
                  customType: "neutral-runtime-continuation",
                  content: "Continue the pending task",
                  display: false,
                },
              ],
              continue: true,
            };
          }
        });
      };
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [
          companion,
          createCodexCompactExtension({
            fetch: fixtureFetch,
            settingsRuntime: {
              get: () => state,
              reload: async () => state,
              update: async () => state,
              flush: async () => {},
            },
          }),
        ],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const sessionManager = SessionManager.inMemory(directory);
      for (let index = 0; index < 4; index += 1) {
        sessionManager.appendMessage({
          role: "user",
          content: `Older task history ${"data ".repeat(4000)}`,
          timestamp: Date.now() - 10_000 + index * 2,
        });
        sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "Still working on the pending task." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: trigger === "pre-prompt" ? 90_000 : 20_000,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: trigger === "pre-prompt" ? 90_010 : 20_010,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now() - 10_000 + index * 2 + 1,
        });
      }
      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime,
        model,
        resourceLoader,
        settingsManager,
        sessionManager,
        tools: ["read"],
      }));
      await session.bindExtensions({ mode: "print" });
      await writeFile(join(directory, "pending.txt"), "Tool execution remains available after compaction.");
      const compactionEvents: Array<{ reason: string; willRetry: boolean }> = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end") compactionEvents.push(event);
      });
      if (trigger === "manual") await session.compact();
      await session.prompt("Complete the pending task.");
      await cancellation;
      assert.equal(
        requests.length,
        trigger === "repeat" ? 4 : ["pre-prompt", "manual", "cancel"].includes(trigger) ? 2 : 3,
      );
      assert.equal(session.isIdle, true);
      assert.match(
        JSON.stringify(
          session.messages
            .slice()
            .reverse()
            .find((message) => message.role === "assistant"),
        ),
        /task response/,
      );
      assert.doesNotMatch(JSON.stringify(session.messages), /msg_maintenance|PI_CONTEXT_COMPACTION_V1/);
      const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
      assert.equal(compactions.length, trigger === "repeat" ? 2 : 1);
      assert.equal(compactions[0].fromHook, true);
      assert.equal(compactionEvents.length, trigger === "repeat" ? 2 : 1);
      if (trigger !== "manual") {
        assert.equal(compactionEvents[0].willRetry, trigger === "overflow");
        assert.equal(compactionEvents[0].reason, trigger === "overflow" ? "overflow" : "threshold");
      }
      const maintenanceRequests = requests.filter((payload) => payload.context_management);
      assert.equal(maintenanceRequests.length, trigger === "repeat" ? 2 : 1);
      const maintenanceInput = maintenanceRequests[0].input as JsonObject[];
      assert.match(JSON.stringify(maintenanceInput.at(-1)), /continuation handoff/);
      assert.doesNotMatch(JSON.stringify(maintenanceInput.at(-1)), /reply only OK/i);
      const persisted = compactions[0].details as { replacementHistory: JsonObject[] };
      assert.deepEqual(persisted.replacementHistory, [checkpoint, maintenanceOutput]);
      assert.equal(maintenanceRequests[0].tool_choice, "none");

      const continuationEntries = sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "codex-compact:continue-v1");
      assert.equal(
        continuationEntries.length,
        ["threshold", "repeat", "context-agent-end", "context-compact"].includes(trigger) ? 1 : 0,
      );
      if (contextSent) {
        const contextEntries = sessionManager
          .getBranch()
          .filter((entry) => entry.type === "custom_message" && entry.customType === "neutral-runtime-context");
        assert.equal(contextEntries.length, 1);
        assert.ok(contextEntries[0].type === "custom_message");
        assert.equal(contextEntries[0].content, "Keep this task context.");
        if (trigger !== "context-and-queued") {
          const workAfterCompaction = requests.slice(requests.indexOf(maintenanceRequests[0]) + 1);
          assert.match(JSON.stringify(workAfterCompaction[0].input), /Keep this task context\./);
        }
      }
      const lastUser = sessionManager
        .getBranch()
        .slice()
        .reverse()
        .find((entry) => entry.type === "message" && entry.message.role === "user");
      assert.ok(lastUser?.type === "message" && lastUser.message.role === "user");
      assert.deepEqual(lastUser.message.content, [
        {
          type: "text",
          text:
            trigger === "queued" || trigger === "context-and-queued"
              ? "Queued next step"
              : "Complete the pending task.",
        },
      ]);
      if (trigger === "mid-turn")
        assert.ok(session.messages.some((message) => message.role === "toolResult" && !message.isError));

      // A later user request keeps the persisted continuation at its original boundary.
      await session.prompt("Continue the task with the next step.");
      const maintenanceIndex = requests.indexOf(maintenanceRequests.at(-1) as JsonObject);
      const replayRequests = requests.slice(maintenanceIndex + 1);
      assert.equal(replayRequests.length, trigger === "repeat" || trigger === "cancel" ? 1 : 2);
      for (const payload of replayRequests) {
        const input = payload.input as JsonObject[];
        const checkpointIndex = input.findIndex((item) => item.type === "compaction");
        assert.ok(checkpointIndex >= 0);
        assert.deepEqual(input.slice(checkpointIndex, checkpointIndex + 2), [checkpoint, maintenanceOutput]);
        assert.doesNotMatch(JSON.stringify(payload), /PI_CONTEXT_COMPACTION_V1|compact_threshold/);
        assert.notEqual(payload.tool_choice, "none");
        assert.equal(input.filter((item) => item.type === "compaction").length, 1);
        assert.match(JSON.stringify(payload.tools), /"name":"read"/);
      }
      if (replayRequests.length === 2) {
        const baseline = replayRequests[0];
        const next = replayRequests[1];
        assert.deepEqual(
          (next.input as JsonObject[]).slice(0, (baseline.input as JsonObject[]).length),
          baseline.input,
        );
        assert.deepEqual(next.tools, baseline.tools);
        assert.ok(session.systemPrompt);
        assert.deepEqual((baseline.input as JsonObject[])[0], { role: "developer", content: session.systemPrompt });
      }
      assert.equal(requests.filter((payload) => payload.context_management).length, trigger === "repeat" ? 2 : 1);
    } finally {
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
