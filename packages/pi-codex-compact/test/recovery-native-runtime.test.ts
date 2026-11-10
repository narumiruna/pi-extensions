import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  type SessionBeforeCompactEvent,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCheckpointDetails, fallbackSummary, latestCheckpoint } from "../src/checkpoint.js";
import { projectedKeptMessages } from "../src/checkpoint-projection.js";
import type { JsonObject } from "../src/protocol.js";

const model: Model<Api> = {
  id: "recovery-native-runtime",
  name: "Recovery native fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const usage = {
  input: 10,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function textResponse(text: string, inputTokens = 10): Response {
  const item = {
    type: "message",
    id: "msg",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return new Response(
    [
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp",
          status: "completed",
          output: [item],
          usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

for (const trigger of ["manual", "threshold", "overflow", "native-failure"] as const) {
  test(`real Pi ${trigger}: recovery failure hands off to native with checkpoint supersession`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const directory = await mkdtemp(join(tmpdir(), "pi-recovery-native-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let modelRuntime: ModelRuntime | undefined;
    try {
      vi.resetModules();
      const { createCodexCompactExtension } = await import("../src/codex-compact.js");
      const { DEFAULT_CODEX_COMPACT_SETTINGS } = await import("../src/settings.js");
      const specifier = "@earendil-works/pi-ai/providers/openai";
      const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
      const native = openaiProvider();
      const requests: Array<{ kind: string; payload: JsonObject }> = [];
      let workCalls = 0;
      const fixtureFetch =
        (maintenance: boolean): typeof fetch =>
        async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as JsonObject;
          const recovery = JSON.stringify(payload).includes("Summarize the preceding conversation");
          const kind = maintenance
            ? recovery
              ? "recovery"
              : "remote"
            : /<previous-summary>|# Conversation/.test(JSON.stringify(payload))
              ? "native"
              : "work";
          // Pi's update summarizer wraps the fallback marker in previous-summary tags.
          requests.push({ kind, payload });
          if (maintenance || (kind === "native" && trigger === "native-failure")) {
            return Response.json({ error: { message: "fixture provider failure" } }, { status: 400 });
          }
          if (kind === "native") return textResponse("Native handoff summary");
          workCalls += 1;
          if (trigger === "overflow" && workCalls === 1)
            return Response.json(
              { error: { message: "maximum context length exceeded", code: "context_length_exceeded" } },
              { status: 400 },
            );
          return textResponse("Work completed", trigger === "threshold" && workCalls === 1 ? 90_000 : 10);
        };
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("openai", async () => ({ type: "api_key", key: "fixture" }));
      modelRuntime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStorePath: join(directory, "models.json"),
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider({
        ...native,
        streamSimple: (active, context, options) => {
          // Pi ignores usage at or before a compaction boundary; each response must be newer.
          vi.setSystemTime(Date.now() + 1);
          return native.streamSimple(active, context, { ...options, maxRetries: 0, fetch: fixtureFetch(false) });
        },
      });
      const state = {
        kind: "loaded" as const,
        path: join(directory, "pi-codex-compact.json"),
        document: {},
        settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: "context-management" as const, maxRetries: 0 },
      };
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 15_000, keepRecentTokens: 150 },
        retry: { enabled: false },
      });
      let preparation: SessionBeforeCompactEvent | undefined;
      let fromExtension: boolean | undefined;
      const failures: unknown[] = [];
      const observer = (pi: ExtensionAPI) => {
        pi.on("session_before_compact", (event) => {
          preparation = event;
        });
        pi.on("session_compact", (event) => {
          fromExtension = event.fromExtension;
        });
        pi.on("session_compact_failed", (event) => {
          failures.push(event);
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
          observer,
          createCodexCompactExtension({
            fetch: fixtureFetch(true),
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
      const manager = SessionManager.inMemory(directory);
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Original secret assistant-only fact" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: 1,
      });
      const old = { role: "user" as const, content: "old retained snapshot", timestamp: 2 };
      const oldId = manager.appendMessage(old);
      const details = createCheckpointDetails({
        provider: model.provider,
        api: model.api,
        profile: "openai-responses-v1",
        modelId: model.id,
        protocol: "context-management",
        replacementHistory: [{ type: "compaction", encrypted_content: "opaque-only-history" }],
        keptMessages: [old],
      });
      manager.appendCompaction(fallbackSummary(details.checkpointId), oldId, 1000, details, true, usage);
      manager.appendMessage({ role: "user", content: `Visible prefix ${"details ".repeat(1500)}`, timestamp: 3 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "read.ts" } }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "toolUse",
        timestamp: 4,
      });
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "read1",
        toolName: "read",
        content: [{ type: "text", text: "file content" }],
        isError: false,
        timestamp: 5,
      });
      const tailId = manager.appendMessage({
        role: "user",
        content: `Recent tail ${"keep ".repeat(200)}`,
        timestamp: 6,
      });
      ({ session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime,
        model,
        resourceLoader,
        settingsManager,
        sessionManager: manager,
        noTools: "all",
      }));
      await session.bindExtensions({ mode: "print" });
      const before = structuredClone(manager.getBranch());
      if (trigger === "manual") await session.compact();
      else if (trigger === "native-failure") await assert.rejects(session.compact(), /fixture provider failure/);
      else await session.prompt("Continue work");
      assert.ok(preparation);
      assert.deepEqual(
        requests.filter((request) => request.kind !== "work").map((request) => request.kind),
        [
          "remote",
          "recovery",
          "native",
          ...(preparation.preparation.isSplitTurn && trigger !== "native-failure" ? ["native"] : []),
        ],
      );
      const remote = JSON.stringify(requests.find((request) => request.kind === "remote")?.payload);
      const recovery = JSON.stringify(requests.find((request) => request.kind === "recovery")?.payload);
      const summary = JSON.stringify(requests.find((request) => request.kind === "native")?.payload);
      assert.match(remote, /opaque-only-history/);
      assert.match(recovery, /opaque-only-history/);
      assert.doesNotMatch(
        summary,
        /opaque-only-history|Original secret assistant-only fact|Summarize the preceding conversation/,
      );
      assert.match(summary, /stores the older history opaquely/);
      assert.match(summary, /Visible prefix/);
      if (trigger === "native-failure") {
        assert.deepEqual(manager.getBranch(), before);
        assert.ok(latestCheckpoint(manager.getBranch()));
        assert.equal(failures.length, 1);
        assert.equal(fromExtension, undefined);
        return;
      }
      assert.equal(fromExtension, false);
      assert.equal(failures.length, 0);
      assert.equal(latestCheckpoint(manager.getBranch()), undefined);
      const published = manager
        .getBranch()
        .filter((entry) => entry.type === "compaction")
        .at(-1);
      assert.ok(published);
      assert.equal(published.firstKeptEntryId, preparation.preparation.firstKeptEntryId);
      assert.deepEqual(published.details, { readFiles: ["read.ts"], modifiedFiles: [] });
      assert.match(published.summary, /Native handoff summary/);
      const kept = projectedKeptMessages(
        preparation.branchEntries,
        preparation.branchEntries.at(-1)?.id ?? null,
        preparation.preparation.firstKeptEntryId,
      );
      const finalized = manager.buildSessionContext().messages;
      const summaryIndex = finalized.findIndex((message) => message.role === "compactionSummary");
      assert.deepEqual(finalized.slice(summaryIndex + 1, summaryIndex + 1 + kept.length), kept);
      assert.ok(manager.getBranch().some((entry) => entry.id === tailId));
      assert.equal(
        manager
          .getBranch()
          .some((entry) => entry.type === "custom_message" && entry.customType === "codex-compact:continue-v1"),
        false,
      );
      assert.equal(workCalls, trigger === "overflow" ? 2 : trigger === "threshold" ? 1 : 0);
      const baseline = manager.buildSessionContext().messages;
      await session.prompt("Next ordinary request");
      const later = JSON.stringify(requests.at(-1)?.payload);
      assert.doesNotMatch(later, /opaque-only-history|PI_CONTEXT_COMPACTION/);
      assert.match(later, /Native handoff summary/);
      assert.deepEqual(manager.buildSessionContext().messages.slice(0, baseline.length), baseline);
      const firstOrdinary = requests.at(-1)?.payload;
      assert.ok(firstOrdinary && Array.isArray(firstOrdinary.input));
      await session.prompt("Another ordinary request");
      const secondOrdinary = requests.at(-1)?.payload;
      assert.ok(secondOrdinary && Array.isArray(secondOrdinary.input));
      assert.equal(secondOrdinary.instructions, firstOrdinary.instructions);
      assert.deepEqual(secondOrdinary.tools, firstOrdinary.tools);
      assert.deepEqual(secondOrdinary.input.slice(0, firstOrdinary.input.length), firstOrdinary.input);
    } finally {
      if (session) {
        await session.abort();
        session.dispose();
      }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
