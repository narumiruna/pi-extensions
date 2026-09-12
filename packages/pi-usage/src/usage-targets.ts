import { sanitizeDisplayText } from "./core.js";
import type { ResolvedUsageAuth, UsageProviderAdapter, UsageProviderTarget, UsageRequestGuard } from "./types.js";

const MAX_TARGETS = 1_000;
const MAX_TARGET_ID_CHARS = 256;
const MAX_TARGET_LABEL_CHARS = 120;
const MAX_TARGET_DESCRIPTION_CHARS = 180;

export type UsageTargetResolution =
  | { kind: "selected"; targetId?: string }
  | {
      kind: "selection-required";
      choices: readonly UsageProviderTarget[];
    };

export interface UsageTargetSelectOptions {
  options: readonly string[];
  targetIdFor(option: string): string | undefined;
}

export async function resolveUsageTarget(
  adapter: UsageProviderAdapter,
  auth: ResolvedUsageAuth,
  rememberedTargetId: string | undefined,
  signal: AbortSignal,
  timeoutMs: number,
  guard: UsageRequestGuard,
): Promise<UsageTargetResolution> {
  if (!adapter.targets) return { kind: "selected" };
  if (rememberedTargetId !== undefined && !isBoundedTargetId(rememberedTargetId)) {
    throw new Error(`The remembered ${adapter.targets.singularLabel} identifier was invalid.`);
  }
  const choices = await listUsageTargets(adapter, auth, signal, timeoutMs, guard);
  if (rememberedTargetId) {
    return choices.some((choice) => choice.id === rememberedTargetId)
      ? { kind: "selected", targetId: rememberedTargetId }
      : { kind: "selection-required", choices };
  }
  if (choices.length === 1) return { kind: "selected", targetId: choices[0]?.id };
  return { kind: "selection-required", choices };
}

export async function listUsageTargets(
  adapter: UsageProviderAdapter,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  guard: UsageRequestGuard,
): Promise<readonly UsageProviderTarget[]> {
  if (!adapter.targets) return [];
  const startedAt = Date.now();
  await guard();
  const listed = await adapter.targets.list(auth, signal, remainingTargetTimeout(timeoutMs, startedAt), guard);
  await guard();
  remainingTargetTimeout(timeoutMs, startedAt);
  const choices = normalizeUsageTargets(listed);
  if (choices.length === 0) {
    throw new Error(`${adapter.targets.pluralLabel} discovery returned no choices.`);
  }
  return choices;
}

export function normalizeUsageTargets(targets: readonly UsageProviderTarget[]): readonly UsageProviderTarget[] {
  if (!Array.isArray(targets)) throw new Error("Target discovery did not return a choices array.");
  if (targets.length > MAX_TARGETS) {
    throw new Error(`Target discovery exceeded ${MAX_TARGETS} choices.`);
  }
  const seen = new Set<string>();
  return targets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("Target discovery returned an invalid choice.");
    }
    const { id, label, description } = target as Partial<UsageProviderTarget>;
    if (!isBoundedTargetId(id)) throw new Error("Target discovery returned an invalid ID.");
    if (seen.has(id)) throw new Error(`Target discovery repeated ${id}.`);
    seen.add(id);
    if (typeof label !== "string") {
      throw new Error("Target discovery returned an invalid display label.");
    }
    if (description !== undefined && typeof description !== "string") {
      throw new Error("Target discovery returned an invalid description.");
    }
    const safeLabel = sanitizeDisplayText(label, MAX_TARGET_LABEL_CHARS);
    if (!safeLabel) throw new Error("Target discovery returned an empty display label.");
    const safeDescription = description ? sanitizeDisplayText(description, MAX_TARGET_DESCRIPTION_CHARS) : undefined;
    return { id, label: safeLabel, ...(safeDescription ? { description: safeDescription } : {}) };
  });
}

export function createUsageTargetSelectOptions(targets: readonly UsageProviderTarget[]): UsageTargetSelectOptions {
  const normalized = normalizeUsageTargets(targets);
  const ids = new Map<string, string>();
  const options = normalized.map((target) => {
    const base = target.description ? `${target.label} — ${target.description}` : target.label;
    let option = base;
    if (ids.has(option)) {
      const safeId = sanitizeDisplayText(target.id, 80) || "target";
      option = `${base} · ${safeId}`;
      let duplicate = 2;
      while (ids.has(option)) {
        option = `${base} · ${safeId} (${duplicate})`;
        duplicate += 1;
      }
    }
    ids.set(option, target.id);
    return option;
  });
  return { options, targetIdFor: (option) => ids.get(option) };
}

function remainingTargetTimeout(timeoutMs: number, startedAt: number): number {
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error("Timed out while discovering provider targets.");
  return remaining;
}

export function isBoundedTargetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TARGET_ID_CHARS &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  );
}
