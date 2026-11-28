export type ForegroundTransferIntent = "reject-conflicts" | "review-force";

export function isForegroundTransferIntent(value: unknown): value is ForegroundTransferIntent {
  return value === "reject-conflicts" || value === "review-force";
}

export function isDestinationConflict(value: unknown): value is { outcome: "destination-conflict" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    value.outcome === "destination-conflict" &&
    Object.keys(value).length === 1
  );
}
