import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isForegroundDirection, isForegroundQueueOutcome } from "../foreground-queue-outcome.js";
import { isDestinationConflict } from "../foreground-transfer.js";
import { record } from "../protocol.js";
import { type DebugCheckEvent, validateDebugCheckSummary } from "./debug-check.js";
import { DEBUG_LOG_FILENAME } from "./paths.js";
import { isStartupTimingReport } from "./sync/startup-timings.js";

const OPERATIONS = [
  "initialize",
  "inspect",
  "status",
  "diff",
  "doctor",
  "history",
  "push",
  "pull",
  "push.foreground",
  "pull.foreground",
  "sync",
  "startup-transfer",
  "shutdown",
  "conflicts",
  "rollback",
  "unlock",
  "migrate-state",
  "daemon.authorize",
  "daemon.authorize-connected",
  "daemon.handover",
] as const;
const OUTCOMES = ["started", "completed", "failed", "cancelled", "blocked", "skipped"] as const;
const JOB_ID = /^[a-f0-9]{16}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const MAX_RECORD_BYTES = 4_096;
const MAX_CHECK_READ_BYTES = 64 * 1024;
const SETUP_KEY = /^[a-f0-9]{64}$/u;
const CYCLE_REASONS = [
  "transient",
  "contention",
  "stale",
  "authentication",
  "storage",
  "unsafe",
  "model",
  "budget",
  "unknown",
];

type DebugSource = "pi-sync" | "pi-sync-daemon";
type DebugOperation = (typeof OPERATIONS)[number];
type Outcome = (typeof OUTCOMES)[number];
export type DebugEvent =
  | { event: "startup-timings"; report: string }
  | { event: "connection"; outcome: Exclude<Outcome, "started" | "blocked"> }
  | { event: "lifecycle"; outcome: "starting" | "ready" | "drained" | "failed" }
  | { event: "job"; operation: DebugOperation; outcome: Outcome; operationId?: string }
  | { event: "continuous-cycle"; outcome: Exclude<Outcome, "started">; reason?: string }
  | DebugCheckEvent;

type RecordedCheck = Pick<DebugCheckEvent, "origin" | "summary" | "operationId"> & { time: string };
export type DebugCheckRead =
  | { kind: "recorded"; check: RecordedCheck }
  | { kind: "no-record" }
  | { kind: "unavailable" };

export function debugOperation(operation: string): DebugOperation | undefined {
  return OPERATIONS.find((known) => known === operation);
}

export function debugJobResult(
  operation: string,
  result: unknown,
): "completed" | "cancelled" | "blocked" | "failed" | undefined {
  if (!isForegroundDirection(operation)) return result === "cancelled" ? "cancelled" : undefined;
  if (isForegroundQueueOutcome(result)) {
    if (result.foregroundQueueCleanup !== "verified-result") return "blocked";
    result = result.result;
  }
  if (isDestinationConflict(result)) return "blocked";
  if (result && typeof result === "object" && "outcome" in result) {
    if (result.outcome === "applied") return "completed";
    if (result.outcome === "cancelled") return "cancelled";
  }
  return "failed";
}

function safeFields(event: DebugEvent): DebugEvent | undefined {
  switch (event.event) {
    case "startup-timings":
      if (
        typeof event.report === "string" &&
        event.report.length <= MAX_RECORD_BYTES &&
        isStartupTimingReport(event.report)
      )
        return { event: event.event, report: event.report };
      break;
    case "connection":
      if (["completed", "failed", "cancelled", "skipped"].includes(event.outcome))
        return { event: event.event, outcome: event.outcome };
      break;
    case "lifecycle":
      if (["starting", "ready", "drained", "failed"].includes(event.outcome))
        return { event: event.event, outcome: event.outcome };
      break;
    case "job":
      if (debugOperation(event.operation) && OUTCOMES.includes(event.outcome))
        return {
          event: event.event,
          operation: event.operation,
          outcome: event.outcome,
          ...(typeof event.operationId === "string" && JOB_ID.test(event.operationId)
            ? { operationId: event.operationId }
            : {}),
        };
      break;
    case "check":
      return safeCheckFields(event);
    case "continuous-cycle":
      if (["completed", "failed", "cancelled", "blocked", "skipped"].includes(event.outcome))
        return {
          event: event.event,
          outcome: event.outcome,
          ...(event.reason && CYCLE_REASONS.includes(event.reason) ? { reason: event.reason } : {}),
        };
      break;
  }
}

function safeCheckFields(value: Record<string, unknown>): DebugCheckEvent | undefined {
  const { origin, setupKey, operationId } = value;
  const summary = validateDebugCheckSummary(value.summary);
  if (
    (origin !== "startup" && origin !== "recheck") ||
    typeof setupKey !== "string" ||
    !SETUP_KEY.test(setupKey) ||
    !summary
  )
    return;
  return {
    event: "check",
    origin,
    setupKey,
    summary,
    ...(typeof operationId === "string" && JOB_ID.test(operationId) ? { operationId } : {}),
  };
}

function owned(stat: BigIntStats) {
  return process.getuid === undefined || stat.uid === BigInt(process.getuid());
}

function privateFile(stat: BigIntStats) {
  return (
    stat.isFile() && stat.nlink === 1n && owned(stat) && (process.platform === "win32" || (stat.mode & 0o077n) === 0n)
  );
}

function safeRoot(stat: BigIntStats) {
  return stat.isDirectory() && owned(stat) && (process.platform === "win32" || (stat.mode & 0o022n) === 0n);
}

function sameIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function readLatestDebugCheck(root: string, setupKey: string): DebugCheckRead {
  try {
    const directory = lstatSync(root, { bigint: true });
    if (!SETUP_KEY.test(setupKey) || !safeRoot(directory) || realpathSync(root) !== root)
      return { kind: "unavailable" };
    const target = path.join(root, DEBUG_LOG_FILENAME);
    const previous = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!previous) return { kind: "no-record" };
    if (!privateFile(previous)) return { kind: "unavailable" };
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!privateFile(opened) || !sameIdentity(previous, opened)) return { kind: "unavailable" };
      const length = Number(opened.size < BigInt(MAX_CHECK_READ_BYTES) ? opened.size : BigInt(MAX_CHECK_READ_BYTES));
      const start = opened.size - BigInt(length);
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const read = readSync(fd, bytes, offset, length - offset, start + BigInt(offset));
        if (!read) return { kind: "unavailable" };
        offset += read;
      }
      const current = lstatSync(target, { bigint: true });
      const currentRoot = lstatSync(root, { bigint: true });
      if (
        !privateFile(current) ||
        !sameIdentity(opened, current) ||
        current.size < opened.size ||
        !safeRoot(currentRoot) ||
        !sameIdentity(directory, currentRoot) ||
        realpathSync(root) !== root
      )
        return { kind: "unavailable" };
      const lines = bytes.toString("utf8").split("\n");
      for (let i = lines.length - 2; i >= (start === 0n ? 0 : 1); i--) {
        const line = lines[i];
        if (!line || Buffer.byteLength(line) >= MAX_RECORD_BYTES) continue;
        try {
          const value: unknown = JSON.parse(line);
          if (
            !record(value) ||
            value.event !== "check" ||
            value.setupKey !== setupKey ||
            (value.source !== "pi-sync-daemon" && value.source !== "pi-sync") ||
            typeof value.time !== "string" ||
            value.time.length !== 24 ||
            new Date(value.time).toISOString() !== value.time
          )
            continue;
          const fields = safeCheckFields(value);
          if (fields)
            return {
              kind: "recorded",
              check: {
                time: value.time,
                origin: fields.origin,
                summary: fields.summary,
                ...(fields.operationId ? { operationId: fields.operationId } : {}),
              },
            };
        } catch {}
      }
      return { kind: "no-record" };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { kind: "unavailable" };
  }
}

export function appendDebugEvent(root: string, source: DebugSource, event: DebugEvent): boolean {
  try {
    if (source !== "pi-sync" && source !== "pi-sync-daemon") return false;
    const fields = safeFields(event);
    if (!fields) return false;
    const bytes = Buffer.from(
      `${JSON.stringify({ time: new Date().toISOString(), source, pid: process.pid, ...fields })}\n`,
    );
    if (bytes.length > MAX_RECORD_BYTES) return false;
    const directory = lstatSync(root, { bigint: true });
    if (!safeRoot(directory) || realpathSync(root) !== root) return false;
    const target = path.join(root, DEBUG_LOG_FILENAME);
    const previous = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (previous && !privateFile(previous)) return false;
    const fd = openSync(
      target,
      constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
      0o600,
    );
    try {
      const opened = fstatSync(fd, { bigint: true });
      const current = lstatSync(target, { bigint: true });
      const currentRoot = lstatSync(root, { bigint: true });
      if (
        !privateFile(opened) ||
        !privateFile(current) ||
        !sameIdentity(opened, current) ||
        (previous && !sameIdentity(previous, opened)) ||
        !safeRoot(currentRoot) ||
        !sameIdentity(directory, currentRoot) ||
        realpathSync(root) !== root
      )
        return false;
      return writeSync(fd, bytes) === bytes.length;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
