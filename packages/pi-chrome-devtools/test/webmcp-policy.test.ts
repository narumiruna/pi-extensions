import assert from "node:assert/strict";
import { test } from "vitest";
import {
  boundedWebMcpDiscovery,
  boundedWebMcpJson,
  normalizeWebMcpInput,
  normalizeWebMcpOutput,
  normalizeWebMcpTool,
  requireMatchingWebMcpTool,
  sanitizeWebMcpDisplay,
  validateWebMcpInput,
  webMcpConfirmationMessage,
  webMcpIdentity,
} from "../src/webmcp/policy.js";

const context = {
  documentId: "loader-1",
  frameOrigin: "https://example.test",
  pageId: "page-1",
  pageUrl: "https://example.test/app",
  sessionGeneration: "4:2",
};

function descriptor(options: { annotations?: Record<string, boolean>; schema?: Record<string, unknown> } = {}) {
  return normalizeWebMcpTool(
    {
      annotations: options.annotations,
      description: "Read state",
      frameId: "frame-1",
      inputSchema: options.schema ?? {
        type: "object",
        properties: { second: { type: "number" }, first: { type: "string" } },
      },
      name: "read_state",
    },
    context,
  );
}

test("schema digests are deterministic and bind safety annotations", () => {
  const first = descriptor({ annotations: { consequential: false, readOnly: true } });
  const reordered = descriptor({
    annotations: { readOnly: true, consequential: false },
    schema: {
      properties: { first: { type: "string" }, second: { type: "number" } },
      type: "object",
    },
  });
  assert.equal(first.schemaDigest, reordered.schemaDigest);
  assert.deepEqual(Object.keys(first.inputSchema), ["properties", "type"]);
  assert.notEqual(
    first.schemaDigest,
    descriptor({ annotations: { readOnly: false, consequential: false } }).schemaDigest,
  );
});

test("rejects page-controlled regex schemas without confusing property names for keywords", () => {
  assert.throws(
    () =>
      descriptor({
        schema: {
          type: "object",
          properties: { value: { type: "string", pattern: "^(a+)+$" } },
        },
      }),
    /page-controlled regular expressions cannot be evaluated safely/u,
  );
  for (const schema of [
    {
      type: "array",
      items: [{ type: "string" }, { type: "string", pattern: "^(a+)+$" }],
    },
    {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { type: "string", pattern: "^(a+)+$" },
    },
  ]) {
    assert.throws(() => descriptor({ schema }), /page-controlled regular expressions cannot be evaluated safely/u);
  }
  assert.doesNotThrow(() =>
    descriptor({
      schema: {
        type: "object",
        properties: { pattern: { type: "string" } },
      },
    }),
  );
});

test("rejects combinatorial schemas before synchronous input validation", () => {
  const branches = Array.from({ length: 2_600 }, () => ({ $ref: "#/$defs/x" }));
  assert.throws(
    () =>
      descriptor({
        schema: {
          $defs: { x: { type: "array", items: { type: "number" } } },
          oneOf: branches,
        },
      }),
    /validation branch limit of 128/u,
  );
  for (const keyword of ["dependencies", "dependentSchemas"] as const) {
    const dependencies = Object.fromEntries(
      Array.from({ length: 129 }, (_value, index) => [`field_${index}`, { $ref: "#/$defs/x" }]),
    );
    assert.throws(
      () =>
        descriptor({
          schema: {
            $defs: { x: { type: "array", items: { type: "number" } } },
            [keyword]: dependencies,
          },
        }),
      /validation branch limit of 128/u,
    );
  }
  assert.doesNotThrow(() =>
    descriptor({
      schema: {
        dependencies: { value: ["other"] },
        oneOf: [
          { type: "object", properties: { value: { type: "string" } } },
          { type: "object", properties: { value: { type: "number" } } },
        ],
      },
    }),
  );
});

test("identity validation rejects stale session, page, origin, schema, and annotation state", () => {
  const tool = descriptor({ annotations: { readOnly: true } });
  assert.equal(requireMatchingWebMcpTool([tool], webMcpIdentity(tool)), tool);
  for (const [field, value] of [
    ["sessionGeneration", "5:0"],
    ["pageId", "other-page"],
    ["documentId", "loader-reloaded"],
    ["frameOrigin", "https://other.test"],
    ["schemaDigest", "0".repeat(64)],
  ] as const) {
    awaitStale(() => requireMatchingWebMcpTool([tool], { ...webMcpIdentity(tool), [field]: value }));
  }
  assert.throws(() => requireMatchingWebMcpTool([], webMcpIdentity(tool)), /no longer available/u);
  assert.throws(() => requireMatchingWebMcpTool([tool, tool], webMcpIdentity(tool)), /identity is ambiguous/u);
});

test("schema, input, and output limits reject oversized or pathological JSON before publication", () => {
  assert.throws(() => descriptor({ schema: { description: "x".repeat(70_000) } }), /input schema exceeds 64\.0KB/u);
  let deep: Record<string, unknown> = {};
  for (let depth = 0; depth < 40; depth += 1) deep = { nested: deep };
  assert.throws(() => normalizeWebMcpInput(deep), /depth limit/u);
  assert.throws(() => normalizeWebMcpInput({ value: Number.POSITIVE_INFINITY }), /non-finite number/u);
  assert.throws(
    () => validateWebMcpInput({ type: "object", required: ["query"], properties: { query: { type: "string" } } }, {}),
    /does not match.*schema/u,
  );
  assert.throws(() => normalizeWebMcpOutput({ content: "x".repeat(1024 * 1024 + 1) }), /tool output exceeds 1\.0MB/u);
});

test("terminal sanitization removes ANSI, OSC, C0/C1, and bidirectional controls", () => {
  const sanitized = sanitizeWebMcpDisplay(
    "safe\u001b[31m red\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\u0001\u0085\u202eend",
  );
  assert.equal(sanitized, "safe redlink���end");
  assert.equal(sanitizeWebMcpDisplay("12345", 4), "123…");
});

test("confirmation identifies the page, origin, tool, bounded input, and attached-profile risk", () => {
  const tool = descriptor();
  const attached = webMcpConfirmationMessage(tool, { token: "secret" }, false);
  assert.match(attached, /attached browser profile.*authenticated sessions/u);
  assert.match(attached, /Page: https:\/\/example\.test\/app/u);
  assert.match(attached, /Frame origin: https:\/\/example\.test/u);
  assert.match(attached, /Tool: read_state/u);
  assert.match(attached, /"token": "secret"/u);
  assert.match(attached, /annotations are untrusted/u);
  assert.match(webMcpConfirmationMessage(tool, {}, true), /isolated browser profile managed by Pi/u);
});

test("discovery truncation remains valid JSON and retains only published identities", () => {
  const tools = [0, 1].map((index) =>
    normalizeWebMcpTool(
      {
        description: `Tool ${index}`,
        frameId: "frame-1",
        inputSchema: { type: "object", description: "x".repeat(30_000) },
        name: `tool_${index}`,
      },
      context,
    ),
  );
  const bounded = boundedWebMcpDiscovery({ id: context.pageId, title: "Example", url: context.pageUrl }, tools);
  const parsed = JSON.parse(bounded.text) as {
    tools: unknown[];
    totalToolCount: number;
    truncated: boolean;
  };
  assert.equal(parsed.totalToolCount, 2);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.tools.length, 1);
  assert.equal(bounded.included.length, 1);
});

test("model-visible JSON remains within Pi byte and line limits", () => {
  const bounded = boundedWebMcpJson({
    items: Array.from({ length: 3_000 }, (_value, index) => `item-${index}`),
  });
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 50 * 1024);
  assert.ok(bounded.text.split("\n").length <= 2_000);
  assert.match(bounded.text, /WebMCP output truncated/u);
});

function awaitStale(callback: () => unknown) {
  assert.throws(callback, /became stale/u);
}
