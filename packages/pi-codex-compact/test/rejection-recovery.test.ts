import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  latestCheckpoint,
} from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { resolveCompactionRoute } from "../src/model-api.js";
import { RejectedRoutes, rejectionRouteKey } from "../src/rejection-state.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";

const rejection = { code: "hardened_oauth_rule_missing", type: "rejected_by_hardened_oauth_boundary" };
const baseModel: Model<"openai-responses"> = {
  id: "gpt-5.5",
  name: "fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 10000,
};
function user(id: string, timestamp: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "user", content: [{ type: "text", text: id }], timestamp },
  };
}
function chain(entries: SessionEntry[]): SessionEntry[] {
  return entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
}
function history(checkpoint: boolean, model: Model<Api> = baseModel): SessionEntry[] {
  const old = user("old", 1);
  if (old.type !== "message") throw new Error("fixture");
  if (!checkpoint) return chain([old, user("prefix", 3), user("tail", 4)]);
  const details = createCheckpointDetails({
    provider: model.provider,
    api: model.api,
    profile:
      model.api === "openai-responses" || model.api === "azure-openai-responses"
        ? "openai-responses-v1"
        : "codex-responses-v1",
    protocol: "responses-compact",
    modelId: model.id,
    checkpointId: "old-checkpoint",
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque-assistant-only-fact" }],
    keptMessages: [old.message],
  });
  return chain([
    old,
    {
      type: "compaction",
      id: "checkpoint",
      parentId: "old",
      timestamp: new Date(2).toISOString(),
      summary: fallbackSummary(details.checkpointId),
      firstKeptEntryId: "old",
      tokensBefore: 500,
      details,
    },
    user("prefix", 3),
    user("tail", 4),
  ]);
}
function summaryResponse(codex = false) {
  const item = {
    type: "message",
    id: "msg",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Earlier fact: sapphire; recent prefix summarized.", annotations: [] }],
  };
  const response = {
    id: "resp",
    status: "completed",
    output: [item],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  return new Response(
    [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: codex ? "response.done" : "response.completed", response },
    ]
      .map((raw) => `data: ${JSON.stringify(raw)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function harness(
  options: {
    checkpoint?: boolean;
    settings?: Partial<CodexCompactSettings>;
    response?: () => Promise<Response>;
    body?: unknown;
    azure?: boolean;
    codex?: boolean;
    custom?: boolean;
    onAuth?: (call: number) => void;
  } = {},
) {
  const specifier = options.codex
    ? "@earendil-works/pi-ai/providers/openai-codex"
    : options.azure
      ? "@earendil-works/pi-ai/providers/azure"
      : "@earendil-works/pi-ai/providers/openai";
  const module = (await import(specifier)) as Record<string, () => Provider>;
  const nativeProvider =
    module[options.codex ? "openaiCodexProvider" : options.azure ? "azureProvider" : "openaiProvider"]();
  const provider: Provider = options.custom
    ? {
        ...nativeProvider,
        id: "fixture-proxy",
        stream: (model, context, opts) => {
          const normalized: Model<Api> = { ...model, api: "openai-responses" };
          return nativeProvider.stream(normalized, context, opts);
        },
      }
    : nativeProvider;
  let settings = { ...DEFAULT_CODEX_COMPACT_SETTINGS, ...options.settings };
  const state = () => ({
    kind: "loaded" as const,
    path: "/tmp/unused.json",
    document: {},
    settings: structuredClone(settings),
  });
  const runtime: CodexCompactSettingsRuntime = {
    get: state,
    reload: async () => state(),
    update: async (patch) => {
      settings = { ...settings, ...patch };
      return state();
    },
    flush: async () => {},
  };
  const mock = createMockPi();
  const payloads: Array<{ url: string; payload: Record<string, unknown> }> = [];
  createCodexCompactExtension({
    settingsRuntime: runtime,
    fetch: async (url, init) => {
      const payload = JSON.parse(
        typeof init?.body === "string" ? init.body : zlib.zstdDecompressSync(init?.body as Uint8Array).toString("utf8"),
      ) as Record<string, unknown>;
      payloads.push({ url: String(url), payload });
      if (options.response) return options.response();
      if (JSON.stringify(payload).includes("Summarize the preceding conversation"))
        return summaryResponse(options.codex);
      return Response.json({ error: options.body ?? rejection }, { status: 401 });
    },
  })(mock.pi);
  let model: Model<Api> = options.codex
    ? {
        ...baseModel,
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      }
    : options.azure
      ? {
          ...baseModel,
          api: "azure-openai-responses",
          provider: "azure-openai-responses",
          baseUrl: "https://example.openai.azure.com/openai/v1",
        }
      : options.custom
        ? { ...baseModel, api: "custom-responses", provider: "fixture-proxy" }
        : { ...baseModel };
  const entries = history(options.checkpoint ?? false, model);
  let authCalls = 0;
  let env: Record<string, string> = {};
  let id = "session";
  const makeContext = (manager = { getSessionId: () => id, getBranch: () => entries }) => {
    const context = createMockContext({
      mode: "tui",
      sessionManager: manager,
      getSystemPrompt: () => "original instructions",
      modelRegistry: {
        getProvider: () => provider,
        getApiKeyAndHeaders: async () => {
          options.onAuth?.(++authCalls);
          return {
            ok: true,
            apiKey: options.codex
              ? `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64url")}.signature`
              : "secret-fixture",
            env,
          };
        },
      },
    });
    Object.defineProperty(context.ctx, "model", { get: () => model });
    return context;
  };
  const context = makeContext();
  const run = (ctx = context.ctx, signal = new AbortController().signal) => {
    const event: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      branchEntries: entries,
      reason: "manual",
      willRetry: false,
      signal,
      preparation: {
        firstKeptEntryId: "tail",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 500,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
    };
    return mock.events.get("session_before_compact")?.[0](event, ctx);
  };
  return {
    ...context,
    mock,
    run,
    payloads,
    provider,
    entries,
    runtime,
    makeContext,
    setModel: (patch: Partial<typeof model>) => {
      model = { ...model, ...patch };
    },
    setEnv: (next: Record<string, string>) => {
      env = next;
    },
    replaceId: () => {
      id = "replacement";
    },
  };
}

test("exact rejection without checkpoint skips later remote requests even with notifications disabled", async () => {
  const h = await harness({ settings: { notifyOnFallback: false } });
  assert.equal(await h.run(), undefined);
  assert.equal(await h.run(), undefined);
  assert.equal(h.payloads.length, 1);
  assert.deepEqual(h.notifications, []);
});

for (const body of [{ ...rejection, code: "other" }, { message: JSON.stringify(rejection) }, "unauthorized"]) {
  test(`unrelated failure does not suppress: ${JSON.stringify(body)}`, async () => {
    const h = await harness({ body });
    await h.run();
    await h.run();
    assert.equal(h.payloads.length, 2);
  });
}

test("default recovery carries encrypted history but not the retained tail, and publishes a native summary", async () => {
  const h = await harness({ checkpoint: true });
  const before = structuredClone(h.entries);
  const result = (await h.run()) as { compaction: { summary: string; firstKeptEntryId: string; details: unknown } };
  assert.ok(result.compaction, JSON.stringify(h.notifications));
  assert.match(result.compaction.summary, /sapphire/);
  assert.equal(result.compaction.firstKeptEntryId, "tail");
  assert.deepEqual(h.entries, before, "hook does not mutate session history");
  assert.equal(h.payloads.length, 2);
  const recovery = JSON.stringify(h.payloads[1].payload);
  assert.match(recovery, /opaque-assistant-only-fact/);
  assert.match(recovery, /prefix/);
  assert.doesNotMatch(recovery, /"text":"tail"/);
  assert.equal(h.payloads[0].url.endsWith("/responses/compact"), true);
  assert.equal(h.payloads[1].url.endsWith("/responses"), true);
  await h.run();
  assert.equal(h.payloads.length, 3, "subsequent compaction skips remote compact, not summary recovery");
  h.entries.push({
    type: "compaction",
    id: "native",
    parentId: "tail",
    timestamp: new Date(5).toISOString(),
    summary: result.compaction.summary,
    firstKeptEntryId: "tail",
    tokensBefore: 500,
    details: result.compaction.details,
  });
  assert.equal(
    latestCheckpoint(h.entries),
    undefined,
    "completed plaintext summary intentionally replaces opaque history",
  );
});

test("new checkpoints fingerprint the finalized retained suffix, not omitted raw entries", async () => {
  const h = await harness({
    response: async () =>
      Response.json({
        output: [{ type: "compaction", encrypted_content: "new-synthetic-opaque" }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      }),
  });
  h.entries.splice(
    0,
    h.entries.length,
    ...chain([
      ...h.entries,
      user("after-tail", 5),
      {
        type: "context_edit",
        id: "omit-tail",
        parentId: null,
        timestamp: new Date(6).toISOString(),
        targetId: "tail",
        replacement: null,
      },
    ]),
  );
  const before = structuredClone(h.entries);
  const result = (await h.run()) as { compaction: { details: { keptMessageFingerprints: string[] } } };
  assert.ok(result?.compaction, JSON.stringify(h.notifications));
  const retained = h.entries.find((entry) => entry.id === "after-tail");
  assert.ok(retained?.type === "message");
  assert.deepEqual(result.compaction.details.keptMessageFingerprints, [fingerprintMessage(retained.message)]);
  assert.deepEqual(h.entries, before);
});

test("legacy pre-checkpoint omission supports replay and checkpoint-aware recovery without transcript mutation", async () => {
  const h = await harness({ checkpoint: true, codex: true });
  const omitted = user("omitted", 1);
  assert.equal(omitted.type, "message");
  if (omitted.type !== "message") throw new Error("fixture");
  const checkpoint = h.entries[1];
  assert.equal(checkpoint.type, "compaction");
  if (checkpoint.type !== "compaction") throw new Error("fixture");
  const parsedCheckpoint = latestCheckpoint(h.entries);
  assert.ok(parsedCheckpoint);
  const details = parsedCheckpoint.details;
  checkpoint.details = {
    ...details,
    keptMessageFingerprints: [...details.keptMessageFingerprints, fingerprintMessage(omitted.message)],
  };
  h.entries.splice(
    0,
    h.entries.length,
    ...chain([
      h.entries[0],
      omitted,
      {
        type: "context_edit",
        id: "omit",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        targetId: "omitted",
        replacement: null,
      },
      ...h.entries.slice(1),
    ]),
  );
  const before = structuredClone(h.entries);
  const context = (await h.mock.events.get("context")?.[0](
    { type: "context", messages: buildSessionContext(h.entries).messages },
    h.ctx,
  )) as { messages: unknown[] };
  assert.ok(context?.messages);
  assert.match(JSON.stringify(context.messages), /PI_CODEX_REMOTE_CHECKPOINT/);
  assert.doesNotMatch(JSON.stringify(context.messages), /omitted/);
  const result = (await h.run()) as { compaction: { summary: string } };
  assert.ok(result.compaction, JSON.stringify(h.notifications));
  assert.equal(h.payloads.length, 2);
  assert.match(JSON.stringify(h.payloads[1].payload), /opaque-assistant-only-fact/);
  assert.doesNotMatch(JSON.stringify(h.payloads[1].payload), /omitted|"text":"tail"/);
  assert.deepEqual(h.entries, before);
  assert.equal(
    h.notifications.some(({ message }) => message.includes("could not be projected")),
    false,
  );
});

test("Cancel setting avoids summary quota and preserves replay across repeated rejection", async () => {
  const h = await harness({ checkpoint: true, settings: { checkpointRecovery: "cancel" } });
  const before = structuredClone(h.entries);
  assert.deepEqual(await h.run(), { cancel: true });
  assert.deepEqual(await h.run(), { cancel: true });
  assert.equal(h.payloads.length, 1);
  assert.deepEqual(h.entries, before);
  const replay = await h.mock.events.get("before_provider_request")?.[0](
    {
      type: "before_provider_request",
      payload: {
        input: [{ role: "user", content: [{ type: "input_text", text: checkpointMarker("old-checkpoint") }] }],
      },
    },
    h.ctx,
  );
  assert.deepEqual(replay, { input: [{ type: "compaction", encrypted_content: "opaque-assistant-only-fact" }] });
});

test("summary recovery failure hands off to Pi native without prematurely changing opaque history", async () => {
  const h = await harness({
    checkpoint: true,
    response: async () => Response.json({ error: rejection }, { status: 401 }),
  });
  const before = structuredClone(h.entries);
  assert.equal(await h.run(), undefined);
  assert.equal(h.payloads.length, 2);
  assert.deepEqual(h.entries, before);
  assert.match(h.notifications.at(-1)?.message ?? "", /using Pi native compaction.*opaque checkpoint may be lost/);
  assert.doesNotMatch(h.notifications.at(-1)?.message ?? "", /secret-fixture/);
});

for (const failure of ["malformed", "unsafe", "empty", "oversized", "timeout"] as const) {
  test(`recovery ${failure} failure hands off to native after releasing its request`, async () => {
    let calls = 0;
    let recoverySignal: AbortSignal | undefined;
    const h = await harness({
      checkpoint: true,
      settings: { maxRetries: 0 },
      response: async () => {
        if (++calls === 1) return Response.json({ error: rejection }, { status: 401 });
        if (failure === "timeout") return new Promise<Response>(() => {});
        if (failure === "malformed") return new Response("data: not-json\n\n");
        const text = failure === "empty" ? "" : "x".repeat(failure === "oversized" ? 2 * 1024 * 1024 + 1 : 1);
        const output =
          failure === "unsafe"
            ? [{ type: "function_call", id: "fc", name: "read", call_id: "fc", arguments: "{}" }]
            : [{ type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text }] }];
        return new Response(
          [
            ...output.flatMap((item, output_index) => [
              { type: "response.output_item.added", output_index, item },
              { type: "response.output_item.done", output_index, item },
            ]),
            { type: "response.completed", response: { id: "resp", status: "completed", output } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const provider = h.provider;
    const originalStream = provider.stream.bind(provider);
    provider.stream = (model, context, options) => {
      if (JSON.stringify(context).includes(checkpointMarker("old-checkpoint"))) recoverySignal = options?.signal;
      return originalStream(model, context, options);
    };
    const before = structuredClone(h.entries);
    try {
      if (failure === "timeout") vi.useFakeTimers();
      const pending = h.run();
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(300_001);
      assert.equal(await pending, undefined);
      assert.equal(calls, 2);
      assert.deepEqual(h.entries, before);
      assert.equal(recoverySignal?.aborted, true);
      assert.match(h.notifications.at(-1)?.message ?? "", /using Pi native compaction/);
      if (failure === "empty" || failure === "oversized")
        assert.match(h.notifications.at(-1)?.message ?? "", /empty or oversized summary/);
      if (failure === "unsafe") assert.match(h.notifications.at(-1)?.message ?? "", /Unsafe checkpoint recovery/);
      if (failure === "timeout") assert.match(h.notifications.at(-1)?.message ?? "", /timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
}

for (const mode of ["tui", "rpc", "print", "json"] as const) {
  test(`${mode} recovery fallback warns only through supported UI and redacts secrets`, async () => {
    const h = await harness({
      checkpoint: true,
      response: async () => Response.json({ error: { message: "secret-fixture\u001b[31m" } }, { status: 400 }),
    });
    Object.assign(h.ctx, { mode, hasUI: mode === "tui" || mode === "rpc" });
    assert.equal(await h.run(), undefined);
    if (mode === "tui" || mode === "rpc") {
      assert.match(h.notifications.at(-1)?.message ?? "", /opaque checkpoint may be lost/);
      assert.doesNotMatch(h.notifications.at(-1)?.message ?? "", /secret-fixture/);
      assert.equal(h.notifications.at(-1)?.message.includes("\u001b"), false);
    } else assert.equal(h.notifications.length, 0);
  });
}

test("notifications disabled still permits recovery-to-native handoff", async () => {
  const h = await harness({
    checkpoint: true,
    settings: { notifyOnFallback: false },
    response: async () => Response.json({ error: rejection }, { status: 401 }),
  });
  assert.equal(await h.run(), undefined);
  assert.equal(h.notifications.length, 0);
});

test("unverifiable checkpoint projection cancels rather than handing off to native", async () => {
  const h = await harness({ checkpoint: true });
  const old = h.entries[0];
  assert.equal(old.type, "message");
  if (old.type === "message") old.message = { role: "user", content: "changed retained snapshot", timestamp: 1 };
  assert.deepEqual(await h.run(), { cancel: true });
  assert.equal(h.payloads.length, 0);
  assert.match(h.notifications.at(-1)?.message ?? "", /cancelled and history preserved/);
});

for (const patch of [{ id: "other-model" }, { provider: "proxy" }, { baseUrl: "https://proxy.test/v1" }] as const) {
  test(`route identity isolates ${JSON.stringify(patch)} and remembers switching back`, async () => {
    const h = await harness();
    await h.run();
    h.setModel(patch);
    await h.run();
    h.setModel(baseModel);
    await h.run();
    assert.equal(h.payloads.length, 2);
  });
}

test("switching a rejected route to Context Management remains eligible", async () => {
  const h = await harness();
  await h.run();
  await h.runtime.update({ protocol: "context-management" });
  await h.run();
  assert.equal(h.payloads.length, 2);
  assert.ok(h.payloads[1].payload.context_management);
  await h.runtime.update({ protocol: "auto" });
  await h.run();
  assert.equal(h.payloads.length, 2);
});

for (const reason of ["reload", "resume", "fork", "switch"] as const) {
  test(`${reason} session_start clears suppression`, async () => {
    const h = await harness();
    await h.run();
    await h.run();
    await h.mock.events.get("session_start")?.[0]({ type: "session_start", reason }, h.ctx);
    await h.run();
    assert.equal(h.payloads.length, 2);
  });
}

test("session managers isolate suppression even with the same headless UI", async () => {
  const h = await harness();
  const second = h.makeContext({ getSessionId: () => "other", getBranch: () => h.entries });
  Object.assign(second.ctx, { ui: (h.ctx as unknown as { ui: unknown }).ui, hasUI: false, mode: "print" });
  await h.run();
  await h.run(second.ctx);
  await h.run();
  await h.run(second.ctx);
  assert.equal(h.payloads.length, 2);
});

for (const transition of [
  "cancel",
  "replace",
  "reload",
  "shutdown",
  "model",
  "branch",
  "model-event",
  "tree",
] as const) {
  test(`delayed rejection after ${transition} cannot publish suppression or clear newer status`, async () => {
    let release!: (value: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let delayed = true;
    const h = await harness({
      response: async () => {
        if (!delayed) return Response.json({ error: rejection }, { status: 401 });
        started();
        return response;
      },
    });
    const controller = new AbortController();
    const pending = h.run(h.ctx, controller.signal);
    await ready;
    if (transition === "cancel") controller.abort();
    if (transition === "replace") h.replaceId();
    if (transition === "reload")
      await h.mock.events.get("session_start")?.[0]({ type: "session_start", reason: "reload" }, h.ctx);
    if (transition === "shutdown")
      await h.mock.events.get("session_shutdown")?.[0]({ type: "session_shutdown", reason: "exit" }, h.ctx);
    if (transition === "model") h.setModel({ id: "new" });
    if (transition === "branch") h.entries.push(user("new-leaf", 10));
    if (transition === "model-event") {
      h.setModel({ id: "new" });
      await h.mock.events.get("model_select")?.[0]({ type: "model_select", model: { ...baseModel, id: "new" } }, h.ctx);
    }
    if (transition === "tree") {
      h.entries.push({ ...user("new-leaf", 10), parentId: "tail" });
      await h.mock.events.get("session_tree")?.[0]({ type: "session_tree", newLeafId: "new-leaf" }, h.ctx);
    }
    if (transition === "replace" || transition === "reload" || transition === "shutdown")
      h.statuses.set("codex-compact", "replacement-owned");
    release(Response.json({ error: rejection }, { status: 401 }));
    assert.deepEqual(await pending, { cancel: true });
    assert.deepEqual(h.notifications, []);
    if (transition === "replace" || transition === "reload" || transition === "shutdown")
      assert.equal(h.statuses.get("codex-compact"), "replacement-owned");
    delayed = false;
    h.setModel(baseModel);
    if (transition === "shutdown") {
      assert.deepEqual(await h.run(), { cancel: true }, "queued old-context events remain cancelled after shutdown");
      assert.equal(h.payloads.length, 1);
      await h.mock.events.get("session_start")?.[0]({ type: "session_start", reason: "resume" }, h.ctx);
    }
    await h.run();
    assert.equal(h.payloads.length, 2, "stale result did not suppress the new attempt");
  });
}

test("rejection cache is bounded without evicting known routes or blocking unknown routes", () => {
  const cache = new RejectedRoutes();
  for (let i = 0; i < 200; i += 1) cache.add(String(i));
  assert.equal(cache.has("0"), true);
  assert.equal(cache.has("127"), true);
  assert.equal(cache.has("128"), false);
  const route = resolveCompactionRoute(baseModel, DEFAULT_CODEX_COMPACT_SETTINGS);
  assert.equal(route.kind, "remote");
  if (route.kind === "remote") {
    assert.notEqual(
      rejectionRouteKey(baseModel, route),
      rejectionRouteKey({ ...baseModel, baseUrl: "https://other.test" }, route),
    );
    assert.notEqual(
      rejectionRouteKey(baseModel, route),
      rejectionRouteKey(baseModel, { ...route, profile: "codex-responses-v1" }),
    );
    assert.notEqual(rejectionRouteKey(baseModel, route), rejectionRouteKey(baseModel, { ...route, api: "custom" }));
  }
});

test("model switch preserves encrypted checkpoint recovery on the selected Responses model", async () => {
  const h = await harness({ checkpoint: true });
  const before = structuredClone(h.entries);
  h.setModel({ id: "other" });
  const result = (await h.run()) as { compaction: { summary: string } };
  assert.match(result.compaction.summary, /sapphire/);
  assert.equal(h.payloads.length, 2);
  assert.ok(h.payloads.every(({ payload }) => payload.model === "other"));
  assert.ok(h.payloads.every(({ payload }) => JSON.stringify(payload).includes("opaque-assistant-only-fact")));
  assert.deepEqual(h.entries, before);
});

test("incompatible checkpoint cancels before any request", async () => {
  const h = await harness({ checkpoint: true });
  const before = structuredClone(h.entries);
  h.setModel({ api: "openai-codex-responses" });
  assert.deepEqual(await h.run(), { cancel: true });
  assert.equal(h.payloads.length, 0);
  assert.deepEqual(h.entries, before);
});

for (const transition of ["cancel", "reload", "settings", "branch", "shutdown", "replacement", "model"] as const) {
  for (const failed of [false, true]) {
    test(`delayed ${failed ? "failed" : "successful"} summary after ${transition} cannot publish or fall back`, async () => {
      let release!: (response: Response) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const response = new Promise<Response>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const h = await harness({
        checkpoint: true,
        response: async () => {
          calls += 1;
          if (calls === 1) return Response.json({ error: rejection }, { status: 401 });
          started();
          return response;
        },
      });
      const controller = new AbortController();
      const pending = h.run(h.ctx, controller.signal);
      await ready;
      const before = structuredClone(h.entries);
      const warnings = h.notifications.length;
      if (transition === "cancel") controller.abort();
      if (transition === "reload")
        await h.mock.events.get("session_start")?.[0]({ type: "session_start", reason: "reload" }, h.ctx);
      if (transition === "settings") await h.runtime.update({ checkpointRecovery: "cancel" });
      if (transition === "branch") h.entries.push({ ...user("new-leaf", 10), parentId: "tail" });
      if (transition === "shutdown")
        await h.mock.events.get("session_shutdown")?.[0]({ type: "session_shutdown", reason: "exit" }, h.ctx);
      if (transition === "replacement") h.replaceId();
      if (transition === "model") h.setModel({ id: "other-model" });
      if (transition === "reload") h.statuses.set("codex-compact", "replacement-owned");
      release(failed ? Response.json({ error: rejection }, { status: 401 }) : summaryResponse());
      assert.deepEqual(await pending, { cancel: true });
      assert.deepEqual(h.entries.slice(0, before.length), before);
      assert.equal(h.notifications.length, warnings);
      if (transition === "reload") assert.equal(h.statuses.get("codex-compact"), "replacement-owned");
      else if (transition !== "replacement") assert.equal(h.statuses.get("codex-compact"), undefined);
    });
  }
}

test("checkpoint recovery setting changes apply immediately without clearing rejection", async () => {
  const h = await harness({ checkpoint: true, settings: { checkpointRecovery: "cancel" } });
  assert.deepEqual(await h.run(), { cancel: true });
  await h.runtime.update({ checkpointRecovery: "summarize" });
  const result = (await h.run()) as { compaction?: { summary: string } };
  assert.match(result.compaction?.summary ?? "", /sapphire/);
  assert.equal(h.payloads.length, 2, "only one rejected compact and one summary");
});

test("actual Azure adapter endpoint and API version changes remain eligible despite unchanged model base URL", async () => {
  const h = await harness({ azure: true });
  h.setEnv({ AZURE_OPENAI_BASE_URL: "https://first.openai.azure.com", AZURE_OPENAI_API_VERSION: "v1" });
  await h.run();
  await h.run();
  assert.equal(h.payloads.length, 1);
  assert.match(h.payloads[0].url, /first.openai.azure.com/);
  h.setEnv({ AZURE_OPENAI_BASE_URL: "https://second.openai.azure.com", AZURE_OPENAI_API_VERSION: "v1" });
  await h.run();
  assert.equal(h.payloads.length, 2);
  assert.match(h.payloads[1].url, /second.openai.azure.com/);
  h.setEnv({ AZURE_OPENAI_BASE_URL: "https://second.openai.azure.com", AZURE_OPENAI_API_VERSION: "next" });
  await h.run();
  assert.equal(h.payloads.length, 3);
  assert.match(h.payloads[2].url, /api-version=next/);
  h.setEnv({ AZURE_OPENAI_BASE_URL: "https://first.openai.azure.com", AZURE_OPENAI_API_VERSION: "v1" });
  await h.run();
  assert.equal(h.payloads.length, 3);
});

test("URL credential and query secret changes do not fingerprint credentials or retry a rejected identity", () => {
  const route = resolveCompactionRoute(baseModel, DEFAULT_CODEX_COMPACT_SETTINGS);
  if (route.kind !== "remote") assert.fail("remote fixture");
  const key = (secret: string) =>
    rejectionRouteKey(
      { ...baseModel, baseUrl: `https://user:${secret}@proxy.test/v1?api-key=${secret}` },
      route,
      `https://user:${secret}@proxy.test/v1/responses/compact?api-key=${secret}`,
    );
  assert.equal(key("first"), key("second"));
  const cache = new RejectedRoutes();
  for (let i = 0; i < 200; i += 1) cache.observe(`successful-route-${i}`, `successful-backend-${i}`);
  cache.add("first-backend");
  cache.observe("route", "first-backend");
  assert.equal(cache.hasObserved("route"), true);
  cache.observe("route", "second-backend");
  assert.equal(cache.hasObserved("route"), false);
  cache.observe("route", "first-backend");
  assert.equal(cache.hasObserved("route"), true);
});

for (const protocol of ["auto", "responses-compact", "remote-v2", "context-management"] as const) {
  test(`actual Codex adapter ${protocol} preserves structured rejection before friendly-error conversion and stops retries`, async () => {
    const h = await harness({
      codex: true,
      settings: { protocol, maxRetries: 2 },
      body: { ...rejection, message: "This ChatPass credential is not authorized for the requested operation." },
    });
    assert.equal(await h.run(), undefined);
    assert.equal(await h.run(), undefined);
    assert.equal(h.payloads.length, 1);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].message, /hardened_oauth_rule_missing/);
    assert.match(h.notifications[0].message, /rejected_by_hardened_oauth_boundary/);
  });
}

for (const codex of [false, true]) {
  for (const protocol of ["remote-v2", "context-management"] as const) {
    for (const type of ["error", "response.failed"] as const) {
      test(`actual ${codex ? "Codex" : "OpenAI"} ${protocol} observes structured ${type} rejection before stream formatting`, async () => {
        const error = { ...rejection, message: "operation denied" };
        const raw =
          type === "error"
            ? { type, error }
            : { type, response: { id: "resp_failure", status: "failed", output: [], error } };
        const h = await harness({
          codex,
          settings: { protocol },
          response: async () =>
            new Response(`data: ${JSON.stringify(raw)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
        });
        assert.equal(await h.run(), undefined);
        assert.equal(await h.run(), undefined);
        assert.equal(h.payloads.length, 1);
        assert.equal(h.notifications.length, 1);
        assert.match(h.notifications[0].message, /hardened_oauth_rule_missing/);
      });
    }
  }
}

for (const codex of [false, true]) {
  for (const protocol of ["responses-compact", "remote-v2", "context-management"] as const) {
    test(`actual ${codex ? "Codex" : "Azure"} ${protocol} failure recovers a compatible checkpoint through ordinary inference`, async () => {
      const h = await harness({ checkpoint: true, codex, azure: !codex, settings: { protocol } });
      if (!codex) h.setEnv({ AZURE_OPENAI_BASE_URL: "https://first.openai.azure.com", AZURE_OPENAI_API_VERSION: "v1" });
      const result = (await h.run()) as { compaction?: { summary: string } };
      assert.match(result.compaction?.summary ?? "", /sapphire/, JSON.stringify(h.notifications));
      assert.equal(h.payloads.length, 2);
      assert.match(JSON.stringify(h.payloads[1].payload), /opaque-assistant-only-fact/);
      assert.doesNotMatch(JSON.stringify(h.payloads[1].payload), /compaction_trigger|context_management/);
    });
  }
}

test("a changed Azure recovery backend cancels before an inference dispatch", async () => {
  let change: () => void = () => {};
  const h = await harness({
    checkpoint: true,
    azure: true,
    onAuth: (call) => {
      if (call === 2) change();
    },
  });
  h.setEnv({ AZURE_OPENAI_BASE_URL: "https://first.openai.azure.com", AZURE_OPENAI_API_VERSION: "v1" });
  change = () => h.setEnv({ AZURE_OPENAI_BASE_URL: "https://second.openai.azure.com", AZURE_OPENAI_API_VERSION: "v1" });
  assert.deepEqual(await h.run(), { cancel: true });
  assert.equal(h.payloads.length, 1);
  assert.match(h.notifications.at(-1)?.message ?? "", /backend changed before dispatch/);
});

test("configured custom API keeps suppression, compatible replay, and ordinary summary recovery independent", async () => {
  const h = await harness({
    custom: true,
    checkpoint: true,
    settings: { apiProfiles: { "custom-responses": "codex-responses-v1" }, checkpointRecovery: "cancel" },
  });
  assert.deepEqual(await h.run(), { cancel: true });
  assert.deepEqual(await h.run(), { cancel: true });
  assert.equal(h.payloads.length, 1);
  await h.runtime.update({ apiProfiles: {} });
  assert.deepEqual(await h.run(), { cancel: true });
  assert.equal(h.payloads.length, 1);
  await h.runtime.update({
    apiProfiles: { "custom-responses": "codex-responses-v1" },
    checkpointRecovery: "summarize",
  });
  const result = (await h.run()) as { compaction?: { summary: string } };
  assert.match(result.compaction?.summary ?? "", /sapphire/, JSON.stringify(h.notifications));
  assert.equal(h.payloads.length, 2, "restored mapping retains rejection and allows only summary inference");
  await h.runtime.update({ enabled: false });
  assert.equal(await h.run(), undefined, "explicit disable still relinquishes compaction and replay");
  assert.equal(
    await h.mock.events.get("before_provider_request")?.[0](
      {
        type: "before_provider_request",
        payload: {
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: checkpointMarker("old-checkpoint") }],
            },
          ],
        },
      },
      h.ctx,
    ),
    undefined,
  );
});

test("shutdown before initialization keeps queued events cancelled until session_start, including changed IDs and native routes", async () => {
  const h = await harness();
  await h.mock.events.get("session_shutdown")?.[0]({ type: "session_shutdown", reason: "exit" }, h.ctx);
  h.replaceId();
  assert.deepEqual(await h.run(), { cancel: true });
  await h.runtime.update({ enabled: false });
  assert.deepEqual(await h.run(), { cancel: true });
  assert.equal(h.payloads.length, 0);
  await h.runtime.update({ enabled: true });
  await h.mock.events.get("session_start")?.[0]({ type: "session_start", reason: "resume" }, h.ctx);
  assert.equal(await h.run(), undefined);
  assert.equal(h.payloads.length, 1);
});

test("a late successful response releases its body after shutdown rather than reviving stale work", async () => {
  let release!: (response: Response) => void;
  let started!: () => void;
  let cancelled!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releasedBody = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const h = await harness({
    response: async () => {
      started();
      return response;
    },
  });
  const pending = h.run();
  await ready;
  await h.mock.events.get("session_shutdown")?.[0]({ type: "session_shutdown", reason: "exit" }, h.ctx);
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  assert.deepEqual(await pending, { cancel: true });
  await releasedBody;
  assert.equal(h.payloads.length, 1);
  assert.deepEqual(h.notifications, []);
});

for (const patch of [
  { version: 999 },
  { replacementHistory: [] },
  { replacementHistory: [{ type: "compaction", encrypted_content: "" }] },
  { keptMessageFingerprints: ["invalid"] },
]) {
  test(`malformed or unsupported owned checkpoint cancels without treating validation failure as native history: ${JSON.stringify(patch)}`, async () => {
    const h = await harness({ checkpoint: true });
    const checkpoint = h.entries.find((entry) => entry.type === "compaction");
    assert.ok(checkpoint && checkpoint.type === "compaction");
    checkpoint.details = { ...(checkpoint.details as object), ...patch };
    const before = structuredClone(h.entries);
    assert.equal(latestCheckpoint(h.entries), undefined);
    assert.deepEqual(await h.run(), { cancel: true });
    assert.equal(h.payloads.length, 0);
    assert.deepEqual(h.entries, before);
    assert.match(h.notifications.at(-1)?.message ?? "", /invalid or unsupported/);
    h.setModel({ api: "anthropic-messages", provider: "anthropic" });
    assert.deepEqual(await h.run(), { cancel: true });
    assert.equal(h.payloads.length, 0);
    await h.runtime.update({ enabled: false });
    assert.equal(await h.run(), undefined, "explicit disable still relinquishes ownership");
  });
}

test("a later native compaction supersedes an archived malformed checkpoint claim", async () => {
  const h = await harness({ checkpoint: true });
  const checkpoint = h.entries.find((entry) => entry.type === "compaction");
  assert.ok(checkpoint && checkpoint.type === "compaction");
  checkpoint.details = { ...(checkpoint.details as object), version: 999 };
  h.entries.push({
    type: "compaction",
    id: "native",
    parentId: "tail",
    timestamp: new Date(5).toISOString(),
    summary: "plaintext summary",
    firstKeptEntryId: "tail",
    tokensBefore: 500,
    details: { readFiles: [], modifiedFiles: [] },
  });
  assert.equal(await h.run(), undefined);
  assert.equal(h.payloads.length, 1, "only the newest compaction owns the current contract");
});
