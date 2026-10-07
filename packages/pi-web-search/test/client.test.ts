import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { displayText, resultText, search } from "../src/client.js";
import { DEFAULTS } from "../src/settings.js";

const settings = { ...DEFAULTS, accountId: "a".repeat(32), apiToken: "TOP_SECRET" };
const signal = () => new AbortController().signal;
const response = (data: unknown) => new Response(JSON.stringify(data));
const fixture = {
  items: [{ url: "https://example.com/", title: "Example", description: "Current information" }],
  metadata: { requestId: "r1", latencyMs: 42 },
};
afterEach(() => vi.useRealTimers());

test("posts the exact Cloudflare contract, preserves order, omits unset alias and returns metadata", async () => {
  let url: unknown;
  let options: RequestInit | undefined;
  const request: typeof fetch = async (input, init) => {
    url = input;
    options = init;
    return response(fixture);
  };
  const result = await search(settings, "current news", 5, signal(), request);
  assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/ai/websearch/`);
  assert.equal(options?.method, "POST");
  assert.equal(options?.redirect, "error");
  assert.deepEqual(options?.headers, { Authorization: "Bearer TOP_SECRET", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(String(options?.body)), {
    query: "current news",
    provider: "ceramic",
    limit: 5,
    options: { gateway: { id: "default" } },
  });
  assert.deepEqual(result, {
    ...fixture,
    provider: "ceramic",
    metadata: { ...fixture.metadata, query: "current news" },
    truncated: false,
  });
});

test("explicit BYOK aliases are passed without retry or fallback on HTTP failure", async () => {
  let calls = 0;
  const request: typeof fetch = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(String(options?.body)).byokAlias, "private_key");
    return new Response("TOP_SECRET", { status: 400 });
  };
  await assert.rejects(search({ ...settings, byokAlias: "private_key" }, "query", 1, signal(), request), /HTTP 400/);
  assert.equal(calls, 1);
});

test.each(["", " ", "a".repeat(1025), "😀".repeat(1025), `${"a".repeat(1024)}😀`])(
  "invalid queries fail before the network",
  async (query) => {
    const request = vi.fn();
    await assert.rejects(search(settings, query, 1, signal(), request));
    assert.equal(request.mock.calls.length, 0);
  },
);

test.each(["😀".repeat(600), "😀".repeat(1024), `${"漢".repeat(512)}${"😀".repeat(512)}`])(
  "Unicode code-point queries up to 1024 dispatch unchanged",
  async (query) => {
    let sent: unknown;
    await search(settings, query, 1, signal(), async (_url, options) => {
      sent = JSON.parse(String(options?.body)).query;
      return response({ items: [], metadata: {} });
    });
    assert.equal(sent, query);
  },
);

test.each([0, 11, 1.5])("invalid limits fail before network: %s", async (limit) => {
  const request = vi.fn();
  await assert.rejects(search(settings, "query", limit, signal(), request));
  assert.equal(request.mock.calls.length, 0);
});

test("missing credentials, abort before dispatch and remote transport errors are safe", async () => {
  const request = vi.fn(async () => {
    throw new Error("TOP_SECRET");
  });
  await assert.rejects(search({ ...DEFAULTS }, "query", 1, signal(), request), /Configure/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(search(settings, "query", 1, aborted.signal, request), /cancelled/);
  assert.equal(request.mock.calls.length, 0);
  await assert.rejects(
    search(settings, "query", 1, signal(), request),
    (error: Error) => !error.message.includes("TOP_SECRET"),
  );
});

test.each([
  {},
  { items: [], metadata: null },
  { items: [{ url: "javascript:alert(1)" }], metadata: {} },
  { items: [{ url: "https://example.com", title: 1 }], metadata: {} },
  { items: [], metadata: { latencyMs: -1 } },
  { items: [], metadata: { requestId: 123 } },
])("malformed response fields fail observably: %j", async (data) => {
  await assert.rejects(
    search(settings, "query", 1, signal(), async () => response(data)),
    /Invalid Cloudflare/,
  );
});

test("malformed JSON, invalid UTF-8 and oversized bodies are rejected with redacted errors", async () => {
  for (const body of ["TOP_SECRET", new Uint8Array([0xff]), "x".repeat(1024 * 1024 + 1)]) {
    await assert.rejects(
      search(settings, "query", 1, signal(), async () => new Response(body)),
      (error: Error) => !error.message.includes("TOP_SECRET"),
    );
  }
});

test("empty results and optional fields remain valid", async () => {
  const result = await search(settings, "query", 1, signal(), async () => response({ items: [], metadata: {} }));
  assert.deepEqual(result.items, []);
  assert.match(resultText(result), /No results/);
});

test("structured and text output stay bounded and terminal sanitization does not change raw fields", async () => {
  const description = "\x1b[31m漢\n\t\x00".repeat(1000);
  const items = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: "a".repeat(1000),
    description,
  }));
  const result = await search(settings, "query", 10, signal(), async () => response({ items, metadata: {} }));
  assert.equal(result.items.length, 10);
  assert.ok(result.items[0].description?.startsWith("\x1b[31m"));
  assert.ok(result.truncated);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50 * 1024);
  const text = resultText(result);
  assert.ok(Buffer.byteLength(text) <= 50 * 1024);
  assert.ok(text.split("\n").length <= 2000);
  for (const control of ["\x00", "\x1b", "\x7f"]) assert.ok(!text.includes(control));
  assert.equal(displayText("\x1b]52;c;secret\x07safe"), "safe");
});

test.each([
  "\u061c",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
])("display removes Unicode directional formatting control %j", (control) => {
  assert.equal(displayText(`safe${control}text`), "safe text");
});

test("display keeps legitimate Unicode joining while raw search fields retain directional controls", async () => {
  const joined = "فارسی\u200c👩\u200d💻";
  assert.equal(displayText(joined), joined);
  const raw = "safe\u202e\u2066text";
  let sent: unknown;
  const result = await search(settings, raw, 1, signal(), async (_url, options) => {
    sent = JSON.parse(String(options?.body)).query;
    return response({ items: [{ url: `https://example.com/${raw}`, title: raw, description: raw }], metadata: {} });
  });
  assert.equal(sent, raw);
  assert.equal(result.metadata.query, raw);
  assert.equal(result.items[0].title, raw);
  assert.equal(result.items[0].description, raw);
  assert.equal(result.items[0].url, `https://example.com/${raw}`);
  assert.doesNotMatch(resultText(result), /\p{Bidi_Control}/u);
});

test("titleless long results render every URL once without silently losing the final item", async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.com/${"x".repeat(1980)}/${i}`,
    description: "d".repeat(1980),
  }));
  const result = await search(settings, "query", 10, signal(), async () => response({ items, metadata: {} }));
  assert.equal(result.truncated, false);
  const before = structuredClone(result);
  const text = resultText(result);
  assert.ok(Buffer.byteLength(text) <= 50 * 1024);
  for (const item of items) assert.equal(text.split(item.url).length - 1, 1);
  assert.deepEqual(result, before);
});

test.each(["bytes", "lines"])("rendered truncation reports %s limits within the reserved budget", (reason) => {
  const result = {
    provider: "ceramic" as const,
    metadata: { query: "query" },
    truncated: false,
    items:
      reason === "bytes"
        ? [{ url: "https://example.com", description: "x".repeat(60000) }]
        : Array.from({ length: 1100 }, (_, i) => ({ url: `https://example.com/${i}` })),
  };
  const before = structuredClone(result);
  const text = resultText(result);
  assert.match(text, /truncat/i);
  assert.ok(Buffer.byteLength(text) <= 50 * 1024);
  assert.ok(text.split("\n").length <= 2000);
  assert.deepEqual(result, before);
});

test("credentials echoed by a successful provider response are redacted", async () => {
  const result = await search(settings, "query", 1, signal(), async () =>
    response({
      items: [{ url: "https://example.com/TOP_SECRET", title: "TOP_SECRET" }],
      metadata: { requestId: "TOP_SECRET" },
    }),
  );
  assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET/);
});

test("redaction expansion and worst-case escaping cannot exceed the structured result budget", async () => {
  const items = Array.from({ length: 10 }, () => ({
    url: `https://e.co/${"x".repeat(2020)}`,
    title: "漢".repeat(2000),
    description: "\u0001".repeat(8000),
  }));
  const result = await search({ ...settings, apiToken: "a" }, "a".repeat(1024), 10, signal(), async () =>
    response({ items, metadata: { requestId: "x".repeat(1000) } }),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50 * 1024);
  assert.ok(result.truncated);
  await assert.rejects(
    search({ ...settings, apiToken: "x" }, "query", 10, signal(), async () => response({ items, metadata: {} })),
    /URL after credential redaction/,
  );
});

test("transport errors cannot impersonate trusted diagnostics to disclose credentials", async () => {
  for (const prefix of ["Invalid Cloudflare", "Cloudflare Web Search"]) {
    await assert.rejects(
      search(settings, "query", 1, signal(), async () => {
        throw new Error(`${prefix}: TOP_SECRET`);
      }),
      (error: Error) => error.message === "Cloudflare Web Search request failed; check network access and settings.",
    );
  }
});

test.each(["timeout", "caller"])("in-flight cancellation releases the deadline: %s", async (reason) => {
  vi.useFakeTimers();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const request: typeof fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("TOP_SECRET")), { once: true });
      ready();
    });
  const caller = new AbortController();
  const pending = search(settings, "query", 1, caller.signal, request);
  const rejection = assert.rejects(pending, reason === "timeout" ? /timed out/ : /cancelled/);
  await started;
  if (reason === "caller") caller.abort();
  else vi.advanceTimersByTime(settings.timeoutMs);
  await rejection;
  assert.equal(vi.getTimerCount(), 0);
});
