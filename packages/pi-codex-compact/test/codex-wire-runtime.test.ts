import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import {
  type AssistantMessage,
  type Context,
  type Model,
  normalizeContext,
  PI_AI_VERSION,
  type Provider,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { test } from "vitest";
import { RECOVERY_INSTRUCTION, summarizeCheckpoint } from "../src/checkpoint-recovery.js";
import { COMPACTION_MAINTENANCE_MESSAGE } from "../src/context-management.js";
import { type JsonObject, rewriteCheckpointMarker } from "../src/protocol.js";
import { requestRemoteCompaction } from "../src/remote.js";

// Choose a wire contract from the resolved SDK version, never from the payload under test.
const hasDeveloperPrefix = !PI_AI_VERSION.startsWith("1.5.");
const systemPrompt = "Keep the exact provider-facing system prompt.";
const model: Model<"openai-codex-responses"> = {
  id: "codex-wire-fixture",
  name: "Codex wire fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://codex-fixture.invalid/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
  compat: { ...(hasDeveloperPrefix ? { supportsMidConvoEffort: true } : {}) },
};
const tools = ["inspect_fixture", "check_fixture"].map((name) => ({
  name,
  description: `Run ${name}.`,
  parameters: Type.Object({ query: Type.String() }),
}));
const apiKey = `header.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
).toString("base64url")}.signature`;
const marker = "Synthetic checkpoint marker";
const checkpoint = { type: "compaction", id: "cmp_previous", encrypted_content: "opaque-previous" };
const nextCheckpoint = { type: "compaction", id: "cmp_next", encrypted_content: "opaque-next" };
const priorCheckpoint = { marker, replacementHistory: [checkpoint] };
const usage = { input_tokens: 20, output_tokens: 3, total_tokens: 23 };

async function nativeProvider(): Promise<Provider> {
  const specifier = "@earendil-works/pi-ai/providers/openai-codex";
  const { openaiCodexProvider } = (await import(specifier)) as { openaiCodexProvider(): Provider };
  return openaiCodexProvider();
}

function user(content: string): Context["messages"][number] {
  return { role: "user", content, timestamp: 1 };
}

function context(messages: Context["messages"]) {
  return normalizeContext({ systemPrompt, messages, tools });
}

function requestBody(init: RequestInit | undefined): JsonObject {
  const body = init?.body;
  if (new Headers(init?.headers).get("content-encoding") === "zstd") {
    assert.ok(body instanceof Uint8Array);
    return JSON.parse(zstdDecompressSync(body).toString("utf8"));
  }
  assert.equal(typeof body, "string");
  return JSON.parse(String(body));
}

function userInput(text: string) {
  return { role: "user", content: [{ type: "input_text", text }] };
}

function effort(level: "low" | "high") {
  return { type: "configuration_update", reasoning: { effort: level } };
}

function textResponse(id: string, compaction = false) {
  const item = {
    type: "message",
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Continue the fixture.", annotations: [] }],
  };
  const outputIndex = compaction ? 1 : 0;
  const events = [
    ...(compaction ? [{ type: "response.output_item.done", output_index: 0, item: nextCheckpoint }] : []),
    { type: "response.output_item.added", output_index: outputIndex, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: outputIndex, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: outputIndex, item },
    {
      type: "response.completed",
      response: { id: `resp_${id}`, status: "completed", output: compaction ? [nextCheckpoint, item] : [item], usage },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function inputOf(body: JsonObject): JsonObject[] {
  assert.ok(Array.isArray(body.input));
  return body.input;
}

function assertInstructions(body: JsonObject) {
  if (hasDeveloperPrefix) {
    const input = inputOf(body);
    assert.equal(Object.hasOwn(body, "instructions"), false);
    assert.deepEqual(input[0], { role: "developer", content: systemPrompt });
    assert.equal(input.filter((item) => item.role === "developer").length, 1);
  } else {
    assert.equal(body.instructions, systemPrompt);
    assert.equal(
      inputOf(body).some((item) => item.role === "developer"),
      false,
    );
  }
}

function assertTools(body: JsonObject, baseline?: unknown) {
  assert.ok(Array.isArray(body.tools));
  assert.deepEqual(
    body.tools.map((tool) => tool.name),
    tools.map((tool) => tool.name),
  );
  if (baseline) assert.deepEqual(body.tools, baseline);
}

function assertPrefix(baseline: JsonObject, next: JsonObject) {
  assertInstructions(baseline);
  assertInstructions(next);
  const before = inputOf(baseline);
  const after = inputOf(next);
  assert.ok(after.length > before.length);
  assert.deepEqual(after.slice(0, before.length), before);
  assertTools(baseline);
  assertTools(next, baseline.tools);
}

async function ordinary(
  provider: Provider,
  messages: Context["messages"],
  reasoning: "low" | "high",
  id: string,
  replay = false,
): Promise<{ body: JsonObject; answer: AssistantMessage }> {
  const requests: JsonObject[] = [];
  const answer = await provider
    .streamSimple(model, context(messages), {
      apiKey,
      reasoning,
      transport: "sse",
      maxRetries: 0,
      onPayload: replay
        ? (payload) => rewriteCheckpointMarker(payload, marker, priorCheckpoint.replacementHistory)
        : undefined,
      fetch: async (_url, init) => {
        requests.push(requestBody(init));
        return textResponse(id);
      },
    })
    .result();
  assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "Fixture did not complete");
  assert.equal(requests.length, 1);
  return { body: requests[0], answer };
}

function assertEffort(body: JsonObject, levels: ("low" | "high")[]) {
  const input = inputOf(body);
  assert.deepEqual(
    input.filter((item) => item.type === "configuration_update"),
    hasDeveloperPrefix ? levels.map(effort) : [],
  );
  assert.equal((body.reasoning as JsonObject).effort, hasDeveloperPrefix ? "medium" : levels.at(-1));
  if (hasDeveloperPrefix) {
    assert.deepEqual(input.at(-1), effort(levels.at(-1) ?? "low"));
    for (const [index, level] of levels.slice(0, -1).entries()) {
      const assistantIndex = input.findIndex((item) => item.id === `msg_${index + 1}`);
      assert.ok(assistantIndex > 0);
      assert.deepEqual(input[assistantIndex - 1], effort(level));
    }
  }
}

function assertCheckpoint(body: JsonObject) {
  const input = inputOf(body);
  assertInstructions(body);
  assert.deepEqual(
    input.filter((item) => item.type === "compaction"),
    [checkpoint],
  );
  assert.deepEqual(input[hasDeveloperPrefix ? 1 : 0], checkpoint);
  assert.equal(JSON.stringify(input).includes(marker), false);
}

test(`Codex ${PI_AI_VERSION} preserves ordinary requests, effort changes, and the replay prefix`, async () => {
  const provider = await nativeProvider();
  const initial = [user("Initial task")];
  const first = await ordinary(provider, initial, "low", "1");
  const history = [...initial, first.answer, user("Follow-up task")];
  const second = await ordinary(provider, history, "low", "2");
  const changed = await ordinary(provider, [...history, second.answer, user("Use higher effort")], "high", "3");
  assertPrefix(first.body, second.body);
  assertPrefix(second.body, changed.body);
  assert.deepEqual(inputOf(first.body)[hasDeveloperPrefix ? 1 : 0], userInput("Initial task"));
  assertEffort(first.body, ["low"]);
  assertEffort(second.body, ["low", "low"]);
  assertEffort(changed.body, ["low", "low", "high"]);

  // Compaction replaces the old prefix. Stability starts again at this replay.
  const retained = [user(marker), first.answer, user("Retained task")];
  const replay = await ordinary(provider, retained, "high", "2", true);
  const later = await ordinary(provider, [...retained, replay.answer, user("Next task")], "high", "3", true);
  assertCheckpoint(replay.body);
  assertCheckpoint(later.body);
  assertPrefix(replay.body, later.body);
  assertEffort(replay.body, ["low", "high"]);
  assertEffort(later.body, ["low", "high", "high"]);
});

for (const protocol of ["responses-compact", "remote-v2", "context-management", "recovery"] as const) {
  test(`Codex ${PI_AI_VERSION} ${protocol} keeps the prepared replay prefix and its retained effort`, async () => {
    const provider = await nativeProvider();
    const first = await ordinary(provider, [user("Initial task")], "low", "1");
    const messages = [user(marker), first.answer, user("Retained task")];
    const baseline = await ordinary(provider, messages, "high", "2", true);
    const requests: JsonObject[] = [];
    const request = {
      provider,
      model,
      context: context(messages),
      protocol: protocol === "recovery" ? "context-management" : protocol,
      profile: "codex-responses-v1",
      thinkingLevel: "high",
      apiKey,
      signal: new AbortController().signal,
      priorCheckpoint,
      maxRetries: 0,
      fetch: async (url, init) => {
        requests.push(requestBody(init));
        if (protocol === "responses-compact") {
          assert.match(String(url), /\/responses\/compact$/u);
          return Response.json({ id: "resp_compact", output: [nextCheckpoint], usage });
        }
        assert.match(String(url), /\/responses$/u);
        return textResponse("maintenance", protocol !== "recovery");
      },
    } as const satisfies Parameters<typeof requestRemoteCompaction>[0];
    if (protocol === "recovery") await summarizeCheckpoint(request, { maxTokens: 200 });
    else assert.deepEqual((await requestRemoteCompaction(request)).item, nextCheckpoint);
    assert.equal(requests.length, 1);
    const [body] = requests;
    assertCheckpoint(body);
    const tail =
      protocol === "remote-v2"
        ? [{ type: "compaction_trigger" }]
        : protocol === "context-management"
          ? [userInput(COMPACTION_MAINTENANCE_MESSAGE)]
          : protocol === "recovery"
            ? [userInput(RECOVERY_INSTRUCTION)]
            : [];
    assert.deepEqual(inputOf(body), [...inputOf(baseline.body), ...tail]);
    assert.deepEqual(body.tools, protocol === "recovery" ? [] : baseline.body.tools);
  });
}
