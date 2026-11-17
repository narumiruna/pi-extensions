import { type EngineContext, engineHost } from "../host.js";
import type { ContinuousErrorKind } from "../sync/continuous-errors.js";

const enabled = new WeakMap<EngineContext["sessionManager"], boolean>();
export type SyncStatusPresentation = { activity: string; reason?: string };
const reasons: Record<ContinuousErrorKind, string> = {
  transient: "temp",
  contention: "busy",
  stale: "stale",
  authentication: "auth",
  storage: "storage",
  unsafe: "review",
  model: "model",
  budget: "limit",
  unknown: "unknown",
};
export function syncStatusFailureReason(kind: ContinuousErrorKind | undefined) {
  return kind && Object.hasOwn(reasons, kind) ? reasons[kind] : "unknown";
}
export function configureSyncStatus(ctx: EngineContext, value: boolean) {
  enabled.set(ctx.sessionManager, value);
  if (!value) setSyncStatus(ctx, undefined);
}
export function setSyncStatus(ctx: EngineContext, value: string | undefined, presentation?: SyncStatusPresentation) {
  if (!ctx.hasUI || (value !== undefined && enabled.get(ctx.sessionManager) === false)) return;
  const host = engineHost();
  if (host.status) host.status(ctx, value, presentation);
  else ctx.ui.setStatus("sync", value);
}
