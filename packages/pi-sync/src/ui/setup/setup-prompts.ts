import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readLocalConfigObject } from "../../settings/settings-store.js";
import type { SyncPolicySettings } from "../../settings/settings-types.js";
import { validateConfigName } from "../../settings/settings-validation.js";
import { DEFAULT_SYNC_INCLUDE } from "../../sync/sync-policy.js";
import { AUTOMATIC_SYNC_DESCRIPTION } from "../sync-behavior.js";
import { safeTerminalText } from "../terminal-text.js";
import {
  acknowledgeSessions,
  directoryScopeLines,
  promptDirectoryRules,
  starterDirectoryRules,
} from "./directory-rules.js";
import { promptTextInput } from "./text-input.js";

export { AUTOMATIC_SYNC_DESCRIPTION } from "../sync-behavior.js";

export async function readSetupConnection(name: string, signal?: AbortSignal) {
  const connection = (await readLocalConfigObject())?.storageConnections[name];
  signal?.throwIfAborted();
  if (!connection) throw new Error("Storage connection changed; reopen setup.");
  return connection;
}

export async function chooseSetupPolicy(
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
  { legacySessions = false } = {},
): Promise<{ sync: SyncPolicySettings; lines: string[]; join: boolean } | undefined> {
  const choice = await ctx.ui.select(
    "Choose synced content\n\nAgent directory (recommended): sync all eligible files, including custom paths, except sessions, bin, and npm.\nJoining existing storage? Review its policy after saving. It will not be adopted automatically.\nLegacy mode: use a fixed list of included paths.",
    [
      "Agent directory (recommended)",
      "Agent directory · edit starter rules",
      "Join an existing remote",
      "Recommended Pi settings",
      "Minimal settings",
      "Cancel",
    ],
    { signal },
  );
  if (signal?.aborted || !choice || choice === "Cancel") return undefined;
  const join = choice === "Join an existing remote";
  if (
    !join &&
    choice !== "Agent directory (recommended)" &&
    choice !== "Agent directory · edit starter rules" &&
    choice !== "Recommended Pi settings" &&
    choice !== "Minimal settings"
  )
    return undefined;
  const joinScope = join
    ? await ctx.ui.select(
        "Choose the existing remote's scope\n\nUse Selected paths for an older setup with an include list. These choices do not change the remote's scope.",
        ["Pi agent directory", "Selected paths (legacy)", "Cancel"],
        { signal },
      )
    : undefined;
  if (signal?.aborted || (join && joinScope !== "Pi agent directory" && joinScope !== "Selected paths (legacy)"))
    return undefined;
  const legacy =
    choice === "Recommended Pi settings" || choice === "Minimal settings" || joinScope === "Selected paths (legacy)";
  const draft = starterDirectoryRules();
  const editRules = choice === "Agent directory · edit starter rules";
  if (editRules) {
    const exclude = await promptDirectoryRules(ctx, "exclude", draft.exclude, signal);
    if (signal?.aborted || !exclude) return undefined;
    draft.exclude = exclude;
    const reinclude = await promptDirectoryRules(ctx, "reinclude", draft.reinclude, signal);
    if (signal?.aborted || !reinclude) return undefined;
    draft.reinclude = reinclude;
  }
  const automatic = join ? false : await chooseAutomaticSync(ctx, signal);
  if (signal?.aborted || automatic === undefined) return undefined;
  const sessions = join || (legacy && !legacySessions) ? false : await chooseSessions(ctx, signal);
  if (signal?.aborted || sessions === undefined) return undefined;
  const remoteWarning = join
    ? "After saving, compare the remote policy. Automatic sync and sessions start Off. No policy is adopted without your review."
    : "If this location already has sync data, compare its policy in Settings before transferring. A mismatch blocks sync.";
  if (legacy) {
    const include = choice === "Minimal settings" ? ["settings.json", "AGENTS.md"] : [...DEFAULT_SYNC_INCLUDE];
    return {
      sync: { include: [...include, ...(sessions ? ["sessions"] : [])], automatic },
      lines: [...includedContentLines(include, sessions), remoteWarning],
      join,
    };
  }
  draft.sessions = sessions;
  if (sessions && !editRules) draft.exclude = draft.exclude.filter((rule) => rule !== "sessions");
  return {
    sync: {
      scope: "agent-directory",
      exclude: draft.exclude,
      ...(draft.reinclude.length ? { reinclude: draft.reinclude } : {}),
      sessions: draft.sessions,
      automatic,
    },
    lines: [...directoryScopeLines(draft), remoteWarning],
    join,
  };
}

export async function finishSetup(
  ctx: ExtensionCommandContext,
  name: string,
  message: string,
  join: boolean,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return;
  ctx.ui.notify(message, "info");
  if (!join) return;
  const { showRemoteSelectionReview } = await import("../remote-selection-ui.js");
  if (signal?.aborted) return;
  await showRemoteSelectionReview(ctx, name, signal, undefined, { origin: "settings" });
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

async function chooseSessions(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const choice = await ctx.ui.select(
    "Session conversations\n\nSessions can contain prompts, tool output, paths, screenshots, and secrets.",
    ["Keep sessions off (recommended)", "Include session conversations", "Cancel"],
    { signal },
  );
  signal?.throwIfAborted();
  if (!choice || choice === "Cancel") return undefined;
  if (choice !== "Include session conversations") return false;
  return (await acknowledgeSessions(ctx, signal)) ? true : undefined;
}

function includedContentLines(include: readonly string[], sessions = false) {
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
