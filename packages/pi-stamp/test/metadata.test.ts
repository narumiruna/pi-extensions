import assert from "node:assert/strict";
import { test } from "vitest";
import {
  captureAssistantMetadata,
  formatAssistantMetadataLines,
  formatToolStampLabel,
  isAssistantMetadataData,
  isStampThinkingLevel,
} from "../src/metadata.js";
import { METADATA_BOOLEAN_FIELDS, METADATA_PRESETS, type StampMetadataSettings } from "../src/metadata-settings.js";

const DEBUG_SETTINGS = { ...METADATA_PRESETS.detailed, showResponseId: true, showDiagnostics: true };

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
  const metadata = captureAssistantMetadata(
    {
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
    },
    DEBUG_SETTINGS,
  );
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
  const metadata = captureAssistantMetadata(
    {
      ...COMPLETE_MESSAGE,
      api: `openai\u001b[31m\napi`,
      provider: "provider\u009b31m\u202eevil\u2066name\u2069",
      model: "m".repeat(400),
      responseModel: "",
      responseId: "response\u0000id",
      diagnostics: [{ type: "retry\u001b[2J", timestamp: 1, error: { name: "E\nrror" } }],
    },
    DEBUG_SETTINGS,
  );
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
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE, DEBUG_SETTINGS);
  assert.ok(metadata);
  assert.deepEqual(formatAssistantMetadataLines(metadata, METADATA_PRESETS.none, false), []);
  assert.deepEqual(formatAssistantMetadataLines(metadata, METADATA_PRESETS.compact, false), [
    "requested-model → actual-model · 1,234 tok · est $0.018",
  ]);
  assert.deepEqual(formatAssistantMetadataLines(metadata, METADATA_PRESETS.detailed, false), [
    "api anthropic-messages · provider anthropic · requested requested-model · response actual-model · stop toolUse",
    "tokens in 100 · out 200 · reasoning 50 · cache read 300 · cache write 400 · total 1,234 · est cost $0.018",
  ]);
  assert.deepEqual(
    formatAssistantMetadataLines(
      metadata,
      {
        ...METADATA_PRESETS.compact,
        showResponseId: true,
        showDiagnostics: true,
      },
      true,
    ),
    [
      "requested-model → actual-model · 1,234 tok · est $0.018",
      "debug · response id resp-1",
      "debug · diagnostics 2",
      "debug · rate_limit · Timeout · code ETIMEDOUT",
      "debug · retry · HTTPError · code 429",
    ],
  );
  const tinyCost = captureAssistantMetadata({
    ...COMPLETE_MESSAGE,
    usage: { ...COMPLETE_MESSAGE.usage, totalTokens: 1_000_000, cost: { total: 0.00001 } },
  });
  assert.ok(tinyCost);
  assert.deepEqual(formatAssistantMetadataLines(tinyCost, METADATA_PRESETS.compact, false), [
    "requested-model → actual-model · 1,000,000 tok · est <$0.0001",
  ]);
  const wholeCost = captureAssistantMetadata({
    ...COMPLETE_MESSAGE,
    usage: { ...COMPLETE_MESSAGE.usage, cost: { total: 1.2 } },
  });
  assert.ok(wholeCost);
  assert.deepEqual(formatAssistantMetadataLines(wholeCost, METADATA_PRESETS.compact, false), [
    "requested-model → actual-model · 1,234 tok · est $1.2",
  ]);
});

test("assistant cost-since-user formatting works with or without full metadata", () => {
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE);
  assert.ok(metadata);
  const costSinceUserData = { estimatedCost: 0.018, costSinceUser: 0.039 };
  assert.deepEqual(
    formatAssistantMetadataLines(metadata, METADATA_PRESETS.compact, false, undefined, costSinceUserData),
    ["requested-model → actual-model · 1,234 tok · est $0.018 · since user $0.039"],
  );
  assert.deepEqual(
    formatAssistantMetadataLines(metadata, METADATA_PRESETS.detailed, false, undefined, costSinceUserData),
    [
      "api anthropic-messages · provider anthropic · requested requested-model · response actual-model · stop toolUse",
      "tokens in 100 · out 200 · reasoning 50 · cache read 300 · cache write 400 · total 1,234 · est cost $0.018 · since user $0.039",
    ],
  );
  assert.deepEqual(
    formatAssistantMetadataLines(undefined, METADATA_PRESETS.none, false, undefined, costSinceUserData),
    ["est $0.018 · since user $0.039"],
  );
  assert.deepEqual(
    formatAssistantMetadataLines(undefined, METADATA_PRESETS.none, false, undefined, {
      costSinceUser: 0.03,
    }),
    ["since user $0.03"],
  );
  assert.deepEqual(
    formatAssistantMetadataLines(metadata, METADATA_PRESETS.compact, false, undefined, {
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
      formatAssistantMetadataLines(metadata, METADATA_PRESETS.compact, false, thinkingLevel)[0] ?? "",
      new RegExp(`thinking ${thinkingLevel}`, "u"),
    );
  }
  assert.equal(isStampThinkingLevel("ultra"), false);

  for (const stopReason of ["length", "error", "aborted"] as const) {
    const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason });
    assert.ok(metadata);
    assert.match(
      formatAssistantMetadataLines(metadata, METADATA_PRESETS.compact, false, "high")[0] ?? "",
      new RegExp(`thinking high · stop ${stopReason}`, "u"),
    );
  }
  for (const stopReason of ["stop", "toolUse"] as const) {
    const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason });
    assert.ok(metadata);
    assert.equal(
      formatAssistantMetadataLines(metadata, METADATA_PRESETS.compact, false, "high")[0]?.includes("stop "),
      false,
    );
  }

  const expanded = captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason: "error" });
  assert.ok(expanded);
  assert.equal(
    formatAssistantMetadataLines(
      expanded,
      { ...METADATA_PRESETS.compact, stopReason: "hidden" },
      false,
      "high",
    )[0]?.includes("stop error"),
    false,
  );
  assert.match(
    formatAssistantMetadataLines(expanded, METADATA_PRESETS.detailed, false, "high")[0] ?? "",
    /thinking high · stop error/u,
  );
  assert.deepEqual(formatAssistantMetadataLines(expanded, METADATA_PRESETS.compact, false, "ultra" as never), []);
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
  assert.deepEqual(formatAssistantMetadataLines(metadata, METADATA_PRESETS.compact, false), ["custom-model"]);
  assert.deepEqual(formatAssistantMetadataLines(metadata, METADATA_PRESETS.detailed, false), [
    "api custom-api · provider custom-provider · requested custom-model · stop stop",
    "tokens in 0 · cache write 0",
  ]);
  assert.equal(captureAssistantMetadata({ ...COMPLETE_MESSAGE, provider: "" }), undefined);
  assert.equal(captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason: "unknown" }), undefined);
});

test("assistant metadata bounds diagnostic summaries while retaining the reported count", () => {
  const metadata = captureAssistantMetadata(
    {
      ...COMPLETE_MESSAGE,
      diagnostics: Array.from({ length: 7 }, (_value, index) => ({
        type: `diagnostic-${index}`,
        timestamp: index,
        error: { name: `Error${index}`, code: index },
      })),
    },
    DEBUG_SETTINGS,
  );
  assert.ok(metadata);
  assert.equal(metadata.diagnosticCount, 7);
  assert.equal(metadata.diagnostics?.length, 5);
  assert.match(
    formatAssistantMetadataLines(metadata, { ...DEBUG_SETTINGS, metadataLayout: "compact" }, true)[2] ?? "",
    /7 \(showing 5\)/u,
  );
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
  const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, diagnostics }, DEBUG_SETTINGS);
  assert.ok(metadata);
  assert.equal(metadata.diagnosticCount, 1_000);
  assert.equal(metadata.diagnostics, undefined);
  assert.equal(inspected, 32);
});

test("assistant metadata validator rejects unknown, malformed, and oversized persisted data", () => {
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE, DEBUG_SETTINGS);
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

const SINGLE_FLAG_CASES = [
  { field: "showRequestedModel", compact: ["requested-model"], expanded: ["requested requested-model"] },
  { field: "showResponseModel", compact: ["actual-model"], expanded: ["response actual-model"] },
  { field: "showProvider", compact: ["provider anthropic"], expanded: ["provider anthropic"] },
  { field: "showApi", compact: ["api anthropic-messages"], expanded: ["api anthropic-messages"] },
  { field: "showPiThinkingLevel", compact: ["thinking high"], expanded: ["thinking high"] },
  { field: "showInputTokens", compact: ["tokens in 100"], expanded: ["tokens in 100"] },
  { field: "showOutputTokens", compact: ["out 200"], expanded: ["out 200"] },
  { field: "showReasoningTokens", compact: ["reasoning 50"], expanded: ["reasoning 50"] },
  { field: "showCacheReadTokens", compact: ["cache read 300"], expanded: ["cache read 300"] },
  { field: "showCacheWriteTokens", compact: ["cache write 400"], expanded: ["cache write 400"] },
  { field: "showTotalTokens", compact: ["1,234 tok"], expanded: ["total 1,234"] },
  { field: "showCallCost", compact: ["est $0.018"], expanded: ["est cost $0.018"] },
  { field: "showResponseId", compact: ["debug · response id resp-1"], expanded: ["debug · response id resp-1"] },
  {
    field: "showDiagnostics",
    compact: [
      "debug · diagnostics 2",
      "debug · rate_limit · Timeout · code ETIMEDOUT",
      "debug · retry · HTTPError · code 429",
    ],
    expanded: [
      "debug · diagnostics 2",
      "debug · rate_limit · Timeout · code ETIMEDOUT",
      "debug · retry · HTTPError · code 429",
    ],
  },
] as const;

test("single-field formatter cases cover every metadata flag", () => {
  assert.deepEqual(
    SINGLE_FLAG_CASES.map(({ field }) => field),
    METADATA_BOOLEAN_FIELDS,
  );
});

test.each(SINGLE_FLAG_CASES)(
  "$field renders alone in either layout without enabling other fields",
  ({ field, compact, expanded }) => {
    const metadata = captureAssistantMetadata(COMPLETE_MESSAGE, DEBUG_SETTINGS);
    assert.ok(metadata);
    for (const metadataLayout of ["compact", "expanded"] as const) {
      const settings: StampMetadataSettings = { ...METADATA_PRESETS.none, metadataLayout, [field]: true };
      for (const expandedTranscript of [false, true]) {
        const expansionOnly = field === "showResponseId" || field === "showDiagnostics";
        const expected = expansionOnly && !expandedTranscript ? [] : metadataLayout === "compact" ? compact : expanded;
        assert.deepEqual(
          formatAssistantMetadataLines(metadata, settings, expandedTranscript, "high"),
          expected,
          `${metadataLayout}, transcript expanded=${expandedTranscript}`,
        );
      }
    }
  },
);

test.each([
  {
    responseModel: "actual-model",
    requested: true,
    response: true,
    compact: ["requested-model → actual-model"],
    expanded: ["requested requested-model · response actual-model"],
  },
  {
    responseModel: "actual-model",
    requested: true,
    response: false,
    compact: ["requested-model"],
    expanded: ["requested requested-model"],
  },
  {
    responseModel: "actual-model",
    requested: false,
    response: true,
    compact: ["actual-model"],
    expanded: ["response actual-model"],
  },
  { responseModel: "actual-model", requested: false, response: false, compact: [], expanded: [] },
  {
    responseModel: "requested-model",
    requested: true,
    response: true,
    compact: ["requested-model"],
    expanded: ["requested requested-model · response requested-model"],
  },
  {
    responseModel: "requested-model",
    requested: true,
    response: false,
    compact: ["requested-model"],
    expanded: ["requested requested-model"],
  },
  {
    responseModel: "requested-model",
    requested: false,
    response: true,
    compact: ["requested-model"],
    expanded: ["response requested-model"],
  },
  { responseModel: "requested-model", requested: false, response: false, compact: [], expanded: [] },
  {
    responseModel: undefined,
    requested: true,
    response: true,
    compact: ["requested-model"],
    expanded: ["requested requested-model"],
  },
  {
    responseModel: undefined,
    requested: true,
    response: false,
    compact: ["requested-model"],
    expanded: ["requested requested-model"],
  },
  { responseModel: undefined, requested: false, response: true, compact: [], expanded: [] },
  { responseModel: undefined, requested: false, response: false, compact: [], expanded: [] },
])(
  "model selection handles response=$responseModel, requested=$requested, response=$response",
  ({ responseModel, requested, response, compact, expanded }) => {
    const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, responseModel });
    assert.ok(metadata);
    for (const metadataLayout of ["compact", "expanded"] as const) {
      const settings = {
        ...METADATA_PRESETS.none,
        metadataLayout,
        showRequestedModel: requested,
        showResponseModel: response,
      };
      for (const expandedTranscript of [false, true]) {
        assert.deepEqual(
          formatAssistantMetadataLines(metadata, settings, expandedTranscript),
          metadataLayout === "compact" ? compact : expanded,
        );
      }
    }
  },
);

test("all stop reasons obey the configured policy independently of layout and transcript expansion", () => {
  for (const metadataLayout of ["compact", "expanded"] as const) {
    for (const expandedTranscript of [false, true]) {
      for (const stopReason of ["hidden", "abnormal", "all"] as const) {
        for (const outcome of ["stop", "toolUse", "length", "error", "aborted"] as const) {
          const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, stopReason: outcome });
          assert.ok(metadata);
          const visible =
            stopReason === "all" || (stopReason === "abnormal" && ["length", "error", "aborted"].includes(outcome));
          assert.deepEqual(
            formatAssistantMetadataLines(
              metadata,
              { ...METADATA_PRESETS.none, metadataLayout, stopReason },
              expandedTranscript,
            ),
            visible ? [`stop ${outcome}`] : [],
            JSON.stringify({ metadataLayout, expandedTranscript, stopReason, outcome }),
          );
        }
      }
    }
  }
});

test("Thinking is independent of model and token flags and remains hidden when disabled", () => {
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE);
  assert.ok(metadata);
  for (const metadataLayout of ["compact", "expanded"] as const) {
    for (const expandedTranscript of [false, true]) {
      const settings = { ...METADATA_PRESETS.none, metadataLayout, showPiThinkingLevel: true };
      assert.deepEqual(formatAssistantMetadataLines(metadata, settings, expandedTranscript, "high"), ["thinking high"]);
      assert.deepEqual(formatAssistantMetadataLines(metadata, settings, expandedTranscript), []);
      assert.deepEqual(
        formatAssistantMetadataLines(
          metadata,
          {
            ...settings,
            showPiThinkingLevel: false,
            showCallCost: true,
          },
          expandedTranscript,
          "high",
        ),
        [metadataLayout === "compact" ? "est $0.018" : "est cost $0.018"],
      );
    }
  }
});

const TOKEN_FLAG_CASES = [
  { field: "showInputTokens", usage: "input", label: "tokens in 0" },
  { field: "showOutputTokens", usage: "output", label: "out 0" },
  { field: "showReasoningTokens", usage: "reasoning", label: "reasoning 0" },
  { field: "showCacheReadTokens", usage: "cacheRead", label: "cache read 0" },
  { field: "showCacheWriteTokens", usage: "cacheWrite", label: "cache write 0" },
  { field: "showTotalTokens", usage: "totalTokens", label: "total 0" },
] as const;

test.each(TOKEN_FLAG_CASES)("$field preserves zero and does not invent missing counts", ({ field, usage, label }) => {
  for (const metadataLayout of ["compact", "expanded"] as const) {
    const settings: StampMetadataSettings = { ...METADATA_PRESETS.none, metadataLayout, [field]: true };
    for (const amount of [0, undefined]) {
      const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, usage: { [usage]: amount } });
      assert.ok(metadata);
      const expected = field === "showTotalTokens" && metadataLayout === "compact" ? "0 tok" : label;
      assert.deepEqual(formatAssistantMetadataLines(metadata, settings, true), amount === undefined ? [] : [expected]);
    }
  }
});

test("all-zero usage stays visible and missing usage does not create an empty expanded row", () => {
  const zero = captureAssistantMetadata({
    ...COMPLETE_MESSAGE,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  });
  assert.ok(zero);
  assert.deepEqual(formatAssistantMetadataLines(zero, METADATA_PRESETS.detailed, false), [
    "api anthropic-messages · provider anthropic · requested requested-model · response actual-model · stop toolUse",
    "tokens in 0 · out 0 · reasoning 0 · cache read 0 · cache write 0 · total 0 · est cost $0",
  ]);
  for (const usage of [undefined, {}]) {
    const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, usage });
    assert.ok(metadata);
    assert.deepEqual(formatAssistantMetadataLines(metadata, METADATA_PRESETS.detailed, true), [
      "api anthropic-messages · provider anthropic · requested requested-model · response actual-model · stop toolUse",
    ]);
  }
});

test("call cost can render without any model, provenance, token, or Thinking fields", () => {
  for (const metadataLayout of ["compact", "expanded"] as const) {
    for (const [cost, formatted] of [
      [0, "$0"],
      [0.00001, "<$0.0001"],
      [0.018, "$0.018"],
      [1.2, "$1.2"],
      [undefined, undefined],
    ] as const) {
      const metadata = captureAssistantMetadata({ ...COMPLETE_MESSAGE, usage: { cost: { total: cost } } });
      assert.ok(metadata);
      const settings = { ...METADATA_PRESETS.none, metadataLayout, showCallCost: true };
      assert.deepEqual(
        formatAssistantMetadataLines(metadata, settings, true, "high"),
        formatted === undefined ? [] : [`${metadataLayout === "compact" ? "est" : "est cost"} ${formatted}`],
      );
    }
  }
});

test("cost since user retains its final-call row independently of granular call-cost visibility", () => {
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE);
  assert.ok(metadata);
  const cost = { estimatedCost: 0.009, costSinceUser: 0.039 };
  for (const metadataLayout of ["compact", "expanded"] as const) {
    const hidden = { ...METADATA_PRESETS.none, metadataLayout };
    assert.deepEqual(formatAssistantMetadataLines(metadata, hidden, true, "high", cost), [
      "est $0.009 · since user $0.039",
    ]);
    assert.deepEqual(
      formatAssistantMetadataLines(metadata, { ...hidden, showProvider: true }, false, "high", cost),
      metadataLayout === "compact"
        ? ["provider anthropic · est $0.009 · since user $0.039"]
        : ["provider anthropic", "est cost $0.009 · since user $0.039"],
    );
  }
});

test("disabled fields stay hidden for old debug-bearing snapshots, even in an expanded transcript", () => {
  const metadata = captureAssistantMetadata(COMPLETE_MESSAGE, DEBUG_SETTINGS);
  assert.ok(metadata);
  const snapshot = JSON.stringify(metadata);
  for (const metadataLayout of ["compact", "expanded"] as const) {
    for (const expandedTranscript of [false, true]) {
      assert.deepEqual(
        formatAssistantMetadataLines(
          metadata,
          { ...METADATA_PRESETS.none, metadataLayout },
          expandedTranscript,
          "high",
        ),
        [],
      );
      assert.deepEqual(
        formatAssistantMetadataLines(
          metadata,
          { ...METADATA_PRESETS.none, metadataLayout, showProvider: true },
          expandedTranscript,
          "high",
        ),
        ["provider anthropic"],
      );
      const lines = formatAssistantMetadataLines(
        metadata,
        { ...METADATA_PRESETS.detailed, metadataLayout },
        expandedTranscript,
        "high",
      );
      assert.ok(lines.every((line) => line.length > 0));
      assert.doesNotMatch(lines.join("\n"), /debug|resp-1|rate_limit|HTTPError|ETIMEDOUT/u);
    }
  }
  assert.equal(JSON.stringify(metadata), snapshot);
});

test("capture preserves the baseline snapshot for each enabled metadata field", () => {
  const baseline = captureAssistantMetadata(COMPLETE_MESSAGE);
  assert.ok(baseline);
  assert.equal(Object.hasOwn(baseline, "responseId"), false);
  assert.equal(Object.hasOwn(baseline, "diagnosticCount"), false);
  assert.equal(Object.hasOwn(baseline, "diagnostics"), false);
  for (const field of METADATA_BOOLEAN_FIELDS) {
    const metadata = captureAssistantMetadata(COMPLETE_MESSAGE, { ...METADATA_PRESETS.none, [field]: true });
    assert.deepEqual(
      metadata,
      {
        ...baseline,
        ...(field === "showResponseId" ? { responseId: "resp-1" } : {}),
        ...(field === "showDiagnostics"
          ? {
              diagnosticCount: 2,
              diagnostics: [
                { type: "rate_limit", errorName: "Timeout", errorCode: "ETIMEDOUT" },
                { type: "retry", errorName: "HTTPError", errorCode: "429" },
              ],
            }
          : {}),
      },
      field,
    );
  }
  for (const stopReason of ["abnormal", "all"] as const) {
    assert.deepEqual(captureAssistantMetadata(COMPLETE_MESSAGE, { ...METADATA_PRESETS.none, stopReason }), baseline);
  }
  assert.deepEqual(captureAssistantMetadata(COMPLETE_MESSAGE, METADATA_PRESETS.compact), baseline);
});

test("all-hidden capture does not read message data and layout alone does not opt in", () => {
  const unreadable = new Proxy(COMPLETE_MESSAGE, {
    get: (_target, key) => assert.fail(`Unexpected read of ${String(key)}`),
  });
  for (const metadataLayout of ["compact", "expanded"] as const) {
    assert.equal(captureAssistantMetadata(unreadable, { ...METADATA_PRESETS.none, metadataLayout }), undefined);
  }
});

test.each([
  { showResponseId: false, showDiagnostics: false },
  { showResponseId: true, showDiagnostics: false },
  { showResponseId: false, showDiagnostics: true },
  { showResponseId: true, showDiagnostics: true },
])("capture reads debug data only for its own enabled flag: %j", ({ showResponseId, showDiagnostics }) => {
  let responseIdReads = 0;
  let diagnosticsReads = 0;
  const metadata = captureAssistantMetadata(
    {
      ...COMPLETE_MESSAGE,
      get responseId() {
        if (!showResponseId) assert.fail("Disabled response ID must not be read");
        responseIdReads += 1;
        return COMPLETE_MESSAGE.responseId;
      },
      get diagnostics() {
        if (!showDiagnostics) assert.fail("Disabled diagnostics must not be read");
        diagnosticsReads += 1;
        return COMPLETE_MESSAGE.diagnostics;
      },
    },
    { ...METADATA_PRESETS.detailed, showResponseId, showDiagnostics },
  );
  assert.ok(metadata);
  assert.equal(responseIdReads > 0, showResponseId);
  assert.equal(diagnosticsReads > 0, showDiagnostics);
  assert.equal(Object.hasOwn(metadata, "responseId"), showResponseId);
  assert.equal(Object.hasOwn(metadata, "diagnosticCount"), showDiagnostics);
  assert.equal(Object.hasOwn(metadata, "diagnostics"), showDiagnostics);
  if (showResponseId) assert.equal(metadata.responseId, "resp-1");
  if (showDiagnostics) assert.equal(metadata.diagnosticCount, 2);
});

test("tool stamp formatting labels only valid reported duration and outcome", () => {
  assert.equal(formatToolStampLabel("read", 1_250, "success"), "tool read · 1.3s · success");
  assert.equal(formatToolStampLabel("bash\u001b[31m", 1, "error"), "tool bash [31m · <0.1s · error");
  assert.equal(formatToolStampLabel("", 100, "success"), undefined);
  assert.equal(formatToolStampLabel("read", -1, "success"), undefined);
  assert.equal(formatToolStampLabel("read", 100, "cancelled" as never), undefined);
});
