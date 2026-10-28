import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createCheckpointDetails, fallbackSummary, latestCheckpoint } from "../src/checkpoint.js";
import type { RemoteCompactionProtocol } from "../src/model-api.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

const model: Model<Api> = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const history = [
  { type: "compaction", encrypted_content: "opaque-session-fixture" },
  { type: "reasoning", id: "rs_session", summary: [], encrypted_content: "signed-session-fixture" },
  { type: "message", id: "msg_session", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
];

test("persisted server checkpoints replay after reload/resume/fork and stop before their branch boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-server-checkpoint-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  try {
    vi.resetModules();
    const { createCodexCompactExtension } = await import("../src/codex-compact.js");
    const session = SessionManager.create(directory, directory);
    const userId = session.appendMessage({ role: "user", content: "old user history", timestamp: 1 });
    const kept = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "old assistant-only fact" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop" as const,
      timestamp: 2,
    };
    const keptId = session.appendMessage(kept);
    const details = createCheckpointDetails({
      provider: model.provider,
      api: model.api,
      profile: "openai-responses-v1",
      modelId: model.id,
      protocol: "context-management",
      replacementHistory: history,
      keptMessages: [kept],
    });
    session.appendCompaction(fallbackSummary(details.checkpointId), keptId, 3000, details, true, usage);
    session.appendMessage({ role: "user", content: "later question", timestamp: 3 });
    const path = session.getSessionFile();
    assert.ok(path);
    const resumed = SessionManager.open(path, directory);
    const forked = SessionManager.forkFrom(path, directory, directory);
    for (const current of [session, resumed, forked]) {
      const mock = createMockPi();
      let reloads = 0;
      const state = {
        kind: "loaded" as const,
        path: join(directory, "pi-codex-compact.json"),
        settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
        document: {},
      };
      createCodexCompactExtension({
        settingsRuntime: {
          get: () => state,
          async reload() {
            reloads += 1;
            return state;
          },
          async update() {
            return state;
          },
          async flush() {},
        },
      })(mock.pi);
      const { ctx } = createMockContext({ model, sessionManager: current });
      await mock.events.get("session_start")?.[0]?.({ type: "session_start", reason: "resume" }, ctx);
      assert.equal(reloads, 1);
      const messages = current.buildSessionContext().messages;
      const projected = (await mock.events.get("context")?.[0]?.({ type: "context", messages }, ctx)) as {
        messages: Array<{ content: Array<{ text: string }> | string }>;
      };
      const marker = projected.messages[0].content;
      assert.ok(Array.isArray(marker));
      const payload = {
        instructions: "stable system",
        tools: [{ type: "function", name: "read" }],
        input: [
          { role: "user", content: [{ type: "input_text", text: marker[0].text }] },
          { role: "user", content: [{ type: "input_text", text: "later question" }] },
        ],
      };
      const replayed = (await mock.events.get("before_provider_request")?.[0]?.(
        { type: "before_provider_request", payload },
        ctx,
      )) as typeof payload;
      assert.deepEqual(replayed.input, [...history, payload.input[1]]);
      assert.equal(replayed.instructions, payload.instructions);
      assert.deepEqual(replayed.tools, payload.tools);
      assert.doesNotMatch(JSON.stringify(replayed), /old user history|old assistant-only fact|PI_CONTEXT_COMPACTION/);
      assert.deepEqual(latestCheckpoint(current.getBranch())?.details.replacementHistory, history);
      const selectedModel = createMockContext({ model: { ...model, id: "other" }, sessionManager: current }).ctx;
      assert.deepEqual(
        await mock.events.get("context")?.[0]?.({ type: "context", messages }, selectedModel),
        projected,
      );
      await mock.events.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "reload" }, ctx);
    }
    forked.branch(userId);
    assert.equal(latestCheckpoint(forked.getBranch()), undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const protocol of ["remote-v2", "responses-compact", "context-management"] satisfies RemoteCompactionProtocol[]) {
  test(`${protocol} stale auth continuation cannot clear replacement-owned status`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-compaction-status-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      vi.resetModules();
      const { createCodexCompactExtension } = await import("../src/codex-compact.js");
      const mock = createMockPi();
      const state = {
        kind: "loaded" as const,
        path: join(directory, "pi-codex-compact.json"),
        settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol },
        document: {},
      };
      createCodexCompactExtension({
        settingsRuntime: {
          get: () => state,
          async reload() {
            return state;
          },
          async update() {
            return state;
          },
          async flush() {},
        },
      })(mock.pi);
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let release!: () => void;
      const auth = new Promise<{ ok: true; apiKey: string }>((resolve) => {
        release = () => resolve({ ok: true, apiKey: "fixture" });
      });
      const { ctx, statuses } = createMockContext({
        model,
        sessionManager: { getSessionId: () => "old-session", getBranch: () => [] },
        modelRegistry: {
          getApiKeyAndHeaders: () => {
            ready();
            return auth;
          },
        },
      });
      const pending = mock.events.get("session_before_compact")?.[0]?.(
        { type: "session_before_compact", branchEntries: [], signal: new AbortController().signal },
        ctx,
      );
      await started;
      await mock.events.get("session_start")?.[0]?.({ type: "session_start", reason: "switch" }, ctx);
      const previousActivityReleased = statuses.get("codex-compact") === undefined;
      statuses.set("codex-compact", "replacement-owned activity");
      release();
      assert.deepEqual(await pending, { cancel: true });
      assert.equal(previousActivityReleased, true, "replacement releases previous activity synchronously");
      assert.equal(statuses.get("codex-compact"), "replacement-owned activity");
      await mock.events.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "reload" }, ctx);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
