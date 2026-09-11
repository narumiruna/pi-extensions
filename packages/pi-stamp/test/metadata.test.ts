import assert from "node:assert/strict";
import { test } from "vitest";
import {
  captureAssistantMetadata,
  formatAssistantMetadataLines,
  formatToolStampLabel,
  isAssistantMetadataData,
  isStampThinkingLevel,
} from "../src/metadata.js";

const COMPLETE_MESSAGE = {
  role: "assistant",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "requested-model",
  responseModel: "actual-model",
  responseId: "resp-1",
  stopReason: "toolUse",
  usage: {
    input: 100,
    output: 200,
    reasoning: 50,
    cacheRead: 300,
    cacheWrite: 400,
    totalTokens: 1_234,
    cost: { total: 0.018 },
  },
  diagnostics: [
    {
      type: "rate_limit",
      timestamp: 1_000,
      error: {
        name: "Timeout",
        code: "ETIMEDOUT",
        message: "Bearer secret-token must never survive",
        stack: "raw stack must never survive",
      },
      details: { payload: "raw details must never survive" },
    },
    {
      type: "retry",
      timestamp: 2_000,
      error: { name: "HTTPError", code: 429, message: "sk-secret" },
    },
  ],
};

test("assistant metadata capture keeps reported fields and excludes sensitive protocol data", () => {
  const metadata = captureAssistantMetadata({
    ...COMPLETE_MESSAGE,
    content: [
      { type: "text", text: "private content", textSignature: "text-secret" },
      { type: "thinking", thinking: "private thought", thinkingSignature: "thinking-secret" },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "secret" },
        thoughtSignature: "thought-secret",
      },
    ],
  });
  assert.deepEqual(metadata, {
    api: "anthropic-messages",
    provider: "anthropic",
    model: "requested-model",
    responseModel: "actual-model",
    responseId: "resp-1",
    stopReason: "toolUse",
    usage: {
      input: 100,
      output: 200,
      reasoning: 50,
      cacheRead: 300,
      cacheWrite: 400,
      totalTokens: 1_234,
      estimatedCost: 0.018,
    },
    diagnosticCount: 2,
    diagnostics: [
      { type: "rate_limit", errorName: "Timeout", errorCode: "ETIMEDOUT" },
      { type: "retry", errorName: "HTTPError", errorCode: "429" },
    ],
  });
  const persisted = JSON.stringify(metadata);
  for (const excluded of [
    "private content",
    "private thought",
    "text-secret",
    "thinking-secret",
    "thought-secret",
    "secret-token",
    "raw stack",
    "raw details",
    "sk-secret",
  ]) {
    assert.equal(persisted.includes(excluded), false, excluded);
  }
  assert.equal(isAssistantMetadataData(metadata), true);
});

test("assistant metadata capture sanitizes and bounds terminal-facing strings", () => {
  const metadata = captureAssistantMetadata({
    ...COMPLETE_MESSAGE,
    api: `openai\u001b[31m\napi`,
    provider: "provider\u009b31m\u202eevil\u2066name\u2069",
    model: "m".repeat(400),
    responseModel: "",
    responseId: "response\u0000id",
    diagnostics: [{ type: "retry\u001b[2J", timestamp: 1, error: { name: "E\nrror" } }],
  });
  assert.ok(metadata);
  assert.equal(JSON.stringify(metadata).includes("\u001b"), false);
  assert.equal(JSON.stringify(metadata).includes("\u009b"), false);
  assert.equal(JSON.stringify(metadata).includes("\u202e"), false);
  assert.equal(JSON.stringify(metadata).includes("\u2066"), false);
  assert.equal(metadata.provider, "provider 31m evil name");
  assert.equal(metadata.model.length, 160);
  assert.equal(metadata.responseModel, undefined);
  assert.equal(metadata.responseId, "response id");
  assert.equal(metadata.diagnostics?.[0]?.errorName, "E rror");
});

test("assistant metadata formatting distinguishes compact, expanded, and explicit debug details", () => {
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE);
  assert.ok(metadata);
  assert.deepEqual(formatAssistantMetadataLines(metadata, "off", false), []);
  assert.deepEqual(formatAssistantMetadataLines(metadata, "compact", false), [
    "requested-model → actual-model · 1,234 tok · est $0.018",
  ]);
  assert.deepEqual(formatAssistantMetadataLines(metadata, "expanded", false), [
    "api anthropic-messages · provider anthropic · requested requested-model · response actual-model · stop toolUse",
    "tokens in 100 · out 200 · reasoning 50 · cache read 300 · cache write 400 · total 1,234 · est cost $0.018",
  ]);
  assert.deepEqual(formatAssistantMetadataLines(metadata, "compact", true), [
    "requested-model → actual-model · 1,234 tok · est $0.018",
    "debug · response id resp-1",
    "debug · diagnostics 2",
    "debug · rate_limit · Timeout · code ETIMEDOUT",
    "debug · retry · HTTPError · code 429",
  ]);
  const tinyCost = captureAssistantMetadata({
    ...COMPLETE_MESSAGE,
    usage: { ...COMPLETE_MESSAGE.usage, totalTokens: 1_000_000, cost: { total: 0.00001 } },
  });
  assert.ok(tinyCost);
  assert.deepEqual(formatAssistantMetadataLines(tinyCost, "compact", false), [
    "requested-model → actual-model · 1,000,000 tok · est <$0.0001",
  ]);
  const wholeCost = captureAssistantMetadata({
    ...COMPLETE_MESSAGE,
    usage: { ...COMPLETE_MESSAGE.usage, cost: { total: 1.2 } },
  });
  assert.ok(wholeCost);
  assert.deepEqual(formatAssistantMetadataLines(wholeCost, "compact", false), [
    "requested-model → actual-model · 1,234 tok · est $1.2",
  ]);
});

test("assistant cost-since-user formatting works with or without full metadata", () => {
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE);
  assert.ok(metadata);
  const costSinceUserData = { estimatedCost: 0.018, costSinceUser: 0.039 };
  assert.deepEqual(formatAssistantMetadataLines(metadata, "compact", false, undefined, true, costSinceUserData), [
    "requested-model → actual-model · 1,234 tok · est $0.018 · since user $0.039",
  ]);
  assert.deepEqual(formatAssistantMetadataLines(metadata, "expanded", false, undefined, true, costSinceUserData), [
    "api anthropic-messages · provider anthropic · requested requested-model · response actual-model · stop toolUse",
    "tokens in 100 · out 200 · reasoning 50 · cache read 300 · cache write 400 · total 1,234 · est cost $0.018 · since user $0.039",
  ]);
  assert.deepEqual(formatAssistantMetadataLines(undefined, "off", false, undefined, true, costSinceUserData), [
    "est $0.018 · since user $0.039",
  ]);
  assert.deepEqual(
    formatAssistantMetadataLines(undefined, "off", false, undefined, true, {
      costSinceUser: 0.03,
    }),
    ["since user $0.03"],
  );
  assert.deepEqual(
    formatAssistantMetadataLines(metadata, "compact", false, undefined, true, {
      estimatedCost: -1,
      costSinceUser: 0.039,
    }),
    [],
  );
});

test("assistant metadata formats effective Thinking level and only abnormal compact outcomes", () => {
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(isStampThinkingLevel(thinkingLevel), true);
    const metadata = captureAssistantMetadata({
      ...COMPLETE_MESSAGE,
      stopReason: "stop",
      diagnostics: [],
    });
    assert.ok(metadata);
    assert.match(
      formatAssistantMetadataLines(metadata, "compact", false, thinkingLevel)[0] ?? "",
      new RegExp(`thinking ${thinkingLevel}`, "u"),
    );
  }
  assert.equal(isStampThinkingLevel("ultra"), false);

  for (const stopReason of ["length", "error", "aborted"] as const) {
    const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason });
    assert.ok(metadata);
    assert.match(
      formatAssistantMetadataLines(metadata, "compact", false, "high")[0] ?? "",
      new RegExp(`thinking high · stop ${stopReason}`, "u"),
    );
  }
  for (const stopReason of ["stop", "toolUse"] as const) {
    const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason });
    assert.ok(metadata);
    assert.equal(formatAssistantMetadataLines(metadata, "compact", false, "high")[0]?.includes("stop "), false);
  }

  const expanded = captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason: "error" });
  assert.ok(expanded);
  assert.equal(
    formatAssistantMetadataLines(expanded, "compact", false, "high", false)[0]?.includes("stop error"),
    false,
  );
  assert.match(
    formatAssistantMetadataLines(expanded, "expanded", false, "high", false)[0] ?? "",
    /thinking high · stop error/u,
  );
  assert.deepEqual(formatAssistantMetadataLines(expanded, "compact", false, "ultra" as never), []);
});

test("assistant metadata preserves missing provider values instead of estimating them", () => {
  const metadata = captureAssistantMetadata({
    role: "assistant",
    api: "custom-api",
    provider: "custom-provider",
    model: "custom-model",
    stopReason: "stop",
    usage: {
      input: 0,
      output: Number.NaN,
      cacheRead: -1,
      cacheWrite: 0,
      totalTokens: undefined,
      cost: {},
    },
  });
  assert.deepEqual(metadata, {
    api: "custom-api",
    provider: "custom-provider",
    model: "custom-model",
    stopReason: "stop",
    usage: { input: 0, cacheWrite: 0 },
  });
  assert.deepEqual(formatAssistantMetadataLines(metadata, "compact", false), ["custom-model"]);
  assert.deepEqual(formatAssistantMetadataLines(metadata, "expanded", false), [
    "api custom-api · provider custom-provider · requested custom-model · stop stop",
    "tokens in 0 · cache write 0",
  ]);
  assert.equal(captureAssistantMetadata({ ...COMPLETE_MESSAGE, provider: "" }), undefined);
  assert.equal(captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason: "unknown" }), undefined);
});

test("assistant metadata bounds diagnostic summaries while retaining the reported count", () => {
  const metadata = captureAssistantMetadata({
    ...COMPLETE_MESSAGE,
    diagnostics: Array.from({ length: 7 }, (_value, index) => ({
      type: `diagnostic-${index}`,
      timestamp: index,
      error: { name: `Error${index}`, code: index },
    })),
  });
  assert.ok(metadata);
  assert.equal(metadata.diagnosticCount, 7);
  assert.equal(metadata.diagnostics?.length, 5);
  assert.match(formatAssistantMetadataLines(metadata, "compact", true)[2] ?? "", /7 \(showing 5\)/u);
});

test("assistant metadata capture bounds work across malformed diagnostic collections", () => {
  let inspected = 0;
  const diagnostics = new Proxy(new Array(1_000), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        inspected += 1;
        if (inspected > 32) throw new Error("diagnostic inspection exceeded its bound");
        return undefined;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, diagnostics });
  assert.ok(metadata);
  assert.equal(metadata.diagnosticCount, 1_000);
  assert.equal(metadata.diagnostics, undefined);
  assert.equal(inspected, 32);
});

test("assistant metadata validator rejects unknown, malformed, and oversized persisted data", () => {
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE);
  assert.ok(metadata);
  for (const value of [
    { ...metadata, future: true },
    { ...metadata, usage: { ...metadata.usage, totalTokens: -1 } },
    {
      ...metadata,
      diagnostics: [...(metadata.diagnostics ?? []), { type: "x" }, { type: "y" }, { type: "z" }, { type: "overflow" }],
    },
    { ...metadata, diagnosticCount: 1 },
    { ...metadata, responseId: "x".repeat(161) },
  ]) {
    assert.equal(isAssistantMetadataData(value), false);
  }
});

test("tool stamp formatting labels only valid reported duration and outcome", () => {
  assert.equal(formatToolStampLabel("read", 1_250, "success"), "tool read · 1.3s · success");
  assert.equal(formatToolStampLabel("bash\u001b[31m", 1, "error"), "tool bash [31m · <0.1s · error");
  assert.equal(formatToolStampLabel("", 100, "success"), undefined);
  assert.equal(formatToolStampLabel("read", -1, "success"), undefined);
  assert.equal(formatToolStampLabel("read", 100, "cancelled" as never), undefined);
});
