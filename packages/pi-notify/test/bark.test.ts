import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BarkDestination, Notification } from "../src/provider.js";
import { createBarkProvider } from "../src/providers/bark.js";

const destination: BarkDestination = {
  provider: "bark",
  label: "Personal Bark",
  serverUrl: "https://api.day.app/",
  deviceKey: "secret-device-key",
};
const note: Notification = {
  id: "metadata-id",
  title: "Pi needs review 😀",
  body: "Session: <literal> 日本",
  bodyEmphasis: [{ style: "bold", offset: 0, length: 7 }],
  settledAt: 123,
};
// Bark's documented JSON acceptance requires code 200, not a timestamp or message field.
const accepted = { code: 200 };
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("Bark validation", () => {
  it("normalizes owned fields without adding an authentication field", () => {
    const provider = createBarkProvider();
    const valid = provider.validate({ ...destination, basicAuth: "unsupported", unrelated: true });
    expect(valid).toEqual({ ...destination, serverUrl: "https://api.day.app" });
    expect(provider.validate(valid)).toEqual(valid);
  });
  it.each(["a", "a".repeat(512), "!#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"])(
    "accepts locally safe keys without assuming an upstream pattern",
    (deviceKey) => {
      expect(createBarkProvider().validate({ ...destination, deviceKey })).toMatchObject({ deviceKey });
    },
  );
  it.each([undefined, null, 1, "", "a".repeat(513), "has space", " secret", "secret\n", "\u0000", "\u007f", "日本"])(
    "rejects unsafe device key %j",
    (deviceKey) => expect(createBarkProvider().validate({ ...destination, deviceKey })).toBeUndefined(),
  );
  it.each([
    ["https://api.day.app/", "https://api.day.app"],
    ["http://localhost:8080/proxy/bark///", "http://localhost:8080/proxy/bark"],
    ["http://192.168.1.2:8080/", "http://192.168.1.2:8080"],
    ["http://[::1]:8080/", "http://[::1]:8080"],
    ["https://例え.jp/日本/", "https://xn--r8jz45g.jp/%E6%97%A5%E6%9C%AC"],
  ])("permits explicit hosted, private, and reverse-proxy bases: %s", (serverUrl, normalized) => {
    expect(createBarkProvider().validate({ ...destination, serverUrl })).toMatchObject({ serverUrl: normalized });
  });
  it.each([
    undefined,
    null,
    "",
    "/relative",
    "//host",
    "https:host",
    "https:/host",
    "https:///host",
    "ftp://host",
    "https://user:secret@host",
    "https://@host",
    "https://host?key=secret",
    "https://host?",
    "https://host#",
    "https://host#fragment",
    " https://host",
    "https://ho\nst",
    "https://host/with space",
    "https://host\\path",
    "https://host/%00",
    "https://host/%0a",
    "https://host/%5cpath",
    "https://host/%broken",
    `https://host/${"a".repeat(2048)}`,
    `https://host/${"日".repeat(230)}`,
  ])("rejects unsafe server URL %j", (serverUrl) => {
    expect(createBarkProvider().validate({ ...destination, serverUrl })).toBeUndefined();
  });
  it.each([
    null,
    [],
    {},
    { ...destination, provider: "webhook" },
    { ...destination, label: undefined },
    { ...destination, label: " " },
    { ...destination, label: "a".repeat(129) },
  ])("rejects invalid destination %j", (value) => expect(createBarkProvider().validate(value)).toBeUndefined());
});

describe("Bark delivery", () => {
  it.each([
    ["https://api.day.app/", "https://api.day.app/push"],
    ["http://127.0.0.1:8080/proxy/bark///", "http://127.0.0.1:8080/proxy/bark/push"],
  ])("posts only the native JSON fields to %s", async (serverUrl, endpoint) => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    expect(await createBarkProvider(fetcher).send({ ...destination, serverUrl }, note, signal())).toEqual({
      state: "accepted",
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      device_key: destination.deviceKey,
      title: note.title,
      body: note.body,
    });
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(destination.deviceKey);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(note.title);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    [accepted, 200, "accepted"],
    [{ code: 200, timestamp: 1, message: "success" }, 200, "accepted"],
    [{ code: 400, message: "secret" }, 200, "api"],
    [{ code: 0 }, 200, "api"],
    [{ code: "200" }, 200, "response"],
    [{ code: null }, 200, "response"],
    [{}, 200, "response"],
    [null, 200, "response"],
    [[], 200, "response"],
    [200, 200, "response"],
    [accepted, 201, "response"],
    [accepted, 202, "response"],
    [{ code: 200, message: "secret" }, 400, "http"],
    ["secret", 401, "http"],
    ["secret", 403, "http"],
    ["secret", 500, "http"],
    ["secret", 302, "http"],
    ["secret", 429, "rate-limit"],
  ])("requires HTTP 200 and numeric code 200: %j / %s", async (body, status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    expect(await createBarkProvider(fetcher).send(destination, note, signal())).toEqual(
      code === "accepted" ? { state: "accepted" } : { state: "failed", code },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([null, "", "not JSON", "x".repeat(65537)])("rejects empty, malformed, or oversized bodies", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await createBarkProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "response",
    });
  });
  it.each(["😀", "日", "a"])("limits UTF-8 bytes without splitting %s", async (point) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    await createBarkProvider(fetcher).send(
      destination,
      { ...note, title: point.repeat(2000), body: point.repeat(5000) },
      signal(),
    );
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload.title).toBe(point.repeat(Math.floor(256 / Buffer.byteLength(point))));
    expect(payload.body).toBe(point.repeat(Math.floor(2048 / Buffer.byteLength(point))));
  });
  it.each(["\u0000", "\n", '"', "\\", "😀\u0000日"])("bounds the encoded text envelope for %j", async (point) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(accepted)));
    const original = point.repeat(5000);
    await createBarkProvider(fetcher).send(
      destination,
      { ...note, title: "\u0000".repeat(500), body: original },
      signal(),
    );
    const { title, body } = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(Buffer.byteLength(title)).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify({ title, body }))).toBeLessThanOrEqual(3000);
    expect(body.length).toBeGreaterThan(0);
    expect(original.startsWith(body)).toBe(true);
    expect(body).not.toContain("�");
    const next = [...original.slice(body.length)][0] ?? "";
    expect(
      Buffer.byteLength(body + next) > 2048 || Buffer.byteLength(JSON.stringify({ title, body: body + next })) > 3000,
    ).toBe(true);
  });
  it("keeps rate-limit diagnostics safe without retrying", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret", { status: 429, headers: { "retry-after": "12" } }));
    expect(await createBarkProvider(fetcher).send(destination, note, signal())).toEqual({
      state: "failed",
      code: "rate-limit",
      retryAfterSeconds: 12,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("skips invalid or pre-cancelled direct calls and redacts exceptions", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`${destination.serverUrl}/${destination.deviceKey}`));
    const provider = createBarkProvider(fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.send(destination, note, controller.signal)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(await provider.send({ ...destination, deviceKey: "bad\nkey" }, note, signal())).toEqual({
      state: "failed",
      code: "invalid-destination",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await provider.send(destination, note, signal())).toEqual({ state: "failed", code: "network" });
  });
  it.each(["cancel", "timeout"])("releases stalled fetch resources on %s", async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sending = createBarkProvider(vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))).send(
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
  it.each(["cancel", "timeout"])("interrupts and releases an uncooperative body on %s", async (kind) => {
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
    const sending = createBarkProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).send(
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
  it("supports private HTTP reverse proxies and refuses native redirects", async () => {
    const requests: { url: string | undefined; auth: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ url: req.url, auth: req.headers.authorization, body });
        if (req.url === "/redirect/push") res.writeHead(307, { location: "/leaked" });
        res.end(JSON.stringify(accepted));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const provider = createBarkProvider();
      expect(await provider.send({ ...destination, serverUrl: `${base}/proxy/bark/` }, note, signal())).toEqual({
        state: "accepted",
      });
      expect(await provider.send({ ...destination, serverUrl: `${base}/redirect/` }, note, signal())).toEqual({
        state: "failed",
        code: "network",
      });
      expect(requests.map((request) => request.url)).toEqual(["/proxy/bark/push", "/redirect/push"]);
      expect(requests[0]?.auth).toBeUndefined();
      expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
        device_key: destination.deviceKey,
        title: note.title,
        body: note.body,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
