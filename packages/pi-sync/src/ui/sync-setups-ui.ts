import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { configFromSettings, loadConfig } from "../settings/config.js";
import { ownRecord } from "../settings/settings-validation.js";
import { throwIfAborted } from "../sync/signals.js";
import { syncErrorGuidance } from "../sync/sync-error-guidance.js";
import { syncIncludeSelection, syncSessionsSelected } from "../sync/sync-policy.js";
import { IGNORE_SETUP_MANAGEMENT_LIMIT, ignoreSetupRecovery, loadSettingsCatalog } from "./settings-review.js";
import { safeTerminalText } from "./terminal-text.js";

export async function countValidSyncSetups(setups: Record<string, unknown> | undefined, signal?: AbortSignal) {
  let count = 0;
  for (const name of Object.keys(setups ?? {})) {
    throwIfAborted(signal);
    let valid = false;
    try {
      await loadConfig(name);
      valid = true;
    } catch {
      // Invalid setups stay visible in management but are not switchable.
    }
    throwIfAborted(signal);
    if (valid) count += 1;
  }
  return count;
}

type SyncSetupActions = {
  add(signal?: AbortSignal): Promise<void>;
  edit(name: string, signal?: AbortSignal): Promise<void>;
  makeCurrent(name: string, signal?: AbortSignal): Promise<"exit" | undefined>;
  remove(name: string, signal?: AbortSignal): Promise<void>;
};

interface SetupMenuState {
  setups: Record<string, unknown>;
  active?: string;
  recovery?: string[];
  selected?: {
    name: string;
    detail: string[];
    valid: boolean;
    removeUnavailable: boolean;
  };
}

export async function showSyncSetups(
  ctx: ExtensionCommandContext,
  actions: SyncSetupActions,
  signal?: AbortSignal,
): Promise<"exit" | undefined> {
  let selectedName: string | undefined;
  let exit = false;
  const nameById = new Map<string, string>();
  type Screen = "list" | "detail";
  type Action = "add" | "select" | "make-current" | "edit" | "remove" | "back";
  const menu = defineMenu<SetupMenuState, Screen, Action, ExtensionCommandContext>({
    start: "list",
    screens: {
      list: ({ state }) => {
        nameById.clear();
        const names = Object.keys(state.setups).sort((left, right) => left.localeCompare(right));
        return {
          kind: "actions",
          title: "Sync setups",
          lines: state.recovery ?? ["What to sync, where to store it, and when to sync."],
          items: [
            ...(state.recovery ? [] : [{ id: "add", label: "Add sync setup", action: "add" as const }]),
            ...names.map((name, index) => {
              const id = `setup:${index}`;
              nameById.set(id, name);
              return {
                id,
                label: `${safeTerminalText(name)}${name === state.active ? " (current)" : ""}`,
                description: setupSummary(state.setups[name]),
                action: "select" as const,
              };
            }),
          ],
          hint: "back",
        };
      },
      detail: ({ state }) => ({
        kind: "actions",
        title: state.selected ? `Sync setup “${safeTerminalText(state.selected.name)}”` : "Sync setup",
        lines: state.selected?.detail ?? ["This sync setup no longer exists."],
        items: state.selected
          ? [
              ...(state.recovery || state.selected.name === state.active || !state.selected.valid
                ? []
                : [
                    {
                      id: "make-current",
                      label: "Make current…",
                      action: "make-current" as const,
                    },
                  ]),
              ...(state.recovery ? [] : [{ id: "edit", label: "Edit storage location…", action: "edit" as const }]),
              ...(state.selected.removeUnavailable
                ? []
                : [
                    {
                      id: "remove",
                      label: "Remove sync setup…",
                      action: "remove" as const,
                    },
                  ]),
              { id: "back", label: "Back", action: "back" },
            ]
          : [{ id: "back", label: "Back", action: "back" }],
        hint: "back",
      }),
    },
    actions: {
      add: async ({ state }) => {
        if (state.recovery) return { kind: "rejected" };
        try {
          await actions.add(signal);
        } catch (error) {
          if (!signal?.aborted) {
            ctx.ui.notify(`Sync setup was not added: ${menuErrorMessage(error)}`, "error");
          }
        }
        return { kind: "stay" };
      },
      select: async ({ itemId }) => {
        selectedName = nameById.get(itemId);
        return selectedName ? { kind: "to", screen: "detail" } : { kind: "rejected" };
      },
      "make-current": async ({ state }) => {
        if (!selectedName || state.recovery || !state.selected?.valid) return { kind: "rejected" };
        try {
          exit = (await actions.makeCurrent(selectedName, signal)) === "exit";
          return exit ? { kind: "close" } : { kind: "stay" };
        } catch (error) {
          notifySetupChangeError(ctx, selectedName, error, signal);
          return { kind: "stay" };
        }
      },
      edit: async ({ state }) => {
        if (!selectedName || state.recovery) return { kind: "rejected" };
        try {
          await actions.edit(selectedName, signal);
        } catch (error) {
          notifySetupChangeError(ctx, selectedName, error, signal);
        }
        return { kind: "stay" };
      },
      remove: async ({ state }) => {
        if (!selectedName || !state.selected || state.selected.removeUnavailable) return { kind: "rejected" };
        const name = selectedName;
        try {
          await actions.remove(name, signal);
          selectedName = undefined;
          return { kind: "back" };
        } catch (error) {
          notifySetupChangeError(ctx, name, error, signal);
          return { kind: "stay" };
        }
      },
      back: async () => {
        selectedName = undefined;
        return { kind: "back" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: async () => loadSetupMenuState(selectedName, signal),
    signal,
    isCurrent: () => !signal?.aborted,
  });
  return exit ? "exit" : undefined;
}

async function loadSetupMenuState(selectedName: string | undefined, signal?: AbortSignal): Promise<SetupMenuState> {
  const catalog = await loadSettingsCatalog();
  throwIfAborted(signal);
  if (!catalog) return { setups: {} };
  const { syncSetups: setups, activeSyncSetup: active } = catalog.settings;
  const recovery = catalog.ignoreSetups.length
    ? [IGNORE_SETUP_MANAGEMENT_LIMIT, ...ignoreSetupRecovery(catalog.path)]
    : undefined;
  if (!selectedName || !Object.hasOwn(setups, selectedName)) return { setups, active, recovery };
  const setupCount = Object.keys(setups).length;
  const isCurrent = selectedName === active;
  let detail: string[];
  let valid = true;
  try {
    const config = configFromSettings(catalog.settings, selectedName);
    const selection = syncIncludeSelection(config.include);
    detail = [
      `Status: ${isCurrent ? "Current" : "Not current"}`,
      `Storage connection: ${safeTerminalText(config.connectionName)}`,
      `Endpoint: ${storageEndpoint(config)}`,
      `Storage location: ${storageLocation(config)}`,
      config.pathPolicy === "ignore-file"
        ? `Sync scope: Pi agent directory · ignore file: ${safeTerminalText(config.ignoreFile ?? ".syncignore")}`
        : config.scope
          ? `Sync scope: Pi agent directory · ${config.exclude?.length ?? 0} exclusions · ${config.reinclude?.length ?? 0} exceptions`
          : `Included content: ${selection.builtIns.length} built-in groups · ${selection.custom.length} extra paths`,
      `Sessions: ${syncSessionsSelected(config) ? "On — privacy-sensitive" : "Off"}`,
      `Automatic sync: ${config.automatic ? "On" : "Off"}`,
      `Automatic transfer at startup: ${config.automaticTransfer ? "On — may upload, replace, or delete selected files; no reload" : "Off"}`,
      `Autonomous sync: ${config.agentMode ? "On (autonomous merged sync)" : "Off"}`,
      `Continuous sync: ${config.continuous ? (config.agentMode ? "On (recurring requests and transfers)" : "Saved On; paused until Autonomous sync is enabled") : "Off"}`,
      ...(recovery
        ? []
        : [
            isCurrent
              ? "Edit included content and automatic sync in /sync → Settings."
              : "To edit included content or automatic sync, make this setup current, then open /sync → Settings.",
          ]),
    ];
  } catch (error) {
    valid = false;
    detail = [
      `Status: Invalid${isCurrent ? " current setup" : ""}`,
      `Reason: ${menuErrorMessage(error)}`,
      "Make current and sync are unavailable until this setup is repaired.",
    ];
  }
  const removeNeedsSwitch = isCurrent && setupCount > 1;
  const ignoreSetupsRemain = catalog.ignoreSetups.some((name) => name !== selectedName);
  const removeUnavailable = removeNeedsSwitch || ignoreSetupsRemain;
  if (recovery) {
    if (removeUnavailable) detail.unshift("Remove unavailable here; use manual recovery.");
    detail.unshift(...recovery);
  } else if (removeNeedsSwitch) {
    detail.push("Remove unavailable: switch to another setup first.");
  }
  return {
    setups,
    active,
    recovery,
    selected: { name: selectedName, detail, valid, removeUnavailable },
  };
}

function notifySetupChangeError(ctx: ExtensionCommandContext, name: string, error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return;
  ctx.ui.notify(`Sync setup “${safeTerminalText(name)}” was not changed: ${menuErrorMessage(error)}`, "error");
}

function menuErrorMessage(error: unknown) {
  return syncErrorGuidance(error);
}

function setupSummary(value: unknown) {
  const storage = ownRecord(ownRecord(value)?.storage);
  if (!storage || typeof storage.connection !== "string") return "Invalid storage reference";
  return safeTerminalText(
    `${storage.connection} · ${storage.bucket ?? storage.branch ?? "WebDAV"} · ${storage.path ?? "missing path"}`,
  );
}

function storageEndpoint(config: Awaited<ReturnType<typeof loadConfig>>) {
  switch (config.backend.type) {
    case "s3":
      return safeTerminalText(config.backend.profile.endpoint);
    case "git":
      return safeTerminalText(config.backend.profile.remote);
    case "webdav":
      return safeTerminalText(config.backend.profile.url);
  }
}

function storageLocation(config: Awaited<ReturnType<typeof loadConfig>>) {
  switch (config.backend.type) {
    case "s3":
      return safeTerminalText(`${config.backend.destination.bucket}/${config.storagePath}`);
    case "git":
      return safeTerminalText(`Git · ${config.backend.destination.branch}:${config.storagePath}`);
    case "webdav":
      return safeTerminalText(`WebDAV · ${config.storagePath}`);
  }
}
