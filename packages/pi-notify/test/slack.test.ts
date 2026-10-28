import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver, type Notification, type SlackDestination, validateDestination } from "../src/provider.js";
import { createGotifyProvider } from "../src/providers/gotify.js";
import { createSlackProvider, validateSlackWebhookUrl } from "../src/providers/slack.js";
import { createTelegramProvider } from "../src/providers/telegram.js";
import { providers } from "../src/providers.js";

// Deliberately synthetic: never send these credentials to Slack.
const destination: SlackDestination = {
  provider: "slack",
  label: "Team Slack",
  webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/SyntheticSecret123",
};
const note: Notification = {
  id: "not-in-payload",
  title: "Pi is ready for review",
  body: "Session: <b>literal</b> _text_ 😀\nWorkspace: /日本/branch",
  bodyEmphasis: [{ style: "bold", offset: 0, length: 7 }],
  settledAt: 0,
};
const signal = () => new AbortController().signal;
const failure = { state: "failed", code: "response" };
// Slack decodes only these three entities once in text objects, including plain_text.
const displayedText = (text: string) =>
  text.replace(/&(amp|lt|gt);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity] ?? entity);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Slack validation", () => {
  it.each([
    destination.webhookUrl,
    "https://hooks.slack.com/services/T123ABC/B456DEF/aBc123",
    `https://hooks.slack.com/services/T1/B2/${"a".repeat(2009)}`,
  ])("preserves supported URL literals: %s", (webhookUrl) => {
    const provider = createSlackProvider();
    const value = { ...destination, webhookUrl };
    expect(validateSlackWebhookUrl(webhookUrl)).toBe(true);
    expect(provider.validate(value)).toEqual(value);
    expect(provider.validate(provider.validate(value))).toEqual(value);
  });
  it.each([
    undefined,
    null,
    42,
    {},
    "",
    "/services/T1/B2/secret",
    "//hooks.slack.com/services/T1/B2/secret",
    "http://hooks.slack.com/services/T1/B2/secret",
    "HTTPS://hooks.slack.com/services/T1/B2/secret",
    "https://HOOKS.SLACK.COM/services/T1/B2/secret",
    "https:hooks.slack.com/services/T1/B2/secret",
    "https:///hooks.slack.com/services/T1/B2/secret",
    "https:////hooks.slack.com/services/T1/B2/secret",
    "https://hooks.slack-gov.com/services/T1/B2/secret",
    "https://hooks.slack.com.evil.example/services/T1/B2/secret",
    "https://evil.example/hooks.slack.com/services/T1/B2/secret",
    "https://hooks.slack.com./services/T1/B2/secret",
    "https://hooks%2eslack.com/services/T1/B2/secret",
    "https://hooks。slack.com/services/T1/B2/secret",
    "https://hоoks.slack.com/services/T1/B2/secret",
    "https://hooks.slack.com:443/services/T1/B2/secret",
    "https://hooks.slack.com:/services/T1/B2/secret",
    "https://user:password@hooks.slack.com/services/T1/B2/secret",
    "https://@hooks.slack.com/services/T1/B2/secret",
    "https://hooks.slack.com@evil.example/services/T1/B2/secret",
    "https://hooks.slack.com\\services/T1/B2/secret",
    "https://hooks.slack.com//services/T1/B2/secret",
    "https://hooks.slack.com/services/./T1/B2/secret",
    "https://hooks.slack.com/other/../services/T1/B2/secret",
    "https://hooks.slack.com/services/%541/B2/secret",
    "https://hooks.slack.com/services/T1/B2/sec%72et",
    "https://hooks.slack.com/services/T1/B2/sec%2fret",
    "https://hooks.slack.com/services/T1/B2/secret/",
    "https://hooks.slack.com/services/T1/B2/secret/extra",
    "https://hooks.slack.com/services/T/B/secret",
    "https://hooks.slack.com/services/t1/B2/secret",
    "https://hooks.slack.com/services/T1/C2/secret",
    "https://hooks.slack.com/services/T1/B2/",
    "https://hooks.slack.com/services/T1/B2/日本",
    "https://hooks.slack.com/services/T1/B2/secret?",
    "https://hooks.slack.com/services/T1/B2/secret?token=secret",
    "https://hooks.slack.com/services/T1/B2/secret#",
    "https://hooks.slack.com/services/T1/B2/secret#secret",
    ` ${destination.webhookUrl}`,
    `${destination.webhookUrl} `,
    `${destination.webhookUrl}\n`,
    `${destination.webhookUrl}\r\n`,
    `${destination.webhookUrl}\u2028`,
    destination.webhookUrl.replace("slack", "sla\nck"),
    `${destination.webhookUrl}\0`,
    `${destination.webhookUrl}\u001b`,
    `${destination.webhookUrl}\u200b`,
    `https://hooks.slack.com/services/T1/B2/${"a".repeat(2010)}`,
  ])("rejects unsupported and normalization-bypass URL %j", (webhookUrl) => {
    expect(validateSlackWebhookUrl(webhookUrl)).toBe(false);
    expect(createSlackProvider().validate({ ...destination, webhookUrl })).toBeUndefined();
  });
  it.each([
    null,
    [],
    {},
    { ...destination, provider: "telegram" },
    { ...destination, label: "" },
    { ...destination, label: " " },
    { ...destination, label: "a".repeat(129) },
    { ...destination, label: 42 },
  ])("rejects invalid destination %j", (value) => {
    expect(createSlackProvider().validate(value)).toBeUndefined();
  });
  it("registers Slack without changing other providers and returns only owned fields", () => {
    expect([...providers.keys()]).toEqual([
      "telegram",
      "gotify",
      "slack",
      "ntfy",
      "pushover",
      "discord",
      "bark",
      "webhook",
      "line",
      "teams",
    ]);
    expect(providers.get("slack")?.label).toBe("Slack");
    expect(validateDestination({ ...destination, future: true, channel: "not-an-override" }, providers)).toEqual(
      destination,
    );
    expect(validateDestination({ ...destination, provider: "unknown" }, providers)).toBeUndefined();
  });
});

describe("Slack payload", () => {
  it("posts only metadata as bounded plain_text with a non-dynamic safe fallback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const provider = createSlackProvider(fetcher);
    expect(await deliver(new Map([[provider.id, provider]]), destination, note, signal())).toEqual({
      state: "accepted",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(destination.webhookUrl);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "content-type": "application/json" } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Pi notification. Open Pi to review.",
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: `${note.title}\nSession: &lt;b&gt;literal&lt;/b&gt; _text_ 😀\nWorkspace: /日本/branch`,
            emoji: false,
          },
        },
      ],
    });
    expect(String(init?.body)).not.toContain(destination.webhookUrl);
    expect(String(init?.body)).not.toContain(destination.label);
    expect(String(init?.body)).not.toContain(note.id);
  });
  it.each([
    "<!here> <!channel> <!everyone> <@U123> <!subteam^S123|@staff> <#C123|general>",
    "@here @channel @everyone #general *bold* _italic_ ~strike~ `code` ```block``` :fire:",
    "<https://evil.example/?token=secret|click> https://evil.example/ &lt;!here&gt; &amp;lt;@U123&amp;gt;",
    'path/日本/😀/é/👩‍💻/مرحبا \\ " }],"type":"mrkdwn","text":"<!everyone>',
  ])("keeps hostile metadata only in plain_text: %s", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const hostile = { ...note, title: body, body };
    expect(await createSlackProvider(fetcher).send(destination, hostile, signal())).toEqual({ state: "accepted" });
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload.blocks).toEqual([
      { type: "section", text: { type: "plain_text", text: expect.any(String), emoji: false } },
    ]);
    expect(displayedText(payload.blocks[0].text.text)).toBe(`${body}\n${body}`);
    expect(payload.blocks[0].text.text).not.toMatch(/[<>]|&(?!amp;|lt;|gt;)/);
    expect(payload.text).toBe("Pi notification. Open Pi to review.");
    expect(payload.mrkdwn).toBe(false);
    expect(payload.parse).toBe("none");
    expect(payload).not.toHaveProperty("link_names");
    expect(payload).not.toHaveProperty("channel");
    expect(payload).not.toHaveProperty("thread_ts");
  });
  it("removes terminal sequences, controls, and bidi controls while keeping line breaks", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const body =
      "\u001b[31mred\u001b[0m\n\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\0\u007f\u202eevil\u2069";
    await createSlackProvider(fetcher).send(destination, { ...note, title: "\u009b31mTitle\u009b0m", body }, signal());
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload.blocks[0].text.text).toBe("Title\nred\nlinkevil");
  });
  it.each(["😀".repeat(3000), `${"a".repeat(2997)}😀tail`, "&<>".repeat(2000)])(
    "bounds text without splitting Unicode code points",
    async (body) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
      await createSlackProvider(fetcher).send(destination, { ...note, title: "", body }, signal());
      const text = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).blocks[0].text.text as string;
      expect(text.length).toBeLessThanOrEqual(3000);
      expect(text.endsWith("…")).toBe(true);
      expect(text).not.toMatch(/[\ud800-\udfff]/u);
    },
  );
  it.each([
    ["/tmp/&lt;repo&gt; &amp;", "/tmp/&amp;lt;repo&amp;gt; &amp;amp;"],
    ["<!here> & <@U123>", "&lt;!here&gt; &amp; &lt;@U123&gt;"],
  ])("encodes entity-like metadata once for literal display: %s", async (body, encoded) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const notification = { ...note, title: "Title", body };
    await createSlackProvider(fetcher).send(destination, notification, signal());
    const text = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).blocks[0].text.text as string;
    expect(text).toBe(`Title\n${encoded}`);
    expect(displayedText(text)).toBe(`Title\n${body}`);
    expect(notification.body).toBe(body);
  });
  it.each([
    [`${"a".repeat(2998)}&`, `\n${"a".repeat(2998)}…`],
    [`${"a".repeat(2995)}<z`, `\n${"a".repeat(2995)}…`],
    [`${"a".repeat(2996)}😀xy`, `\n${"a".repeat(2996)}😀…`],
    [`${"a".repeat(2995)}<`, `\n${"a".repeat(2995)}&lt;`],
    ["a".repeat(2999), `\n${"a".repeat(2999)}`],
  ])("bounds encoded text without partial entities or code points", async (body, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    await createSlackProvider(fetcher).send(destination, { ...note, title: "", body }, signal());
    const text = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).blocks[0].text.text as string;
    expect(text).toBe(expected);
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;)|[\ud800-\udfff]/u);
  });
  it("keeps an empty sanitized notification valid", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    await createSlackProvider(fetcher).send(destination, { ...note, title: "\0", body: "" }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).blocks[0].text.text).toBe("Pi notification");
  });
});

describe("Slack response contract", () => {
  it.each([
    ["ok", 200, { state: "accepted" }],
    ["ok\n", 200, failure],
    [" ok", 200, failure],
    ["ok ", 200, failure],
    ["OK", 200, failure],
    ["", 200, failure],
    ["\ufeffok", 200, failure],
    ['"ok"', 200, failure],
    ['{"ok":true}', 200, failure],
    ["invalid_payload", 200, failure],
    ["unknown_error", 200, failure],
    [destination.webhookUrl, 200, failure],
    ["ok", 201, { state: "failed", code: "http" }],
    ["ok", 202, { state: "failed", code: "http" }],
    [null, 204, { state: "failed", code: "http" }],
    ...[300, 301, 302, 303, 307, 308, 400, 401, 403, 404, 410, 500, 503].map(
      (status) => [destination.webhookUrl, status, { state: "failed", code: "http" }] as const,
    ),
    ["secret", 429, { state: "failed", code: "rate-limit" }],
  ] as const)("normalizes %j / HTTP %s without exposing response data", async (body, status, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    expect(await createSlackProvider(fetcher).send(destination, note, signal())).toEqual(expected);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    ["8", 8],
    ["1", 1],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ["0", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["1e2", undefined],
    ["+8", undefined],
    ["NaN", undefined],
    ["Infinity", undefined],
    ["9999999999999999999", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
    [destination.webhookUrl, undefined],
  ])("exposes only safe positive integer Retry-After seconds: %s", async (retry, expected) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret", { status: 429, headers: { "retry-after": String(retry) } }));
    expect(await createSlackProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      ...(expected === undefined ? {} : { retryAfterSeconds: expected }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not expose Retry-After on other failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret", { status: 503, headers: { "retry-after": "8" } }));
    expect(await createSlackProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "http",
    });
  });
  it("accepts success split across byte chunks", async () => {
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array(0));
        stream.enqueue(Uint8Array.of(111));
        stream.enqueue(Uint8Array.of(107));
        stream.close();
      },
    });
    expect(
      await createSlackProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
        destination,
        note,
        signal(),
      ),
    ).toEqual({ state: "accepted" });
    expect(body.locked).toBe(false);
  });
  it.each([null, new Uint8Array([111, 107, 0xff]), "x".repeat(65_536)])(
    "rejects absent, invalid, or unknown bodies",
    async (body) => {
      expect(
        await createSlackProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
          destination,
          note,
          signal(),
        ),
      ).toEqual(failure);
    },
  );
  it("bounds streamed responses and cancels and unlocks oversized bodies", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array(65_537));
      },
      cancel,
    });
    expect(
      await createSlackProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
        destination,
        note,
        signal(),
      ),
    ).toEqual(failure);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("cancels error bodies without reading them", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    expect(
      await createSlackProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 400 }))).send(
        destination,
        note,
        signal(),
      ),
    ).toEqual({ state: "failed", code: "http" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

describe("Slack cancellation and resource safety", () => {
  it("does not request pre-cancelled or invalid destinations or fall back to another provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createSlackProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(await provider.send({ ...destination, webhookUrl: "invalid" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(await deliver(providers, { ...destination, webhookUrl: "invalid" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(await createTelegramProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(await createGotifyProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["cancel", "timeout"])(
    "interrupts a pending request on %s with one attempt and no timer leak",
    async (kind) => {
      vi.useFakeTimers();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error(destination.webhookUrl)), { once: true });
          }),
      );
      const controller = new AbortController();
      const sending = createSlackProvider(fetcher).send(destination, note, controller.signal);
      if (kind === "cancel") controller.abort();
      else {
        await vi.advanceTimersByTimeAsync(9999);
        expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await sending).toEqual(
        kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
      );
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["cancel", "timeout"])(
    "interrupts a stalled detached body on %s, removes listeners and releases its reader",
    async (kind) => {
      vi.useFakeTimers();
      let ready!: () => void;
      const reading = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const cancel = vi.fn();
      const body = new ReadableStream(
        {
          pull() {
            ready();
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      let remove: ReturnType<typeof vi.spyOn> | undefined;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        if (init?.signal) remove = vi.spyOn(init.signal, "removeEventListener");
        return new Response(body);
      });
      const controller = new AbortController();
      const sending = createSlackProvider(fetcher).send(destination, note, controller.signal);
      await reading;
      if (kind === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(10_000);
      expect(await sending).toEqual(
        kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("rejects a late success and cancels its body after cancellation", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return new Response(body);
    });
    expect(await createSlackProvider(fetcher).send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("does not accept success when cancelled during the final body read", async () => {
    const controller = new AbortController();
    const body = new ReadableStream(
      {
        pull(stream) {
          stream.enqueue(new TextEncoder().encode("ok"));
          stream.close();
          controller.abort();
        },
      },
      { highWaterMark: 0 },
    );
    expect(
      await createSlackProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
        destination,
        note,
        controller.signal,
      ),
    ).toEqual({ state: "cancelled", code: "cancelled" });
    expect(body.locked).toBe(false);
  });
  it.each([200, 400])("does not wait for stalled underlying cancellation (HTTP %s)", async (status) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array(65_537));
      },
      cancel,
    });
    expect(
      await createSlackProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }))).send(
        destination,
        note,
        signal(),
      ),
    ).toEqual(status === 200 ? failure : { state: "failed", code: "http" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("redacts stream exceptions and cleans up timers and locks", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream(
      {
        pull(stream) {
          stream.error(new Error(destination.webhookUrl));
        },
      },
      { highWaterMark: 0 },
    );
    expect(
      await createSlackProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
        destination,
        note,
        signal(),
      ),
    ).toEqual({ state: "failed", code: "network" });
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses the built-in fetch default and redacts transport exceptions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(destination.webhookUrl));
    vi.stubGlobal("fetch", fetcher);
    expect(await createSlackProvider().send(destination, note, signal())).toEqual({ state: "failed", code: "network" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("refuses real HTTP redirects without forwarding the payload", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      req.resume();
      res.writeHead(302, { location: "/leaked" });
      res.end(destination.webhookUrl);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Keep production URL validation intact; only replace the network target in this harness.
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => fetch(`${base}/hook`, init));
    try {
      expect(await createSlackProvider(fetcher).send(destination, note, signal())).toEqual({
        state: "failed",
        code: "network",
      });
      expect(paths).toEqual(["/hook"]);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
