export function isForegroundDirection(operation: string): boolean {
  return operation === "push.foreground" || operation === "pull.foreground";
}

export type ForegroundQueueOutcome =
  | { foregroundQueueCleanup: "before-mutation" }
  | { foregroundQueueCleanup: "verified-result"; result: unknown };

export function isForegroundQueueOutcome(value: unknown): value is ForegroundQueueOutcome {
  if (!value || typeof value !== "object" || !("foregroundQueueCleanup" in value)) return false;
  return (
    value.foregroundQueueCleanup === "before-mutation" ||
    (value.foregroundQueueCleanup === "verified-result" && Object.hasOwn(value, "result"))
  );
}
