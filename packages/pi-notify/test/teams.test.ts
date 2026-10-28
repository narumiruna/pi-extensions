import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination, Notification, TeamsDestination } from "../src/provider.js";
import { createTeamsProvider } from "../src/providers/teams.js";

// Synthetic structural fixture, NOT a credential or verified live workflow URL.
// Current path migration examples (including /direct/cu/20/workflows/...):
// https://learn.microsoft.com/en-us/power-automate/triggers-troubleshoot
// Signed Request URL examples corroborate query names, not a full Teams grammar:
// https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-http-endpoint
// Public endpoint/202 reports are corroboration only, not normative contracts:
// https://dev.classmethod.jp/en/articles/aws-step-functions-teams-workflows-new-webhook-url/
// https://simonscholz.dev/tutorials/microsoft-teams-messages-webhook-workflow/
const host = "tenant.example.environment.api.powerplatform.com";
const path = "/powerautomate/automations/direct/workflows/workflow-123/triggers/manual/paths/invoke";
const query = "api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=synthetic-signature_123";
const url = `https://${host}${path}?${query}`;
const destination: TeamsDestination = { provider: "teams", label: "Team workflow", webhookUrl: url };
const note: Notification = {
  id: "private-notification-id",
  title: "Pi needs review",
  body: "Session: <literal> 😀\nPath: /private/project",
  bodyEmphasis: [{ style: "bold", offset: 0, length: 7 }],
  settledAt: 123,
};
const signal = () => new AbortController().signal;
const response = (body: string | null = null, status = 202) => new Response(body, { status });
const validateUrl = (webhookUrl: unknown) => createTeamsProvider().validate({ ...destination, webhookUrl });
const withQuery = (value: string) => `https://${host}${path}?${value}`;
const withPath = (value: string) => `https://${host}${value}?${query}`;
const payload = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) =>
  JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body));
const payloadText = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): string =>
  payload(fetcher, index).attachments[0].content.body[0].inlines[0].text;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Teams destination validation", () => {
  it("returns owned fields only and preserves the complete signed URL", () => {
    const provider = createTeamsProvider();
    expect(provider.id).toBe("teams");
    expect(provider.label).toBe("Microsoft Teams");
    expect(provider.validate({ ...destination, extra: "storage-owned" })).toEqual(destination);
  });
  it.each([null, undefined, [], {}, 1, "teams", { ...destination, provider: "slack" }])(
    "rejects invalid object %j",
    (value) => expect(createTeamsProvider().validate(value)).toBeUndefined(),
  );
  it.each([null, undefined, 1, [], "", " ", "a".repeat(129)])("rejects invalid label %j", (label) => {
    expect(createTeamsProvider().validate({ ...destination, label })).toBeUndefined();
  });
  it("accepts the shared 128-character label boundary without changing it", () => {
    const label = ` ${"a".repeat(126)} `;
    expect(createTeamsProvider().validate({ ...destination, label })).toEqual({ ...destination, label });
  });
  it.each([undefined, null, 1, [], ""])("rejects non-URL values %j", (value) => {
    expect(validateUrl(value)).toBeUndefined();
  });
  it.each([
    "a.environment.api.powerplatform.com",
    "0.environment.api.powerplatform.com",
    "a-b.c0.environment.api.powerplatform.com",
    `${"a".repeat(63)}.environment.api.powerplatform.com`,
    host,
    `${host}:443`,
  ])("accepts local commercial DNS form %s", (authority) => {
    const webhookUrl = `https://${authority}${path}?${query}`;
    expect(validateUrl(webhookUrl)).toEqual({ ...destination, webhookUrl });
  });
  it.each([
    "environment.api.powerplatform.com",
    ".environment.api.powerplatform.com",
    "evilenvironment.api.powerplatform.com",
    "a.environment.api.powerplatform.com.evil.test",
    "a.environment.api.powerplatform.com.",
    "a..environment.api.powerplatform.com",
    "-a.environment.api.powerplatform.com",
    "a-.environment.api.powerplatform.com",
    "a_b.environment.api.powerplatform.com",
    "A.environment.api.powerplatform.com",
    "a.environment.api.Powerplatform.com",
    `${"a".repeat(64)}.environment.api.powerplatform.com`,
    "a.environment.api.powerplatform.cn",
    "a.environment.api.powerplatform.us",
    "example.webhook.office.com",
    "example.logic.azure.com",
    "localhost",
    "127.0.0.1",
    "[::1]",
    "tenant%2eexample.environment.api.powerplatform.com",
    "%74enant.environment.api.powerplatform.com",
    "ténant.environment.api.powerplatform.com",
    `user@${host}`,
    `user:password@${host}`,
    `@${host}`,
    `${host}:80`,
    `${host}:444`,
    `${host}:0443`,
    `${host}:+443`,
    `${host}:443:443`,
    `${host}:`,
  ])("rejects unsupported or noncanonical authority %s", (authority) => {
    expect(validateUrl(`https://${authority}${path}?${query}`)).toBeUndefined();
  });
  it.each(["http://", "HTTPS://", "https:/", "https:////", "//", "ftp://"])(
    "rejects nonliteral HTTPS scheme %s",
    (scheme) => expect(validateUrl(`${scheme}${host}${path}?${query}`)).toBeUndefined(),
  );
  it.each([" ", "\t", "\r", "\n", "\u0000", "\u001b", "\u007f", "\u0085", "\u00a0", "\\"])(
    "rejects unsafe literal input %j in every URL part",
    (unsafe) => {
      for (const webhookUrl of [
        `${unsafe}${url}`,
        `${url}${unsafe}`,
        url.replace("tenant", `ten${unsafe}ant`),
        url.replace("workflows", `work${unsafe}flows`),
        url.replace("synthetic", `syn${unsafe}thetic`),
      ])
        expect(validateUrl(webhookUrl)).toBeUndefined();
    },
  );
  it.each(["#", "#fragment", "#sig=other"])("rejects fragment %s", (fragment) => {
    expect(validateUrl(`${url}${fragment}`)).toBeUndefined();
  });
  it.each(["workflow-123", "A", "0", "opaque_workflow-ID_123", "0123456789abcdef0123456789abcdef", "a".repeat(256)])(
    "accepts locally bounded opaque workflow ID %s",
    (id) => {
      expect(validateUrl(withPath(path.replace("workflow-123", id)))).toBeDefined();
    },
  );
  it.each(["20", "A", "route-ID_0", "a".repeat(256)])("accepts the scale-unit route form %s", (route) => {
    expect(validateUrl(withPath(path.replace("direct/", `direct/cu/${route}/`)))).toBeDefined();
  });
  it.each(["", ".", "..", "a.b", "a/b", "%61", "%2e", "%2E%2e", "%2f", "日", "a".repeat(257)])(
    "rejects unsupported workflow/route identifier %s",
    (id) => {
      expect(validateUrl(withPath(path.replace("workflow-123", id)))).toBeUndefined();
      expect(validateUrl(withPath(path.replace("direct/", `direct/cu/${id}/`)))).toBeUndefined();
    },
  );
  it.each([
    path.toUpperCase(),
    path.replace("powerautomate", "%70owerautomate"),
    path.replace("/direct/", "/direct/./"),
    path.replace("/direct/", "/direct/a/../"),
    path.replace("/direct/", "/direct/%2e/"),
    path.replace("/direct/", "/direct/%2e%2e/"),
    path.replace("/direct/", "/direct//"),
    path.replace("/direct/", "/direct/cu/"),
    path.replace("manual", "automatic"),
    path.replace("/paths", ""),
    path.replace("/powerautomate/automations", ""),
    `${path}/`,
    `${path}/extra`,
    path.replace("invoke", "invoke;other"),
    path.replace("workflows", "workflows%3fignored"),
  ])("rejects path normalization or unsupported path %s", (value) => {
    expect(validateUrl(withPath(value))).toBeUndefined();
  });
  it("enforces the complete DNS hostname boundary separately from the URL cap", () => {
    const prefix = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.`;
    const suffix = ".environment.api.powerplatform.com";
    const boundary = `${prefix}${"d".repeat(253 - prefix.length - suffix.length)}${suffix}`;
    expect(boundary.length).toBe(253);
    expect(validateUrl(`https://${boundary}${path}?${query}`)).toBeDefined();
    expect(validateUrl(`https://d${boundary}${path}?${query}`)).toBeUndefined();
  });
  it("accepts all 24 query-key orders without rebuilding the raw URL", () => {
    const pairs = query.split("&");
    const orders = pairs.flatMap((a) =>
      pairs
        .filter((b) => b !== a)
        .flatMap((b) =>
          pairs
            .filter((c) => c !== a && c !== b)
            .map((c) => [a, b, c, pairs.find((d) => d !== a && d !== b && d !== c)].join("&")),
        ),
    );
    expect(new Set(orders).size).toBe(24);
    for (const order of orders) {
      const webhookUrl = withQuery(order);
      expect(validateUrl(webhookUrl)).toEqual({ ...destination, webhookUrl });
    }
  });
  it.each([
    "api-version=1&sp=/triggers/manual/run&sv=1.0&sig=a",
    "api-version=1&sp=/triggers/manual/run&sv=1.0&sig=a=",
    "api-version=1&sp=/triggers/manual/run&sv=1.0&sig=a%3D",
    "sig=a+Z/0==&sv=1.0&sp=%2ftriggers%2fmanual%2frun&api-version=1",
    "sp=%2Ftriggers/manual%2Frun&sig=a%2BZ%2F0%3D%3d&api-version=1&sv=1.0",
    "sv=1.0&sig=URL_safe-0_&api-version=1&sp=%2Ftriggers%2Fmanual%2Frun",
    "sv=1.0&sig=%61&api-version=1&sp=/%74riggers/manual/run",
  ])("preserves accepted query order and opaque signature bytes: %s", (value) => {
    const webhookUrl = withQuery(value);
    expect(validateUrl(webhookUrl)).toEqual({ ...destination, webhookUrl });
  });
  it.each([
    "",
    query.replace("api-version=1&", ""),
    query.replace("sp=%2Ftriggers%2Fmanual%2Frun&", ""),
    query.replace("sv=1.0&", ""),
    query.replace("&sig=synthetic-signature_123", ""),
    query.replace("api-version=1", "api-version=2"),
    query.replace("api-version=1", "api-version=%31"),
    query.replace("sv=1.0", "sv=1"),
    query.replace("sv=1.0", "sv=%31.0"),
    query.replace("sp=%2Ftriggers%2Fmanual%2Frun", "sp=/triggers/manual/run/"),
    query.replace("sp=%2Ftriggers%2Fmanual%2Frun", "sp=/triggers/other/run"),
    query.replace("sp=%2Ftriggers%2Fmanual%2Frun", "sp=%252Ftriggers%252Fmanual%252Frun"),
    query.replace("sig=synthetic-signature_123", "sig="),
    query.replace("sig=synthetic-signature_123", "sig"),
    `${query}&unknown=value`,
    `${query}&`,
    `${query};extra=other`,
    query.replace("&sv", "&&sv"),
    query.replace("sig=", "SIG="),
    query.replace("sig=", "%73ig="),
    query.replace("api-version=", "api%2Dversion="),
    query.replace("sp=", "%73p="),
    query.replace("sv=", "%73v="),
    query.replace("sig=synthetic-signature_123", "sig=="),
    query.replace("sig=synthetic-signature_123", "sig=a==="),
    query.replace("sig=synthetic-signature_123", "sig=a=b"),
  ])("rejects missing, unknown, ambiguous or noncanonical query %s", (value) => {
    expect(validateUrl(withQuery(value))).toBeUndefined();
  });
  it.each(["api-version=1", "sp=%2Ftriggers%2Fmanual%2Frun", "sv=1.0", "sig=a", "%73ig=a"])(
    "rejects duplicate keys and encoded aliases %s",
    (pair) => expect(validateUrl(withQuery(`${query}&${pair}`))).toBeUndefined(),
  );
  it.each([
    "%",
    "%0",
    "%GG",
    "%C3%28",
    "%FF",
    "%ED%A0%80",
    "%00",
    "%09",
    "%0a",
    "%0D",
    "%1b",
    "%7f",
    "%C2%85",
    "%20",
    "%5c",
    "%23",
    "%26",
    "%3f",
    "%3b",
    "%252F",
    "日",
    "!",
    ":",
    "a.b",
    "a~b",
    "=a",
    "a=b",
  ])("rejects malformed or unsafe signature %s", (sig) => {
    for (const value of [sig, `a${sig}`, `${sig}a`]) {
      expect(validateUrl(withQuery(query.replace("synthetic-signature_123", value)))).toBeUndefined();
    }
  });
  it.each(["%", "%0", "%GG", "%C3%28", "%FF", "%00", "%5c"])("rejects malformed/unsafe sp %s", (sp) => {
    expect(validateUrl(withQuery(query.replace("%2Ftriggers%2Fmanual%2Frun", sp)))).toBeUndefined();
  });
  it.each([8191, 8192, 8193])("enforces the local entire-URL length boundary %s", (length) => {
    const webhookUrl = url.replace("synthetic-signature_123", "a".repeat(length - url.length + 23));
    expect(webhookUrl.length).toBe(length);
    expect(validateUrl(webhookUrl) !== undefined).toBe(length <= 8192);
  });
});

describe("Teams payload", () => {
  it("posts one fixed literal-text Adaptive Card without Authorization or target overrides", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    expect(await createTeamsProvider(fetcher).send(destination, note, signal())).toEqual({ state: "accepted" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(url);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: { "content-type": "application/json" },
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
    expect(payload(fetcher)).toEqual({
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          contentUrl: null,
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.2",
            body: [{ type: "RichTextBlock", inlines: [{ type: "TextRun", text: `${note.title}\n${note.body}` }] }],
          },
        },
      ],
    });
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toMatch(
      /bodyEmphasis|settledAt|private-notification-id|synthetic-signature|workflow-123/,
    );
  });
  it("does not normalize signed bytes at fetch time", async () => {
    const webhookUrl = `https://${host}:443${path}?sig=a%2BZ%2f0%3d%3D&sv=1.0&sp=%2ftriggers/manual/run&api-version=1`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    await createTeamsProvider(fetcher).send({ ...destination, webhookUrl }, note, signal());
    expect(fetcher.mock.calls[0]?.[0]).toBe(webhookUrl);
  });
  it("keeps hostile mentions, links and markup literal without structured entities or actions", async () => {
    const text = '@everyone @all <at>Team</at> <@123> **bold** [label](https://example.test) <tag> & "quote" `code` $';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    await createTeamsProvider(fetcher).send(destination, { ...note, title: text, body: text }, signal());
    expect(payloadText(fetcher)).toBe(`${text}\n${text}`);
    const content = payload(fetcher).attachments[0].content;
    expect(Object.keys(content).sort()).toEqual(["$schema", "body", "type", "version"]);
    expect(content.body[0].inlines).toEqual([{ type: "TextRun", text: `${text}\n${text}` }]);
  });
  it("sanitizes linewise before counting escaped JSON and does not mutate raw metadata", async () => {
    const title = "\u001b[31mPi\u001b[0m\u0007\u0000";
    const body = "Session: \u001b]8;;https://evil.test\u0007name\u001b]8;;\u0007\nPath:\t/private\u202e/dir\u009b31m";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    await createTeamsProvider(fetcher).send(destination, { ...note, title, body }, signal());
    expect(payloadText(fetcher)).toBe("Pi\nSession: name\nPath: /private/dir");
    expect(title).toContain("\u001b");
    expect(body).toContain("\u202e");
  });
  it.each(["a", "日", "😀", "e\u0301", "👨‍👩‍👧‍👦", '"', "\\", "\n"])(
    "bounds the entire encoded envelope, including escapes and ellipsis, for %j",
    async (point) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
      const body = point.repeat(30_000);
      await createTeamsProvider(fetcher).send(destination, { ...note, title: "Title", body }, signal());
      const encoded = String(fetcher.mock.calls[0]?.[1]?.body);
      const text = payloadText(fetcher);
      expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(24_000);
      expect(text.startsWith("Title\n")).toBe(true);
      expect(text.endsWith("…")).toBe(true);
      expect(Array.from(text).every((character) => character.length === 2 || !/[\uD800-\uDFFF]/u.test(character))).toBe(
        true,
      );
      expect(`Title\n${body}`.startsWith(text.slice(0, -1))).toBe(true);
      // Another complete source point cannot fit beside the ellipsis.
      const next = Array.from(`Title\n${body}`.slice(text.length - 1))[0] ?? "";
      expect(Buffer.byteLength(encoded, "utf8") + Buffer.byteLength(JSON.stringify(next), "utf8") - 2).toBeGreaterThan(
        24_000,
      );
    },
  );
  it("keeps exact 24,000-byte payloads and includes the ellipsis within a clipped budget", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const provider = createTeamsProvider(fetcher);
    await provider.send(destination, { ...note, title: "T", body: "" }, signal());
    const overhead = Buffer.byteLength(String(fetcher.mock.calls[0]?.[1]?.body), "utf8");
    const budget = 24_000 - overhead;
    for (const length of [budget - 1, budget, budget + 1]) {
      await provider.send(destination, { ...note, title: "T", body: "a".repeat(length) }, signal());
    }
    expect(Buffer.byteLength(String(fetcher.mock.calls[1]?.[1]?.body))).toBe(23_999);
    expect(Buffer.byteLength(String(fetcher.mock.calls[2]?.[1]?.body))).toBe(24_000);
    expect(payloadText(fetcher, 2)).toBe(`T\n${"a".repeat(budget)}`);
    expect(Buffer.byteLength(String(fetcher.mock.calls[3]?.[1]?.body))).toBe(24_000);
    expect(payloadText(fetcher, 3)).toBe(`T\n${"a".repeat(budget - 3)}…`);
  });
  it.each(['"', "\\", "日", "😀", "\n"])("counts exact escaped/Unicode byte boundaries for %j", async (point) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const provider = createTeamsProvider(fetcher);
    await provider.send(destination, { ...note, title: "T", body: "" }, signal());
    const budget = 24_000 - Buffer.byteLength(String(fetcher.mock.calls[0]?.[1]?.body));
    const cost = Buffer.byteLength(JSON.stringify(point)) - 2;
    const body = point.repeat(Math.floor(budget / cost)) + "a".repeat(budget % cost);
    await provider.send(destination, { ...note, title: "T", body }, signal());
    await provider.send(destination, { ...note, title: "T", body: `${body}z` }, signal());
    expect(payloadText(fetcher, 1)).toBe(`T\n${body}`);
    expect(Buffer.byteLength(String(fetcher.mock.calls[1]?.[1]?.body))).toBe(24_000);
    expect(payloadText(fetcher, 2).endsWith("…")).toBe(true);
    expect(Buffer.byteLength(String(fetcher.mock.calls[2]?.[1]?.body))).toBeLessThanOrEqual(24_000);
  });
  it("keeps a boundary emoji whole and removes it whole to make room for an ellipsis", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const provider = createTeamsProvider(fetcher);
    await provider.send(destination, { ...note, title: "T", body: "" }, signal());
    const budget = 24_000 - Buffer.byteLength(String(fetcher.mock.calls[0]?.[1]?.body));
    const body = `${"a".repeat(budget - 4)}😀`;
    await provider.send(destination, { ...note, title: "T", body }, signal());
    await provider.send(destination, { ...note, title: "T", body: `${body}z` }, signal());
    expect(payloadText(fetcher, 1)).toBe(`T\n${body}`);
    expect(payloadText(fetcher, 2)).toBe(`T\n${"a".repeat(budget - 4)}…`);
    expect(Buffer.byteLength(String(fetcher.mock.calls[2]?.[1]?.body))).toBe(23_999);
  });
  it("does not repeatedly serialize huge payloads while clipping", async () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    await createTeamsProvider(fetcher).send(destination, { ...note, title: "T", body: "😀".repeat(500_000) }, signal());
    expect(Buffer.byteLength(String(fetcher.mock.calls[0]?.[1]?.body))).toBeLessThanOrEqual(24_000);
    expect(stringify.mock.calls.filter(([value]) => typeof value === "object")).toHaveLength(1);
    expect(stringify.mock.calls.length).toBeLessThan(24_001);
  });
});

describe("Teams local acceptance and shared transport", () => {
  it.each([
    null,
    "",
    "Accepted",
    "{",
    "{}",
    "[]",
    "null",
    "123",
    '{"error":"synthetic-secret"}',
    '{"status":"failed"}',
  ])("accepts bounded HTTP 202 body %j without interpreting undocumented fields", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body));
    expect(await createTeamsProvider(fetcher).send(destination, note, signal())).toEqual({ state: "accepted" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(Array.from({ length: 100 }, (_, index) => 200 + index).filter((status) => status !== 202))(
    "rejects every other 2xx status %s",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(status === 204 || status === 205 ? null : "ok", status));
      expect(await createTeamsProvider(fetcher).send(destination, note, signal())).toEqual({
        state: "failed",
        code: "response",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it.each([301, 302, 307, 308, 400, 401, 403, 404, 409, 413, 500, 503])(
    "returns safe HTTP failure for %s and cancels unread bodies",
    async (status) => {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const stream = new ReadableStream({ cancel });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status }));
      expect(await createTeamsProvider(fetcher).send(destination, note, signal())).toEqual({
        state: "failed",
        code: "http",
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );
  it.each([
    [undefined, undefined],
    ["12", 12],
    ["0008", 8],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ["0", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["+1", undefined],
    ["1e2", undefined],
    ["99999999999999999999", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
    [url, undefined],
  ])("returns only safe positive 429 Retry-After seconds: %s", async (retry, seconds) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(url, {
        status: 429,
        headers: retry === undefined ? {} : { "retry-after": retry },
      }),
    );
    expect(await createTeamsProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("revalidates direct callers and prioritizes pre-abort without fetching or starting timers", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createTeamsProvider(fetcher);
    const invalid = { ...destination, webhookUrl: "https://example.test" };
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(invalid, note, controller.signal)).toEqual({ state: "cancelled", code: "cancelled" });
    for (const value of [
      invalid,
      { ...destination, label: "" },
      { ...destination, provider: "webhook" } as unknown as Destination,
    ]) {
      expect(await provider.send(value, note, signal())).toEqual({ state: "failed", code: "invalid-destination" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([65_536, 65_537])("requires the complete bounded response read at %s bytes", async (length) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(length));
        if (length === 65_536) controller.close();
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 202 }));
    expect(await createTeamsProvider(fetcher).send(destination, note, signal())).toEqual(
      length === 65_536 ? { state: "accepted" } : { state: "failed", code: "response" },
    );
    if (length > 65_536) expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
  it("counts response bytes across chunks, not characters, and releases the reader", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("😀".repeat(8192)));
        controller.enqueue(new TextEncoder().encode("😀".repeat(8192)));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 202 }));
    expect(await createTeamsProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "response",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
  it.each(["cancel", "timeout"])(
    "interrupts stalled injected fetch after %s and cancels late responses",
    async (kind) => {
      let respond!: (value: Response) => void;
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );
      const sending = createTeamsProvider(fetcher).send(destination, note, controller.signal);
      const combined = fetcher.mock.calls[0]?.[1]?.signal;
      if (kind === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(10_000);
      expect(await sending).toEqual(
        kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
      );
      expect(combined?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const stream = new ReadableStream({ cancel });
      respond(new Response(stream, { status: 202 }));
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );
  it.each(["cancel", "timeout"])("does not accept 202 before a stalled body read completes after %s", async (kind) => {
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream(
      {
        pull() {
          ready();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 202 }));
    const sending = createTeamsProvider(fetcher).send(destination, note, controller.signal);
    await reading;
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10_000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("uses one total deadline across fetch and body, and removes its owned listener", async () => {
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    let respond!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const sending = createTeamsProvider(fetcher).send(destination, note, signal());
    await vi.advanceTimersByTimeAsync(9000);
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    respond(
      new Response(
        new ReadableStream(
          {
            pull() {
              ready();
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 202 },
      ),
    );
    await reading;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sending).toEqual({ state: "failed", code: "timeout" });
    const combined = fetcher.mock.calls[0]?.[1]?.signal;
    const index = add.mock.contexts.indexOf(combined);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(remove.mock.calls).toContainEqual(["abort", add.mock.calls[index]?.[1]]);
    expect(remove.mock.contexts).toContain(combined);
  });
  it.each(["success", "http", "fetch-error", "body-error", "cap", "cancel"])(
    "cleans timers and listeners after %s",
    async (kind) => {
      const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
      const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>();
      if (kind === "fetch-error") fetcher.mockRejectedValue(new Error(url));
      else if (kind === "cancel") fetcher.mockImplementation(() => new Promise(() => {}));
      else if (kind === "body-error")
        fetcher.mockResolvedValue(
          new Response(
            new ReadableStream({
              start(source) {
                source.error(new Error(url));
              },
            }),
            { status: 202 },
          ),
        );
      else fetcher.mockResolvedValue(response(kind === "cap" ? "a".repeat(65_537) : null, kind === "http" ? 500 : 202));
      const sending = createTeamsProvider(fetcher).send(destination, note, controller.signal);
      if (kind === "cancel") controller.abort();
      const result = await sending;
      expect(JSON.stringify(result)).not.toContain(url);
      const combined = fetcher.mock.calls[0]?.[1]?.signal;
      const index = add.mock.contexts.indexOf(combined);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(remove.mock.calls).toContainEqual(["abort", add.mock.calls[index]?.[1]]);
      expect(remove.mock.contexts).toContain(combined);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["fetch", "read"])("returns only safe codes for credential-bearing %s failures", async (stage) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error(url));
      },
    });
    const fetcher = vi.fn<typeof fetch>();
    if (stage === "fetch") fetcher.mockRejectedValue(new Error(url));
    else fetcher.mockResolvedValue(new Response(stream, { status: 202 }));
    expect(await createTeamsProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "network",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
