import {
  DIFF_REVIEW_OUTPUT_BYTES,
  DIFF_REVIEW_OUTPUT_LINES,
  type DiffReviewPreview,
} from "../../diff-review-protocol.js";
import { edits, type Hunk, lines, text } from "./text-merge.js";

export const DIFF_REVIEW_FILE_BYTES = 64 * 1024;
export const DIFF_REVIEW_FILE_BASE64_CHARS = Math.ceil(DIFF_REVIEW_FILE_BYTES / 3) * 4;
const MAX_EDIT_CELLS = 1_000_000;
const CONTEXT = 3;

export type DiffReviewInput = { local: Buffer | undefined; remote: Buffer | undefined } | { notice: string };

export const DIFF_REVIEW_LIMIT_NOTICE = "This file exceeds the text preview limits. No partial patch was returned.";

function notice(message: string): DiffReviewPreview {
  return { kind: "notice", message };
}

function* hunkGroups(changes: readonly Hunk[]) {
  let group: Hunk[] = [];
  for (const change of changes) {
    const previous = group.at(-1);
    if (previous && change.start - previous.end > 2 * CONTEXT) {
      yield group;
      group = [];
    }
    group.push(change);
  }
  if (group.length) yield group;
}

function range(start: number, count: number) {
  if (count === 1) return String(start + 1);
  return `${count === 0 ? start : start + 1},${count}`;
}

class DiffOutputLimitError extends Error {}

function unifiedDiff(base: string[], changes: Hunk[], signal?: AbortSignal) {
  const output: string[] = [];
  let bytes = 0;
  const append = (line: string) => {
    bytes += Buffer.byteLength(line);
    if (bytes > DIFF_REVIEW_OUTPUT_BYTES || output.length >= DIFF_REVIEW_OUTPUT_LINES) throw new DiffOutputLimitError();
    output.push(line);
  };
  const sourceLine = (prefix: string, line: string) => {
    if (line.endsWith("\n")) append(prefix + line);
    else {
      append(`${prefix}${line}\n`);
      append("\\ No newline at end of file\n");
    }
  };
  append("--- Local\n");
  append("+++ Remote\n");
  let offset = 0;
  for (const group of hunkGroups(changes)) {
    signal?.throwIfAborted();
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;
    const start = Math.max(0, first.start - CONTEXT);
    const end = Math.min(base.length, last.end + CONTEXT);
    const delta = group.reduce((sum, change) => sum + change.lines.length - (change.end - change.start), 0);
    append(`@@ -${range(start, end - start)} +${range(start + offset, end - start + delta)} @@\n`);
    offset += delta;
    let cursor = start;
    for (const change of group) {
      for (const line of base.slice(cursor, change.start)) sourceLine(" ", line);
      for (const line of base.slice(change.start, change.end)) sourceLine("-", line);
      for (const line of change.lines) sourceLine("+", line);
      cursor = change.end;
    }
    for (const line of base.slice(cursor, end)) sourceLine(" ", line);
  }
  return output.join("");
}

export function buildDiffReviewPreview(input: DiffReviewInput, signal?: AbortSignal): DiffReviewPreview {
  signal?.throwIfAborted();
  if ("notice" in input) return notice(input.notice);
  const localBytes = input.local ?? Buffer.alloc(0);
  const remoteBytes = input.remote ?? Buffer.alloc(0);
  if (Math.max(localBytes.length, remoteBytes.length) > DIFF_REVIEW_FILE_BYTES) return notice(DIFF_REVIEW_LIMIT_NOTICE);
  if (localBytes.length === 0 && remoteBytes.length === 0)
    return notice("This empty file differs only in presence. There is no text hunk.");
  let local: string[];
  let remote: string[];
  try {
    const localText = text(localBytes);
    const remoteText = text(remoteBytes);
    if (/\r(?!\n)/u.test(localText) || /\r(?!\n)/u.test(remoteText)) throw new Error("Unsupported line endings.");
    local = lines(localText);
    remote = lines(remoteText);
  } catch {
    return notice("This file is binary or is not supported UTF-8 text. Its contents were not returned.");
  }
  if (
    Math.max(local.length, remote.length) > DIFF_REVIEW_OUTPUT_LINES ||
    (local.length + 1) * (remote.length + 1) > MAX_EDIT_CELLS
  )
    return notice(DIFF_REVIEW_LIMIT_NOTICE);
  const changes = edits(local, remote, signal);
  if (!changes.length) return notice("There are no text differences in this file.");
  try {
    return { kind: "diff", content: unifiedDiff(local, changes, signal) };
  } catch (error) {
    if (error instanceof DiffOutputLimitError) return notice(DIFF_REVIEW_LIMIT_NOTICE);
    throw error;
  }
}
