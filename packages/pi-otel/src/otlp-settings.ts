import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";

export interface OtlpRuntimeConfig {
  endpoint: string;
  /** Requires HTTPS unless the endpoint uses a loopback IP. */
  headers?: Readonly<Record<string, string>>;
  serviceName?: string;
}

export type OtlpConnection = Required<OtlpRuntimeConfig>;

const RESERVED_HEADERS = new Set([
  "__proto__",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
  "user-agent",
]);

export function normalizeOtlpConnection(input: Readonly<Record<string, unknown>>): OtlpConnection {
  const url = parseHttpUrl(input.endpoint);
  if (!url) {
    throw new Error("OTLP endpoint must be a full HTTP or HTTPS URL without credentials, a query, or a fragment.");
  }
  const serviceName = input.serviceName === undefined ? "pi" : input.serviceName;
  if (typeof serviceName !== "string" || !serviceName.trim()) {
    throw new Error("OTLP serviceName must be a non-empty string.");
  }
  const headers = normalizeHeaders(input.headers);
  // URL canonicalizes numeric IPs. Do not trust DNS or hosts-file aliases with cleartext credentials.
  const loopback = (url.hostname.startsWith("127.") && isIP(url.hostname) === 4) || url.hostname === "[::1]";
  if (Object.keys(headers).length > 0 && url.protocol === "http:" && !loopback) {
    throw new Error("OTLP headers require HTTPS unless the endpoint uses a loopback IP (127.0.0.0/8 or [::1]).");
  }
  return { endpoint: url.href, headers, serviceName: serviceName.trim() };
}

function parseHttpUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !/^https?:\/\//iu.test(value.trim()) || /[?#]/u.test(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function normalizeHeaders(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("OTLP headers must be an object of literal HTTP header names and values.");
  }
  const entries = new Map<string, string>();
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    try {
      validateHeaderName(name);
      if (typeof value !== "string" || !value.trim() || RESERVED_HEADERS.has(key) || entries.has(key)) {
        throw new Error("Invalid header");
      }
      validateHeaderValue(name, value);
      entries.set(key, value.trim());
    } catch {
      // Neither the header name nor its value is safe to include in a diagnostic.
      throw new Error("OTLP headers contain an invalid, reserved, empty, or duplicate HTTP header.");
    }
  }
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

export function otlpSecrets(headers: Readonly<Record<string, string>>): string[] {
  const auth = headers.authorization;
  const token = auth?.match(/^\S+\s+(.+)$/u)?.[1];
  return [...new Set([...Object.values(headers), ...(token ? [token] : [])])].sort((a, b) => b.length - a.length);
}
