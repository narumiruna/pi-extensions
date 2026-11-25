export function isForegroundDirection(operation: string): boolean {
  return operation === "push.foreground" || operation === "pull.foreground";
}

export type ForegroundQueueOutcome =
  | { foregroundQueueCleanup: "before-mutation" }
  | { foregroundQueueCleanup: "resume-adoption"; journal: string }
  | { foregroundQueueCleanup: "verified-result"; result: unknown };

export function isForegroundQueueOutcome(value: unknown): value is ForegroundQueueOutcome {
  if (!value || typeof value !== "object" || !("foregroundQueueCleanup" in value)) return false;
  return (
    value.foregroundQueueCleanup === "before-mutation" ||
    (value.foregroundQueueCleanup === "resume-adoption" &&
      "journal" in value &&
      typeof value.journal === "string" &&
      /^[a-f0-9]{64}$/u.test(value.journal)) ||
    (value.foregroundQueueCleanup === "verified-result" && Object.hasOwn(value, "result"))
  );
}
