import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, type MenuSettingItem, runMenu } from "@narumitw/pi-tui-kit";
import { configFromSettings, loadSettingsConfig, syncCheckConfigFingerprint } from "../settings/config.js";
import { localConfigPath, readActiveLocalConfigDocumentForRepair } from "../settings/config-file.js";
import { updateSyncSetup } from "../settings/settings-management.js";
import { updateLocalConfig } from "../settings/settings-store.js";
import { validateSettingsDocument } from "../settings/settings-validation.js";
import { normalizeLocalFields, sameLocalFields } from "../sync/local-fields.js";
import {
  SETUP_SWITCH_ACTION_OPTIONS,
  saveOnSwitch,
  setupSwitchActionFromLabel,
  setupSwitchActionLabel,
} from "../sync/setup-switch.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import type { RunRoute } from "./cancellable-operation.js";
import { directoryScopeSummary, showExcludedPaths } from "./excluded-paths-ui.js";
import { manualIgnoreFileGuidance } from "./ignore-file-guidance.js";
import { ignoreFileSettingsAvailable, showIgnoreFileAction } from "./ignore-file-ui.js";
import { dispatchManagerResult } from "./manager-result-dispatcher.js";
import { boundedSettingsUI } from "./settings-frame.js";
import { IGNORE_SETUP_MANAGEMENT_LIMIT, ignoreSetupRecovery } from "./settings-review.js";
import { showEditSyncSetupStorage, showSyncSetupManager } from "./setup/setup-actions.js";
import { showStorageConnections } from "./storage-connections-ui.js";
import { describeSyncMode, readSyncModePolicy, showSyncModeSetting } from "./sync-mode-setting.js";
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
  if (!ctx.hasUI || signal?.aborted || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return disposition;
  const validateSettingsOwner = captureMutationOwner(ctx, signal);
  const isCurrent = () => {
    try {
      validateSettingsOwner();
      return true;
    } catch {
      return false;
    }
  };
  if (ctx.mode === "rpc") {
    // Preserve RPC catalog management; preference/credential editing stays TUI-only.
    const document = await readActiveLocalConfigDocumentForRepair().catch(() => null);
    if (!isCurrent()) return disposition;
    const settingsPath = document?.path ?? localConfigPath();
    let config: Awaited<ReturnType<typeof loadSettingsConfig>> | undefined;
    try {
      if (document) config = configFromSettings(validateSettingsDocument(document.parsed), reviewedSetup);
    } catch {
      config = undefined;
    }
    const limited = config?.reservedIgnoreNames !== undefined && !(await ignoreFileSettingsAvailable(ctx, signal));
    if (!isCurrent()) return disposition;
    ctx.ui.notify(
      [
        document === null
          ? "Could not read the active pi-sync settings file. Check file access or repair the JSON before reopening /sync."
          : `Edit pi-sync settings manually: ${safeTerminalText(settingsPath)}`,
        ...(limited ? [IGNORE_SETUP_MANAGEMENT_LIMIT, ...ignoreSetupRecovery(settingsPath)] : []),
        ...(!limited && config?.reservedIgnoreNames !== undefined
          ? ["Use TUI Settings → Sync mode → Review current policy… when automatic work requires approval."]
          : []),
        ...(config?.pathPolicy === "ignore-file"
          ? [manualIgnoreFileGuidance(config.ignoreFile ?? ".syncignore")]
          : config?.scope === "agent-directory"
            ? directoryScopeSummary(config)
            : []),
      ].join("\n"),
      "info",
    );
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
    await runMenu(ctx, management, { getState: () => undefined, signal, isCurrent });
    return disposition;
  }
  const initial = await loadSettingsConfig(reviewedSetup);
  if (!isCurrent()) return disposition;
  const ignoreAvailable = await ignoreFileSettingsAvailable(ctx, signal);
  if (!isCurrent()) return disposition;
  const setupName = initial.setupName;
  type SettingsState = Awaited<ReturnType<typeof loadSettingsConfig>> & {
    modePolicy?: Awaited<ReturnType<typeof readSyncModePolicy>>;
  };
  type Action =
    | "sync-mode"
    | "merge-settings"
    | "local-fields"
    | "content-policy"
    | "skip-secret-scan"
    | "show-status"
    | "debug"
    | "on-switch"
    | "include"
    | "exclude"
    | "ignore-switch"
    | "ignore-migrate"
    | "remote-include"
    | "storage-location"
    | "setups"
    | "connections";
  let saveStatus = "Simple choices save immediately. Back does not undo saved changes.";
  // Keep Kit's existing settings adapter: native SettingsList has no async save/rollback
  // contract or injected keybindings. Kit preserves these safety and accessibility behaviors.
  const menu = defineMenu<SettingsState, "settings", Action, ExtensionCommandContext>({
    start: "settings",
    screens: {
      settings: ({ state }) => ({
        kind: "settings",
        title: "Pi Sync Settings",
        lines: [
          `Setup: ${safeTerminalText(state.setupName)} · Connection: ${safeTerminalText(state.connectionName)}`,
          ...(state.reservedIgnoreNames !== undefined && !ignoreAvailable
            ? ["Setup preferences are read-only; adding, editing, and switching setups are unavailable."]
            : [saveStatus]),
          ...(state.pathPolicy === "ignore-file" ? [manualIgnoreFileGuidance(state.ignoreFile ?? ".syncignore")] : []),
        ],
        items: (
          [
            ...(state.pathPolicy === "ignore-file"
              ? ignoreAvailable
                ? [
                    {
                      id: "ignoreFile",
                      label: "Ignore file",
                      description: `Select another existing local file. Sessions: ${state.include.includes("sessions") ? "opted in (rules still apply)" : "off"}. No transfer starts.`,
                      currentValue: safeTerminalText(state.ignoreFile ?? ".syncignore"),
                      action: "ignore-switch" as const,
                    },
                  ]
                : []
              : state.reservedIgnoreNames !== undefined && !ignoreAvailable
                ? []
                : state.scope === "agent-directory"
                  ? [
                      {
                        id: "include",
                        label: "Agent directory scope",
                        description:
                          "Edit exclusions, re-inclusions, and session opt-in in one reviewed draft. No transfer starts.",
                        currentValue: `${state.exclude?.length ?? 0} excluded · ${state.reinclude?.length ?? 0} re-included · Sessions ${state.include.includes("sessions") ? "opted in" : "off"}`,
                        action: "include" as const,
                      },
                    ]
                  : [
                      {
                        id: "include",
                        label: "Included paths",
                        description:
                          "This setup: choose paths in a draft, then review and Save or Discard. No transfer is started.",
                        currentValue: `${state.include.length} paths · Edit`,
                        action: "include" as const,
                      },
                      {
                        id: "exclude",
                        label: "Excluded paths",
                        description:
                          "This setup: draft relative paths or *, ?, ** patterns, then review Save/Discard. No transfer starts; old history is retained.",
                        currentValue: `${state.exclude?.length ?? 0} rules · Edit`,
                        action: "exclude" as const,
                      },
                    ]),
            ...(ignoreAvailable && state.pathPolicy !== "ignore-file"
              ? [
                  {
                    id: "migrateIgnoreFile",
                    label: "Migrate to ignore file…",
                    description: "Review the scope change for this legacy setup. Migration does not start a transfer.",
                    currentValue: "Review",
                    action: "ignore-migrate" as const,
                  },
                ]
              : []),
            ...(state.reservedIgnoreNames !== undefined && !ignoreAvailable
              ? []
              : [
                  {
                    id: "remoteInclude",
                    label:
                      ignoreAvailable || state.scope === "agent-directory"
                        ? "Compare sync policies"
                        : "Compare included paths",
                    description:
                      state.pathPolicy === "ignore-file"
                        ? "Read-only comparison of local and remote policy, not file contents."
                        : "Compare what sync manages on this device and the remote, not file contents. No files transfer unless you explicitly Continue.",
                    currentValue: "Review",
                    action: "remote-include" as const,
                  },
                ]),
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
                state.reservedIgnoreNames !== undefined && !ignoreAvailable
                  ? "Review configured setups and recovery options. Adding, editing, and switching are unavailable."
                  : "This device: add, switch, edit, or remove sync setups. Each edit identifies its owner before saving.",
              currentValue: "Open",
              action: "setups",
            },
            {
              id: "connections",
              label: "Manage storage connections",
              description:
                state.reservedIgnoreNames !== undefined && !ignoreAvailable
                  ? "Review shared connections. Connection changes are unavailable while ignore-file setups are configured."
                  : "Shared connections on this device: review affected setups before saving server or credential changes.",
              currentValue: "Open",
              action: "connections",
            },
            { id: "syncMode", ...describeSyncMode(state, ignoreAvailable, state.modePolicy), action: "sync-mode" },
            {
              id: "onSwitch",
              label: "On setup switch",
              description:
                state.reservedIgnoreNames === undefined
                  ? "All setups on this device: ask before a pull review, open it automatically, or switch without pulling. Applies to subsequent switches."
                  : "While ignore-file setups exist, switching saves only the active setup. Run a reviewed pull separately.",
              currentValue: setupSwitchActionLabel(state.onSwitch),
              values: SETUP_SWITCH_ACTION_OPTIONS.map(({ label }) => label),
              action: "on-switch",
            },
            {
              id: "mergeSettings",
              label: "Merge settings fields",
              description:
                "This setup, opt-in: merge independent global settings.json root fields with a verified private ancestor. Arrays and nested objects remain atomic. Applies to subsequent sync; no reload.",
              currentValue: state.mergeSettings ? "On" : "Off",
              values: ["On", "Off"],
              action: "merge-settings",
            },
            {
              id: "contentPolicy",
              label: "Content merge / partial progress",
              description: `This setup, opt-in: ${state.scope === "agent-directory" ? "review format compatibility" : "review the version-5 upgrade"} before saving. Merge bounded text and prefix-only sessions; partial progress keeps withheld versions and baselines. Applies to subsequent sync; disabling does not clear recovery evidence.`,
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
          ] satisfies MenuSettingItem<Action>[]
        ).map((item) =>
          state.reservedIgnoreNames !== undefined && !ignoreAvailable && !["setups", "connections"].includes(item.id)
            ? { ...item, disabled: true }
            : item,
        ),
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
          const previous = await loadSettingsConfig(setupName);
          validate();
          const mergeContent = value === "Merge only" || value === "Merge + partial";
          const partialSync = value === "Partial only" || value === "Merge + partial";
          if (
            !(await ctx.ui.confirm(
              "Save content policy?",
              `${previous.pathPolicy === "ignore-file" ? "Ignore-file policy keeps settings version 8 and snapshot version 6; older clients must refuse them." : previous.scope === "agent-directory" ? "Agent directory scope uses snapshot version 5; older clients must refuse it." : "This explicitly upgrades settings to at least version 5; partial snapshots use version 3, or version 4 with exclusions, and older clients must refuse them."} Text/session merge is conservative. Partial sync preserves withheld versions and old baselines. Disabling does not clear unresolved groups or recovery evidence. Review a directional migration first if portable policy changes.`,
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
              setup.sync.scope !== previous.scope ||
              Boolean(setup.sync.mergeContent) !== Boolean(previous.mergeContent) ||
              Boolean(setup.sync.partialSync) !== Boolean(previous.partialSync)
            )
              throw new Error("Content policy changed during review.");
            return {
              ...current,
              version: current.version >= 6 ? current.version : 5,
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
          const previous = await loadSettingsConfig(setupName);
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
            `${previous.pathPolicy === "ignore-file" ? "Ignore-file policy keeps settings version 8 and snapshot version 6." : previous.scope === "agent-directory" ? "Agent directory scope uses snapshot version 5." : "This opts into at least settings/snapshot version 4/2; exclude-enabled setups retain snapshot version 4."} Older clients must refuse unsupported formats. Future snapshots omit these fields, but old remote history is NOT erased. Review an explicit force push/pull migration before further sync. Removed rules can expose or replace local-only values.`,
            { signal: mutationSignal },
          );
          validate();
          if (!confirmed) return { kind: "rejected" };
          ctx.ui.notify("Saving reviewed Pi Sync policy…", "info");
          await updateLocalConfig((current) => {
            validate();
            const setup = current.syncSetups[setupName];
            if (
              !setup ||
              setup.sync.scope !== previous.scope ||
              !sameLocalFields(setup.sync.localFields, previous.localFields)
            )
              throw new Error("Field policy changed while under review; reopen settings.");
            return {
              ...current,
              version: current.version >= 5 ? current.version : 4,
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
      "sync-mode": async ({ state: { modePolicy: _modePolicy, ...config }, signal: actionSignal }) => {
        const reviewSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        try {
          if ((await showSyncModeSetting(ctx, config, reviewSignal)) === "close") return exitSettings();
        } catch (error) {
          if (reviewSignal.aborted || !isCurrent()) return { kind: "close" };
          notifySaveFailure(ctx, error);
        }
        return resumeSettings(reviewSignal);
      },
      "skip-secret-scan": async ({ value, signal: actionSignal }) => {
        const skipSecretScan = value === "On";
        const mutationSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        try {
          const latest = await loadSettingsConfig(setupName);
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
          const latest = await loadSettingsConfig(setupName);
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
          const latest = await loadSettingsConfig(setupName);
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
      exclude: async ({ signal: actionSignal }) => {
        const editorSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        await showExcludedPaths(ctx, setupName, editorSignal);
        return resumeSettings(editorSignal);
      },
      "ignore-switch": ignoreAction("switch"),
      "ignore-migrate": ignoreAction("migrate"),
      "remote-include": async ({ state, signal: actionSignal }) => {
        if (state.reservedIgnoreNames !== undefined && !ignoreAvailable) return { kind: "rejected" };
        const reviewSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
        const { showRemoteSelectionReview } = await import("./remote-selection-ui.js");
        if (reviewSignal.aborted) return { kind: "rejected" };
        const review = await showRemoteSelectionReview(ctx, setupName, reviewSignal, undefined, {
          origin: "settings",
          ...(state.pathPolicy === "ignore-file" ? { readOnly: true } : { runRoute }),
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
  for (const id of ["merge-settings", "skip-secret-scan", "show-status", "debug", "on-switch"] as const) {
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
          : id === "debug"
            ? "Saved. Applies next session start."
            : "Saved. Applies to subsequent operations; status visibility applies immediately.";
      ctx.ui.notify(saveStatus, result?.kind === "rejected" ? "warning" : "info");
      return result;
    };
  }
  function ignoreAction(action: Parameters<typeof showIgnoreFileAction>[2]) {
    return async ({ state, signal: actionSignal }: { state: SettingsState; signal: AbortSignal }) => {
      if (!ignoreAvailable || (state.pathPolicy === "ignore-file") === (action === "migrate"))
        return { kind: "rejected" as const };
      const editorSignal = signal ? AbortSignal.any([signal, actionSignal]) : actionSignal;
      const latest = await loadSettingsConfig();
      if (editorSignal.aborted || !isCurrent()) return { kind: "close" as const };
      if (syncCheckConfigFingerprint(latest) !== syncCheckConfigFingerprint(state)) {
        ctx.ui.notify("Sync setup changed while Settings was open; reopen it before changing the policy.", "warning");
        return { kind: "close" as const };
      }
      await showIgnoreFileAction(ctx, setupName, action, state.ignoreFile ?? ".syncignore", editorSignal);
      return resumeSettings(editorSignal);
    };
  }
  async function resumeSettings(editorSignal: AbortSignal) {
    if (editorSignal.aborted || !isCurrent()) return { kind: "close" as const };
    try {
      const active = await loadSettingsConfig();
      if (editorSignal.aborted || !isCurrent() || active.setupName !== setupName) return { kind: "close" as const };
      // Stay reloads authoritative rows without pushing a duplicate screen or clearing search.
      return { kind: "stay" as const };
    } catch {
      return { kind: "close" as const };
    }
  }
  await runMenu({ ...ctx, ui: boundedSettingsUI(ctx) }, menu, {
    getState: async () => {
      const config = await loadSettingsConfig(setupName);
      if (!isCurrent() || !ignoreAvailable) return config;
      const modePolicy = await readSyncModePolicy(ctx, config, signal).catch(() => undefined);
      return { ...config, modePolicy };
    },
    signal,
    isCurrent,
  });
  return disposition;
}

function notifySaveFailure(ctx: ExtensionCommandContext, error: unknown) {
  ctx.ui.notify(
    `Pi Sync settings save failed: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
    "error",
  );
}
