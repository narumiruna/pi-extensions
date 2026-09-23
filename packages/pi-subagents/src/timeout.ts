const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

export function prepareTimeoutArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return args as Record<string, unknown>;
  if (!Object.hasOwn(args, "timeoutMs")) return args as Record<string, unknown>;
  const record = args as Record<string, unknown>;
  if (typeof record.timeoutMs !== "number") return record;
  const { timeoutMs, ...prepared } = record;
  if (prepared.timeout === undefined) return { ...prepared, timeout: timeoutMs / 1000 };
  return prepared;
}
