import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGotifyProvider, normalizeGotifyUrl } from "../src/gotify.js";
import { deliver, type GotifyDestination, type Notification } from "../src/provider.js";
import { providers } from "../src/providers.js";
import { createTelegramProvider } from "../src/telegram.js";

const destination: GotifyDestination = {
  provider: "gotify",
  label: "Personal Gotify",
  serverUrl: "https://push.example.com/gotify/",
  appToken: "A-application-token",
};
const note: Notification = {
  id: "1",
  title: "Pi needs review",
  body: "Session: <b>literal</b> _text_ 😀",
  settledAt: 0,
};
const accepted = { id: 1, appid: 2, message: note.body, date: "2026-07-06T10:00:00Z" };
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("Gotify validation", () => {
  it.each([
    ["https://push.example.com/", "https://push.example.com"],
    ["https://push.example.com/gotify///", "https://push.example.com/gotify"],
    ["http://localhost:8080", "http://localhost:8080"],
    ["http://192.168.1.2:8080/base/", "http://192.168.1.2:8080/base"],
    ["http://[::1]:8080/", "http://[::1]:8080"],
    ["https://push.example.com/日本/", "https://push.example.com/%E6%97%A5%E6%9C%AC"],
    ["https://例え.jp/", "https://xn--r8jz45g.jp"],
  ])("normalizes base URL %s", (value, expected) => {
    expect(normalizeGotifyUrl(value)).toBe(expected);
  });
  it.each([
    undefined,
    "",
    "/relative",
    "//push.example.com",
    "https:push.example.com",
    "file:///tmp/push",
    "ftp://host",
    "https://user:secret@host",
    "https://secret@host",
    "https://@host",
    "https://:secret@host",
    "https://user%3Asecret@host",
    "https:///user:secret@host",
    "https:////user:secret@host",
    "https:///host",
    "https://host?token=secret",
    "https://host?",
    "https://host#fragment",
    "https://host#",
    " https://host",
    "https://ho\nst",
    "https://host/with space",
    "https://host/\u001b",
    "https://host\\path",
    `https://host/${"a".repeat(2048)}`,
    `https://push.example/${"日".repeat(230)}`,
  ])("rejects unsafe or malformed URL %j", (serverUrl) => {
    expect(createGotifyProvider().validate({ ...destination, serverUrl })).toBeUndefined();
  });
  it.each([
    null,
    [],
    {},
    { ...destination, provider: "telegram" },
    { ...destination, label: " " },
    { ...destination, label: "a".repeat(129) },
    { ...destination, appToken: "" },
    { ...destination, appToken: "secret\r\nheader" },
    { ...destination, appToken: "token with space" },
    { ...destination, appToken: "☃" },
    { ...destination, appToken: "a".repeat(513) },
    { ...destination, priority: "5" },
    { ...destination, priority: null },
    { ...destination, priority: 1.5 },
    { ...destination, priority: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid destination %j", (value) => {
    expect(createGotifyProvider().validate(value)).toBeUndefined();
  });
  it.each(["https://例え.jp/日本/", `https://push.example/${"日".repeat(200)}`, `https://host/${"a".repeat(2035)}`])(
    "keeps canonical validation idempotent: %s",
    (serverUrl) => {
      const provider = createGotifyProvider();
      const normalized = provider.validate({ ...destination, serverUrl });
      expect(normalized).toBeDefined();
      expect(provider.validate(normalized)).toEqual(normalized);
    },
  );
  it.each([undefined, -2, 0, 5, Number.MAX_SAFE_INTEGER])("accepts optional priority %j", (priority) => {
    expect(createGotifyProvider().validate({ ...destination, priority })).toEqual({
      ...destination,
      serverUrl: "https://push.example.com/gotify",
      priority,
    });
  });
});

describe("Gotify delivery", () => {
  it.each([undefined, 0, 5, -1])("posts native fields and application-token header, priority %j", async (priority) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    const provider = createGotifyProvider(fetcher);
    expect(await deliver(new Map([[provider.id, provider]]), { ...destination, priority }, note, signal())).toEqual({
      state: "accepted",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://push.example.com/gotify/message");
    expect(String(url)).not.toContain(destination.appToken);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "X-Gotify-Key": destination.appToken },
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ title: note.title, message: note.body, ...(priority === undefined ? {} : { priority }) });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    [accepted, 200, { state: "accepted" }],
    [{ error: "secret", errorCode: 401 }, 401, { state: "failed", code: "http" }],
    ["secret", 403, { state: "failed", code: "http" }],
    ["secret", 500, { state: "failed", code: "http" }],
    ["secret", 429, { state: "failed", code: "rate-limit" }],
    [{ error: "secret", errorCode: 400 }, 200, { state: "failed", code: "response" }],
    [{}, 200, { state: "failed", code: "response" }],
    [[], 200, { state: "failed", code: "response" }],
    [{ ...accepted, id: "1" }, 200, { state: "failed", code: "response" }],
    [{ ...accepted, appid: 0 }, 200, { state: "failed", code: "response" }],
    [{ ...accepted, date: "invalid" }, 200, { state: "failed", code: "response" }],
    [{ ...accepted, message: null }, 200, { state: "failed", code: "response" }],
  ])("normalizes response %j / %s", async (body, status, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    expect(await createGotifyProvider(fetcher).send(destination, note, signal())).toEqual(expected);
  });
  it.each([
    ["8", 8],
    ["0", undefined],
    ["invalid", undefined],
    ["1.5", undefined],
    ["9999999999999999999", undefined],
  ])("only exposes safe retry-after seconds: %s", async (retry, expected) => {
    const provider = createGotifyProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("secret", { status: 429, headers: { "retry-after": String(retry) } })),
    );
    expect(await provider.send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      ...(expected === undefined ? {} : { retryAfterSeconds: expected }),
    });
  });
  it.each(["not JSON", "x".repeat(65537)])("bounds malformed or oversized success bodies", async (body) => {
    const provider = createGotifyProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
    expect(await provider.send(destination, note, signal())).toEqual({ state: "failed", code: "response" });
  });
  it("cancels oversized streamed bodies and releases the reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel,
    });
    const provider = createGotifyProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
    expect(await provider.send(destination, note, signal())).toEqual({ state: "failed", code: "response" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("rejects missing response bodies", async () => {
    const provider = createGotifyProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
    expect(await provider.send(destination, note, signal())).toEqual({ state: "failed", code: "response" });
  });
  it("cancels and times out hanging fetches without exposing exceptions or leaking timers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(destination.appToken)), { once: true });
        }),
    );
    const provider = createGotifyProvider(fetcher);
    const controller = new AbortController();
    const sending = provider.send(destination, note, controller.signal);
    controller.abort();
    expect(await sending).toEqual({ state: "cancelled", code: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    const timed = provider.send(destination, note, signal());
    await vi.advanceTimersByTimeAsync(10000);
    expect(await timed).toEqual({ state: "failed", code: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("honors cancellation while reading the response", async () => {
    const controller = new AbortController();
    const body = new ReadableStream(
      {
        pull(stream) {
          controller.abort();
          stream.enqueue(new TextEncoder().encode(JSON.stringify(accepted)));
        },
      },
      { highWaterMark: 0 },
    );
    const provider = createGotifyProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
    expect(await provider.send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(body.locked).toBe(false);
  });
  it.each(["cancel", "timeout"])("interrupts a stalled response body on %s", async (kind) => {
    vi.useFakeTimers();
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream(
            {
              start(stream) {
                init?.signal?.addEventListener("abort", () => stream.error(new Error(destination.appToken)), {
                  once: true,
                });
              },
              pull() {
                ready();
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const sending = createGotifyProvider(fetcher).send(destination, note, controller.signal);
    await reading;
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not request pre-cancelled or invalid destinations and never falls back to Telegram", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createGotifyProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(await deliver(providers, { ...destination, serverUrl: "https://secret@host" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(await provider.send({ ...destination, serverUrl: "invalid" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(await createTelegramProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("redacts network and redirect failures", async () => {
    const provider = createGotifyProvider(
      vi.fn<typeof fetch>().mockRejectedValue(new Error(`${destination.serverUrl}/${destination.appToken}`)),
    );
    expect(await provider.send(destination, note, signal())).toEqual({ state: "failed", code: "network" });
  });
  it("uses the built-in registry with real HTTP and refuses redirects without forwarding the token", async () => {
    const requests: { url: string | undefined; token: string | string[] | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ url: req.url, token: req.headers["x-gotify-key"], body });
        if (req.url === "/redirect/message") {
          res.writeHead(302, { location: "/leaked" });
          res.end();
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(accepted));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await deliver(providers, { ...destination, serverUrl: `${base}/gotify/` }, note, signal())).toEqual({
        state: "accepted",
      });
      expect(await deliver(providers, { ...destination, serverUrl: `${base}/redirect` }, note, signal())).toEqual({
        state: "failed",
        code: "network",
      });
      expect(requests.map((request) => request.url)).toEqual(["/gotify/message", "/redirect/message"]);
      expect(requests[0]?.token).toBe(destination.appToken);
      expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ title: note.title, message: note.body });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
