import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { deliver, type Notification, type NtfyDestination } from "../src/provider.js";
import { createNtfyProvider } from "../src/providers/ntfy.js";
import { providers } from "../src/providers.js";

const destination: NtfyDestination = {
  provider: "ntfy",
  label: "Personal ntfy",
  serverUrl: "https://ntfy.sh/",
  topic: "pi-private_topic-123",
};
const note: Notification = {
  id: "secret-id",
  title: "Pi needs review",
  body: "Session: <literal> 😀",
  bodyEmphasis: [{ style: "bold", offset: 0, length: 7 }],
  settledAt: 123,
};
// https://docs.ntfy.sh/subscribe/api/#json-message-format (minimal notification message).
const accepted = { id: "wze9zgqK41", time: 1638542110, event: "message", topic: destination.topic, message: note.body };
const signal = () => new AbortController().signal;

describe("ntfy validation", () => {
  it("returns every owned optional field for clearing and excludes unknown fields", () => {
    expect(createNtfyProvider().validate({ ...destination, unrelated: "preserve in store only" })).toEqual({
      ...destination,
      serverUrl: "https://ntfy.sh/",
      accessToken: undefined,
      priority: undefined,
    });
  });
  it.each([undefined, 1, 2, 3, 4, 5])("accepts optional priority %j", (priority) => {
    expect(createNtfyProvider().validate({ ...destination, priority })?.provider).toBe("ntfy");
  });
  it.each([0, 6, -1, 1.5, NaN, Infinity, null, "3"])("rejects priority %j", (priority) => {
    expect(createNtfyProvider().validate({ ...destination, priority })).toBeUndefined();
  });
  it.each(["a", "_", "-", "A-Z_a-z0-9", "a".repeat(64), "Docs", "V1"])("accepts topic %s", (topic) => {
    expect(createNtfyProvider().validate({ ...destination, topic })?.provider).toBe("ntfy");
  });
  it.each([
    undefined,
    null,
    "",
    "a".repeat(65),
    "topic.name",
    "topic/name",
    "two topics",
    "日本",
    "one,two",
    "x\n",
    "x?",
    "*",
    "docs",
    "static",
    "file",
    "app",
    "metrics",
    "account",
    "settings",
    "signup",
    "login",
    "v1",
  ])("rejects invalid or reserved topic %j", (topic) => {
    expect(createNtfyProvider().validate({ ...destination, topic })).toBeUndefined();
  });
  it.each([
    null,
    [],
    {},
    { ...destination, provider: "gotify" },
    { ...destination, label: " " },
    { ...destination, label: "a".repeat(129) },
    { ...destination, serverUrl: "https://secret@host" },
    { ...destination, serverUrl: "https://host?token=secret" },
    ...[null, 1, "", "a".repeat(513), "has space", "secret\r\nheader", "☃"].map((accessToken) => ({
      ...destination,
      accessToken,
    })),
  ])("rejects invalid destination %j", (value) => {
    expect(createNtfyProvider().validate(value)).toBeUndefined();
  });
  it.each(["tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2", "a".repeat(512)])(
    "accepts safe optional Bearer token",
    (accessToken) => {
      const provider = createNtfyProvider();
      const valid = provider.validate({ ...destination, accessToken });
      expect(valid).toMatchObject({ accessToken });
      expect(provider.validate(valid)).toEqual(valid);
    },
  );
});

describe("ntfy delivery", () => {
  it.each([
    ["https://ntfy.sh/", undefined, undefined, "https://ntfy.sh/"],
    ["http://127.0.0.1:8080/proxy/ntfy/", "tk_secret", 5, "http://127.0.0.1:8080/proxy/ntfy/"],
    ["http://127.0.0.1:8080/exact-publish", undefined, undefined, "http://127.0.0.1:8080/exact-publish"],
  ])(
    "posts only native metadata fields to normalized server base %s",
    async (serverUrl, accessToken, priority, endpoint) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
      expect(
        await createNtfyProvider(fetcher).send({ ...destination, serverUrl, accessToken, priority }, note, signal()),
      ).toEqual({ state: "accepted" });
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0] ?? [];
      expect(url).toBe(endpoint);
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
        },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        topic: destination.topic,
        title: note.title,
        message: note.body,
        ...(priority === undefined ? {} : { priority }),
      });
      expect(String(init?.body)).not.toContain("bodyEmphasis");
      expect(String(init?.body)).not.toContain("settledAt");
      expect(String(init?.body)).not.toContain("secret-id");
    },
  );
  it.each([
    [accepted, 200, "accepted"],
    [accepted, 201, "response"],
    [accepted, 202, "response"],
    [{}, 200, "response"],
    [[], 200, "response"],
    [null, 200, "response"],
    [{ ...accepted, id: "" }, 200, "response"],
    [{ ...accepted, id: 1 }, 200, "response"],
    [{ ...accepted, time: "1638542110" }, 200, "response"],
    [{ ...accepted, time: 0 }, 200, "response"],
    [{ ...accepted, time: 1.5 }, 200, "response"],
    [{ ...accepted, event: "open" }, 200, "response"],
    [{ ...accepted, topic: "other" }, 200, "response"],
    [{ ...accepted, message: null }, 200, "response"],
    [{ code: 40001, error: "secret" }, 200, "response"],
    [{ code: 40001, error: "secret" }, 400, "http"],
    ["secret", 401, "http"],
    ["secret", 403, "http"],
    ["secret", 500, "http"],
    ["secret", 429, "rate-limit"],
  ])("checks documented acceptance %j / %s", async (body, status, code) => {
    const provider = createNtfyProvider(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status })),
    );
    expect(await provider.send(destination, note, signal())).toEqual(
      code === "accepted" ? { state: "accepted" } : { state: "failed", code },
    );
  });
  it.each([null, "not JSON", "x".repeat(65537)])("rejects missing/malformed/oversized JSON", async (body) => {
    expect(
      await createNtfyProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
        destination,
        note,
        signal(),
      ),
    ).toEqual({ state: "failed", code: "response" });
  });
  it("retains validated rate-limit diagnostics without retrying", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret", { status: 429, headers: { "retry-after": "12" } }));
    expect(await createNtfyProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      retryAfterSeconds: 12,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["😀", "日", "a"])("bounds text bytes without splitting %s", async (point) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    await createNtfyProvider(fetcher).send(
      destination,
      { ...note, title: point.repeat(2000), body: point.repeat(5000) },
      signal(),
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(Buffer.byteLength(body.title)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(body.message)).toBeLessThanOrEqual(4096);
    expect(body.title).toBe(point.repeat(Math.floor(1024 / Buffer.byteLength(point))));
    expect(body.message).toBe(point.repeat(Math.floor(4096 / Buffer.byteLength(point))));
  });
  it.each(["\u0000".repeat(5000), "a".repeat(2000)])(
    "also bounds the JSON envelope for hostile escaped text",
    async (text) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
      await createNtfyProvider(fetcher).send(
        destination,
        { ...note, title: "\u0000".repeat(2000), body: text },
        signal(),
      );
      expect(Buffer.byteLength(String(fetcher.mock.calls[0]?.[1]?.body))).toBeLessThanOrEqual(8192);
    },
  );
  it("skips invalid and pre-cancelled direct calls, without falling back", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createNtfyProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(await provider.send({ ...destination, topic: "docs" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(await deliver(providers, { ...destination, priority: 6 }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["cancel", "timeout"])("propagates %s while injected fetch ignores abort", async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const sending = createNtfyProvider(fetcher).send(destination, note, controller.signal);
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["cancel", "timeout"])("releases stalled response streams after %s", async (kind) => {
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const sending = createNtfyProvider(fetcher).send(destination, note, controller.signal);
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
  it("uses registered native HTTP and refuses redirects without forwarding credentials", async () => {
    const requests: { url: string | undefined; auth: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ url: req.url, auth: req.headers.authorization, body });
        if (req.url === "/redirect" || req.url === "/proxy/ntfy") {
          // Conventional slash-mounted proxies redirect the slashless base, which must not be used.
          res.writeHead(302, { location: req.url === "/proxy/ntfy" ? "/proxy/ntfy/" : "/leaked" });
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
      expect(
        await deliver(
          providers,
          { ...destination, serverUrl: `${base}/proxy/ntfy/`, accessToken: "tk_secret" },
          note,
          signal(),
        ),
      ).toEqual({ state: "accepted" });
      expect(
        await deliver(
          providers,
          { ...destination, serverUrl: `${base}/redirect`, accessToken: "tk_secret" },
          note,
          signal(),
        ),
      ).toEqual({ state: "failed", code: "network" });
      expect(requests.map((request) => request.url)).toEqual(["/proxy/ntfy/", "/redirect"]);
      expect(requests[0]?.auth).toBe("Bearer tk_secret");
      expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
        topic: destination.topic,
        title: note.title,
        message: note.body,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
