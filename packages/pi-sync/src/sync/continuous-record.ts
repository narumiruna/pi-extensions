import type { AnySyncConfig } from "../settings/settings-types.js";
import { withLock } from "../state/lock.js";
import { withStateDirectoryAccess } from "../state/state-directory.js";
import { ContinuousError, type ContinuousErrorKind } from "./continuous-errors.js";
import { type ContinuousLease, continuousLeaseOwner } from "./continuous-lease.js";
import {
  CONTINUOUS_RECORD_MAX_BYTES,
  continuousBinding,
  readContinuousPrivate,
  readContinuousPrivateDocument,
  writeContinuousPrivate,
} from "./continuous-storage.js";

export const REQUEST_WINDOW_MS = 15 * 60_000;
export interface ContinuousRecord {
  version: 1;
  binding: string;
  pending: boolean;
  phase: "waiting" | "syncing" | "retry" | "blocked";
  next: number;
  failures: number;
  evidence?: string;
  recovery?: string;
  notice?: string;
  configuration?: string;
  error?: ContinuousErrorKind;
  checked?: number;
  transferred?: number;
  calls: { key: string; at: number }[];
  attempts: Record<string, number>;
}
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
export function validateContinuousRecord(value: unknown, binding: string): asserts value is ContinuousRecord {
  const record = value as ContinuousRecord;
  if (
    !record ||
    typeof record !== "object" ||
    record.version !== 1 ||
    record.binding !== binding ||
    Object.keys(record).some(
      (key) =>
        ![
          "version",
          "binding",
          "pending",
          "phase",
          "next",
          "failures",
          "evidence",
          "recovery",
          "notice",
          "configuration",
          "error",
          "checked",
          "transferred",
          "calls",
          "attempts",
        ].includes(key),
    ) ||
    typeof record.pending !== "boolean" ||
    !["waiting", "syncing", "retry", "blocked"].includes(record.phase) ||
    !timestamp(record.next) ||
    !timestamp(record.failures) ||
    record.failures > 30 ||
    (record.evidence !== undefined && !digest(record.evidence)) ||
    (record.recovery !== undefined && !digest(record.recovery)) ||
    (record.notice !== undefined && !digest(record.notice)) ||
    (record.configuration !== undefined && !digest(record.configuration)) ||
    (record.error !== undefined &&
      ![
        "transient",
        "contention",
        "stale",
        "authentication",
        "storage",
        "unsafe",
        "model",
        "budget",
        "unknown",
      ].includes(record.error)) ||
    (record.checked !== undefined && !timestamp(record.checked)) ||
    (record.transferred !== undefined && !timestamp(record.transferred)) ||
    !Array.isArray(record.calls) ||
    record.calls.length > 2 ||
    record.calls.some(
      (call) => !call || Object.keys(call).sort().join(",") !== "at,key" || !digest(call.key) || !timestamp(call.at),
    ) ||
    !record.attempts ||
    typeof record.attempts !== "object" ||
    Array.isArray(record.attempts) ||
    Object.entries(record.attempts).some(
      ([key, count]) => !digest(key) || !Number.isInteger(count) || count < 1 || count > 2,
    ) ||
    record.calls.some(
      (call) => (record.attempts[call.key] ?? 0) < record.calls.filter((other) => other.key === call.key).length,
    )
  )
    throw new Error("Invalid continuous sync state; evidence retained.");
}
function emptyContinuousRecord(binding: string): ContinuousRecord {
  return { version: 1, binding, pending: true, phase: "waiting", next: 0, failures: 0, calls: [], attempts: {} };
}
export async function readContinuousRecord(binding: string): Promise<ContinuousRecord> {
  const value = await readContinuousPrivate(`${binding}.json`);
  if (value === undefined) return emptyContinuousRecord(binding);
  validateContinuousRecord(value, binding);
  return value;
}
export async function updateContinuousRecord<T>(
  binding: string,
  lease: ContinuousLease,
  update: (record: ContinuousRecord) => T,
): Promise<T> {
  return withStateDirectoryAccess(() =>
    withLock("continuous-state", async () => {
      lease.assert();
      const record = await readContinuousRecord(binding);
      lease.assert();
      const result = update(record);
      validateContinuousRecord(record, binding);
      lease.assert();
      await writeContinuousPrivate(`${binding}.json`, record);
      lease.assert();
      return result;
    }),
  );
}
export function normalizeContinuousClock(record: ContinuousRecord, now: number) {
  // A backward wall-clock jump cannot grant more calls: retain them for a full window.
  record.calls = record.calls
    .map((call) => ({ ...call, at: Math.min(call.at, now) }))
    .filter((call) => now - call.at < REQUEST_WINDOW_MS);
  record.next = Math.min(record.next, now + (record.error === "budget" ? REQUEST_WINDOW_MS : 300_000));
}
export async function reserveContinuousRequest(
  binding: string,
  lease: ContinuousLease,
  key: string,
  clock: () => number = Date.now,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!digest(key)) throw new Error("Invalid continuous candidate key.");
  let failure: ContinuousError | undefined;
  await updateContinuousRecord(binding, lease, (record) => {
    signal?.throwIfAborted();
    const now = clock();
    signal?.throwIfAborted();
    normalizeContinuousClock(record, now);
    if ((record.attempts[key] ?? 0) >= 2)
      failure = new ContinuousError(
        "model",
        "Automatic request limit reached for this evidence. Change the evidence or review /sync; Sync now does not reset this limit.",
      );
    else if (record.calls.length >= 2)
      failure = new ContinuousError(
        "budget",
        "Automatic request window is full.",
        Math.max(0, (record.calls[0]?.at ?? now) + REQUEST_WINDOW_MS - now),
      );
    else {
      record.attempts[key] = (record.attempts[key] ?? 0) + 1;
      record.calls.push({ key, at: now });
    }
  });
  // Atomic publication is not interruptible. A reservation written before cancellation stays spent.
  signal?.throwIfAborted();
  if (failure) throw failure;
}

const recoveryActions: Record<ContinuousErrorKind, string> = {
  transient: "Wait for the scheduled retry. Check network and service availability if failures continue.",
  contention: "Wait for the active sync operation to finish. Do not remove a live lock.",
  stale: "Wait for a fresh inspection after the retry delay. Local or remote evidence changed.",
  authentication: "Repair storage or Pi model authentication, then reopen /sync. Do not share credentials.",
  storage: "Repair private-state permissions, free space or storage access. Retain accounting and recovery evidence.",
  unsafe:
    "Remove secrets or repair unsupported conflicts. Changed evidence is inspected again; review /sync if needed.",
  model:
    "Review conflict evidence and Pi model access. Sync now reuses cached refusals; a refusal needs changed evidence or a separately confirmed retry.",
  budget:
    "Wait for the window allowance shown above. Waiting does not restore exhausted candidates or accounting capacity.",
  unknown:
    "Review /sync diagnostics and reconcile pending recovery before retrying. Do not delete private evidence or blindly republish.",
};

function serializedBytes(record: ContinuousRecord): number {
  // Keep this aligned with writeJson's private-document encoding.
  return Buffer.byteLength(`${JSON.stringify(record, null, "\t")}\n`);
}

/** Check space for one reservation without retaining or publishing the synthetic candidate. */
function hasReservationCapacity(record: ContinuousRecord, now: number): boolean {
  const existing = Object.keys(record.attempts).find((key) => record.attempts[key] === 1);
  let key = existing ?? "0".repeat(64);
  if (!existing) {
    for (let index = 1; record.attempts[key] !== undefined; index++) key = index.toString(16).padStart(64, "0");
  }
  return (
    serializedBytes({
      ...record,
      calls: [...record.calls, { key, at: now }],
      attempts: { ...record.attempts, [key]: (record.attempts[key] ?? 0) + 1 },
    }) <= CONTINUOUS_RECORD_MAX_BYTES
  );
}

/** Read-only status: no directory creation, lease, mutation, request reservation or provider call. */
export async function continuousStatusLines(config: AnySyncConfig, clock: () => number = Date.now): Promise<string[]> {
  if (!config.continuous) return ["Continuous sync: Off"];
  if (!config.agentMode) return ["Continuous sync: paused; enable Agent mode first"];
  try {
    const binding = await continuousBinding(config);
    const document = await readContinuousPrivateDocument(`${binding}.json`);
    const record = document === undefined ? emptyContinuousRecord(binding) : document.value;
    validateContinuousRecord(record, binding);
    const bytes = serializedBytes(record);
    // Only this detached read is normalized. A Status read never publishes clock repairs or expires durable calls.
    const now = clock();
    normalizeContinuousClock(record, now);
    const spent = Object.values(record.attempts).filter((count) => count === 2).length;
    const eligible =
      record.calls.length < 2 ? now : Math.min(...record.calls.map((call) => call.at)) + REQUEST_WINDOW_MS;
    const capacityRecord = { ...record, calls: [...record.calls] };
    normalizeContinuousClock(capacityRecord, eligible);
    const available = hasReservationCapacity(capacityRecord, eligible);
    const owner = await continuousLeaseOwner(binding).catch(
      () => "Local scheduler lease: private owner metadata unavailable; retain evidence and repair access",
    );
    return [
      `Continuous sync: ${record.phase}${record.error ? ` (${record.error})` : ""}${document === undefined ? "; no accounting record yet" : ""}`,
      owner,
      "Scheduler owner model: unavailable; the observing session's selected model is not proof of the owner's model.",
      `Automatic requests (rolling 15 minutes, window only): ${record.calls.length}/2 used; ${2 - record.calls.length} remaining.`,
      `Next request eligibility: ${available ? (eligible === now ? "now (window allowance)" : `${new Date(eligible).toISOString()} (window allowance)`) : "unavailable (accounting full)"}. Candidate, capacity, ownership and safety checks still apply.`,
      `Spent candidates: ${spent} exhausted / ${Object.keys(record.attempts).length} tracked; 2 automatic requests per candidate. Expired windows do not clear this limit.`,
      `Accounting: ${bytes}/${CONTINUOUS_RECORD_MAX_BYTES} serialized bytes; ${Math.max(0, CONTINUOUS_RECORD_MAX_BYTES - bytes)} bytes free; ${document?.bytes ?? 0} bytes on disk${available ? "." : "; full for another reservation."}`,
      ...(!available
        ? [
            "Accounting recovery: pause Continuous sync and seek reviewed recovery. Do not delete accounting, prune candidates or reset limits to regain requests.",
          ]
        : []),
      `Last successful background check: ${record.checked !== undefined ? new Date(record.checked).toISOString() : "not yet checked"}`,
      `Last successful background transfer: ${record.transferred !== undefined ? new Date(record.transferred).toISOString() : "none"}`,
      ...(record.phase === "retry" ? [`Next background attempt: ${new Date(record.next).toISOString()}`] : []),
      ...(record.error ? [`Recovery (${record.error}): ${recoveryActions[record.error]}`] : []),
      ...(record.phase === "blocked" && !record.error
        ? ["Review /sync diagnostics and repair changed evidence. Retain private recovery state."]
        : []),
      "Monitoring requires an eligible open Pi session. Status does not spend model requests or clear retry limits.",
    ];
  } catch {
    return [
      "Continuous sync: private state unavailable; usage, eligibility and accounting bytes cannot be verified.",
      `Accounting capacity: ${CONTINUOUS_RECORD_MAX_BYTES} bytes; do not treat unavailable accounting as unused allowance.`,
      "Recovery: pause Continuous sync, retain malformed, unknown or unsafe evidence, and repair private-state access. Do not delete accounting or reset limits.",
    ];
  }
}
