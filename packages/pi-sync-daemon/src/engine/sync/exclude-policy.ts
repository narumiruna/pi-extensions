import path from "node:path";
import { Minimatch } from "minimatch";

const MAX_RULES = 1_024;
const MAX_RULE_BYTES = 4_096;
const MAX_TOTAL_BYTES = 256 * 1_024;

/** Exclusions are a set; keep spelling for exact reviews, not filesystem lookup. */
export function normalizeSyncExclude(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid pi-sync settings: sync.exclude must be an array.");
  if (value.length > MAX_RULES) throw new Error(`sync.exclude exceeds ${MAX_RULES} rules.`);
  const seen = new Set<string>();
  let total = 0;
  const rules = value.map((item) => {
    if (typeof item !== "string") throw new Error("sync.exclude rules must be strings.");
    const bytes = Buffer.byteLength(item, "utf8");
    total += bytes;
    if (bytes > MAX_RULE_BYTES || total > MAX_TOTAL_BYTES) throw new Error("sync.exclude exceeds its byte limit.");
    const rule = item.trim();
    const segments = rule.split("/");
    if (
      !rule ||
      path.posix.isAbsolute(rule) ||
      path.win32.isAbsolute(rule) ||
      /^[a-z]:/iu.test(rule) ||
      rule.includes("\\") ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject untrusted terminal controls.
      /[\u0000-\u001f\u007f-\u009f]/u.test(item) ||
      /^[!#]/u.test(rule) ||
      /[[\]{}()]/u.test(rule) ||
      segments.some(
        (segment) => !segment || segment === "." || segment === ".." || (segment.includes("**") && segment !== "**"),
      )
    )
      throw new Error(
        "Invalid sync.exclude rule: use a safe relative path with only *, ?, and whole-segment ** globs.",
      );
    const key = rule.toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate sync.exclude rule (case-insensitive).");
    seen.add(key);
    return rule;
  });
  return rules.sort((left, right) => {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function sameSyncExclude(left: unknown, right: unknown) {
  return (
    JSON.stringify(normalizeSyncExclude(left).map((rule) => rule.toLowerCase())) ===
    JSON.stringify(normalizeSyncExclude(right).map((rule) => rule.toLowerCase()))
  );
}

/** Compile at the operation boundary and reuse for every file/directory. */
export function compileSyncExclude(value: unknown) {
  const matchers = normalizeSyncExclude(value).map(
    (rule) =>
      // A trailing globstar also matches zero segments; ancestor matching owns its subtree.
      new Minimatch(rule.replace(/(?:\/\*\*)+$/u, ""), {
        dot: true,
        nocase: true,
        nonegate: true,
        nocomment: true,
        nobrace: true,
        noext: true,
        platform: "linux",
        optimizationLevel: 0,
      }),
  );
  return (relativePath: string): boolean => {
    if (matchers.length === 0) return false;
    for (let candidate = relativePath; candidate; ) {
      if (matchers.some((matcher) => matcher.match(candidate))) return true;
      const slash = candidate.lastIndexOf("/");
      if (slash < 0) break;
      candidate = candidate.slice(0, slash);
    }
    return false;
  };
}
