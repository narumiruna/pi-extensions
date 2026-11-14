import { createHash } from "node:crypto";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { isDeniedPath } from "../paths.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";

export const SYNC_IGNORE_NAME = ".syncignore";
export const DEFAULT_SYNC_IGNORE =
  "# Paths are relative to the Pi agent directory.\n# Session conversations can contain private data.\n/sessions/\n";
const MAX_IGNORE_BYTES = 256 * 1_024;
let cached: { text: string; matcher: Ignore } | undefined;

export function normalizeSyncIgnore(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_IGNORE_BYTES ||
    value.includes("\0") ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    throw new Error("Invalid .syncignore: expected UTF-8 text without NUL, at most 256 KiB.");
  }
  return value;
}

export function syncIgnoreAllows(text: string, relativePath: string, directory = false): boolean {
  if (cached?.text !== text)
    cached = { text: normalizeSyncIgnore(text), matcher: ignore({ ignorecase: false }).add(text) };
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject unsafe snapshot paths.
    /[\u0000-\u001f\u007f-\u009f]/u.test(relativePath) ||
    isDeniedPath(relativePath)
  )
    return false;
  // The policy is transported even when a broad pattern excludes dotfiles or everything.
  if (relativePath === SYNC_IGNORE_NAME) return !directory;
  if (relativePath.toLowerCase() === SYNC_IGNORE_NAME) return false;
  return !cached.matcher.ignores(`${relativePath}${directory ? "/" : ""}`);
}

export function validateSnapshotIgnorePolicy(snapshot: Snapshot) {
  if (snapshot.version !== 4 && snapshot.selection?.version !== 2) return;
  if (snapshot.version !== 4 || snapshot.selection?.version !== 2)
    throw new Error(".syncignore policy requires snapshot version 4 and selection version 2.");
  const text = normalizeSyncIgnore(snapshot.selection.ignore);
  const policies = snapshot.files.filter((file) => file.path.toLowerCase() === SYNC_IGNORE_NAME);
  const content = Buffer.from(text);
  if (
    policies.length !== 1 ||
    policies[0]?.path !== SYNC_IGNORE_NAME ||
    policies[0].contentBase64 !== content.toString("base64") ||
    policies[0].sha256 !== createHash("sha256").update(content).digest("hex")
  )
    throw new Error("Snapshot .syncignore content does not match its selection policy.");
}

/** A conservative compatibility projection for existing session/settings controls, never file enumeration. */
export function ignorePolicyInclude(text: string): string[] {
  return [
    ...(syncIgnoreAllows(text, "settings.json") ? ["settings.json"] : []),
    ...(syncIgnoreAllows(text, "sessions", true) ? ["sessions"] : []),
    SYNC_IGNORE_NAME,
  ];
}

/** Preserve the intersection of legacy setup scopes without enabling newly discovered paths. */
export function ignoreFromLegacyIncludes(lists: readonly (readonly string[])[]): string {
  let selected = [...(lists[0] ?? [])];
  for (const list of lists.slice(1)) {
    selected = selected.flatMap((left) =>
      list.flatMap((right) =>
        left === right || left.startsWith(`${right}/`) ? [left] : right.startsWith(`${left}/`) ? [right] : [],
      ),
    );
  }
  selected = [...new Set(selected)].sort();
  const root: { selected: boolean; children: Map<string, typeof root> } = { selected: false, children: new Map() };
  for (const item of selected) {
    let node = root;
    for (const segment of item.split("/")) {
      if (node.selected) break;
      let child = node.children.get(segment);
      if (!child) {
        child = { selected: false, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.selected = true;
    node.children.clear();
  }
  const lines = [
    "# Migrated from the intersection of all legacy sync.include lists.",
    "# Remove these rules only after reviewing the expanded sync scope.",
    "/*",
  ];
  const escapePattern = (value: string) => value.replace(/[\\*?[\]#! ]/gu, "\\$&");
  const visit = (node: typeof root, prefix: string) => {
    for (const [name, child] of node.children) {
      const relative = prefix ? `${prefix}/${escapePattern(name)}` : escapePattern(name);
      if (child.selected) lines.push(`!/${relative}`);
      else {
        lines.push(`!/${relative}/`, `/${relative}/*`);
        visit(child, relative);
      }
    }
  };
  visit(root, "");
  return `${lines.join("\n")}\n`;
}
