import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification, WebhookDestination } from "../src/provider.js";
import { createWebhookProvider } from "../src/providers/webhook.js";

const destination: WebhookDestination = {
  provider: "webhook",
  label: "Private endpoint",
  webhookUrl: "https://receiver.example/secret-endpoint/",
};
const note: Notification = {
  id: "metadata-id",
  title: "Pi needs review 😀",
  body: "Session: <literal> 日本",
  bodyEmphasis: [{ style: "bold", offset: 0, length: 7 }],
  settledAt: 1792281600123,
};
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("Generic webhook validation", () => {
  it("returns an owned undefined token for clearing and excludes unknown fields", () => {
    const provider = createWebhookProvider();
    const valid = provider.validate({ ...destination, headers: { secret: "unsupported" }, template: "unsupported" });
    expect(valid).toEqual({ ...destination, bearerToken: undefined });
    expect(Object.hasOwn(valid ?? {}, "bearerToken")).toBe(true);
    expect(provider.validate(valid)).toEqual(valid);
    expect(provider.validate({ ...destination, bearerToken: undefined })).toEqual(valid);
  });
  it.each(["a", "a".repeat(512), "!#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"])(
    "accepts safe optional Bearer tokens",
    (bearerToken) => {
      expect(createWebhookProvider().validate({ ...destination, bearerToken })).toMatchObject({ bearerToken });
    },
  );
  it.each([null, 1, "", "a".repeat(513), "has space", " secret", "secret\r\nheader", "\u0000", "\u007f", "日本"])(
    "rejects unsafe Bearer token %j",
    (bearerToken) => expect(createWebhookProvider().validate({ ...destination, bearerToken })).toBeUndefined(),
  );
  it.each([
    ["https://host", "https://host/"],
    ["https://HOST:443/path", "https://host/path"],
    ["https://host/path/", "https://host/path/"],
    ["https://host/path///", "https://host/path///"],
    ["http://localhost:8080/proxy/hook/", "http://localhost:8080/proxy/hook/"],
    ["http://192.168.1.2:8080/", "http://192.168.1.2:8080/"],
    ["http://[::1]:8080/", "http://[::1]:8080/"],
    ["https://例え.jp/日本/", "https://xn--r8jz45g.jp/%E6%97%A5%E6%9C%AC/"],
  ])("normalizes exact endpoint %s without removing trailing slashes", (webhookUrl, normalized) => {
    const provider = createWebhookProvider();
    const valid = provider.validate({ ...destination, webhookUrl });
    expect(valid).toMatchObject({ webhookUrl: normalized });
    expect(provider.validate(valid)).toEqual(valid);
  });
  it("applies the 2048-character limit to the complete normalized endpoint", () => {
    const prefix = "https://host/";
    const exact = `${prefix}${"a".repeat(2048 - prefix.length)}`;
    const provider = createWebhookProvider();
    expect(provider.validate({ ...destination, webhookUrl: exact })).toMatchObject({ webhookUrl: exact });
    expect(provider.validate({ ...destination, webhookUrl: `${exact}/` })).toBeUndefined();
    // Raw Unicode fits, but percent encoding and the retained slash make the endpoint too long.
    const expanded = `https://h/${"日".repeat(226)}aaaa/`;
    expect(new URL(expanded).href.length).toBe(2049);
    expect(provider.validate({ ...destination, webhookUrl: expanded })).toBeUndefined();
  });
  it.each([
    undefined,
    null,
    1,
    "",
    "/relative",
    "//host",
    "https:host",
    "https:/host",
    "https:///host",
    "ftp://host",
    "file:///tmp",
    "https://user:secret@host",
    "https://secret@host",
    "https://@host",
    "https://:secret@host",
    "https://host?token=secret",
    "https://host?",
    "https://host#",
    "https://host#fragment",
    " https://host",
    "https://ho\nst",
    "https://host/with space",
    "https://host\\path",
    "https://host/\u001b",
    "https://host/%00",
    "https://host/%0a",
    "https://host/%5cpath",
    "https://host/%broken",
    `https://host/${"a".repeat(2048)}`,
  ])("rejects unsafe endpoint %j", (webhookUrl) => {
    expect(createWebhookProvider().validate({ ...destination, webhookUrl })).toBeUndefined();
  });
  it.each([
    null,
    [],
    {},
    { ...destination, provider: "bark" },
    { ...destination, label: undefined },
    { ...destination, label: " " },
    { ...destination, label: "a".repeat(129) },
  ])("rejects invalid destination %j", (value) => expect(createWebhookProvider().validate(value)).toBeUndefined());
});

describe("Generic webhook delivery", () => {
  it.each([undefined, "secret-bearer-token"])(
    "posts the exact fixed payload with optional Bearer auth %j",
    async (bearerToken) => {
      vi.useFakeTimers();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      expect(await createWebhookProvider(fetcher).send({ ...destination, bearerToken }, note, signal())).toEqual({
        state: "accepted",
      });
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        destination.webhookUrl,
        expect.objectContaining({
          method: "POST",
          redirect: "error",
          signal: expect.any(AbortSignal),
          headers: {
            "content-type": "application/json",
            ...(bearerToken === undefined ? {} : { Authorization: `Bearer ${bearerToken}` }),
          },
        }),
      );
      const raw = String(fetcher.mock.calls[0]?.[1]?.body);
      const payload = JSON.parse(raw);
      expect(payload).toEqual({ id: note.id, title: note.title, body: note.body, settledAt: note.settledAt });
      expect(Object.keys(payload)).toEqual(["id", "title", "body", "settledAt"]);
      expect(raw).not.toContain(destination.webhookUrl);
      expect(raw).not.toContain("secret-bearer-token");
      expect(raw).not.toContain("bodyEmphasis");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("preserves Unicode metadata and epoch milliseconds without provider-specific text limits", async () => {
    const notification = { ...note, title: "😀日本".repeat(1000), body: '😀日本\n"\\'.repeat(2000) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON"));
    expect(await createWebhookProvider(fetcher).send(destination, notification, signal())).toEqual({
      state: "accepted",
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      settledAt: 1792281600123,
    });
  });
  it.each([
    [200, "not JSON"],
    [200, ""],
    [201, '{"success":false}'],
    [202, "queued"],
    [204, null],
    [205, null],
    [206, "partial"],
    [299, "accepted"],
  ])("accepts HTTP %s even with empty or non-JSON content", async (status, body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    expect(await createWebhookProvider(fetcher).send(destination, note, signal())).toEqual({ state: "accepted" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([301, 302, 307, 400, 401, 403, 404, 500])("returns a safe HTTP failure for %s", async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(`${destination.webhookUrl}/secret-token`, { status }));
    expect(await createWebhookProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "http",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    ["12", 12],
    ["0", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["secret-token", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
  ])("returns only validated rate-limit diagnostics %s without retrying", async (retryAfter, expected) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret", { status: 429, headers: { "retry-after": String(retryAfter) } }));
    expect(await createWebhookProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      ...(expected === undefined ? {} : { retryAfterSeconds: expected }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([65536, 65537])("bounds non-JSON response bytes at %s", async (length) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const bytes = new TextEncoder().encode("x".repeat(length));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        if (length === 65536) controller.close();
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await createWebhookProvider(fetcher).send(destination, note, signal())).toEqual(
      length === 65536 ? { state: "accepted" } : { state: "failed", code: "response" },
    );
    if (length > 65536) expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("skips invalid or pre-cancelled calls and redacts network and stream errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${destination.webhookUrl}/secret-token`));
    const provider = createWebhookProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(await provider.send({ ...destination, bearerToken: "bad\nheader" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await provider.send(destination, note, signal())).toEqual({ state: "failed", code: "network" });
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("secret-token"));
      },
    });
    expect(
      await createWebhookProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
        destination,
        note,
        signal(),
      ),
    ).toEqual({ state: "failed", code: "network" });
    expect(body.locked).toBe(false);
  });
  it.each(["cancel", "timeout"])("interrupts an uncooperative fetch on %s", async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sending = createWebhookProvider(vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))).send(
      destination,
      note,
      controller.signal,
    );
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["cancel", "timeout"])("releases a stalled body even when cancellation stalls: %s", async (kind) => {
    vi.useFakeTimers();
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream(
      {
        pull() {
          ready();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const sending = createWebhookProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
      destination,
      note,
      controller.signal,
    );
    await reading;
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses private HTTP endpoints with their exact trailing slash and refuses redirects", async () => {
    const requests: { url: string | undefined; auth: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ url: req.url, auth: req.headers.authorization, body });
        res.writeHead(req.url === "/redirect/" ? 307 : 204, req.url === "/redirect/" ? { location: "/leaked" } : {});
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const provider = createWebhookProvider();
      const authenticated = { ...destination, bearerToken: "secret-bearer-token" };
      expect(await provider.send({ ...authenticated, webhookUrl: `${base}/proxy/hook/` }, note, signal())).toEqual({
        state: "accepted",
      });
      expect(await provider.send({ ...authenticated, webhookUrl: `${base}/redirect/` }, note, signal())).toEqual({
        state: "failed",
        code: "network",
      });
      expect(requests.map((request) => request.url)).toEqual(["/proxy/hook/", "/redirect/"]);
      expect(requests[0]?.auth).toBe("Bearer secret-bearer-token");
      expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
        id: note.id,
        title: note.title,
        body: note.body,
        settledAt: note.settledAt,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
