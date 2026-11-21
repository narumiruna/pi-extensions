import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeDirectoryRules } from "../../sync/sync-policy.js";
import { safeTerminalText } from "../terminal-text.js";

export interface DirectoryRulesDraft {
  exclude: string[];
  reinclude: string[];
  sessions: boolean;
}

export const DIRECTORY_SCOPE_ALWAYS_LOCAL =
  "Always local: Pi credentials (auth.json), project trust (trust.json), their locks, and Pi Sync's settings and service state. Rules cannot override these protections.";

export const SESSION_PRIVACY_WARNING =
  "Session JSONL can contain prompts, tool output, paths, screenshots, and secrets. Sync sessions only to storage you trust.";

export function starterDirectoryRules(): DirectoryRulesDraft {
  return { exclude: ["sessions", "bin", "npm"], reinclude: [], sessions: false };
}

export function setSessionOptIn(draft: DirectoryRulesDraft, sessions: boolean) {
  draft.sessions = sessions;
  if (sessions) draft.exclude = draft.exclude.filter((rule) => rule.toLowerCase() !== "sessions");
}

export async function acknowledgeSessions(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const confirmed = await ctx.ui.confirm("Include session conversations?", SESSION_PRIVACY_WARNING, { signal });
  return !signal?.aborted && confirmed;
}

export async function promptDirectoryRules(
  ctx: ExtensionCommandContext,
  kind: "exclude" | "reinclude",
  initial: readonly string[],
  signal?: AbortSignal,
  validate: () => void = () => signal?.throwIfAborted(),
) {
  let draft = JSON.stringify(initial);
  while (!signal?.aborted) {
    const title = kind === "exclude" ? "Excluded paths" : "Re-included paths";
    const input = await ctx.ui.input(
      `${title}\n\nCurrent rules: ${summarizeDirectoryRules(initial)}\nEnter a JSON string array. Blank keeps the draft; [] clears it.`,
      draft,
      { signal },
    );
    if (signal?.aborted || input === undefined) return undefined;
    validate();
    draft = input || draft;
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!Array.isArray(parsed)) throw new Error("Enter a JSON string array.");
      return normalizeDirectoryRules(parsed);
    } catch {
      ctx.ui.notify("Invalid rule array or unsupported pattern. No settings changed.", "error");
    }
  }
  return undefined;
}

export function summarizeDirectoryRules(rules: readonly string[] = []) {
  if (!rules.length) return "none";
  const sample = rules.slice(0, 5).map((rule) => {
    const safe = safeTerminalText(rule);
    return safe.length > 80 ? `${safe.slice(0, 80)}…` : safe;
  });
  return `${rules.length} · ${sample.join(", ")}${rules.length > sample.length ? ", …" : ""}`;
}

export function formatDirectoryRules(label: string, rules: readonly string[]) {
  return [`${label}:`, ...(rules.length ? rules.map((rule) => `  ${safeTerminalText(rule)}`) : ["  (none)"])];
}

export function directoryScopeLines(draft: DirectoryRulesDraft) {
  return [
    "Scope: Pi agent directory · all eligible files, including custom paths",
    ...formatDirectoryRules("Excluded paths", draft.exclude),
    ...formatDirectoryRules("Re-included paths (override exclusions)", draft.reinclude),
    `Sessions: ${draft.sessions ? "On — explicit opt-in; path rules still apply" : "Off — rules cannot enable sessions"}`,
    DIRECTORY_SCOPE_ALWAYS_LOCAL,
    "Synced files can contain sensitive data the secret scanner cannot identify. Review the preview before transferring.",
  ];
}
