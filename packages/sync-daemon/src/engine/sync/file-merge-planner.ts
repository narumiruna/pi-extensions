import { createHash } from "node:crypto";
import path from "node:path";
import { isDeniedPath } from "../paths.js";
import type { SnapshotFile } from "../snapshot/snapshot-types.js";

/** Absence and an empty file are different states. A missing ancestor is not absence. */
export type FileVersion = SnapshotFile | undefined;
export type FileMergeDecision =
  | { kind: "accepted"; path: string; source: "equal" | "local" | "remote" | "merged"; file: FileVersion }
  | { kind: "conflict"; path: string; reason: "both-changed" | "protected-session" | "path-collision" };

export type FileMergePlan =
  | { kind: "review"; reason: "missing-baseline" | "selection-changed" }
  | { kind: "planned"; decisions: FileMergeDecision[]; conflicts: Extract<FileMergeDecision, { kind: "conflict" }>[] };

export interface FileMergeInput {
  /** Undefined means unavailable; an empty map is an established empty baseline. */
  baseline: Readonly<Record<string, string>> | undefined;
  local: readonly SnapshotFile[];
  remote: readonly SnapshotFile[];
  selectionCompatible: boolean;
  protectedPaths?: ReadonlySet<string>;
}

/** Pure, deterministic decisions only. This does not authorize publication or mutation. */
export function planFileMerge(input: FileMergeInput): FileMergePlan {
  if (!input.selectionCompatible) return { kind: "review", reason: "selection-changed" };
  if (input.baseline === undefined) return { kind: "review", reason: "missing-baseline" };
  const local = indexFiles(input.local);
  const remote = indexFiles(input.remote);
  const baseline = input.baseline;
  for (const [filePath, hash] of Object.entries(baseline)) {
    validatePath(filePath);
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid merge baseline hash.");
  }
  const paths = [...new Set([...Object.keys(baseline), ...local.keys(), ...remote.keys()])].sort();
  const collisions = collidingPaths(paths);
  const protectedKeys = new Set([...(input.protectedPaths ?? [])].map(mergePathIdentity));
  const decisions: FileMergeDecision[] = paths.map((filePath) => {
    if (collisions.has(filePath)) return { kind: "conflict", path: filePath, reason: "path-collision" };
    const left = local.get(filePath);
    const right = remote.get(filePath);
    const ancestor = Object.hasOwn(baseline, filePath) ? baseline[filePath] : undefined;
    let source: "equal" | "local" | "remote";
    let file: FileVersion;
    if (left?.sha256 === right?.sha256) {
      source = "equal";
      file = left;
    } else if (right?.sha256 === ancestor) {
      source = "local";
      file = left;
    } else if (left?.sha256 === ancestor) {
      source = "remote";
      file = right;
    } else {
      return { kind: "conflict", path: filePath, reason: "both-changed" };
    }
    if (source === "remote" && protectedKeys.has(mergePathIdentity(filePath))) {
      return { kind: "conflict", path: filePath, reason: "protected-session" };
    }
    return { kind: "accepted", path: filePath, source, file };
  });
  return {
    kind: "planned",
    decisions,
    conflicts: decisions.filter((decision) => decision.kind === "conflict"),
  };
}

function indexFiles(files: readonly SnapshotFile[]) {
  const result = new Map<string, SnapshotFile>();
  for (const file of files) {
    validatePath(file.path);
    if (result.has(file.path)) throw new Error("Duplicate merge path.");
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.contentBase64) ||
      file.contentBase64.length % 4 !== 0 ||
      Buffer.from(file.contentBase64, "base64").toString("base64") !== file.contentBase64 ||
      createHash("sha256").update(Buffer.from(file.contentBase64, "base64")).digest("hex") !== file.sha256
    ) {
      throw new Error("Invalid merge file content or checksum.");
    }
    result.set(file.path, file);
  }
  return result;
}

function validatePath(filePath: string) {
  if (
    !filePath ||
    filePath === "." ||
    filePath === ".." ||
    filePath.startsWith("../") ||
    path.posix.isAbsolute(filePath) ||
    filePath.includes("\\") ||
    (process.platform === "win32" &&
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Native Windows filename restrictions.
      (/[<>:"|?*\u0001-\u001f]/u.test(filePath) ||
        filePath
          .split("/")
          .some(
            (segment) => /[ .]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
          ))) ||
    path.posix.normalize(filePath) !== filePath ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject unsafe snapshot paths.
    /[\u0000\ud800-\udfff]/u.test(filePath) ||
    isDeniedPath(filePath) ||
    (filePath.startsWith("sessions/") && !filePath.endsWith(".jsonl"))
  ) {
    throw new Error("Unsafe merge path.");
  }
}

export function mergePathIdentity(filePath: string) {
  // Node path strings encode invalid UTF-16 as U+FFFD; context paths can still contain it.
  return Buffer.from(filePath, "utf8").toString("utf8").normalize("NFC").toLowerCase();
}

/** Conservative dependency groups: never accept a case or file/directory transition independently. */
export function collidingPaths(paths: readonly string[]) {
  const byLower = new Map<string, string[]>();
  for (const filePath of paths) {
    const lower = mergePathIdentity(filePath);
    const variants = byLower.get(lower) ?? [];
    variants.push(filePath);
    byLower.set(lower, variants);
  }
  const result = new Set<string>();
  for (const variants of byLower.values()) {
    if (variants.length > 1) for (const variant of variants) result.add(variant);
  }
  for (const filePath of paths) {
    const segments = mergePathIdentity(filePath).split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const ancestors = byLower.get(segments.slice(0, length).join("/"));
      if (ancestors) {
        result.add(filePath);
        for (const ancestor of ancestors) result.add(ancestor);
      }
    }
  }
  return result;
}
