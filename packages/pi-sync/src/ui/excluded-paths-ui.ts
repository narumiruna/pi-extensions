import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig, syncCheckConfigFingerprint } from "../settings/config.js";
import { localConfigPath } from "../settings/config-file.js";
import { updateSyncSetup } from "../settings/settings-management.js";
import { normalizeSyncExclude, sameSyncExclude } from "../sync/exclude-policy.js";
import { captureMutationOwner } from "../sync/sync-local.js";
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
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(
        [
          `Excluded paths: ${(config.exclude ?? []).map(safeTerminalText).join(", ") || "none"}`,
          `Edit sync.exclude in ${safeTerminalText(localConfigPath())}; an explicit array requires settings version 6.`,
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
            "Draft only. Save opts into settings version 6 / snapshot version 4; older clients must refuse them.",
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
