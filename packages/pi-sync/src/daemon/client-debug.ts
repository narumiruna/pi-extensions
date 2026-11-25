import { type DebugEvent, debugJobResult, debugOperation } from "@narumitw/pi-sync-daemon/engine/debug-log";

export function observeDebugJob(operation: string, append: (event: DebugEvent) => void) {
  const kind = debugOperation(operation);
  if (!kind) return undefined;
  let operationId: string | undefined;
  const record = (outcome: Extract<DebugEvent, { event: "job" }>["outcome"]) =>
    append({ event: "job", operation: kind, outcome, ...(operationId ? { operationId } : {}) });
  return {
    onSubmit(id: string) {
      if (operationId && operationId !== id) record("blocked");
      operationId = id;
      record("started");
    },
    returned(result: unknown, interrupted = false) {
      const outcome = debugJobResult(kind, result);
      if (interrupted && outcome !== "completed") record("cancelled");
      else if (outcome) record(outcome);
      else if (
        result === "archived" ||
        (kind === "initialize" &&
          typeof result === "object" &&
          result !== null &&
          "handoverRequired" in result &&
          result.handoverRequired === true)
      )
        record("blocked");
      else if (
        kind === "migrate-state" &&
        typeof result === "object" &&
        result !== null &&
        "status" in result &&
        result.status === "cancelled"
      )
        record("cancelled");
      else record("completed");
    },
    rejected(error: unknown, cancelled: boolean) {
      if (cancelled || (error instanceof Error && error.name === "AbortError")) record("cancelled");
      else if (
        error instanceof Error &&
        (error.name === "SyncDecisionRequiredError" || error.name === "RemoteSelectionMismatchError")
      )
        record("blocked");
      else record("failed");
    },
  };
}
