import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, type MenuSettingItem, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig } from "../settings/config.js";
import { localConfigPath } from "../settings/config-file.js";
import { updateSyncSetup } from "../settings/settings-management.js";
import { updateLocalConfig } from "../settings/settings-store.js";
import { normalizeLocalFields, sameLocalFields } from "../sync/local-fields.js";
import {
  SETUP_SWITCH_ACTION_OPTIONS,
  saveOnSwitch,
  setupSwitchActionFromLabel,
  setupSwitchActionLabel,
} from "../sync/setup-switch.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import {
  AGENT_MODE_DESCRIPTION,
  CONTINUOUS_DESCRIPTION,
  saveAgentMode,
  saveContinuousMode,
} from "./agent-mode-setting.js";
import type { RunRoute } from "./cancellable-operation.js";
import { dispatchManagerResult } from "./manager-result-dispatcher.js";
import { boundedSettingsUI } from "./settings-frame.js";
import { showEditSyncSetupStorage, showSyncSetupManager } from "./setup/setup-actions.js";
import { showStorageConnections } from "./storage-connections-ui.js";
import { AUTOMATIC_SYNC_DESCRIPTION, STARTUP_TRANSFER_DESCRIPTION, startupTransferSummary } from "./sync-behavior.js";
import { configureSyncStatus } from "./sync-status.js";
import { safeTerminalText } from "./terminal-text.js";

export type SyncSettingsRoute = RunRoute;

export async function showSyncSettings(
  ctx: ExtensionCommandContext,
  runRoute: SyncSettingsRoute,
  signal?: AbortSignal,
  reviewedSetup?: string,
): Promise<"back" | "exit"> {
  let disposition: "back" | "exit" = "back";
  const exitSettings = () => {
    disposition = "exit";
    return { kind: "close" as const };
  };
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`Edit pi-sync settings manually: ${safeTerminalText(localConfigPath())}`, "info");
    if (ctx.mode === "rpc" && ctx.hasUI) {
      // Preserve RPC catalog management; preference/credential editing stays TUI-only.
      const management = defineMenu<undefined, "management", "setups" | "connections", ExtensionCommandContext>({
        start: "management",
        screens: {
          management: () => ({
            kind: "actions",
            title: "Sync settings management",
            items: [
              { id: "setups", label: "Manage sync setups", action: "setups" },
              { id: "connections", label: "Manage storage connections", action: "connections" },
            ],
            hint: "back",
          }),
        },
        actions: {
          setups: async ({ signal: actionSignal }) => {
            const result = await showSyncSetupManager(ctx, runRoute, actionSignal);
            return result === "exit" ? exitSettings() : { kind: "stay" };
          },
          connections: async ({ signal: actionSignal }) => {
            await showStorageConnections(ctx, actionSignal);
            return { kind: "stay" };
          },
        },
      });
      await runMenu(ctx, management, { getState: () => undefined, signal, isCurrent: () => !signal?.aborted });
    }
    return disposition;
  }
  const initial = await loadConfig(reviewedSetup);
  if (signal?.aborted) return "back";
  const setupName = initial.setupName;
  type Action =
    | "automatic"
    | "automatic-transfer"
    | "agent-mode"
    | "continuous"
    | "merge-settings"
    | "local-fields"
    | "content-policy"
    | "skip-secret-scan"
    | "show-status"
    | "debug"
    | "on-switch"
    | "include"
    | "remote-include"
    | "storage-location"
    | "setups"
    | "connections";
  let saveStatus = "Simple choices save immediately. Back does not undo saved changes.";
  // Keep Kit's existing settings adapter: native SettingsList has no async save/rollback
  // contract or injected keybindings. Kit preserves these safety and accessibility behaviors.
  const menu = defineMenu<Awaited<ReturnType<typeof loadConfig>>, "settings", Action, ExtensionCommandContext>({
    start: "settings",
    screens: {
      settings: ({ state }) => ({
        kind: "settings",
        title: "Pi Sync Settings",
        lines: [
          `Setup: ${safeTerminalText(state.setupName)} · Connection: ${safeTerminalText(state.connectionName)}`,
          saveStatus,
        ],
        items: [
          {
            id: "include",
            label: "Included paths",
            description:
              "This setup: choose paths in a draft, then review and Save or Discard. No transfer is started.",
            currentValue: `${state.include.length} paths · Edit`,
            action: "include",
          },
          {
            id: "remoteInclude",
            label: "Compare included paths",
            description:
              "This setup: compare included-path policies, not file contents. Review before saving either list; no files transfer unless you explicitly Continue.",
            currentValue: "Review",
            action: "remote-include",
          },
          {
            id: "localFields",
            label: "Machine-local fields",
            description:
              "This setup: settings.json root fields excluded from future portable snapshots, not project overrides. Policy changes require reviewed directional migration; old history remains.",
            currentValue: `${state.localFields?.length ?? 0} fields · Edit`,
            action: "local-fields",
          },
          {
            id: "storageLocation",
            label: "Storage location",
            description: "This setup: review and save bucket, branch, or path changes. Remote history is not moved.",
            currentValue:
              state.backend.type === "s3"
                ? `${safeTerminalText(state.backend.destination.bucket)} · ${safeTerminalText(state.backend.destination.prefix)}`
                : state.backend.type === "git"
                  ? `${safeTerminalText(state.backend.destination.branch)} · ${safeTerminalText(state.backend.destination.directory)}`
                  : safeTerminalText(state.backend.destination.path),
            action: "storage-location",
          },
          {
            id: "setups",
            label: "Manage sync setups",
            description:
              "This device: add, switch, edit, or remove sync setups. Each edit identifies its owner before saving.",
            currentValue: "Open",
            action: "setups",
          },
          {
            id: "connections",
            label: "Manage storage connections",
            description:
              "Shared connections on this device: review affected setups before saving server or credential changes.",
            currentValue: "Open",
            action: "connections",
          },
          {
            id: "automatic",
            label: "Automatic sync",
            description: AUTOMATIC_SYNC_DESCRIPTION,
            currentValue: state.automatic ? "On" : "Off",
            values: ["On", "Off"],
            action: "automatic",
          },
          {
            id: "automaticTransfer",
            label: "Startup transfer",
            description: `${STARTUP_TRANSFER_DESCRIPTION} Saved preference and requirements: ${startupTransferSummary(state)}.`,
            currentValue: state.automaticTransfer ? "On" : "Off",
            values: ["On", "Off"],
            action: "automatic-transfer",
          },
          {
            id: "agentMode",
            label: "Agent mode (experimental)",
            description: AGENT_MODE_DESCRIPTION,
            currentValue: state.agentMode ? "On" : "Off",
            values: ["On", "Off"],
            action: "agent-mode",
          },
          {
            id: "continuous",
            label: "Continuous sync (experimental)",
            description: `${CONTINUOUS_DESCRIPTION}${state.continuous && !state.agentMode ? " Saved On, but paused until Agent mode is enabled." : ""}`,
            currentValue: state.continuous ? "On" : "Off",
            values: ["On", "Off"],
            action: "continuous",
          },
          {
            id: "onSwitch",
            label: "On setup switch",
            description:
              "All setups on this device: ask before a pull review, open it automatically, or switch without pulling. Applies to subsequent switches.",
            currentValue: setupSwitchActionLabel(state.onSwitch),
            values: SETUP_SWITCH_ACTION_OPTIONS.map(({ label }) => label),
            action: "on-switch",
          },
          {
            id: "mergeSettings",
            label: "Merge settings fields",
            description:
              "This setup, experimental opt-in: merge independent global settings.json root fields with a verified private ancestor. Arrays and nested objects remain atomic. Applies to subsequent sync; no reload.",
            currentValue: state.mergeSettings ? "On" : "Off",
            values: ["On", "Off"],
            action: "merge-settings",
          },
          {
            id: "contentPolicy",
            label: "Content merge / partial progress",
            description:
              "This setup, experimental opt-in: review the version-5 upgrade before saving. Merge bounded text and prefix-only sessions; partial progress keeps withheld versions and baselines. Applies to subsequent sync; disabling does not clear recovery evidence.",
            currentValue: state.mergeContent
              ? state.partialSync
                ? "Merge + partial"
                : "Merge only"
              : state.partialSync
                ? "Partial only"
                : "Off",
            values: ["Off", "Merge only", "Merge + partial", "Partial only"],
            action: "content-policy",
          },
          {
            id: "skipSecretScan",
            label: "Skip secret scan",
            description:
              "All setups on this device: skip possible-secret checks on subsequent pushes, including automatic pushes. Other safety checks remain. Diagnostics still scans.",
            currentValue: state.skipSecretScan ? "On" : "Off",
            values: ["On", "Off"],
            action: "skip-secret-scan",
          },
          {
            id: "showStatus",
            label: "Show sync status",
            description:
              "All setups on this device: saved and applied immediately to Pi status. Review widgets and notifications remain available.",
            currentValue: state.showStatus ? "On" : "Off",
            values: ["On", "Off"],
            action: "show-status",
          },
          {
            id: "debug",
            label: "Debug startup timings",
            description:
              "All setups on this device: show startup durations in the TUI transcript or RPC notifications, including initial Continuous sync. Applies next session start; no credentials or file contents.",
            currentValue: state.debug ? "On" : "Off",
            values: ["On", "Off"],
            action: "debug",
          },
        ] satisfies MenuSettingItem<Action>[],
      }),
    },
    actions: {
      "storage-location": async ({ signal: actionSignal }) => {
        const editorSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        await showEditSyncSetupStorage(ctx, setupName, editorSignal);
        return resumeSettings(editorSignal);
      },
      setups: async ({ signal: actionSignal }) => {
        const editorSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        const result = await showSyncSetupManager(ctx, runRoute, editorSignal);
        return result === "exit" ? exitSettings() : resumeSettings(editorSignal);
      },
      connections: async ({ signal: actionSignal }) => {
        const editorSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        await showStorageConnections(ctx, editorSignal);
        return resumeSettings(editorSignal);
      },
      "content-policy": async ({ value, signal: actionSignal }) => {
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, mutationSignal);
        try {
          const previous = await loadConfig(setupName);
          validate();
          const mergeContent = value === "Merge only" || value === "Merge + partial";
          const partialSync = value === "Partial only" || value === "Merge + partial";
          if (
            !(await ctx.ui.confirm(
              "Save experimental content policy?",
              "This explicitly upgrades settings to version 5; partial snapshots use version 3 and older clients must refuse them. Text/session merge is conservative. Partial sync preserves withheld versions and old baselines. Disabling does not clear unresolved groups or recovery evidence. Review a directional migration first if portable policy changes.",
              { signal: mutationSignal },
            ))
          )
            return { kind: "rejected" };
          validate();
          ctx.ui.notify("Saving reviewed Pi Sync policy…", "info");
          await updateLocalConfig((current) => {
            validate();
            const setup = current.syncSetups[setupName];
            if (
              !setup ||
              Boolean(setup.sync.mergeContent) !== Boolean(previous.mergeContent) ||
              Boolean(setup.sync.partialSync) !== Boolean(previous.partialSync)
            )
              throw new Error("Content policy changed during review.");
            return {
              ...current,
              version: 5,
              syncSetups: {
                ...current.syncSetups,
                [setupName]: { ...setup, sync: { ...setup.sync, mergeContent, partialSync } },
              },
            };
          }, mutationSignal);
          validate();
          saveStatus =
            "Saved reviewed policy for this setup. Applies to subsequent sync operations; recovery evidence is retained.";
          ctx.ui.notify(saveStatus, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "merge-settings": async ({ value, signal: actionSignal }) => {
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, mutationSignal);
        try {
          validate();
          await updateSyncSetup(
            setupName,
            (setup) => ({ ...setup, sync: { ...setup.sync, mergeSettings: value === "On" } }),
            { signal: mutationSignal },
          );
          validate();
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "local-fields": async ({ signal: actionSignal }) => {
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, mutationSignal);
        try {
          const previous = await loadConfig(setupName);
          validate();
          const input = await ctx.ui.input(
            "Machine-local settings.json root fields (JSON string array)",
            JSON.stringify(previous.localFields ?? []),
            { signal: mutationSignal },
          );
          validate();
          if (input === undefined) return { kind: "rejected" };
          let fields: string[];
          try {
            fields = normalizeLocalFields(JSON.parse(input));
          } catch {
            throw new Error("Invalid localFields JSON array; no policy was changed.");
          }
          if (sameLocalFields(previous.localFields, fields)) return { kind: "stay" };
          const confirmed = await ctx.ui.confirm(
            "Save portable field policy?",
            "This opts into settings/snapshot version 4/2; older clients must refuse them. Future snapshots omit these fields, but old remote history is NOT erased. Review an explicit force push/pull migration before further sync. Removed rules can expose or replace local-only values.",
            { signal: mutationSignal },
          );
          validate();
          if (!confirmed) return { kind: "rejected" };
          ctx.ui.notify("Saving reviewed Pi Sync policy…", "info");
          await updateLocalConfig((current) => {
            validate();
            const setup = current.syncSetups[setupName];
            if (!setup || !sameLocalFields(setup.sync.localFields, previous.localFields))
              throw new Error("Field policy changed while under review; reopen settings.");
            return {
              ...current,
              version: current.version === 5 ? 5 : 4,
              syncSetups: {
                ...current.syncSetups,
                [setupName]: { ...setup, sync: { ...setup.sync, localFields: fields } },
              },
            };
          }, mutationSignal);
          validate();
          saveStatus =
            "Saved reviewed policy for this setup. Applies to subsequent sync operations; recovery evidence is retained.";
          ctx.ui.notify(saveStatus, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      automatic: async ({ value, signal: actionSignal }) => {
        const automatic = value === "On";
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        try {
          const latest = await loadConfig(setupName);
          if (mutationSignal.aborted) return { kind: "rejected" };
          if (latest.automatic === automatic) return { kind: "stay" };
          await updateSyncSetup(setupName, (setup) => ({ ...setup, sync: { ...setup.sync, automatic } }), {
            signal: mutationSignal,
          });
          if (mutationSignal.aborted) return { kind: "rejected" };
          ctx.ui.notify(
            `Automatic sync ${automatic ? "enabled" : "disabled"} for “${safeTerminalText(setupName)}”.`,
            "info",
          );
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "agent-mode": async ({ value, signal: actionSignal }) => {
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, mutationSignal);
        try {
          const saved = await saveAgentMode(ctx, setupName, value === "On", mutationSignal);
          if (!saved) return { kind: "rejected" };
          try {
            validate();
            ctx.ui.notify(
              "Agent mode saved. Applies to subsequent sync and the next session start; no transfer started.",
              "info",
            );
          } catch {
            // The save committed. A closed or replaced UI must not report a failed save.
            // The next Settings read shows the persisted value.
          }
          return { kind: "stay" };
        } catch (error) {
          try {
            validate();
          } catch {
            return { kind: "rejected" };
          }
          notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      continuous: async ({ value, signal: actionSignal }) => {
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, mutationSignal);
        try {
          const saved = await saveContinuousMode(ctx, setupName, value === "On", mutationSignal);
          if (!saved) return { kind: "rejected" };
          try {
            validate();
            ctx.ui.notify(
              value === "On"
                ? "Continuous sync enabled. Monitoring starts after the /sync command or manager closes; completed work is not undone."
                : "Continuous sync disabled. Completed work is not undone.",
              "info",
            );
          } catch {
            /* committed save; do not use stale UI */
          }
          return { kind: "stay" };
        } catch (error) {
          try {
            validate();
          } catch {
            return { kind: "rejected" };
          }
          notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "automatic-transfer": async ({ value, signal: actionSignal }) => {
        const automaticTransfer = value === "On";
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        try {
          await updateSyncSetup(setupName, (setup) => ({ ...setup, sync: { ...setup.sync, automaticTransfer } }), {
            signal: mutationSignal,
          });
          if (mutationSignal.aborted) return { kind: "rejected" };
          ctx.ui.notify(
            `Automatic startup transfer ${automaticTransfer ? "enabled for the next session start" : "disabled"}. Completed transfers are not undone.`,
            "info",
          );
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "skip-secret-scan": async ({ value, signal: actionSignal }) => {
        const skipSecretScan = value === "On";
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        try {
          const latest = await loadConfig(setupName);
          if (mutationSignal.aborted) return { kind: "rejected" };
          if (latest.skipSecretScan === skipSecretScan) return { kind: "stay" };
          await updateLocalConfig((settings) => ({ ...settings, skipSecretScan }), mutationSignal);
          if (mutationSignal.aborted) return { kind: "rejected" };
          ctx.ui.notify(`Secret scan ${skipSecretScan ? "disabled" : "enabled"} for pushes in all setups.`, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "show-status": async ({ value, signal: actionSignal }) => {
        const showStatus = value === "On";
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        try {
          const latest = await loadConfig(setupName);
          if (mutationSignal.aborted) return { kind: "rejected" };
          if (latest.showStatus === showStatus) return { kind: "stay" };
          await updateLocalConfig((settings) => ({ ...settings, showStatus }), mutationSignal);
          if (mutationSignal.aborted) return { kind: "rejected" };
          configureSyncStatus(ctx, showStatus);
          ctx.ui.notify(`Pi Sync status ${showStatus ? "enabled" : "disabled"} for all setups.`, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      debug: async ({ value, signal: actionSignal }) => {
        const debug = value === "On";
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        try {
          await updateLocalConfig((settings) => ({ ...settings, debug }), mutationSignal);
          if (mutationSignal.aborted) return { kind: "rejected" };
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "on-switch": async ({ value, signal: actionSignal }) => {
        const action = value ? setupSwitchActionFromLabel(value) : undefined;
        if (!action) return { kind: "rejected" };
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        try {
          const latest = await loadConfig(setupName);
          if (mutationSignal.aborted) return { kind: "rejected" };
          if (latest.onSwitch === action) return { kind: "stay" };
          await saveOnSwitch(action, mutationSignal);
          if (mutationSignal.aborted) return { kind: "rejected" };
          ctx.ui.notify(`After switching setup: ${value}.`, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!mutationSignal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      include: async ({ signal: actionSignal }) => {
        const editorSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        await runRoute("files", editorSignal, undefined, setupName);
        return editorSignal.aborted ? { kind: "rejected" } : { kind: "stay" };
      },
      "remote-include": async ({ signal: actionSignal }) => {
        const reviewSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        const { showRemoteSelectionReview } = await import("./remote-selection-ui.js");
        if (reviewSignal.aborted) return { kind: "rejected" };
        const review = await showRemoteSelectionReview(ctx, setupName, reviewSignal, undefined, {
          origin: "settings",
          runRoute,
        });
        if (reviewSignal.aborted) return { kind: "rejected" };
        if (review.kind === "route-result") {
          const disposition = await dispatchManagerResult(ctx, review.result, review.route, runRoute, reviewSignal);
          return disposition.kind === "close" ? exitSettings() : { kind: "stay" };
        }
        return review.kind === "closed" || review.kind === "stale" ? exitSettings() : { kind: "stay" };
      },
    },
  });
  for (const id of [
    "automatic",
    "automatic-transfer",
    "merge-settings",
    "skip-secret-scan",
    "show-status",
    "debug",
    "on-switch",
  ] as const) {
    const save = menu.actions[id];
    menu.actions[id] = async (action) => {
      const validate = captureMutationOwner(ctx, action.signal);
      validate();
      ctx.ui.notify("Saving Pi Sync setting…", "info");
      const result = await save(action);
      if (action.signal.aborted || signal?.aborted) return { kind: "rejected" };
      validate();
      saveStatus =
        result?.kind === "rejected"
          ? "Save failed or rejected. Previous value retained; retry is available."
          : id === "automatic-transfer" || id === "automatic" || id === "debug"
            ? "Saved. Enabling startup work applies next session start; completed transfers are not undone."
            : "Saved. Applies to subsequent operations; status visibility applies immediately.";
      ctx.ui.notify(saveStatus, result?.kind === "rejected" ? "warning" : "info");
      return result;
    };
  }
  async function resumeSettings(editorSignal: AbortSignal) {
    if (editorSignal.aborted) return { kind: "close" as const };
    try {
      const active = await loadConfig();
      if (editorSignal.aborted || active.setupName !== setupName) return { kind: "close" as const };
      // Stay reloads authoritative rows without pushing a duplicate screen or clearing search.
      return { kind: "stay" as const };
    } catch {
      return { kind: "close" as const };
    }
  }
  await runMenu({ ...ctx, ui: boundedSettingsUI(ctx) }, menu, {
    getState: () => loadConfig(setupName),
    signal,
    isCurrent: () => !signal?.aborted,
  });
  return disposition;
}

function notifySaveFailure(ctx: ExtensionCommandContext, error: unknown) {
  ctx.ui.notify(
    `Pi Sync settings save failed: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
    "error",
  );
}
