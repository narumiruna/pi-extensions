import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeHttpUrl, postJson, truncateUtf8 } from "../src/providers/http.js";
import { providers } from "../src/providers.js";

const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("notification HTTP URL validation", () => {
  it.each([
    ["https://ntfy.sh/", "https://ntfy.sh"],
    ["https://host/proxy///", "https://host/proxy"],
    ["http://localhost:8080/ntfy/", "http://localhost:8080/ntfy"],
    ["http://192.168.1.2:80", "http://192.168.1.2"],
    ["http://[::1]:8080/", "http://[::1]:8080"],
    ["https://例え.jp/日本/", "https://xn--r8jz45g.jp/%E6%97%A5%E6%9C%AC"],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeHttpUrl(value)).toBe(expected);
    expect(normalizeHttpUrl(expected)).toBe(expected);
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
    "https:////host",
    "ftp://host",
    "file:///tmp",
    "https://user:secret@host",
    "https://secret@host",
    "https://@host",
    "https://:secret@host",
    "https://user%3Asecret@host",
    "https://host?",
    "https://host?key=secret",
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
    "https://host/a/../private",
    "https://host/a/./private",
    "https://host/private/%2e%2e",
    "https://host/private/%2E./",
    "https://host/private/%2f../",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://127.1",
    "http://0x7f000001",
    "http://127.0.0.1.",
    `https://host/${"a".repeat(2048)}`,
    `https://host/${"日".repeat(230)}`,
  ])("rejects unsafe URL %j", (value) => {
    expect(normalizeHttpUrl(value)).toBeUndefined();
  });
  it.each(
    ["ntfy", "bark", "webhook"].flatMap((provider) =>
      [
        "https://host/private/../",
        "https://host/private/%2e%2e",
        "https://host/private/%2F../",
        "http://2130706433",
        "http://0177.0.0.1",
        "http://127.1",
        "http://0x7f000001",
      ].map((url) => ({ provider, url })),
    ),
  )("rejects ambiguous $provider destination $url before credentials can be sent", ({ provider, url }) => {
    expect(
      providers.get(provider)?.validate({
        provider,
        label: "Private",
        serverUrl: url,
        webhookUrl: url,
        topic: "private-topic",
        deviceKey: "secret-key",
      }),
    ).toBeUndefined();
  });
  it("truncates UTF-8 without splitting code points", () => {
    expect(truncateUtf8("a😀日z", 4)).toBe("a");
    expect(truncateUtf8("a😀日z", 5)).toBe("a😀");
    expect(truncateUtf8("a😀日z", 8)).toBe("a😀日");
    expect(truncateUtf8("abc", 0)).toBe("");
  });
});

describe("bounded notification HTTP", () => {
  it("posts JSON once, disables redirects, and consumes a bounded response", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}'));
    expect(
      await postJson("https://host/base", { text: "hello" }, signal(), fetcher, { Authorization: "Bearer secret" }),
    ).toEqual({ state: "response", body: { ok: true }, status: 200 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([
      "https://host/base",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: '{"text":"hello"}',
        headers: { "content-type": "application/json", Authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores empty stream chunks without changing acceptance", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 1000; i++) controller.enqueue(new Uint8Array());
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      },
    });
    expect(
      await postJson("https://host", {}, signal(), vi.fn<typeof fetch>().mockResolvedValue(new Response(body))),
    ).toEqual({ state: "response", body: { ok: true }, status: 200 });
    expect(body.locked).toBe(false);
  });
  it.each([null, "not JSON", ""])("lets providers check empty or non-JSON acceptance: %j", async (body) => {
    expect(
      await postJson("https://host", {}, signal(), vi.fn<typeof fetch>().mockResolvedValue(new Response(body))),
    ).toEqual({ state: "response", body: undefined, status: 200 });
  });
  it.each([301, 302, 400, 401, 403, 500])("returns a safe HTTP error for %s", async (status) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream({ cancel });
    const result = await postJson(
      "https://secret",
      {},
      signal(),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status })),
    );
    expect(result).toEqual({ state: "failed", code: "http" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([
    ["8", 8],
    ["0", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["99999999999999999999", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
    ["secret", undefined],
  ])("exposes only positive safe retry seconds %s", async (retry, expected) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret", { status: 429, headers: { "retry-after": String(retry) } }));
    expect(await postJson("https://secret", {}, signal(), fetcher)).toEqual({
      state: "failed",
      code: "rate-limit",
      ...(expected === undefined ? {} : { retryAfterSeconds: expected }),
    });
  });
  it.each([65536, 65537])(
    "bounds streamed bytes at %s and releases the reader even if cancel stalls",
    async (length) => {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const bytes = new TextEncoder().encode(`"${"a".repeat(length - 2)}"`);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
        },
        cancel,
      });
      // Close the exact-boundary body so it can be accepted; oversize must stop without waiting for EOF.
      const exact = new Response(bytes);
      const result = await postJson(
        "https://host",
        {},
        signal(),
        vi.fn<typeof fetch>().mockResolvedValue(length === 65536 ? exact : new Response(body)),
      );
      expect(result).toEqual(
        length === 65536
          ? { state: "response", body: "a".repeat(length - 2), status: 200 }
          : { state: "failed", code: "response" },
      );
      if (length > 65536) expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    },
  );
  it.each(["cancel", "timeout"])("interrupts injected fetch that ignores its signal: %s", async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sending = postJson(
      "https://secret",
      {},
      controller.signal,
      vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
    );
    if (kind === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(10000);
    expect(await sending).toEqual(
      kind === "cancel" ? { state: "cancelled", code: "cancelled" } : { state: "failed", code: "timeout" },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["cancel", "timeout"])("interrupts an injected stalled stream with non-settling cancel: %s", async (kind) => {
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
    const sending = postJson(
      "https://secret",
      {},
      controller.signal,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
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
  it("keeps one deadline across headers and body", async () => {
    vi.useFakeTimers();
    let respond!: (response: Response) => void;
    const fetching = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const sending = postJson("https://host", {}, signal(), vi.fn<typeof fetch>().mockReturnValue(fetching));
    await vi.advanceTimersByTimeAsync(9000);
    respond(new Response(new ReadableStream({ pull() {} }, { highWaterMark: 0 })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sending).toEqual({ state: "failed", code: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a late response when injected fetch ignores abort", async () => {
    let respond!: (response: Response) => void;
    const controller = new AbortController();
    const sending = postJson(
      "https://host",
      {},
      controller.signal,
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      ),
    );
    controller.abort();
    expect(await sending).toEqual({ state: "cancelled", code: "cancelled" });
    const cancel = vi.fn();
    respond(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("redacts network and stream errors and skips pre-cancelled requests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("https://host/secret"));
    const controller = new AbortController();
    controller.abort();
    expect(await postJson("https://secret", {}, controller.signal, fetcher)).toEqual({
      state: "cancelled",
      code: "cancelled",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await postJson("https://secret", {}, signal(), fetcher)).toEqual({ state: "failed", code: "network" });
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("secret"));
      },
    });
    expect(
      await postJson("https://secret", {}, signal(), vi.fn<typeof fetch>().mockResolvedValue(new Response(body))),
    ).toEqual({ state: "failed", code: "network" });
    expect(body.locked).toBe(false);
  });
});
