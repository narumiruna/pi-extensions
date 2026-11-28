import { record } from "../protocol.js";

const selections = ["same", "different", "legacy", "unavailable"] as const;
const failures = ["settings-changed", "timeout", "permission", "storage", "unavailable"] as const;
export type DebugCheckOrigin = "startup" | "recheck";
export type DebugCheckSummary =
  | {
      outcome: "checked";
      baseline: boolean;
      localChanged: boolean;
      remoteChanged: boolean;
      remoteSnapshot: boolean;
      localFiles: number;
      selection: (typeof selections)[number];
    }
  | { outcome: "failed"; reason: (typeof failures)[number] };
export type DebugCheckEvent = {
  event: "check";
  origin: DebugCheckOrigin;
  setupKey: string;
  summary: DebugCheckSummary;
  operationId?: string;
};

export function summarizeDebugInspection(value: unknown): DebugCheckSummary | undefined {
  if (!record(value)) return;
  return validateDebugCheckSummary({
    outcome: "checked",
    baseline: typeof value.firstSync === "boolean" ? !value.firstSync : undefined,
    localChanged: value.localChanged,
    remoteChanged: value.remoteChanged,
    remoteSnapshot: value.head === undefined || record(value.head) ? value.head !== undefined : undefined,
    localFiles: value.localFiles,
    selection: record(value.selectionState) ? value.selectionState.kind : "unavailable",
  });
}

export function debugCheckFailure(error: unknown): Extract<DebugCheckSummary, { outcome: "failed" }> {
  const fields = record(error) ? error : {};
  const status = fields.status;
  const reason =
    fields.code === "SYNC_INSPECTION_CHANGED"
      ? "settings-changed"
      : fields.name === "TimeoutError" || fields.code === "ETIMEDOUT"
        ? "timeout"
        : status === 401 || status === 403
          ? "permission"
          : typeof status === "number" && status >= 400
            ? "storage"
            : "unavailable";
  return { outcome: "failed", reason };
}

export function validateDebugCheckSummary(value: unknown): DebugCheckSummary | undefined {
  if (!record(value)) return;
  if (value.outcome === "failed") {
    const reason = failures.find((item) => item === value.reason);
    return reason ? { outcome: "failed", reason } : undefined;
  }
  const selection = selections.find((item) => item === value.selection);
  if (
    value.outcome !== "checked" ||
    typeof value.baseline !== "boolean" ||
    typeof value.localChanged !== "boolean" ||
    typeof value.remoteChanged !== "boolean" ||
    typeof value.remoteSnapshot !== "boolean" ||
    typeof value.localFiles !== "number" ||
    !Number.isSafeInteger(value.localFiles) ||
    value.localFiles < 0 ||
    !selection ||
    (!value.remoteSnapshot && selection !== "unavailable")
  )
    return;
  return {
    outcome: "checked",
    baseline: value.baseline,
    localChanged: value.localChanged,
    remoteChanged: value.remoteChanged,
    remoteSnapshot: value.remoteSnapshot,
    localFiles: value.localFiles,
    selection,
  };
}
