import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { requireSettings } from "../settings/settings-store.js";
import {
  migrateToSyncIgnore,
  migrationSyncIgnore,
  readSyncIgnoreFile,
  syncIgnorePath,
} from "../settings/sync-ignore-settings.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { safeTerminalText } from "./terminal-text.js";

export async function loadSyncIgnoreReview(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const validate = captureMutationOwner(ctx, signal);
  const settings = await requireSettings();
  validate();
  const previous = await readSyncIgnoreFile();
  validate();
  const migration = settings.version !== 6;
  const text = migration ? migrationSyncIgnore(settings) : (previous ?? "");
  const lines = migration
    ? [
        "All sync setups will share one synchronized .syncignore instead of sync.include.",
        "The generated rules preserve only paths allowed by EVERY legacy setup (their intersection). No new content or session scope is enabled.",
        "A private settings backup is retained. No files transfer now; the remote policy needs a separate reviewed force push.",
        "Settings version 6 and snapshot version 4 require compatible clients on every machine. Do not downgrade.",
      ]
    : [
        `Edit manually: ${syncIgnorePath()}`,
        "Git ignore rules, relative to the Pi agent directory. All setups share this file.",
        "Changes apply to the next operation; remote differences require review before automatic sync.",
        "Credentials and internal state are always excluded. Ignored local files are not deleted and remote history is not erased.",
        "Removing /sessions/ can authorize private session conversations. Review the destination before doing so.",
      ];
  return {
    migration,
    title: migration ? "Migrate all setups to .syncignore?" : "Shared .syncignore",
    content: [...lines, "", ...(text || "(empty — no user exclusions)").split("\n")].map(safeTerminalText).join("\n"),
    async save(workSignal: AbortSignal) {
      validate();
      if (!migration) return;
      await migrateToSyncIgnore(settings, previous, workSignal);
      validate();
      ctx.ui.notify(
        "All setups now use .syncignore. No files were transferred. Review the remote policy before syncing.",
        "info",
      );
    },
  };
}

export async function showSyncIgnoreSettings(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(
        `Edit the shared sync rules in ${safeTerminalText(syncIgnorePath())}. Legacy settings require reviewed migration in TUI.`,
        "info",
      );
    return;
  }
  const review = await loadSyncIgnoreReview(ctx, signal);
  if (signal?.aborted) return;
  const menu = defineMenu<undefined, "rules", "save", ExtensionCommandContext>({
    start: "rules",
    screens: {
      rules: () => ({
        kind: "review",
        title: review.title,
        content: review.content,
        format: { kind: "text" },
        viewportSize: "adaptive",
        hint: "close",
        ...(review.migration ? { confirm: { id: "save", label: "Migrate all setups", action: "save" } } : {}),
      }),
    },
    actions: {
      save: async ({ signal: workSignal }) => {
        await review.save(workSignal);
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, { getState: () => undefined, signal, isCurrent: () => !signal?.aborted });
}
