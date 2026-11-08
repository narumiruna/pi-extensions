import { isAbsolute, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ScopeTarget } from "./paths.js";

// Persisted session identity must survive package renames or active guards would be lost.
export const STATE_TYPE = "scope-state";
export const MAX_TARGETS = 100;
export const MAX_STATE_BYTES = 24_000;

export interface ScopeSnapshot {
  version: 1;
  cwd: string;
  targets: ScopeTarget[] | null;
}

export interface ScopeState {
  state: "inactive" | "active" | "blocked";
  entryId?: string;
  snapshot?: ScopeSnapshot;
  error?: string;
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

export function createSnapshot(cwd: string, targets: readonly ScopeTarget[] | null): ScopeSnapshot {
  if (!absolutePath(cwd)) throw new Error("Scope workspace must be an absolute normalized path");
  if (targets !== null && (targets.length === 0 || targets.length > MAX_TARGETS)) {
    throw new Error(`Select between 1 and ${MAX_TARGETS} files; use /scope off to end the restriction`);
  }
  const unique = new Map<string, ScopeTarget>();
  for (const target of targets ?? []) {
    if (!absolutePath(target?.path) || !absolutePath(target?.canonical)) {
      throw new Error("Scope targets must contain absolute normalized paths");
    }
    if (!unique.has(target.canonical)) unique.set(target.canonical, { path: target.path, canonical: target.canonical });
  }
  const snapshot: ScopeSnapshot = {
    version: 1,
    cwd,
    targets:
      targets === null
        ? null
        : [...unique.values()].sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0)),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_STATE_BYTES) {
    throw new Error(`Scope selection exceeds the ${MAX_STATE_BYTES}-byte notice limit; select fewer files`);
  }
  return snapshot;
}

export function parseSnapshot(value: unknown): ScopeSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid scope snapshot");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.cwd !== "string" || (data.targets !== null && !Array.isArray(data.targets))) {
    throw new Error("Invalid or unsupported scope snapshot");
  }
  return createSnapshot(data.cwd, data.targets as ScopeTarget[] | null);
}

export function restoreScope(branch: readonly SessionEntry[], cwd: string): ScopeState {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    try {
      const snapshot = parseSnapshot(entry.data);
      if (snapshot.cwd !== resolve(cwd)) throw new Error("Saved scope belongs to another workspace");
      return { state: snapshot.targets === null ? "inactive" : "active", snapshot, entryId: entry.id };
    } catch (error) {
      return {
        state: "blocked",
        entryId: entry.id,
        error: `${error instanceof Error ? error.message : "Scope restoration failed"}. Edits remain blocked; repair with /scope or exit with /scope off.`,
      };
    }
  }
  return { state: "inactive" };
}

export function sameScope(left: ScopeSnapshot | undefined, right: ScopeSnapshot): boolean {
  if (!left || left.cwd !== right.cwd || (left.targets === null) !== (right.targets === null)) return false;
  if (left.targets === null || right.targets === null) return left.targets === right.targets;
  return (
    left.targets.length === right.targets.length &&
    left.targets.every((target, index) => {
      const other = right.targets?.[index];
      return target.canonical === other?.canonical && target.path === other.path;
    })
  );
}
