import { SyncBackendConflictError } from "../backends/sync-backend.js";

export type ContinuousErrorKind =
  | "transient"
  | "contention"
  | "stale"
  | "authentication"
  | "storage"
  | "unsafe"
  | "model"
  | "budget"
  | "unknown";

/** Categories are safe to persist; provider messages and causes are not. */
export class ContinuousError extends Error {
  constructor(
    readonly kind: ContinuousErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ContinuousError";
  }
}

export function continuousFailure(error: unknown): { kind: ContinuousErrorKind; retry: boolean; delay?: number } {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current) && seen.size < 8; ) {
    seen.add(current);
    if (current instanceof ContinuousError)
      return {
        kind: current.kind,
        retry: ["transient", "contention", "stale", "budget"].includes(current.kind),
        delay: current.retryAfterMs,
      };
    if (current instanceof SyncBackendConflictError) return { kind: "stale", retry: true };
    if (typeof current !== "object") break;
    const value = current as {
      status?: unknown;
      code?: unknown;
      name?: unknown;
      cause?: unknown;
      retryAfterMs?: unknown;
    };
    if (value.status === 401 || value.status === 403) return { kind: "authentication", retry: false };
    if (
      value.status === 408 ||
      value.status === 429 ||
      (typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 500 && value.status <= 599)
    )
      return { kind: "transient", retry: true, delay: boundedRetryDelay(value.retryAfterMs) };
    if (value.code === "ELOCKED") return { kind: "contention", retry: true };
    if (value.code === "ECOMPROMISED") return { kind: "stale", retry: true };
    if (
      value.name === "TimeoutError" ||
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(String(value.code))
    )
      return { kind: "transient", retry: true };
    if (["EACCES", "EPERM", "ENOSPC", "EROFS", "EIO"].includes(String(value.code)))
      return { kind: "storage", retry: false };
    current = value.cause;
  }
  return { kind: "unknown", retry: false };
}

export function boundedRetryDelay(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, 300_000) : undefined;
}

export function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return;
  const seconds = Number(value);
  return boundedRetryDelay(Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now());
}
