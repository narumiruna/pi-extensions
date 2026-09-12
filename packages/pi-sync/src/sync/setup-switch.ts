import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { setSyncSetupCompletions } from "../commands/command.js";
import { loadConfig, syncConfigReviewIdentity, syncSetupReviewIdentity } from "../settings/config.js";
import { configuredSyncSetupNames, updateLocalConfig } from "../settings/settings-store.js";
import type { OnSwitchAction } from "../settings/settings-types.js";
import { normalizeOnSwitch } from "../settings/settings-validation.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { SetupPullRequiresUiError } from "./sync-errors.js";

export { SetupPullRequiresUiError } from "./sync-errors.js";

export const SETUP_SWITCH_ACTION_OPTIONS: ReadonlyArray<{
  label: string;
  value: OnSwitchAction;
}> = [
  { label: "Ask before pull", value: "ask-before-pull" },
  { label: "Start pull", value: "pull-after-switch" },
  { label: "Switch only", value: "switch-only" },
];

export function setupSwitchActionLabel(action: OnSwitchAction) {
  return SETUP_SWITCH_ACTION_OPTIONS.find((option) => option.value === action)?.label ?? action;
}

export function setupSwitchActionFromLabel(label: string): OnSwitchAction | undefined {
  return SETUP_SWITCH_ACTION_OPTIONS.find((option) => option.label === label)?.value;
}

export async function saveOnSwitch(action: OnSwitchAction, signal?: AbortSignal) {
  await updateLocalConfig((settings) => ({ ...settings, onSwitch: action }), signal);
}

export type SetupPullOutcome = "applied" | "cancelled";

export interface SetupSwitchResult {
  pullApplied: boolean;
}

export async function useSyncSetup(
  ctx: ExtensionCommandContext,
  name: string,
  pullCurrentSetup?: (setup: string) => Promise<SetupPullOutcome | undefined>,
  expectedAction?: OnSwitchAction,
  signal?: AbortSignal,
  expectedSetupIdentity?: string,
): Promise<SetupSwitchResult> {
  const normalized = name.trim();
  if (!normalized) throw new Error("Usage: /sync use <setup>");
  const loadedConfig = await loadConfig(normalized);
  const reviewedSetupIdentity = expectedSetupIdentity ?? syncConfigReviewIdentity(loadedConfig);
  throwIfAborted(signal);
  const switchResult: { action: OnSwitchAction; switched: boolean } = {
    action: "ask-before-pull",
    switched: false,
  };
  await updateLocalConfig((current) => {
    throwIfAborted(signal);
    const setup = current.syncSetups[normalized];
    if (!setup) {
      throw new Error(`Sync setup “${safeTerminalText(normalized)}” no longer exists.`);
    }
    const connectionName = setup.storage.connection;
    const connection = current.storageConnections[connectionName];
    if (
      !connection ||
      syncSetupReviewIdentity(normalized, setup, connectionName, connection) !== reviewedSetupIdentity
    ) {
      throw new Error(
        `Sync setup “${safeTerminalText(normalized)}” changed while the switch preview was open; reopen it and review the current destination.`,
      );
    }
    switchResult.action = normalizeOnSwitch(current.onSwitch);
    if (expectedAction !== undefined && switchResult.action !== expectedAction) {
      throw new Error("Setup-switch behavior changed while the preview was open; reopen it and retry.");
    }
    if (switchResult.action === "pull-after-switch" && !ctx.hasUI) {
      throw new SetupPullRequiresUiError(
        `Automatic setup pulls require interactive confirmation; sync setup “${safeTerminalText(normalized)}” was not switched. Use TUI or RPC mode.`,
      );
    }
    if (current.activeSyncSetup === normalized) return current;
    switchResult.switched = true;
    return { ...current, activeSyncSetup: normalized };
  }, signal);
  throwIfAborted(signal);
  if (!switchResult.switched) {
    ctx.ui.notify(`Sync setup “${safeTerminalText(normalized)}” is already current.`, "info");
    return { pullApplied: false };
  }
  setSyncSetupCompletions(await configuredSyncSetupNames());
  throwIfAborted(signal);

  if (switchResult.action === "switch-only") {
    ctx.ui.notify(`Switched to “${safeTerminalText(normalized)}”. No files were pulled.`, "info");
    return { pullApplied: false };
  }
  if (switchResult.action === "ask-before-pull") {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        `Switched to “${safeTerminalText(normalized)}”. No files were pulled because confirmation requires TUI mode; run /sync pull to apply this setup.`,
        "info",
      );
      return { pullApplied: false };
    }
    const confirmed = await ctx.ui.confirm(
      `Review a pull for sync setup “${safeTerminalText(normalized)}” now?`,
      "pi-sync will check the remote snapshot and show the exact local writes and deletions before applying anything.",
      { signal },
    );
    throwIfAborted(signal);
    if (!confirmed) {
      ctx.ui.notify(`Switched to “${safeTerminalText(normalized)}”; files were not pulled.`, "info");
      return { pullApplied: false };
    }
  }

  ctx.ui.notify(`Switched to “${safeTerminalText(normalized)}”. Checking remote files for a reviewed pull…`, "info");
  if (!pullCurrentSetup) {
    throw new Error(`Switched to “${safeTerminalText(normalized)}”, but pull is unavailable.`);
  }
  const pullOutcome = await pullCurrentSetup(normalized);
  throwIfAborted(signal);
  if (pullOutcome === "cancelled") {
    ctx.ui.notify(
      `Pull cancelled; sync setup “${safeTerminalText(normalized)}” remains current and synced files were not changed.`,
      "info",
    );
  }
  return { pullApplied: pullOutcome === "applied" };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
