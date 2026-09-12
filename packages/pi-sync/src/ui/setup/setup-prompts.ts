import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readLocalConfigObject } from "../../settings/settings-store.js";
import { validateConfigName } from "../../settings/settings-validation.js";
import { DEFAULT_SYNC_INCLUDE } from "../../sync/sync-policy.js";
import { safeTerminalText } from "../terminal-text.js";
import { promptTextInput } from "./text-input.js";

export async function readSetupConnection(name: string, signal?: AbortSignal) {
  const connection = (await readLocalConfigObject())?.storageConnections[name];
  signal?.throwIfAborted();
  if (!connection) throw new Error("Storage connection changed; reopen setup.");
  return connection;
}

export const AUTOMATIC_SYNC_DESCRIPTION =
  "Check the current setup in the background at startup; review changes in /sync before transferring. At shutdown, automatically push selected content only when sessions are included. No startup dialogs.";

export async function chooseSetupContent(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const choice = await ctx.ui.select(
    "Choose included content\n\nRecommended: Pi settings, instructions, skills, prompts, themes, and extensions.\nMinimal: settings.json and AGENTS.md.\nReview the exact paths before saving.",
    ["Recommended Pi settings", "Minimal settings", "Cancel"],
    { signal },
  );
  signal?.throwIfAborted();
  if (!choice || choice === "Cancel") return undefined;
  return choice === "Minimal settings" ? ["settings.json", "AGENTS.md"] : [...DEFAULT_SYNC_INCLUDE];
}

export async function chooseAutomaticSync(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const choice = await ctx.ui.select(
    `Automatic sync for this setup\n\n${AUTOMATIC_SYNC_DESCRIPTION}`,
    ["Keep automatic sync off", "Enable automatic sync", "Cancel"],
    { signal },
  );
  signal?.throwIfAborted();
  return !choice || choice === "Cancel" ? undefined : choice === "Enable automatic sync";
}

export async function chooseSessions(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const choice = await ctx.ui.select(
    "Session conversations\n\nSessions can contain prompts, tool output, paths, screenshots, and secrets.",
    ["Keep sessions off (recommended)", "Include session conversations", "Cancel"],
    { signal },
  );
  signal?.throwIfAborted();
  if (!choice || choice === "Cancel") return undefined;
  if (choice !== "Include session conversations") return false;
  const confirmed = await ctx.ui.confirm(
    "Include session conversations?",
    "I understand that session JSONL can contain prompts, tool output, paths, screenshots, and secrets.",
    { signal },
  );
  signal?.throwIfAborted();
  return confirmed ? true : undefined;
}

export function includedContentLines(include: readonly string[], sessions = false) {
  const paths = [...include, ...(sessions && !include.includes("sessions") ? ["sessions"] : [])];
  return [
    `Included content: ${paths.length} paths`,
    ...paths.map((item) => `  ${safeTerminalText(item)}`),
    `Sessions: ${sessions ? "On — privacy warning acknowledged" : "Off"}`,
  ];
}

export async function promptResourceName(
  ctx: ExtensionCommandContext,
  kind: "sync setup" | "storage connection",
  defaultValue: string,
  signal?: AbortSignal,
  literalBrackets = false,
) {
  return promptTextInput(
    ctx,
    `Name this ${kind}\n\nA local label, such as home or work.`,
    {
      defaultValue,
      rejectPlaceholders: !literalBrackets,
      validate: async (name) => {
        validateConfigName(name, kind);
        const settings = await readLocalConfigObject();
        signal?.throwIfAborted();
        const names = kind === "sync setup" ? settings?.syncSetups : settings?.storageConnections;
        if (names && Object.hasOwn(names, name)) {
          throw new Error(`A ${kind} with this name already exists. Choose a different name.`);
        }
        return name;
      },
    },
    signal,
  );
}
