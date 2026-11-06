import { createHash, createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { encodeKey, posixJoin } from "../../paths.js";
import { retryAfter } from "../../sync/continuous-errors.js";
import type { RemoteObject, ResolvedS3Backend } from "../backend-types.js";

const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function iso8601Basic(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function isCloudflareR2Endpoint(endpoint: string | undefined) {
  const value = endpoint?.trim();
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "r2.cloudflarestorage.com" || hostname.endsWith(".r2.cloudflarestorage.com");
  } catch {
    return false;
  }
}

export class S3ObjectAlreadyExistsError extends Error {
  constructor(readonly key: string) {
    super(`S3 object already exists: ${key}`);
    this.name = "S3ObjectAlreadyExistsError";
  }
}

export class S3HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "S3HttpError";
  }
}

export class S3Client {
  private config: ResolvedS3Backend;
  private endpoint: URL;
  private signal?: AbortSignal;
  private requestTimeoutMs: number;
  private omitSessionTokenAfterRejection = false;

  constructor(config: ResolvedS3Backend, signal?: AbortSignal, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.config = config;
    this.endpoint = new URL(config.profile.endpoint);
    this.signal = signal;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /** Read-only access probe. A bare 404 cannot distinguish a missing key from a missing bucket. */
  async diagnoseRead(key: string): Promise<"readable" | "missing-key" | "missing-bucket" | "unknown-404"> {
    this.signal?.throwIfAborted();
    const response = await this.request("GET", key);
    if (response.ok) {
      await response.body?.cancel();
      this.signal?.throwIfAborted();
      return "readable";
    }
    const detail = await this.readErrorText(response);
    this.signal?.throwIfAborted();
    if (response.status === 404) {
      const code = /<Code>\s*([A-Za-z]+)\s*<\/Code>/u.exec(detail)?.[1];
      if (code === "NoSuchBucket") return "missing-bucket";
      if (code === "NoSuchKey") return "missing-key";
      return "unknown-404";
    }
    throw new S3HttpError(`S3 remote read failed (HTTP ${response.status}).`, response.status);
  }

  async getJson<T>(key: string): Promise<RemoteObject<T>> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const object = await this.request("GET", key);
      if (object.status === 404) return { missing: true };
      if (!object.ok) {
        throw new S3HttpError(
          `S3 GET failed (${object.status}): ${await this.readErrorText(object)}`,
          object.status,
          retryAfter(object),
        );
      }
      const body = await readBoundedText(object, MAX_JSON_RESPONSE_BYTES, "S3 JSON response");
      // R2 can intermittently return an empty 200 body (read-after-write
      // inconsistency on a long-lived keep-alive connection), which makes
      // response.json() throw "JSON Parse error: Unexpected EOF" under Bun.
      // Retry so the transient blip is absorbed instead of surfacing as a
      // "pi-sync auto sync skipped" warning on every session start.
      if (body.length > 0) {
        return {
          value: JSON.parse(body) as T,
          etag: normalizeEtag(object.headers.get("etag")),
          missing: false,
        };
      }
      lastError = new Error(`S3 GET returned an empty body for ${key}`);
      if (attempt < maxAttempts) {
        await sleep(250 * attempt, undefined, { signal: this.signal });
      }
    }
    throw lastError;
  }

  async getBuffer(key: string): Promise<RemoteObject<Buffer>> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const object = await this.request("GET", key);
      if (object.status === 404) return { missing: true };
      if (!object.ok) {
        throw new S3HttpError(
          `S3 GET failed (${object.status}): ${await this.readErrorText(object)}`,
          object.status,
          retryAfter(object),
        );
      }
      const buffer = await readBoundedBuffer(object, MAX_SNAPSHOT_RESPONSE_BYTES, "S3 snapshot response");
      // R2 can intermittently return an empty 200 body on a long-lived
      // keep-alive connection (same root cause as the getJson retry
      // above). getBuffer is only used for snapshot .json.gz payloads,
      // which are always non-empty, so an empty body is a transient
      // blip, not a legitimate response. Retry so the checksum guard
      // downstream doesn't surface it as "Remote snapshot checksum
      // mismatch".
      if (buffer.length > 0) {
        return { value: buffer, etag: normalizeEtag(object.headers.get("etag")), missing: false };
      }
      lastError = new Error(`S3 GET returned an empty body for ${key}`);
      if (attempt < maxAttempts) {
        await sleep(250 * attempt, undefined, { signal: this.signal });
      }
    }
    throw lastError;
  }

  async putJson(key: string, value: unknown, options: { ifAbsent?: boolean; ifMatch?: string } = {}) {
    const body = Buffer.from(JSON.stringify(value, null, "\t"), "utf8");
    await this.putBuffer(key, body, "application/json", options);
  }

  async putBuffer(
    key: string,
    body: Buffer,
    contentType: string,
    options: { ifAbsent?: boolean; ifMatch?: string } = {},
  ) {
    const headers: Record<string, string> = { "content-type": contentType };
    if (options.ifAbsent) headers["if-none-match"] = "*";
    if (options.ifMatch) headers["if-match"] = options.ifMatch;
    const response = await this.request("PUT", key, body, headers);
    if ((options.ifAbsent || options.ifMatch) && (response.status === 412 || response.status === 409)) {
      await response.body?.cancel();
      if (options.ifAbsent && response.status === 412) throw new S3ObjectAlreadyExistsError(key);
      if (options.ifAbsent || options.ifMatch) {
        throw new S3HttpError(`S3 conditional PUT rejected (${response.status}).`, response.status);
      }
    }
    if (!response.ok) {
      throw new S3HttpError(
        `S3 PUT failed (${response.status}): ${await this.readErrorText(response)}`,
        response.status,
        retryAfter(response),
      );
    }
    await response.body?.cancel();
  }

  async delete(key: string) {
    const response = await this.request("DELETE", key);
    if (!response.ok && response.status !== 404) {
      throw new S3HttpError(
        `S3 DELETE failed (${response.status}): ${await this.readErrorText(response)}`,
        response.status,
        retryAfter(response),
      );
    }
    await response.body?.cancel();
  }

  private async request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ) {
    const url = new URL(this.endpoint.toString());
    // Preserve escaped endpoint bytes without decoding or double-encoding them.
    // SigV4 requires uppercase escape hex, including existing endpoint escapes.
    const endpointPath = url.pathname
      .replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9._~/%-]/gu, encodeKey)
      .replace(/%[0-9A-Fa-f]{2}/gu, (escaped) => escaped.toUpperCase());
    url.pathname = posixJoin(endpointPath, encodeKey(this.config.destination.bucket), encodeKey(key));
    const send = async (sessionToken: string | undefined) => {
      const transportSignal = this.transportSignal();
      const headers = await signedHeaders({
        method,
        url,
        body,
        // Transfer compression can weaken an object's ETag (R2 JSON responses).
        // Read the original representation for exact checksums and strong If-Match tokens.
        extraHeaders: method === "GET" ? { ...extraHeaders, "accept-encoding": "identity" } : extraHeaders,
        accessKeyId: this.config.profile.accessKeyId,
        secretAccessKey: this.config.profile.secretAccessKey,
        sessionToken,
        region: this.config.profile.region,
      });
      try {
        return await fetch(url, {
          method,
          headers,
          body: body ? new Uint8Array(body) : undefined,
          // Never forward signed headers or snapshot bodies to an unreviewed URL.
          redirect: "error",
          signal: transportSignal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new Error("S3 request timed out.", { cause: error });
        }
        throw new Error(`S3 request failed: ${this.redact(errorMessage(error))}`, { cause: error });
      }
    };
    const sessionToken = this.omitSessionTokenAfterRejection ? undefined : this.config.profile.sessionToken;
    const response = await send(sessionToken);
    try {
      if (!(await this.shouldRetryWithoutSessionToken(response, sessionToken))) return response;
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    await response.body?.cancel();
    const retry = await send(undefined);
    if (retry.ok || retry.status === 404) this.omitSessionTokenAfterRejection = true;
    return retry;
  }

  private transportSignal() {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  private async shouldRetryWithoutSessionToken(response: Response, sessionToken: string | undefined) {
    if (
      !sessionToken ||
      !isCloudflareR2Endpoint(this.config.profile.endpoint) ||
      response.ok ||
      response.status !== 400
    ) {
      return false;
    }
    return isSecurityTokenInvalidArgument(
      await readBoundedText(response.clone(), MAX_ERROR_RESPONSE_BYTES, "S3 error response"),
    );
  }

  private async readErrorText(response: Response) {
    try {
      return this.redact(await readBoundedText(response, MAX_ERROR_RESPONSE_BYTES, "S3 error response"));
    } catch (error) {
      return this.redact(errorMessage(error));
    }
  }

  private redact(value: string) {
    let redacted = value;
    let endpointUsername: string | undefined;
    let endpointPassword: string | undefined;
    let endpointQueryValues: string[] = [];
    try {
      const endpoint = new URL(this.config.profile.endpoint);
      endpointUsername = endpoint.username;
      endpointPassword = endpoint.password;
      endpointQueryValues = [...endpoint.searchParams.values()];
    } catch {
      // The constructor already validates normal runtime endpoints.
    }
    for (const secret of [
      this.config.profile.accessKeyId,
      this.config.profile.secretAccessKey,
      this.config.profile.sessionToken,
      endpointUsername,
      endpointPassword,
      ...endpointQueryValues,
    ]) {
      if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  }
}

async function readBoundedText(response: Response, limit: number, label: string) {
  return (await readBoundedBuffer(response, limit, label)).toString("utf8");
}

async function readBoundedBuffer(response: Response, limit: number, label: string) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    // Do not await cancellation of a cloned stream before its sibling can be released.
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} exceeds the ${limit}-byte limit.`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeds the ${limit}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function signedHeaders(input: {
  method: string;
  url: URL;
  body?: Buffer;
  extraHeaders: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}) {
  const now = new Date();
  const amzDate = iso8601Basic(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(input.body ?? Buffer.alloc(0));
  const headers: Record<string, string> = {
    ...lowercaseKeys(input.extraHeaders),
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]?.trim()}\n`).join("");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    input.url.searchParams.toString(),
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(Buffer.from(canonicalRequest))].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(Buffer.from(`AWS4${input.secretAccessKey}`), dateStamp), input.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
  };
}

function hmac(key: Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function lowercaseKeys(value: Record<string, string>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item]));
}

function normalizeEtag(value: string | null) {
  return value ?? undefined;
}

function isSecurityTokenInvalidArgument(text: string) {
  return text.includes("<Code>InvalidArgument</Code>") && text.includes("<Message>X-Amz-Security-Token</Message>");
}
