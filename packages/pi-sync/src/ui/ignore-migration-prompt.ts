import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { piDaemonClient } from "../daemon/pi-client.js";
import { ignoreFileSettingsAvailable, showIgnoreFileAction } from "./ignore-file-ui.js";
import { safeTerminalText } from "./terminal-text.js";

const reviewNow = "Review migration now";
const notNow = "Not now";

export async function showIgnoreMigrationPrompt(
  ctx: ExtensionCommandContext,
  setup: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI || signal.aborted || !isCurrent()) return false;
  if (!(await ignoreFileSettingsAvailable(ctx, signal)) || signal.aborted || !isCurrent()) return false;

  let shown = false;
  try {
    const client = piDaemonClient(ctx);
    const valid = () => {
      if (signal.aborted || !isCurrent()) return false;
      client.validate();
      return true;
    };
    const offer = await client.run("ignore.migration-offer", { setup }, signal, ctx);
    if (!valid()) return false;
    const token = readOfferToken(offer);
    if (!token) return false;

    shown = true;
    const choice = await ctx.ui.select(
      [
        `Review migration for sync setup “${safeTerminalText(setup)}”?`,
        "Your current rules still apply. Review the paths that would change before deciding.",
        "Migration does not start a transfer. You can review it later in Pi Sync Settings.",
      ].join("\n\n"),
      [reviewNow, notNow],
      { signal },
    );
    if (!valid()) return true;
    if (choice === notNow) {
      await client.run("ignore.migration-defer", { setup, token }, signal, ctx);
    } else if (choice === reviewNow) {
      await showIgnoreFileAction(ctx, setup, "migrate", ".syncignore", signal, token);
    }
  } catch (error) {
    if (!signal.aborted && isCurrent()) {
      ctx.ui.notify(
        `Pi Sync migration prompt: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
        "warning",
      );
    }
  }
  return shown;
}

function readOfferToken(value: unknown) {
  if (value === null) return undefined;
  const token = (value as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/u.test(token)) {
    throw new Error("Invalid migration offer from the daemon.");
  }
  return token;
}
