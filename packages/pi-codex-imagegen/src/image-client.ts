import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations";
export const AUTH_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 300_000;
// Image endpoints can finish generation before sending headers. Allow the full
// request budget rather than applying an ordinary short metadata-request limit.
export const HEADERS_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
export const MAX_PROMPT_CHARS = 32_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_RESPONSE_BYTES = MAX_BASE64_CHARS + 64 * 1024;

export type ImageAuthRegistry = Pick<
  ModelRegistry,
  "getAll" | "getProvider" | "isUsingOAuth" | "getProviderAuth" | "getProviderAuthStatus"
>;

type ImageRequest = { prompt: string; transparentBackground: boolean };
type RequestOptions = {
  signal: AbortSignal;
  isCurrent?: () => boolean;
  fetch?: typeof globalThis.fetch;
};

const PROVIDER = "openai-codex";
const AUTH_ERROR = "Cannot resolve compatible Pi Codex OAuth. Sign in to openai-codex through Pi and try again.";
const CANCELLED = "Image generation cancelled. The server may still consume quota.";
const INVALID_RESPONSE = "The image endpoint returned invalid image JSON. No automatic retry was made.";
const REQUEST_TIMEOUT_ERROR =
  "Image generation timed out. No automatic retry was made; the server may still consume quota.";

class ImageClientError extends Error {}

function fail(message: string): never {
  throw new ImageClientError(message);
}

function isCanonicalBaseUrl(value: unknown): boolean {
  // Accept Pi's provider root and Codex's API root, not URL-normalized aliases.
  return (
    value === "https://chatgpt.com/backend-api" ||
    value === "https://chatgpt.com/backend-api/" ||
    value === "https://chatgpt.com/backend-api/codex" ||
    value === "https://chatgpt.com/backend-api/codex/"
  );
}

function compatibleMetadata(registry: ImageAuthRegistry) {
  const model = registry.getAll().find((candidate) => candidate.provider === PROVIDER);
  const provider = registry.getProvider(PROVIDER);
  if (!model || !provider || provider.id !== PROVIDER) {
    fail("Pi openai-codex is unavailable. Configure its provider and sign in through Pi.");
  }
  const status = registry.getProviderAuthStatus(PROVIDER);
  if (!status.configured) fail("Pi openai-codex authentication is missing. Sign in through Pi.");
  if (!registry.isUsingOAuth(model) || !provider.auth.oauth) {
    fail("Image generation requires Pi openai-codex OAuth, not an API key or another OpenAI login.");
  }
  if (!isCanonicalBaseUrl(provider.baseUrl) || !isCanonicalBaseUrl(model.baseUrl)) {
    fail("Image generation requires the canonical ChatGPT backend. Custom provider endpoints are not supported.");
  }
  return status;
}

/** Read public, non-secret metadata only. This does not resolve or refresh auth. */
export function getImageAuthStatus(registry: ImageAuthRegistry): string {
  try {
    const status = compatibleMetadata(registry);
    const sources = {
      stored: "stored Pi auth",
      runtime: "runtime auth",
      environment: "environment auth",
      fallback: "fallback auth",
      models_json_key: "models.json auth",
      models_json_command: "models.json auth command",
    };
    // Never display arbitrary labels or provider-supplied strings.
    const source = status.source && Object.hasOwn(sources, status.source) ? sources[status.source] : undefined;
    return `Pi openai-codex OAuth configured${source ? ` (${source})` : ""}. Endpoint access is unverified.`;
  } catch (error) {
    return error instanceof ImageClientError ? error.message : "Pi Codex authentication metadata is unavailable.";
  }
}

function accountIdFromToken(token: unknown): { token: string; accountId: string } {
  if (typeof token !== "string" || token.length > 32 * 1024) fail(AUTH_ERROR);
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(part)))
    fail(AUTH_ERROR);
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8"));
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (
      !isObject(header) ||
      typeof header.alg !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(header.alg) ||
      header.alg.toLowerCase() === "none"
    )
      fail(AUTH_ERROR);
    const claim = isObject(payload) ? payload["https://api.openai.com/auth"] : undefined;
    const accountId = isObject(claim) ? claim.chatgpt_account_id : undefined;
    if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(accountId)) fail(AUTH_ERROR);
    // Pi owns token refresh. This parses the account claim, not a signature verification.
    return { token, accountId };
  } catch {
    return fail(AUTH_ERROR);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cancelBody(response: Response): void {
  // Never wait for an uncooperative transport's cancellation acknowledgement.
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cleanup cannot expose transport errors or replace the original failure.
  }
}

function statusError(status: number): never {
  if (status === 401) fail("Image authentication was rejected (401). Sign in to openai-codex through Pi again.");
  if (status === 403) fail("Image access was denied (403). Check account entitlement and organization policy.");
  if (status === 429)
    fail("The image quota or rate limit was reached (429). Check your account limits before trying again.");
  if (status >= 300 && status < 400) fail("The image endpoint returned a redirect. Redirects are not allowed.");
  fail(
    "The image endpoint rejected the request. Check service availability before trying again; no automatic retry was made.",
  );
}

/** Send exactly one request. Pi owns auth refresh; late auth results are not consumed. */
export async function generateImageRequest(
  registry: ImageAuthRegistry,
  request: ImageRequest,
  options: RequestOptions,
): Promise<{ base64: string; requestId?: string }> {
  const controller = new AbortController();
  const abort = (message: string) => {
    if (!controller.signal.aborted) controller.abort(new ImageClientError(message));
  };
  const onAbort = () => abort(CANCELLED);
  options.signal.addEventListener("abort", onAbort, { once: true });
  const expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
  const totalTimer = setTimeout(() => abort(REQUEST_TIMEOUT_ERROR), REQUEST_TIMEOUT_MS);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const checkCurrent = () => {
    if (options.signal.aborted || options.isCurrent?.() === false) abort(CANCELLED);
    if (Date.now() >= expiresAt) abort(REQUEST_TIMEOUT_ERROR);
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  // Race even APIs which ignore AbortSignal. Each race removes its own listener.
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const signal = controller.signal;
      const aborted = () => {
        signal.removeEventListener("abort", aborted);
        reject(signal.reason);
      };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  const deadline = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
    const timer = setTimeout(() => abort(message), ms);
    try {
      return await wait(promise);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    checkCurrent();
    const { prompt, transparentBackground } = request;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      fail("The image prompt must contain 1 to 32,000 characters and cannot be blank.");
    }
    if (typeof transparentBackground !== "boolean") fail("The background choice must be a boolean.");
    compatibleMetadata(registry);
    let resolved: Awaited<ReturnType<ImageAuthRegistry["getProviderAuth"]>>;
    try {
      // The public facade has no signal argument. Only this wait can be cancelled.
      resolved = await deadline(
        registry.getProviderAuth(PROVIDER),
        AUTH_TIMEOUT_MS,
        "Pi Codex authentication timed out. Try signing in through Pi again.",
      );
    } catch {
      checkCurrent();
      fail(AUTH_ERROR);
    }
    checkCurrent();
    compatibleMetadata(registry);
    if (!resolved || (resolved.auth.baseUrl !== undefined && !isCanonicalBaseUrl(resolved.auth.baseUrl)))
      fail(AUTH_ERROR);
    const { token, accountId } = accountIdFromToken(resolved.auth.apiKey);
    checkCurrent();
    // There is no public Pi helper for arbitrary HTTP operations. Use runtime fetch;
    // proxy support is runtime-dependent, not Pi's provider/WebSocket proxy handling.
    const pending = (options.fetch ?? globalThis.fetch)(IMAGE_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-ID": accountId,
        originator: "pi-codex-imagegen",
        "User-Agent": "pi-codex-imagegen",
      },
      body: JSON.stringify({
        prompt,
        background: transparentBackground ? "transparent" : "opaque",
        model: "gpt-image-2",
        quality: "auto",
        size: "auto",
      }),
    });
    // A fetch implementation may return after abort. Close its body without using it.
    void pending.then(
      (late) => {
        if (controller.signal.aborted) cancelBody(late);
      },
      () => undefined,
    );
    response = await deadline(
      pending,
      HEADERS_TIMEOUT_MS,
      "The image endpoint response headers timed out. No automatic retry was made.",
    );
    checkCurrent();
    if (response.redirected) fail("The image endpoint returned a redirect. Redirects are not allowed.");
    if (!response.ok) statusError(response.status);
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
      fail(INVALID_RESPONSE);
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
      fail("The image response exceeds the size limit.");
    if (!response.body) fail(INVALID_RESPONSE);
    reader = response.body.getReader();
    // A growing buffer also bounds allocation overhead for one-byte chunks.
    let body = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    // The total deadline also bounds every body read, including stalled streams.
    for (;;) {
      const chunk = await wait(reader.read());
      checkCurrent();
      if (chunk.done) break;
      const nextSize = bytes + chunk.value.byteLength;
      if (nextSize > MAX_RESPONSE_BYTES) fail("The image response exceeds the size limit.");
      if (nextSize > body.byteLength) {
        const next = Buffer.allocUnsafe(Math.min(MAX_RESPONSE_BYTES, Math.max(nextSize, body.byteLength * 2)));
        body.copy(next, 0, 0, bytes);
        body = next;
      }
      body.set(chunk.value, bytes);
      bytes = nextSize;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, bytes)));
    } catch {
      fail(INVALID_RESPONSE);
    }
    checkCurrent();
    if (!isObject(parsed) || !Array.isArray(parsed.data) || parsed.data.length !== 1) fail(INVALID_RESPONSE);
    const image: unknown = parsed.data[0];
    if (!isObject(image) || typeof image.b64_json !== "string" || !image.b64_json.trim()) fail(INVALID_RESPONSE);
    const base64 = image.b64_json;
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    if (base64.length > MAX_BASE64_CHARS || Math.floor((base64.length * 3) / 4) - padding > MAX_IMAGE_BYTES) {
      fail("The generated image exceeds the size limit.");
    }
    const requestId = response.headers.get("x-codex-imagegen-request-id");
    // Only the nested image ID is defined by Codex; do not expose arbitrary headers.
    return {
      base64,
      ...(requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? { requestId } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof ImageClientError) throw error;
    return fail("Image generation failed. Check Pi authentication and network access; no automatic retry was made.");
  } finally {
    clearTimeout(totalTimer);
    options.signal.removeEventListener("abort", onAbort);
    if (reader) {
      try {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } catch {
        // Cleanup is best effort and must not disclose transport errors.
      }
    } else if (response) {
      cancelBody(response);
    }
  }
}
