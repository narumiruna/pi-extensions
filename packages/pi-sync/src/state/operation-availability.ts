import { errorMessage } from "../sync/sync-errors.js";
import { inspectLock, isLockGuardHeld, isStaleLock, type LockInspection } from "./lock.js";
import type { LockFile } from "./state-types.js";

export type OperationAvailability =
  | { kind: "free" }
  | { kind: "live"; lock: LockFile }
  | { kind: "busy"; lock?: LockFile; metadata: LockInspection["status"] }
  | { kind: "recoverable-stale"; lock: LockFile }
  | { kind: "recoverable-unreadable" }
  | { kind: "inspection-error"; message: string };

interface OperationInspectionDependencies {
  inspectMetadata(): Promise<LockInspection>;
  inspectGuard(): Promise<boolean>;
}

const DEFAULT_INSPECTION_DEPENDENCIES: OperationInspectionDependencies = {
  inspectMetadata: inspectLock,
  inspectGuard: isLockGuardHeld,
};

export async function inspectOperationAvailability(
  dependencies: OperationInspectionDependencies = DEFAULT_INSPECTION_DEPENDENCIES,
): Promise<OperationAvailability> {
  try {
    const metadata = await dependencies.inspectMetadata();
    const guardHeld = await dependencies.inspectGuard();
    return classifyOperationAvailability(metadata, guardHeld);
  } catch (error) {
    return { kind: "inspection-error", message: errorMessage(error) };
  }
}

export function classifyOperationAvailability(metadata: LockInspection, guardHeld: boolean): OperationAvailability {
  if (metadata.status === "valid" && !isStaleLock(metadata.lock)) {
    return { kind: "live", lock: metadata.lock };
  }
  if (guardHeld) {
    return {
      kind: "busy",
      metadata: metadata.status,
      ...(metadata.status === "valid" ? { lock: metadata.lock } : {}),
    };
  }
  if (metadata.status === "valid") {
    return { kind: "recoverable-stale", lock: metadata.lock };
  }
  if (metadata.status === "unreadable") return { kind: "recoverable-unreadable" };
  return { kind: "free" };
}

export function operationBlocksChanges(availability: OperationAvailability) {
  return availability.kind !== "free";
}

export function operationCanRecover(availability: OperationAvailability) {
  return availability.kind === "recoverable-stale" || availability.kind === "recoverable-unreadable";
}
