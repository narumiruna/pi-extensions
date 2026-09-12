import { XMLParser } from "fast-xml-parser";
import type { RemoteObject, ResolvedWebDavBackend } from "../backend-types.js";

const JSON_LIMIT = 1024 * 1024;
const ERROR_LIMIT = 64 * 1024;
const SNAPSHOT_LIMIT = 256 * 1024 * 1024;
const XML_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export interface WebDavPutOptions {
  ifAbsent?: boolean;
  ifMatch?: string;
}

export interface WebDavEntry {
  href: string;
  etag?: string;
  collection: boolean;
}

export class WebDavHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebDavHttpError";
  }
}

export class WebDavPreconditionError extends WebDavHttpError {
  constructor(message = "WebDAV precondition failed.") {
    super(message, 412);
    this.name = "WebDavPreconditionError";
  }
}

export class WebDavClient {
  private readonly baseUrl: URL;
  private readonly authorization: string;

  constructor(
    private readonly config: ResolvedWebDavBackend,
    private readonly signal?: AbortSignal,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.baseUrl = new URL(config.profile.url);
    assertSafeAuthenticatedUrl(this.baseUrl);
    if (
      !config.profile.username ||
      !config.profile.password ||
      config.profile.username.includes(":") ||
      hasControlCharacter(config.profile.username) ||
      hasControlCharacter(config.profile.password)
    ) {
      throw new Error("Invalid WebDAV credentials.");
    }
    this.authorization = `Basic ${Buffer.from(`${config.profile.username}:${config.profile.password}`).toString("base64")}`;
  }

  async getBuffer(remotePath: string): Promise<RemoteObject<Buffer>> {
    const response = await this.request(remotePath, { method: "GET" });
    if (response.status === 404) {
      await response.body?.cancel();
      return { missing: true };
    }
    await this.requireOk(response, "read");
    return {
      value: await readBounded(response, SNAPSHOT_LIMIT, "WebDAV response is too large"),
      etag: response.headers.get("etag") ?? undefined,
      missing: false,
    };
  }

  async getJson<T>(remotePath: string): Promise<RemoteObject<T>> {
    const response = await this.request(remotePath, { method: "GET" });
    if (response.status === 404) {
      await response.body?.cancel();
      return { missing: true };
    }
    await this.requireOk(response, "read");
    const bytes = await readBounded(response, JSON_LIMIT, "WebDAV JSON response is too large");
    try {
      return {
        value: JSON.parse(bytes.toString("utf8")) as T,
        etag: response.headers.get("etag") ?? undefined,
        missing: false,
      };
    } catch (error) {
      throw new Error("WebDAV JSON response is malformed.", { cause: error });
    }
  }

  async putBuffer(remotePath: string, body: Buffer, contentType: string, options: WebDavPutOptions = {}) {
    const headers: Record<string, string> = { "content-type": contentType };
    if (options.ifAbsent) headers["if-none-match"] = "*";
    if (options.ifMatch) headers["if-match"] = options.ifMatch;
    const response = await this.request(remotePath, {
      method: "PUT",
      headers,
      body: body as unknown as BodyInit,
    });
    if (response.status === 412) {
      await response.body?.cancel();
      throw new WebDavPreconditionError();
    }
    await this.requireOk(response, "write");
    await response.body?.cancel();
    return response.headers.get("etag") ?? undefined;
  }

  async putJson(remotePath: string, value: unknown, options: WebDavPutOptions = {}) {
    return this.putBuffer(remotePath, Buffer.from(JSON.stringify(value)), "application/json", options);
  }

  async makeCollection(remotePath: string) {
    const response = await this.request(remotePath, { method: "MKCOL" });
    if (response.status === 405) {
      await response.body?.cancel();
      return false;
    }
    await this.requireOk(response, "create collection");
    await response.body?.cancel();
    return true;
  }

  async ensureCollection(remotePath: string) {
    const segments = safeSegments(remotePath);
    for (let index = 1; index <= segments.length; index += 1) {
      await this.makeCollection(segments.slice(0, index).join("/"));
    }
  }

  async listCollection(remotePath: string): Promise<WebDavEntry[]> {
    const response = await this.request(remotePath, {
      method: "PROPFIND",
      headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>',
    });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new WebDavHttpError("WebDAV collection is missing.", 404);
    }
    if (response.status !== 207) await this.requireOk(response, "list collection");
    const xml = (await readBounded(response, XML_LIMIT, "WebDAV directory response is too large")).toString("utf8");
    try {
      const parsed = new XMLParser({
        removeNSPrefix: true,
        ignoreAttributes: false,
        processEntities: false,
      }).parse(xml) as {
        multistatus?: { response?: unknown };
      };
      if (!parsed.multistatus || parsed.multistatus.response === undefined) {
        throw new Error("Missing DAV multistatus response.");
      }
      const responses = asArray(parsed.multistatus.response);
      return responses.map(parseEntry);
    } catch (error) {
      throw new Error("WebDAV directory response is malformed.", { cause: error });
    }
  }

  async delete(remotePath: string) {
    const response = await this.request(remotePath, { method: "DELETE" });
    if (response.status === 404) {
      await response.body?.cancel();
      return;
    }
    if (response.status === 207) {
      await response.body?.cancel();
      throw new WebDavHttpError("WebDAV probe cleanup returned a partial response.", 207);
    }
    await this.requireOk(response, "delete probe resource");
    await response.body?.cancel();
  }

  private async request(remotePath: string, init: RequestInit) {
    throwIfAborted(this.signal);
    let url = appendRemotePath(this.baseUrl, remotePath);
    for (let redirects = 0; ; redirects += 1) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          headers: {
            accept: "*/*",
            authorization: this.authorization,
            ...headersObject(init.headers),
          },
          redirect: "manual",
          signal,
        });
      } catch (error) {
        throwIfAborted(this.signal);
        throw new Error(
          `WebDAV ${String(init.method ?? "GET")} request failed for ${redactText(safeUrl(url), this.config)}.`,
          {
            cause: redactError(error, this.config),
          },
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      const method = String(init.method ?? "GET").toUpperCase();
      if ([301, 302, 303].includes(response.status) && method !== "GET" && method !== "HEAD") {
        throw new Error(
          `WebDAV refused an ambiguous HTTP ${response.status} redirect for ${method}; configure the canonical collection URL or require HTTP 307/308.`,
        );
      }
      if (redirects >= MAX_REDIRECTS) throw new Error("WebDAV redirect limit exceeded.");
      const location = response.headers.get("location");
      if (!location) throw new Error("WebDAV redirect is missing Location.");
      const next = new URL(location, url);
      if (next.origin !== this.baseUrl.origin) {
        throw new Error("WebDAV refused a cross-origin authenticated redirect.");
      }
      url = next;
    }
  }

  private async requireOk(response: Response, action: string) {
    if (response.ok) return;
    const body = (await readBounded(response, ERROR_LIMIT, "WebDAV error body is too large"))
      .toString("utf8")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remote error text is untrusted terminal input.
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .trim();
    const detail = body ? `: ${redactText(body, this.config)}` : "";
    throw new WebDavHttpError(`WebDAV ${action} failed with HTTP ${response.status}${detail}`, response.status);
  }
}

function assertSafeAuthenticatedUrl(url: URL) {
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "Invalid WebDAV URL: HTTPS is required and embedded credentials, query, or fragment are not allowed.",
    );
  }
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

function appendRemotePath(base: URL, remotePath: string) {
  const url = new URL(base);
  const suffix = safeSegments(remotePath).map(encodeURIComponent).join("/");
  url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${suffix}`;
  return url;
}

function safeSegments(value: string) {
  const segments = value
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Remote path segments cannot contain controls.
        /[\u0000-\u001f]/u.test(segment),
    )
  ) {
    throw new Error("Invalid WebDAV remote path.");
  }
  return segments;
}

async function readBounded(response: Response, limit: number, message: string) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel();
    throw new Error(message);
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
      if (total > limit) throw new Error(message);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, total);
}

function parseEntry(value: unknown): WebDavEntry {
  if (!value || typeof value !== "object") throw new Error("Invalid WebDAV response entry.");
  const record = value as Record<string, unknown>;
  const href = typeof record.href === "string" ? record.href : undefined;
  if (!href) throw new Error("Invalid WebDAV response href.");
  const propstat = asArray(record.propstat).find((item) => {
    if (!item || typeof item !== "object") return false;
    return String((item as Record<string, unknown>).status ?? "").includes(" 200 ");
  }) as Record<string, unknown> | undefined;
  const prop = propstat?.prop as Record<string, unknown> | undefined;
  return {
    href,
    etag: typeof prop?.getetag === "string" ? prop.getetag : undefined,
    collection:
      !!prop?.resourcetype && typeof prop.resourcetype === "object" && Object.hasOwn(prop.resourcetype, "collection"),
  };
}

function asArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function headersObject(headers: HeadersInit | undefined) {
  return Object.fromEntries(new Headers(headers).entries());
}

function safeUrl(url: URL) {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function redactError(error: unknown, config: ResolvedWebDavBackend) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactText(message, config));
}

function redactText(value: string, config: ResolvedWebDavBackend) {
  let result = value;
  for (const secret of [config.profile.username, config.profile.password, config.profile.url]) {
    if (!secret) continue;
    for (const variant of new Set([secret, encodeURIComponent(secret)])) {
      result = result.replace(new RegExp(escapeRegExp(variant), "giu"), "[redacted]");
    }
  }
  return result.replace(/basic\s+[a-z0-9+/=]+/giu, "Basic [redacted]").replace(/\?[^\s]*/gu, "?[redacted]");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
