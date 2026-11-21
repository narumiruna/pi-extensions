import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig, syncCheckConfigFingerprint } from "../settings/config.js";
import { localConfigPath } from "../settings/config-file.js";
import { updateSyncSetup } from "../settings/settings-management.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { normalizeSyncExclude, sameSyncExclude } from "../sync/exclude-policy.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import {
  acknowledgeSessions,
  type DirectoryRulesDraft,
  directoryScopeLines,
  formatDirectoryRules,
  promptDirectoryRules,
  summarizeDirectoryRules,
} from "./setup/directory-rules.js";
import { saveReviewedDraft } from "./setup/setup-review.js";
import { safeTerminalText } from "./terminal-text.js";

/** Transactional draft; Pi owns editor input/paste and Kit owns review/cancellation. */
export async function showExcludedPaths(ctx: ExtensionCommandContext, setupName: string, signal?: AbortSignal) {
  const validate = captureMutationOwner(ctx, signal);
  const isCurrent = () => {
    try {
      validate();
      return true;
    } catch {
      return false;
    }
  };
  validate();
  const config = await loadConfig(setupName);
  validate();
  if (config.scope === "agent-directory") return showDirectoryScope(ctx, config, signal);
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(
        [
          `Excluded paths: ${(config.exclude ?? []).map(safeTerminalText).join(", ") || "none"}`,
          `Edit sync.exclude in ${safeTerminalText(localConfigPath())}; an explicit array requires settings version 6 or later.`,
        ].join("\n"),
        "info",
      );
    return;
  }
  let draft = JSON.stringify(config.exclude ?? []);
  while (isCurrent()) {
    const entered = await ctx.ui.input("Excluded paths · JSON array · empty input keeps draft", draft, { signal });
    if (!isCurrent() || entered === undefined) return;
    const input = entered || draft;
    draft = input;
    let exclude: string[];
    try {
      const parsed: unknown = JSON.parse(input);
      if (!Array.isArray(parsed)) throw new Error("Enter a JSON string array.");
      exclude = normalizeSyncExclude(parsed);
    } catch {
      ctx.ui.notify("Invalid exclude array or unsupported pattern. No settings changed.", "error");
      continue;
    }
    if (sameSyncExclude(exclude, config.exclude)) return;
    let choice: "save" | "discard" | "edit" | undefined;
    const menu = defineMenu<undefined, "review", "choose", ExtensionCommandContext>({
      start: "review",
      screens: {
        review: () => ({
          kind: "actions",
          title: "Review excluded paths",
          lines: [
            `Setup: ${safeTerminalText(config.setupName)}`,
            "Draft only. Save requires at least settings version 6 and uses snapshot version 4 for this allowlist setup.",
            "Excluded local files stay untouched. New snapshots omit matching remote files; old history is NOT erased.",
            "Removing rules can expose local content or allow pull to replace it. Review a force push to publish policy changes.",
            "Previously excluded:",
            ...(config.exclude?.length ? config.exclude.map((rule) => `- ${safeTerminalText(rule)}`) : ["(none)"]),
            "Proposed excluded paths:",
            ...(exclude.length ? exclude.map((rule) => `+ ${safeTerminalText(rule)}`) : ["(none)"]),
          ],
          items: [
            { id: "save", label: "Save changes", action: "choose" },
            { id: "discard", label: "Discard changes", action: "choose" },
            { id: "edit", label: "Continue editing", action: "choose" },
          ],
          hint: "close",
        }),
      },
      actions: {
        choose: async ({ itemId }) => {
          choice = itemId === "save" ? "save" : itemId === "edit" ? "edit" : "discard";
          return { kind: "close" };
        },
      },
    });
    await runMenu(ctx, menu, { getState: () => undefined, signal, isCurrent });
    if (!isCurrent()) return;
    if (choice === "edit") continue;
    if (choice !== "save") return;
    try {
      await updateSyncSetup(
        setupName,
        (setup) => {
          validate();
          if (setup.sync.pathPolicy === "ignore-file")
            throw new Error("Edit the ignore file to change this setup's policy.");
          return { ...setup, sync: { ...setup.sync, exclude } };
        },
        { expectedConfigFingerprint: syncCheckConfigFingerprint(config), upgradeExclude: true, signal },
      );
      if (isCurrent()) ctx.ui.notify("Excluded paths saved. Applies to subsequent sync; no transfer started.", "info");
    } catch (error) {
      if (isCurrent())
        ctx.ui.notify(
          `Excluded paths not saved: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
          "error",
        );
    }
    return;
  }
}

export function directoryScopeSummary(config: AnySyncConfig) {
  return [
    `Setup: ${safeTerminalText(config.setupName)} · Scope: Pi agent directory`,
    `Excluded paths: ${summarizeDirectoryRules(config.exclude)}`,
    `Re-included paths: ${summarizeDirectoryRules(config.reinclude)}`,
    `Session opt-in: ${config.include.includes("sessions") ? "On (path rules still apply)" : "Off"}`,
    "Pi credentials and project trust always stay local.",
  ];
}

export async function showDirectoryScope(ctx: ExtensionCommandContext, config: AnySyncConfig, signal?: AbortSignal) {
  const validate = captureMutationOwner(ctx, signal);
  const isCurrent = () => {
    try {
      validate();
      return true;
    } catch {
      return false;
    }
  };
  if (!isCurrent()) return;
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(
        [
          ...directoryScopeSummary(config),
          `Edit sync.exclude, sync.reinclude, and sync.sessions in ${safeTerminalText(localConfigPath())}.`,
        ].join("\n"),
        "info",
      );
    return;
  }
  const original: DirectoryRulesDraft = {
    exclude: config.exclude ?? [],
    reinclude: config.reinclude ?? [],
    sessions: config.include.includes("sessions"),
  };
  const draft: DirectoryRulesDraft = { ...original };
  const change = () => ({
    exclude: !sameSyncExclude(draft.exclude, original.exclude),
    reinclude: !sameSyncExclude(draft.reinclude, original.reinclude),
    sessions: draft.sessions !== original.sessions,
  });
  const menu = defineMenu<undefined, "draft", "exclude" | "reinclude" | "sessions" | "review", ExtensionCommandContext>(
    {
      start: "draft",
      screens: {
        draft: () => ({
          kind: "actions",
          title: `Agent directory scope · ${safeTerminalText(config.setupName)}`,
          lines: [
            "Changes stay in this draft until you review and save. Back discards the draft.",
            "Session opt-in does not change path rules. Edit the rules separately to select which sessions can sync.",
          ],
          items: [
            { id: "exclude", label: `Edit excluded paths… (${draft.exclude.length})`, action: "exclude" },
            { id: "reinclude", label: `Edit re-included paths… (${draft.reinclude.length})`, action: "reinclude" },
            {
              id: "sessions",
              label: `Session opt-in: ${draft.sessions ? "On → Off" : "Off → On"}`,
              action: "sessions",
            },
            { id: "review", label: "Review changes…", action: "review" },
          ],
          hint: "back",
        }),
      },
      actions: {
        exclude: async ({ signal: actionSignal }) => editRules("exclude", actionSignal),
        reinclude: async ({ signal: actionSignal }) => editRules("reinclude", actionSignal),
        sessions: async ({ signal: actionSignal }) => {
          if (!draft.sessions && !(await acknowledgeSessions(ctx, actionSignal))) return { kind: "stay" };
          if (actionSignal.aborted || !isCurrent()) return { kind: "close" };
          draft.sessions = !draft.sessions;
          return { kind: "stay" };
        },
        review: async ({ signal: actionSignal }) => {
          const changed = change();
          if (!changed.exclude && !changed.reinclude && !changed.sessions) return { kind: "close" };
          try {
            validate();
            const saved = await saveReviewedDraft(
              ctx,
              "Review agent directory scope",
              [
                `Setup: ${safeTerminalText(config.setupName)}`,
                "",
                ...directoryScopeLines(draft),
                "",
                ...formatDirectoryRules("Previously excluded", original.exclude),
                ...formatDirectoryRules("Previously re-included", original.reinclude),
                `Previous session opt-in: ${original.sessions ? "On" : "Off"}`,
                "Changing rules can expose or replace files. Existing remote history is not erased.",
                "A remote policy mismatch blocks transfer until reviewed. Saving does not start a transfer.",
              ],
              "Save changes",
              (saveSignal) =>
                updateSyncSetup(
                  config.setupName,
                  (setup) => {
                    validate();
                    if (setup.sync.scope !== "agent-directory" || setup.sync.pathPolicy === "ignore-file")
                      throw new Error("Sync scope changed during review.");
                    return {
                      ...setup,
                      sync: {
                        ...setup.sync,
                        ...(changed.exclude ? { exclude: draft.exclude } : {}),
                        ...(changed.reinclude ? { reinclude: draft.reinclude } : {}),
                        ...(changed.sessions ? { sessions: draft.sessions } : {}),
                      },
                    };
                  },
                  { expectedConfigFingerprint: syncCheckConfigFingerprint(config), signal: saveSignal },
                ),
              actionSignal,
            );
            if (saved && !actionSignal.aborted && isCurrent())
              ctx.ui.notify("Agent directory rules saved. Applies to subsequent sync; no transfer started.", "info");
          } catch (error) {
            if (!actionSignal.aborted && isCurrent())
              ctx.ui.notify(
                `Agent directory rules not saved: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
                "error",
              );
          }
          return { kind: "close" };
        },
      },
    },
  );
  const result = await runMenu(ctx, menu, { getState: () => undefined, signal, isCurrent });
  if (result.kind === "error" && isCurrent()) throw result.error;

  async function editRules(kind: "exclude" | "reinclude", actionSignal: AbortSignal) {
    const rules = await promptDirectoryRules(ctx, kind, draft[kind], actionSignal, validate);
    if (actionSignal.aborted || !isCurrent()) return { kind: "close" as const };
    if (rules) draft[kind] = rules;
    return { kind: "stay" as const };
  }
}
