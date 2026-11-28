import { record } from "./protocol.js";

export type DiffReviewStatus = "local-only" | "remote-only" | "different";

interface DiffReviewFile {
  id: string;
  path: string;
  status: DiffReviewStatus;
}

export type DiffReviewInventory =
  | { kind: "review"; id: string; lines: readonly string[]; files: readonly DiffReviewFile[] }
  | { kind: "unavailable"; message: string };

export type DiffReviewPreview =
  | { kind: "diff"; content: string }
  | { kind: "notice"; message: string }
  | { kind: "stale" };

export const DIFF_REVIEW_CATALOG_BYTES = 256 * 1024;
export const DIFF_REVIEW_CATALOG_FILES = 1024;
export const DIFF_REVIEW_PATH_BYTES = 4096;
export const DIFF_REVIEW_PATH_DEPTH = 64;
export const DIFF_REVIEW_OUTPUT_BYTES = 128 * 1024;
export const DIFF_REVIEW_OUTPUT_LINES = 2000;
export const DIFF_REVIEW_REQUEST_MS = 5_000;

export function isDiffReviewId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
}

export function isDiffReviewPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > DIFF_REVIEW_PATH_BYTES ||
    Buffer.byteLength(value) > DIFF_REVIEW_PATH_BYTES ||
    value.includes("\\") ||
    value.includes("\0")
  )
    return false;
  const parts = value.split("/");
  return parts.length <= DIFF_REVIEW_PATH_DEPTH && parts.every((part) => part && part !== "." && part !== "..");
}

export function parseDiffReviewInventory(value: unknown): DiffReviewInventory {
  const invalid = () => new Error("Invalid daemon diff review inventory.");
  if (record(value)) {
    if (
      value.kind === "unavailable" &&
      Object.keys(value).length === 2 &&
      typeof value.message === "string" &&
      value.message.length > 0 &&
      value.message.length <= DIFF_REVIEW_CATALOG_BYTES &&
      Buffer.byteLength(JSON.stringify(value)) <= DIFF_REVIEW_CATALOG_BYTES
    )
      return { kind: "unavailable", message: value.message };
    if (
      value.kind === "review" &&
      Object.keys(value).length === 4 &&
      isDiffReviewId(value.id) &&
      Array.isArray(value.lines) &&
      value.lines.length <= DIFF_REVIEW_CATALOG_FILES &&
      value.lines.every((line) => typeof line === "string" && line.length <= DIFF_REVIEW_CATALOG_BYTES) &&
      Array.isArray(value.files) &&
      value.files.length <= DIFF_REVIEW_CATALOG_FILES
    ) {
      const ids = new Set<string>();
      const paths = new Set<string>();
      const files: DiffReviewFile[] = [];
      for (const file of value.files) {
        if (
          !record(file) ||
          Object.keys(file).length !== 3 ||
          !isDiffReviewId(file.id) ||
          !isDiffReviewPath(file.path) ||
          (file.status !== "local-only" && file.status !== "remote-only" && file.status !== "different") ||
          ids.has(file.id) ||
          paths.has(file.path)
        )
          throw invalid();
        ids.add(file.id);
        paths.add(file.path);
        files.push({ id: file.id, path: file.path, status: file.status });
      }
      const inventory = { kind: "review", id: value.id, lines: [...value.lines] as string[], files } as const;
      if (Buffer.byteLength(JSON.stringify(inventory)) <= DIFF_REVIEW_CATALOG_BYTES) return inventory;
    }
  }
  throw invalid();
}

export function readDiffReviewPreview(value: unknown): DiffReviewPreview {
  if (record(value)) {
    const keys = Object.keys(value).length;
    if (keys === 1 && value.kind === "stale") return { kind: "stale" };
    if (
      keys === 2 &&
      value.kind === "notice" &&
      typeof value.message === "string" &&
      value.message.length > 0 &&
      value.message.length <= 1024
    )
      return { kind: "notice", message: value.message };
    if (
      keys === 2 &&
      value.kind === "diff" &&
      typeof value.content === "string" &&
      value.content.length <= DIFF_REVIEW_OUTPUT_BYTES &&
      Buffer.byteLength(value.content) <= DIFF_REVIEW_OUTPUT_BYTES &&
      value.content.startsWith("--- Local\n+++ Remote\n@@ ") &&
      (value.content.match(/\n/gu)?.length ?? 0) <= DIFF_REVIEW_OUTPUT_LINES
    )
      return { kind: "diff", content: value.content };
  }
  throw new Error("Invalid daemon diff review preview.");
}
