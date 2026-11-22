import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { customAutomationSummary, type SyncMode, syncMode } from "@narumitw/pi-sync-daemon/engine/settings/sync-mode";
import { piDaemonClient } from "../daemon/pi-client.js";
import { syncSettingsConfigFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { startupTransferEnabled } from "../sync/agent-policy.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { syncSessionsSelected } from "../sync/sync-policy.js";
import { safeTerminalText } from "./terminal-text.js";

const REVIEW_POLICY = "Review current policy…";
const MODES = ["Manual", "Automatic"] as const;
type Policy = { setup: string; automatic: boolean; fingerprint: string };
type ModeSave = { kind: "cancelled" | "unchanged" } | { kind: "saved"; reviewRequired: boolean; fingerprint?: string };

export function canReviewSyncMode(config: AnySyncConfig) {
  return (
    config.reservedIgnoreNames !== undefined &&
    (startupTransferEnabled(config) || (config.automatic && syncSessionsSelected(config)))
  );
}

export async function readSyncModePolicy(ctx: ExtensionCommandContext, config: AnySyncConfig, signal?: AbortSignal) {
  if (!canReviewSyncMode(config) || signal?.aborted) return undefined;
  const client = piDaemonClient(ctx);
  const policy = (await client.run("daemon.policy", {}, signal)) as Policy;
  return policy.setup === config.setupName ? policy : undefined;
}

export function describeSyncMode(config: AnySyncConfig, canInspect: boolean, policy?: Policy) {
  const mode = syncMode(config);
  return {
    label: "Sync mode",
    currentValue: `${mode}${canInspect && canReviewSyncMode(config) && !policy?.automatic ? " · Review required" : ""}`,
    description: [
      mode === "Custom" ? `Custom: ${customAutomationSummary(config)}.` : undefined,
      "This setup: Manual runs only on request. Automatic checks and syncs while Pi is idle, with model help for supported conflicts.",
      "For custom combinations, edit pi-sync.json or use /skill:configure-pi-sync for guidance.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export async function showSyncModeSetting(ctx: ExtensionCommandContext, config: AnySyncConfig, signal: AbortSignal) {
  const validate = captureMutationOwner(ctx, signal);
  const client = piDaemonClient(ctx);
  const policy = await readSyncModePolicy(ctx, config, signal).catch(() => undefined);
  validate();
  const hardCancel = new AbortController();
  const stop = ctx.ui.onTerminalInput((data) => {
    if (!isKeyRelease(data) && matchesKey(data, Key.ctrl("c"))) {
      hardCancel.abort();
      return { consume: true };
    }
  });
  const selectSignal = AbortSignal.any([signal, hardCancel.signal]);
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(
      "Sync mode",
      [...MODES, ...(canReviewSyncMode(config) && !policy?.automatic ? [REVIEW_POLICY] : [])],
      { signal: selectSignal },
    );
  } finally {
    stop();
  }
  if (hardCancel.signal.aborted) return "close";
  validate();
  if (choice === undefined) return;
  const review = async (fingerprint: string) => {
    const accepted = await client.run("daemon.authorize-connected", { fingerprint }, signal);
    validate();
    return accepted === true;
  };
  if (choice === REVIEW_POLICY) {
    if (!policy) {
      ctx.ui.notify(
        "Could not read the active policy. If handover is required, run /sync daemon handover. Otherwise check /sync daemon status and the setup's rules before reopening Settings.",
        "warning",
      );
      return;
    }
    if (!policy.automatic && (await review(policy.fingerprint)))
      ctx.ui.notify("Automatic work approved for this setup and policy.", "info");
    return;
  }
  if (!MODES.some((mode) => choice === mode) || choice === syncMode(config)) return;
  const mode = choice as SyncMode;
  const result = (await client.run(
    "settings.sync-mode",
    { mode, expected: syncSettingsConfigFingerprint(config) },
    signal,
  )) as ModeSave;
  validate();
  if (result.kind !== "saved") return;
  if (!result.reviewRequired) {
    ctx.ui.notify(`${mode} sync saved. No transfer started.`, "info");
    return;
  }
  let approved = false;
  if (result.fingerprint) {
    try {
      approved = await review(result.fingerprint);
    } catch (error) {
      validate();
      ctx.ui.notify(
        `Automatic sync saved but approval failed: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
        "warning",
      );
      return;
    }
  }
  ctx.ui.notify(
    approved
      ? "Automatic sync saved and approved. No transfer started."
      : "Automatic sync saved. Review current policy before automatic work can start.",
    approved ? "info" : "warning",
  );
}
