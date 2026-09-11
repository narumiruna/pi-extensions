import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { refreshTargetCompletions } from "../../commands/setup-completions.js";
import { localConfigPath } from "../../settings/config-file.js";
import { safeTerminalText } from "../terminal-text.js";
import { showGitSetup } from "./git-ui.js";
import { showS3Setup } from "./s3-ui.js";
import { promptInitialSetupName } from "./setup-name-ui.js";
import { showWebDavSetup } from "./webdav-ui.js";

export async function showSetupWizard(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      `Guided sync setup requires TUI mode for masked credential input. Create version 3 settings in ${safeTerminalText(localConfigPath())}.`,
      "warning",
    );
    return false;
  }
  const preset = await ctx.ui.select(
    "Set up sync\n\nWhere will Pi settings be stored?",
    ["Cloudflare R2", "Other S3-compatible storage", "WebDAV", "Git", "Cancel"],
    { signal },
  );
  if (signal?.aborted || !preset || preset === "Cancel") return false;
  const targetName = await promptInitialSetupName(ctx, signal);
  if (!targetName) return false;
  if (preset === "WebDAV") {
    const saved = await showWebDavSetup(ctx, targetName, signal);
    if (signal?.aborted) return false;
    if (saved) await refreshTargetCompletions();
    return saved;
  }
  if (preset === "Git") {
    const saved = await showGitSetup(ctx, targetName, signal);
    if (signal?.aborted) return false;
    if (saved) await refreshTargetCompletions();
    return saved;
  }
  return showS3Setup(ctx, preset, targetName, signal);
}
