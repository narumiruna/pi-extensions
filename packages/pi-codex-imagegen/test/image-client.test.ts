import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_TIMEOUT_MS,
  generateImageRequest,
  getImageAuthStatus,
  HEADERS_TIMEOUT_MS,
  IMAGE_ENDPOINT,
  type ImageAuthRegistry,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from "../src/image-client.js";

const BASE = "https://chatgpt.com/backend-api";
const SECRET = "synthetic-secret-never-display";
const ACCOUNT = "synthetic-account-123";
const nativeFetch = globalThis.fetch;
const request = { prompt: "  A fox\nwith a hat.  ", transparentBackground: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function jwt(payload: unknown = { "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } }) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.${Buffer.from(SECRET).toString("base64url")}`;
}

function fixture() {
  const model: Model<Api> = {
    id: "catalog-codex-model",
    name: "Codex",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: BASE,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const forbidden = () => {
    throw new Error("Provider execution is forbidden in image-client tests");
  };
  const provider: Provider = {
    id: "openai-codex",
    name: "Synthetic Codex",
    baseUrl: BASE,
    headers: { Authorization: SECRET, "x-untrusted": SECRET },
    auth: { oauth: { name: "Synthetic OAuth", login: forbidden, refresh: forbidden, toAuth: forbidden } },
    getModels: forbidden,
    stream: forbidden,
    streamSimple: forbidden,
  };
  const registry = {
    // A different primary provider/catalog order must not affect image authentication.
    getAll: vi.fn<ImageAuthRegistry["getAll"]>().mockReturnValue([{ ...model, provider: "other" }, model]),
    getProvider: vi.fn<ImageAuthRegistry["getProvider"]>().mockReturnValue(provider),
    isUsingOAuth: vi.fn<ImageAuthRegistry["isUsingOAuth"]>().mockReturnValue(true),
    getProviderAuthStatus: vi
      .fn<ImageAuthRegistry["getProviderAuthStatus"]>()
      .mockReturnValue({ configured: true, source: "stored", label: SECRET }),
    getProviderAuth: vi.fn<ImageAuthRegistry["getProviderAuth"]>().mockResolvedValue({
      auth: { apiKey: jwt(), headers: { Authorization: SECRET, "x-untrusted": SECRET } },
      source: SECRET,
    }),
  } satisfies ImageAuthRegistry;
  return { registry, model, provider };
}

function json(value: unknown = { data: [{ b64_json: "aW1hZ2U=" }] }, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
}

function run(
  registry: ImageAuthRegistry,
  fetch: typeof globalThis.fetch,
  signal = new AbortController().signal,
  isCurrent?: () => boolean,
) {
  return generateImageRequest(registry, request, { signal, fetch, isCurrent });
}

beforeEach(() => {
  // Every test must explicitly supply a synthetic transport or the local-only adapter.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External fetch is forbidden");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Pi auth boundary", () => {
  it("reports metadata only, without resolving auth or displaying labels", () => {
    const { registry } = fixture();
    expect(getImageAuthStatus(registry)).toBe(
      "Pi openai-codex OAuth configured (stored Pi auth). Endpoint access is unverified.",
    );
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    expect(registry.isUsingOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai-codex" }));
    expect(getImageAuthStatus(registry)).not.toContain(SECRET);
    registry.getAll.mockImplementation(() => {
      throw new Error(SECRET);
    });
    expect(getImageAuthStatus(registry)).not.toContain(SECRET);
  });

  it.each(["missing model", "missing provider", "missing auth", "non-OAuth", "missing OAuth adapter"])(
    "rejects %s before auth resolution",
    async (kind) => {
      const { registry, provider } = fixture();
      if (kind === "missing model") registry.getAll.mockReturnValue([]);
      if (kind === "missing provider") registry.getProvider.mockReturnValue(undefined);
      if (kind === "missing auth") registry.getProviderAuthStatus.mockReturnValue({ configured: false });
      if (kind === "non-OAuth") registry.isUsingOAuth.mockReturnValue(false);
      if (kind === "missing OAuth adapter") registry.getProvider.mockReturnValue({ ...provider, auth: {} });
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(run(registry, fetch)).rejects.toThrow(/Pi|OAuth/);
      expect(getImageAuthStatus(registry)).not.toContain("configured (");
      expect(registry.getProviderAuth).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://api.openai.com/v1",
    "https://evil.test/backend-api",
    "http://chatgpt.com/backend-api",
    "https://chatgpt.com.evil.test/backend-api",
    "https://user@chatgpt.com/backend-api",
    "https://chatgpt.com:443/backend-api",
    `${BASE}?x=1`,
    `${BASE}#x`,
    `${BASE}//`,
    `${BASE}/../backend-api`,
    `${BASE}/codex/responses`,
    "HTTPS://CHATGPT.COM/backend-api",
  ])("rejects noncanonical provider and resolved auth URLs: %s", async (baseUrl) => {
    const { registry, provider } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    registry.getProvider.mockReturnValue({ ...provider, baseUrl });
    await expect(run(registry, fetch)).rejects.toThrow("canonical ChatGPT backend");
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    registry.getProvider.mockReturnValue(provider);
    registry.getProviderAuth.mockResolvedValue({ auth: { apiKey: jwt(), baseUrl } });
    await expect(run(registry, fetch)).rejects.toThrow("Cannot resolve compatible Pi Codex OAuth");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks model endpoint metadata and auth metadata again after refresh", async () => {
    const { registry, model } = fixture();
    registry.getAll.mockReturnValue([{ ...model, baseUrl: "https://evil.test" }]);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(run(registry, fetch)).rejects.toThrow("canonical");
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    registry.getAll.mockReturnValue([model]);
    registry.getProviderAuth.mockImplementation(async () => {
      registry.isUsingOAuth.mockReturnValue(false);
      return { auth: { apiKey: jwt() } };
    });
    await expect(run(registry, fetch)).rejects.toThrow("requires Pi openai-codex OAuth");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "sk-synthetic-key",
    "not.a.jwt",
    jwt({}),
    jwt({ chatgpt_account_id: ACCOUNT }),
    jwt({ "https://api.openai.com/auth": { chatgpt_account_id: 123 } }),
    jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "" } }),
    jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "a".repeat(257) } }),
    jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account\r\nheader" } }),
    jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "a b" } }),
    "a".repeat(32 * 1024 + 1),
  ])("rejects incompatible bearer token %# without sending a request", async (apiKey) => {
    const { registry } = fixture();
    registry.getProviderAuth.mockResolvedValue({ auth: { apiKey } });
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(run(registry, fetch)).rejects.toThrow("Cannot resolve compatible Pi Codex OAuth");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["none", "", "invalid algorithm"])("rejects invalid JWT algorithms %#", async (alg) => {
    const { registry } = fixture();
    const parts = jwt().split(".");
    parts[0] = Buffer.from(JSON.stringify({ alg })).toString("base64url");
    registry.getProviderAuth.mockResolvedValue({ auth: { apiKey: parts.join(".") } });
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(run(registry, fetch)).rejects.toThrow("Cannot resolve compatible Pi Codex OAuth");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["reject", "missing"])("redacts %s auth errors", async (mode) => {
    const { registry } = fixture();
    if (mode === "reject") registry.getProviderAuth.mockRejectedValue(new Error(`${SECRET} ${jwt()}`));
    else registry.getProviderAuth.mockResolvedValue(undefined);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(run(registry, fetch)).rejects.toThrow(/^Cannot resolve compatible Pi Codex OAuth\./);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["cancel", "stale", "timeout"])("does not consume late auth after %s", async (mode) => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const auth = deferred<Awaited<ReturnType<ImageAuthRegistry["getProviderAuth"]>>>();
    registry.getProviderAuth.mockReturnValue(auth.promise);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController();
    let current = true;
    const result = run(registry, fetch, controller.signal, () => current);
    const rejected = expect(result).rejects.toThrow(mode === "timeout" ? "authentication timed out" : "cancelled");
    if (mode === "cancel") controller.abort(new Error(SECRET));
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS);
    if (mode === "stale") current = false;
    const consumed = vi.fn(() => {
      throw new Error("Late auth must not be consumed");
    });
    auth.resolve(
      mode === "stale"
        ? { auth: { apiKey: jwt() } }
        : {
            get auth() {
              return consumed();
            },
          },
    );
    await rejected;
    expect(consumed).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already cancelled or stale request before auth", async () => {
    const { registry } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController();
    controller.abort(SECRET);
    await expect(run(registry, fetch, controller.signal)).rejects.toThrow("cancelled");
    await expect(run(registry, fetch, undefined, () => false)).rejects.toThrow("cancelled");
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
  });
});

describe("request contract", () => {
  it.each([false, true])("sends the golden built-in request with transparency=%s", async (transparentBackground) => {
    const { registry, provider } = fixture();
    registry.getProvider.mockReturnValue({ ...provider, baseUrl: `${BASE}/codex/` });
    registry.getProviderAuth.mockResolvedValue({
      auth: { apiKey: jwt(), baseUrl: `${BASE}/`, headers: { "x-untrusted": SECRET } },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(undefined, {
        "x-codex-imagegen-request-id": "req-imagegen-123",
        "x-request-id": SECRET,
      }),
    );
    expect(
      await generateImageRequest(
        registry,
        { ...request, transparentBackground },
        { fetch, signal: new AbortController().signal },
      ),
    ).toEqual({ base64: "aW1hZ2U=", requestId: "req-imagegen-123" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(IMAGE_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt()}`,
      "ChatGPT-Account-ID": ACCOUNT,
      originator: "pi-codex-imagegen",
      "User-Agent": "pi-codex-imagegen",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      prompt: request.prompt,
      background: transparentBackground ? "transparent" : "opaque",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    });
    expect(registry.getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai-codex");
    expect(registry.isUsingOAuth.mock.invocationCallOrder[0]).toBeLessThan(
      registry.getProviderAuth.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each(["", " \n\t", "a".repeat(32_001)])("rejects invalid prompt %# before resolving auth", async (prompt) => {
    const { registry } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      generateImageRequest(registry, { ...request, prompt }, { fetch, signal: new AbortController().signal }),
    ).rejects.toThrow("32,000");
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the prompt limit and captures request values before asynchronous auth", async () => {
    const { registry } = fixture();
    const original = { ...request, prompt: "a".repeat(32_000) };
    registry.getProviderAuth.mockImplementation(async () => {
      original.prompt = "mutated";
      original.transparentBackground = true;
      return { auth: { apiKey: jwt() } };
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json());
    await generateImageRequest(registry, original, { fetch, signal: new AbortController().signal });
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      prompt: "a".repeat(32_000),
      background: "opaque",
    });
  });

  it("uses runtime fetch when no public HTTP helper is available", async () => {
    const { registry } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json());
    vi.stubGlobal("fetch", fetch);
    await generateImageRequest(registry, request, { signal: new AbortController().signal });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("bounded response and failures", () => {
  it.each([401, 403, 429, 500, 302, 307, 308])("redacts HTTP %s without retry or body consumption", async (status) => {
    const { registry } = fixture();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status,
      headers: { "content-type": "text/plain", location: `https://evil.test/${SECRET}`, "x-request-id": SECRET },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const result = await run(registry, fetch).catch((error: Error) => error.message);
    if (status === 401) expect(result).toContain("Sign in");
    if (status === 403) expect(result).toContain("entitlement");
    if (status === 429) expect(result).toContain("limits");
    if (status >= 300 && status < 400) expect(result).toContain("Redirects are not allowed");
    expect(result).not.toContain(SECRET);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each(["transport", "redirect fetch", "stream failure"])("redacts %s errors and never retries", async (kind) => {
    const { registry } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (kind === "stream failure")
      fetch.mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error(SECRET));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    else fetch.mockRejectedValue(new Error(`${SECRET} ${jwt()} ${ACCOUNT}`));
    const result = await run(registry, fetch).catch((error: Error) => error.message);
    expect(result).toBe(
      "Image generation failed. Check Pi authentication and network access; no automatic retry was made.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    null,
    {},
    { data: [] },
    { data: [{ b64_json: "" }] },
    { data: [{ b64_json: " \n" }] },
    { data: [{ b64_json: 1 }] },
    { data: [{ fileId: SECRET }] },
    { data: [{ file_id: SECRET }] },
    { data: [{ url: `https://evil.test/${SECRET}` }] },
    { data: [{ b64_json: "YQ==" }, { b64_json: "Yg==" }] },
  ])("rejects missing, empty, file/URL-only, or extra image data %#", async (value) => {
    const { registry } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(value === undefined ? {} : value));
    await expect(run(registry, fetch)).rejects.toThrow("invalid image JSON");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a followed redirect or absent body from a transport", async () => {
    const { registry } = fixture();
    const redirected = json();
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(run(registry, vi.fn<typeof globalThis.fetch>().mockResolvedValue(redirected))).rejects.toThrow(
      "Redirects are not allowed",
    );
    const absentBody = new Response(null, { headers: { "content-type": "application/json" } });
    await expect(run(registry, vi.fn<typeof globalThis.fetch>().mockResolvedValue(absentBody))).rejects.toThrow(
      "invalid image JSON",
    );
  });

  it.each(["text/html", "image/png", "application/octet-stream", "text/event-stream", "application/problem+json", ""])(
    "rejects unsupported response media: %s",
    async (contentType) => {
      const { registry } = fixture();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(SECRET, { headers: { "content-type": contentType } }));
      await expect(run(registry, fetch)).rejects.toThrow("invalid image JSON");
    },
  );

  it.each([`{"data":${SECRET}`, "null", "[]", "", '{"data":[] } trailing'])(
    "rejects malformed JSON %# without reflecting it",
    async (body) => {
      const { registry } = fixture();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
      await expect(run(registry, fetch)).rejects.toThrow(/^The image endpoint returned invalid image JSON\./);
    },
  );

  it("accepts chunked UTF-8 JSON and ignores unknown response metadata", async () => {
    const { registry } = fixture();
    const bytes = new TextEncoder().encode(
      JSON.stringify({ data: [{ b64_json: "YQ==", generation_id: SECRET }], metadata: "雪", usage: {} }),
    );
    let offset = 0;
    const response = new Response(
      new ReadableStream({
        pull(c) {
          if (offset === bytes.length) c.close();
          else c.enqueue(bytes.subarray(offset, ++offset));
        },
      }),
      { headers: { "content-type": "Application/JSON; charset=utf-8" } },
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    expect(await run(registry, fetch)).toEqual({ base64: "YQ==" });
    expect(response.body?.locked).toBe(false);
  });

  it("rejects invalid UTF-8 JSON", async () => {
    const { registry } = fixture();
    const response = new Response(new Uint8Array([123, 34, 255, 34, 58, 49, 125]), {
      headers: { "content-type": "application/json" },
    });
    await expect(run(registry, vi.fn<typeof globalThis.fetch>().mockResolvedValue(response))).rejects.toThrow(
      "invalid image JSON",
    );
  });

  it.each(["advertised", "chunked", "base64", "decoded"])("bounds %s response sizes", async (kind) => {
    const { registry } = fixture();
    const cancel = vi.fn();
    let response: Response;
    if (kind === "advertised")
      response = new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json", "content-length": String(MAX_RESPONSE_BYTES + 1) },
      });
    else if (kind === "base64" || kind === "decoded")
      response = json({
        data: [{ b64_json: "A".repeat(Math.ceil((32 * 1024 * 1024) / 3) * 4 + (kind === "base64" ? 1 : 0)) }],
      });
    else {
      let count = 0;
      const chunk = new Uint8Array(1024 * 1024).fill(32);
      response = new Response(
        new ReadableStream({
          pull(c) {
            if (++count < 100) c.enqueue(chunk);
            else c.close();
          },
          cancel,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    await expect(run(registry, vi.fn<typeof globalThis.fetch>().mockResolvedValue(response))).rejects.toThrow(
      "size limit",
    );
    expect(response.body?.locked).toBe(false);
    if (kind === "advertised" || kind === "chunked") expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["", "contains spaces", "a".repeat(129), "unsafe/value", "unsafe\tvalue"])(
    "omits unsafe request IDs %#",
    async (requestId) => {
      const { registry } = fixture();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json(undefined, { "x-codex-imagegen-request-id": requestId, "x-request-id": SECRET }));
      expect(await run(registry, fetch)).toEqual({ base64: "aW1hZ2U=" });
    },
  );
});

describe("deadlines, cancellation, and resource ownership", () => {
  it.each(["success", "error", "cancel"])("removes abort listeners after %s", async (kind) => {
    const { registry } = fixture();
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      if (kind === "cancel") controller.abort();
      return kind === "error" ? new Response(SECRET, { status: 500 }) : json();
    });
    await run(registry, fetch, controller.signal).catch(() => undefined);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const ownedSignal = fetch.mock.calls[0]?.[1]?.signal;
    expect(ownedSignal).toBeInstanceOf(AbortSignal);
    if (ownedSignal) expect(getEventListeners(ownedSignal, "abort")).toHaveLength(0);
  });

  it("allows image generation to take longer than an ordinary metadata request before headers", async () => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const pending = deferred<Response>();
    const started = deferred<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      started.resolve();
      return pending.promise;
    });
    const result = run(registry, fetch);
    await started.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    pending.resolve(json());
    await expect(result).resolves.toEqual({ base64: "aW1hZ2U=" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "timeout"])("bounds uncooperative fetch before headers: %s", async (mode) => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const pending = deferred<Response>();
    const started = deferred<void>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const controller = new AbortController();
    const result = run(registry, fetch, controller.signal);
    const rejected = expect(result).rejects.toThrow(mode === "cancel" ? "cancelled" : "timed out");
    await started.promise;
    if (mode === "cancel") controller.abort(SECRET);
    else await vi.advanceTimersByTimeAsync(HEADERS_TIMEOUT_MS);
    await rejected;
    const cancel = vi.fn();
    pending.resolve(new Response(new ReadableStream({ cancel })));
    await pending.promise;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "timeout", "stale"])("closes a stalled body on %s and releases its lock", async (mode) => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const reading = deferred<void>();
    const cancel = vi.fn();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(c) {
            streamController = c;
          },
          pull() {
            reading.resolve();
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const controller = new AbortController();
    let current = true;
    const result = run(registry, fetch, controller.signal, () => current);
    const rejected = expect(result).rejects.toThrow(mode === "timeout" ? "timed out" : "cancelled");
    await reading.promise;
    if (mode === "cancel") controller.abort(SECRET);
    else if (mode === "timeout") await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    else {
      current = false;
      streamController.enqueue(new TextEncoder().encode("{}"));
    }
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("revalidates ownership after headers before reading a response", async () => {
    const { registry } = fixture();
    let current = true;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      current = false;
      return response;
    });
    await expect(run(registry, fetch, undefined, () => current)).rejects.toThrow("cancelled");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait for a stream's cancellation acknowledgement", async () => {
    const { registry } = fixture();
    const reading = deferred<void>();
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve();
          },
          cancel() {
            return new Promise(() => undefined);
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
    const result = run(registry, vi.fn<typeof globalThis.fetch>().mockResolvedValue(response), controller.signal);
    const rejected = expect(result).rejects.toThrow("cancelled");
    await reading.promise;
    controller.abort();
    await rejected;
    expect(response.body?.locked).toBe(false);
  });

  it("keeps one total deadline across auth, headers, and body", async () => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const auth = deferred<Awaited<ReturnType<ImageAuthRegistry["getProviderAuth"]>>>();
    const headers = deferred<Response>();
    const fetching = deferred<void>();
    const reading = deferred<void>();
    registry.getProviderAuth.mockReturnValue(auth.promise);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      fetching.resolve();
      return headers.promise;
    });
    const result = run(registry, fetch);
    const rejected = expect(result).rejects.toThrow("Image generation timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    auth.resolve({ auth: { apiKey: jwt() } });
    await fetching.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    headers.resolve(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              reading.resolve();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await reading.promise;
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 40_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not follow a real local HTTP redirect", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(302, { location: "/must-not-follow" });
      res.end(SECRET);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((_url, init) => nativeFetch(`http://127.0.0.1:${port}/synthetic-only`, init));
    try {
      const { registry } = fixture();
      await expect(run(registry, fetch)).rejects.toThrow("no automatic retry");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it.each([false, true])("closes an actual local HTTP socket with body started=%s", async (bodyStarted) => {
    const received = deferred<void>();
    const closed = deferred<void>();
    const reading = deferred<void>();
    const server = createServer((req, res) => {
      req.resume();
      res.on("close", () => closed.resolve());
      if (bodyStarted) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"data":[');
      }
      received.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    let response: Response | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      expect(url).toBe(IMAGE_ENDPOINT);
      response = await nativeFetch(`http://127.0.0.1:${port}/synthetic-only`, init);
      if (response.body) {
        const getReader = response.body.getReader.bind(response.body);
        vi.spyOn(response.body, "getReader").mockImplementation(() => {
          const reader = getReader();
          const read = reader.read.bind(reader);
          vi.spyOn(reader, "read").mockImplementation(() => {
            reading.resolve();
            return read();
          });
          return reader;
        });
      }
      return response;
    });
    try {
      const { registry } = fixture();
      const result = run(registry, fetch, controller.signal);
      const rejected = expect(result).rejects.toThrow("cancelled");
      await received.promise;
      if (bodyStarted) await reading.promise;
      controller.abort(SECRET);
      await rejected;
      await closed.promise;
      expect(fetch).toHaveBeenCalledTimes(1);
      if (response) expect(response.body?.locked).toBe(false);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
