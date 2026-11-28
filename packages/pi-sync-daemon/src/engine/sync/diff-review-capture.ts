import { randomUUID } from "node:crypto";
import {
  DIFF_REVIEW_CATALOG_BYTES,
  DIFF_REVIEW_CATALOG_FILES,
  DIFF_REVIEW_PATH_DEPTH,
  type DiffReviewInventory,
  isDiffReviewPath,
} from "../../diff-review-protocol.js";
import { DIFF_REVIEW_RETAINED_BYTES, type PreparedDiffReview } from "../../diff-review-store.js";
import { type Execution, OWNERSHIP_CLEANUP_REQUIRED, record } from "../../protocol.js";
import type { EngineContext } from "../host.js";
import { configFromSettings, syncCheckConfigFingerprint } from "../settings/config.js";
import { readLocalConfigForDiagnostics } from "../settings/config-file.js";
import { assertNoRetiredRuleJournal } from "../settings/retired-ignore-recovery.js";
import { validateSettingsDocument } from "../settings/settings-validation.js";
import { createSnapshotCaptureLimits, SnapshotCaptureLimitError } from "../snapshot/snapshot-capture-limit.js";
import { type SnapshotDifference, snapshotDifferences } from "../snapshot/snapshot-difference.js";
import type { Snapshot, SnapshotFile } from "../snapshot/snapshot-types.js";
import { withStateDirectoryAccess } from "../state/state-directory.js";
import { formatDiffCounts, formatDiffRow } from "../ui/sync-format.js";
import { safeTerminalText, snapshotPathLabel } from "../ui/terminal-text.js";
import {
  DIFF_REVIEW_FILE_BASE64_CHARS,
  DIFF_REVIEW_FILE_BYTES,
  DIFF_REVIEW_LIMIT_NOTICE,
  type DiffReviewInput,
} from "./diff-review-preview.js";
import { sameLocalFields } from "./local-fields.js";
import { MAX_AGENT_DIRECTORY_ENTRIES, MAX_AGENT_DIRECTORY_FILES } from "./sync-policy.js";
import { captureDiffComparison } from "./sync-queries.js";

const CAPTURE_MS = 30_000;
const CAPTURE_BYTES = 64 * 1024 * 1024;
const CAPTURE_LIMIT = "The comparison exceeds the file review limits.";
const RETAINED_LIMIT = "There is not enough review memory for this comparison.";
const FAILURE = "Could not capture file differences. Check the selected setup and storage, then reopen the review.";
const SESSION_NOTICE = "Session and JSONL files are metadata-only. Their contents were not returned.";
const FIELD_NOTICE = "The local and remote settings field policies differ. Settings contents were not returned.";

type UnavailableDiffReview = Extract<DiffReviewInventory, { kind: "unavailable" }>;

function unavailable(message: string): UnavailableDiffReview {
  return { kind: "unavailable", message };
}

function inputFor(change: SnapshotDifference<SnapshotFile>, fieldPoliciesMatch: boolean): DiffReviewInput {
  const path = change.path.toLowerCase();
  if (path.startsWith("sessions/") || path.endsWith(".jsonl")) return { notice: SESSION_NOTICE };
  if (path === "settings.json" && !fieldPoliciesMatch) return { notice: FIELD_NOTICE };
  const local = change.local?.contentBase64;
  const remote = change.remote?.contentBase64;
  if ([local, remote].some((value) => (value?.length ?? 0) > DIFF_REVIEW_FILE_BASE64_CHARS))
    return { notice: DIFF_REVIEW_LIMIT_NOTICE };
  const left = local === undefined ? undefined : Buffer.from(local, "base64");
  const right = remote === undefined ? undefined : Buffer.from(remote, "base64");
  if (Math.max(left?.length ?? 0, right?.length ?? 0) > DIFF_REVIEW_FILE_BYTES)
    return { notice: DIFF_REVIEW_LIMIT_NOTICE };
  return { local: left, remote: right };
}

function copyText(value: string) {
  return Buffer.from(value, "utf16le").toString("utf16le");
}

interface Comparison {
  local: Snapshot;
  remote?: Snapshot;
  lines: readonly string[];
  warnings: readonly string[];
  selectionState?: { kind: string };
}

function boundedSummary(
  reason: string,
  comparison: Comparison,
  counts: readonly string[],
  changes?: readonly SnapshotDifference<SnapshotFile>[],
) {
  const { local, remote, warnings, selectionState } = comparison;
  const headline = `${reason} File previews are unavailable. Summary only.`;
  const essential = [
    headline,
    ...counts,
    ...(selectionState?.kind === "different" ? ["Remote included content differs from this setup."] : []),
    ...warnings,
  ];
  let used = Buffer.byteLength(JSON.stringify(unavailable(essential.join("\n"))));
  let omitted = !changes;
  const truncation = "More summary details were omitted to stay within the overview limits.";
  const add = (line: string) => {
    const size = Buffer.byteLength(JSON.stringify(line));
    if (used + size + truncation.length + 2 > DIFF_REVIEW_CATALOG_BYTES) {
      omitted = true;
      return false;
    }
    used += size;
    essential.push(line);
    return true;
  };
  for (const line of comparison.lines) {
    if (!warnings.includes(line) && !add(safeTerminalText(line))) break;
  }
  if (changes) {
    if (!remote) add(`Remote is empty. Local push would upload: ${safeTerminalText(local.id)}`);
    else if (!changes.length) add("No file differences.");
    for (const change of changes) {
      if (!isDiffReviewPath(change.path)) {
        omitted = true;
        continue;
      }
      if (!add(remote ? formatDiffRow(change) : `Add: ${snapshotPathLabel(change.path)}`)) break;
    }
  }
  if (omitted) essential.push(truncation);
  return unavailable(essential.join("\n"));
}

export function prepareDiffReview(
  comparison: Comparison,
  staleSetup: PreparedDiffReview["staleSetup"],
):
  | { unavailable: UnavailableDiffReview }
  | { prepared: PreparedDiffReview; fallback(reason: string): UnavailableDiffReview } {
  const { local, remote } = comparison;
  const counts = remote ? formatDiffCounts(local, remote) : [`local: ${local.files.length} files`, "Remote is empty."];
  if (local.files.length + (remote?.files.length ?? 0) > 2 * MAX_AGENT_DIRECTORY_FILES)
    return { unavailable: boundedSummary(CAPTURE_LIMIT, comparison, counts) };
  const changes = snapshotDifferences(local.files, remote?.files);
  const fallback = (reason: string) => boundedSummary(reason, comparison, counts, changes);
  if (changes.length > DIFF_REVIEW_CATALOG_FILES) return { unavailable: fallback(CAPTURE_LIMIT) };
  const lines = [
    ...comparison.lines.map(safeTerminalText),
    ...counts,
    ...(changes.length ? [] : ["No file differences."]),
    "Read-only comparison. − Local, + Remote. Neither side is a proposed transfer.",
  ].map(copyText);
  const files: PreparedDiffReview["inventory"]["files"][number][] = [];
  const inventory = { kind: "review", id: randomUUID(), lines, files } as const;
  const rows = new Map<string, DiffReviewInput>();
  let catalogBytes = Buffer.byteLength(JSON.stringify(inventory));
  if (catalogBytes > DIFF_REVIEW_CATALOG_BYTES) return { unavailable: fallback(CAPTURE_LIMIT) };
  let retainedBytes = 0;
  const fieldPoliciesMatch = !remote || sameLocalFields(local.localFields ?? [], remote.localFields ?? []);
  for (const change of changes) {
    const { path, status } = change;
    if (!isDiffReviewPath(path)) return { unavailable: fallback(CAPTURE_LIMIT) };
    const file = { id: randomUUID(), path: copyText(path), status };
    catalogBytes += Buffer.byteLength(JSON.stringify(file)) + 1;
    if (catalogBytes > DIFF_REVIEW_CATALOG_BYTES) return { unavailable: fallback(CAPTURE_LIMIT) };
    const input = inputFor(change, fieldPoliciesMatch);
    if (!("notice" in input)) retainedBytes += (input.local?.length ?? 0) + (input.remote?.length ?? 0);
    files.push(file);
    rows.set(file.id, input);
    if (retainedBytes + 2 * catalogBytes + 512 * files.length > DIFF_REVIEW_RETAINED_BYTES)
      return { unavailable: fallback(RETAINED_LIMIT) };
  }
  return {
    prepared: { inventory, rows, bytes: retainedBytes + 2 * catalogBytes + 512 * files.length, staleSetup },
    fallback,
  };
}

function readDiffSetup(root: string, setup: string | undefined, signal: AbortSignal) {
  return withStateDirectoryAccess(async () => {
    signal.throwIfAborted();
    assertNoRetiredRuleJournal(root);
    const observation = await readLocalConfigForDiagnostics(root);
    signal.throwIfAborted();
    if (!observation?.stillCurrent()) throw new Error("Sync setup is unavailable or changed.");
    assertNoRetiredRuleJournal(root);
    return configFromSettings(validateSettingsDocument(observation.document.parsed), setup);
  });
}

function setupFreshness(root: string, setup: string | undefined, fingerprint: string) {
  return async (signal: AbortSignal) => {
    try {
      const current = await readDiffSetup(root, setup, signal);
      return syncCheckConfigFingerprint(current) !== fingerprint;
    } catch {
      return true;
    }
  };
}

export async function captureDiffReview(
  ctx: EngineContext,
  payload: unknown,
  execution: Execution,
): Promise<DiffReviewInventory> {
  if (!execution.diffReview || ctx.mode !== "tui" || !ctx.hasUI)
    throw new Error("File previews require a live TUI client.");
  if (
    !record(payload) ||
    Object.keys(payload).some((key) => key !== "setup" && key !== "fingerprint") ||
    (payload.setup !== undefined && (typeof payload.setup !== "string" || payload.setup.length > 512)) ||
    (payload.fingerprint !== undefined &&
      (typeof payload.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(payload.fingerprint) || !payload.setup))
  )
    throw new Error("Invalid diff review request.");
  execution.diffReview.clear();
  const setup = typeof payload.setup === "string" ? payload.setup : undefined;
  const selectedSetup = payload.fingerprint === undefined ? setup : undefined;
  const deadline = AbortSignal.timeout(CAPTURE_MS);
  const signal = AbortSignal.any([execution.signal, deadline]);
  const changed = () => unavailable("The sync setup changed. Reopen the review.");
  try {
    const config = await readDiffSetup(execution.root, selectedSetup, signal);
    execution.validate();
    signal.throwIfAborted();
    const fingerprint = syncCheckConfigFingerprint(config);
    if (payload.fingerprint !== undefined && (setup !== config.setupName || payload.fingerprint !== fingerprint))
      return changed();
    const staleSetup = setupFreshness(execution.root, selectedSetup, fingerprint);
    const local = createSnapshotCaptureLimits({
      bytes: CAPTURE_BYTES,
      entries: MAX_AGENT_DIRECTORY_ENTRIES,
      files: MAX_AGENT_DIRECTORY_FILES + 1,
      depth: DIFF_REVIEW_PATH_DEPTH,
    });
    const comparison = await withStateDirectoryAccess(() =>
      captureDiffComparison(ctx, config, signal, undefined, { local, remoteBytes: CAPTURE_BYTES }),
    );
    execution.validate();
    const stale = await staleSetup(signal);
    execution.validate();
    signal.throwIfAborted();
    if (stale) return changed();
    const result = prepareDiffReview(comparison, staleSetup);
    if ("unavailable" in result) return result.unavailable;
    return execution.diffReview.retain(result.prepared) ? result.prepared.inventory : result.fallback(RETAINED_LIMIT);
  } catch (error) {
    if (record(error) && error.code === OWNERSHIP_CLEANUP_REQUIRED) {
      throw Object.assign(new Error("Daemon ownership cleanup is required."), { code: OWNERSHIP_CLEANUP_REQUIRED });
    }
    execution.validate();
    if (deadline.aborted) return unavailable("Capturing the comparison timed out. No file previews are available.");
    if (error instanceof SnapshotCaptureLimitError)
      return unavailable(`${CAPTURE_LIMIT} The summary could not be completed within those limits.`);
    return unavailable(FAILURE);
  }
}
