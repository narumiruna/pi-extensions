import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { validateConfigName } from "../../settings/settings-validation.js";
import { errorMessage } from "../../sync/sync-errors.js";
import { safeTerminalText } from "../terminal-text.js";

export async function promptInitialSetupName(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  while (!signal?.aborted) {
    const hint = "For example: home or work. Leave blank for default.";
    // Pi styles the whole input title as accent; give only the guidance a muted role.
    const guidance = ctx.mode === "tui" ? ctx.ui.theme.fg("muted", hint) : hint;
    // This compact prompt owns its default hint; the general helper would repeat it.
    const value = await ctx.ui.input(`Sync setup name\n${guidance}`, undefined, { signal });
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    if (value === undefined) return undefined;
    const name = value.trim() || "default";
    try {
      if (name.includes("<") || name.includes(">")) {
        throw new Error("Replace example placeholders with your own name.");
      }
      validateConfigName(name, "sync setup");
      return name;
    } catch (error) {
      ctx.ui.notify(
        `This name cannot be used for the sync setup. ${safeTerminalText(errorMessage(error))} Enter another name (for example, default).`,
        "warning",
      );
    }
  }
  return undefined;
}
