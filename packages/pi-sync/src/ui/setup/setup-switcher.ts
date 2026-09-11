import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig, syncConfigReviewIdentity } from "../../settings/config.js";
import { loadOnSwitch, readLocalConfigObject } from "../../settings/settings-store.js";
import type { AnySyncConfig } from "../../settings/settings-types.js";
import { ownRecord } from "../../settings/settings-validation.js";
import { useSyncSetup } from "../../sync/setup-switch.js";
import { errorMessage } from "../../sync/sync-errors.js";
import { automaticSyncSummary } from "../automatic-sync-summary.js";
import { type RunRoute, runCancellableOperation } from "../cancellable-operation.js";
import { dispatchManagerResult } from "../manager-result-dispatcher.js";
import { backendStorageDescription } from "../manager-state.js";
import { safeTerminalText } from "../terminal-text.js";

async function selectSetupForSwitch(
  ctx: ExtensionCommandContext,
  raw: Record<string, unknown>,
  targets: Record<string, unknown>,
  active: string | undefined,
  signal?: AbortSignal,
) {
  let selectedName: string | undefined;
  const nameById = new Map<string, string>();
  const profiles = ownRecord(raw.storageConnections);
  const menu = defineMenu<undefined, "setups", "select", ExtensionCommandContext>({
    start: "setups",
    screens: {
      setups: () => ({
        kind: "actions",
        title: "Switch sync setup",
        lines: [`Current sync setup: ${safeTerminalText(active ?? "none")}`],
        items: Object.keys(targets)
          .sort((left, right) => left.localeCompare(right))
          .map((candidate, index) => {
            const target = ownRecord(targets[candidate]);
            const storage = ownRecord(target?.storage);
            const profileName = typeof storage?.connection === "string" ? storage.connection : undefined;
            const profile = profileName && profiles ? ownRecord(profiles[profileName]) : undefined;
            const location = profile
              ? profile.type === "git"
                ? `${String(storage?.branch ?? "missing branch")}:${String(storage?.path ?? "missing path")}`
                : profile.type === "s3"
                  ? `${String(storage?.bucket ?? "missing bucket")}/${String(storage?.path ?? "missing path")}`
                  : String(storage?.path ?? "missing path")
              : `invalid: missing connection ${profileName ?? "reference"}`;
            const id = `setup:${index}`;
            nameById.set(id, candidate);
            return {
              id,
              label: `${safeTerminalText(candidate)}${candidate === active ? " (current)" : ""}`,
              description: `${safeTerminalText(profileName ?? "unknown")} · ${safeTerminalText(location)}`,
              action: "select" as const,
            };
          }),
        hint: "close",
      }),
    },
    actions: {
      select: async ({ itemId }) => {
        selectedName = nameById.get(itemId);
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal,
    isCurrent: () => !signal?.aborted,
  });
  return selectedName;
}

export async function showSetupSwitcher(
  ctx: ExtensionCommandContext,
  runRoute: RunRoute,
  selectedName?: string,
  signal?: AbortSignal,
) {
  const raw = await readLocalConfigObject();
  if (signal?.aborted) return false;
  if (raw?.version !== 3) {
    ctx.ui.notify("Add a second sync setup before switching setups.", "info");
    return false;
  }
  const targets = ownRecord(raw.syncSetups);
  if (!targets) {
    ctx.ui.notify("No sync setups are configured.", "warning");
    return false;
  }
  const active = typeof raw.activeSyncSetup === "string" ? raw.activeSyncSetup : undefined;
  let name = selectedName;
  if (!name) {
    name = await selectSetupForSwitch(ctx, raw, targets, active, signal);
    if (!name) return false;
  }
  if (!name || !Object.hasOwn(targets, name)) {
    ctx.ui.notify(`Sync setup “${safeTerminalText(name ?? "unknown")}” no longer exists.`, "warning");
    return false;
  }
  if (name === active) {
    ctx.ui.notify(`Sync setup “${safeTerminalText(name)}” is already current.`, "info");
    return false;
  }
  let config: AnySyncConfig;
  try {
    config = await loadConfig(name);
    if (signal?.aborted) return false;
  } catch (error) {
    ctx.ui.notify(
      `Cannot use sync setup “${safeTerminalText(name)}”: ${safeTerminalText(errorMessage(error))}`,
      "error",
    );
    return false;
  }
  const onSwitch = await loadOnSwitch();
  if (signal?.aborted) return false;
  const switchEffect =
    onSwitch === "ask-before-pull"
      ? "After switching, pi-sync will ask whether to review a pull for this setup."
      : onSwitch === "pull-after-switch"
        ? "After switching, pi-sync will check this setup and show exact changes before applying them."
        : "After switching, pi-sync will not pull or modify synced files.";
  const confirmed = await ctx.ui.confirm(
    "Switch sync setup?",
    [
      `From: ${safeTerminalText(active ?? "none")}`,
      `To: ${safeTerminalText(name)}`,
      `Storage: ${backendStorageDescription(config)}`,
      `Included content: ${config.include.length} paths`,
      `Automatic sync: ${automaticSyncSummary(config.automatic)} · Sessions: ${config.include.includes("sessions") ? "On" : "Off"}`,
      "",
      switchEffect,
    ].join("\n"),
    { signal },
  );
  if (signal?.aborted || !confirmed) return false;
  try {
    let pullClosed = false;
    const result = await useSyncSetup(
      ctx,
      name,
      async (selectedTarget) => {
        const pullResult = await runCancellableOperation(
          ctx,
          `Pulling sync setup “${safeTerminalText(name)}”…`,
          "pull",
          runRoute,
          {
            commitAware: true,
            cancelledMessage: null,
            target: selectedTarget,
            signal,
          },
        );
        const disposition = await dispatchManagerResult(ctx, pullResult, "pull", runRoute, signal);
        if (pullResult.kind === "closed" || pullResult.kind.endsWith("required")) {
          pullClosed = disposition.kind === "close";
        }
        if (disposition.appliedRoute === "pull") return "applied";
        if (pullResult.kind === "completed") return pullResult.outcome;
        return pullResult.kind === "cancelled" ? "cancelled" : undefined;
      },
      onSwitch,
      signal,
      syncConfigReviewIdentity(config),
    );
    if (pullClosed) return "closed";
    return result.pullApplied ? "pull-attempted" : "switched";
  } catch (error) {
    if (signal?.aborted) return false;
    ctx.ui.notify(
      `Sync setup “${safeTerminalText(name)}” was not switched: ${safeTerminalText(errorMessage(error))}`,
      "error",
    );
    return false;
  }
}
