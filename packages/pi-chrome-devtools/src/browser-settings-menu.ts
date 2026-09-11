import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { shutdownManagedBrowser, syncManagedBrowserSettings } from "./browser-manager.js";
import {
  applyAvailableChromeDevtoolsTools,
  configuredChromeDevtoolsTools,
  setChromeDevtoolsSessionOwner,
} from "./lazy-tools.js";
import {
  applyRuntimeBrowserSettings,
  applyRuntimeWebMcpSetting,
  invalidateWebMcpOperations,
  state,
  webMcpEnabled,
} from "./runtime.js";
import {
  type BrowserSettingsPatch,
  type BrowserSettingsSource,
  loadSettings,
  parseBrowserEndpoint,
  type SettingsLoadResult,
  saveBrowserSettings,
  saveWebMcpSettings,
} from "./settings.js";
import { sanitizeChromeDevtoolsDisplay } from "./tool-selector.js";

type BrowserSettingsScreen = "settings" | "endpoint" | "executable" | "extensions";
type BrowserSettingsAction =
  | "open-endpoint"
  | "save-endpoint"
  | "set-auto-launch"
  | "set-webmcp"
  | "open-executable"
  | "save-executable"
  | "show-extensions";

interface BrowserSettingsMenuState {
  load: SettingsLoadResult;
}

type CommandContext = ExtensionCommandContext;

export async function showChromeDevtoolsBrowserSettings(
  pi: ExtensionAPI,
  ctx: CommandContext,
  generation: number,
): Promise<{ closeParent: boolean }> {
  setChromeDevtoolsSessionOwner(pi, ctx.sessionManager);
  const ownerSignal = state.sessionController.signal;
  const isCurrent = () => generation === state.sessionGeneration && !ownerSignal.aborted;
  const projectTrusted = ctx.isProjectTrusted();
  const menu = defineMenu<BrowserSettingsMenuState, BrowserSettingsScreen, BrowserSettingsAction>({
    start: "settings",
    screens: {
      settings: ({ state: current }) => {
        if (current.load.userFile.kind === "invalid") return invalidSettingsScreen(current.load);
        const browser = current.load.effectiveBrowser;
        return {
          kind: "settings",
          title: "Chrome DevTools Browser settings",
          lines: settingsContextLines(current.load),
          items: [
            {
              id: "endpoint",
              label: "DevTools endpoint",
              description: 'HTTP origin with an explicit port; enter "default" to restore 127.0.0.1:9222.',
              currentValue: sanitizeChromeDevtoolsDisplay(browser.endpoint),
              action: "open-endpoint",
            },
            {
              id: "auto-launch",
              label: "Auto-launch",
              description: "Launch an isolated managed browser when a local endpoint is unavailable.",
              currentValue: browser.autoLaunchEnabled ? "On" : "Off",
              values: ["On", "Off"],
              action: "set-auto-launch",
            },
            {
              id: "executable",
              label: "Browser executable",
              description: 'Absolute executable path; enter "automatic" to restore browser discovery.',
              currentValue: sanitizeChromeDevtoolsDisplay(browser.executablePath ?? "Automatic"),
              action: "open-executable",
            },
            {
              id: "webmcp",
              label: "WebMCP · Experimental",
              description: "Allow user-confirmed calls to page-provided WebMCP tools in this browser session.",
              currentValue: current.load.effectiveWebMcpEnabled ? "On" : "Off",
              values: ["On", "Off"],
              action: "set-webmcp",
            },
            {
              id: "extensions",
              label: "Unpacked extensions",
              description: "Inspect trusted extension paths configured in user or project JSON.",
              currentValue: `${browser.extensionPaths.length} configured`,
              action: "show-extensions",
            },
          ],
        };
      },
      endpoint: ({ state: current }) => ({
        kind: "input",
        title: "DevTools endpoint",
        lines: [
          sanitizeChromeDevtoolsDisplay(`Current effective endpoint: ${current.load.effectiveBrowser.endpoint}`),
          'Enter an HTTP origin with an explicit port, or "default".',
        ],
        placeholder: "http://127.0.0.1:9222",
        action: "save-endpoint",
        hint: "back",
      }),
      executable: ({ state: current }) => ({
        kind: "input",
        title: "Browser executable",
        lines: [
          sanitizeChromeDevtoolsDisplay(
            `Current effective executable: ${current.load.effectiveBrowser.executablePath ?? "automatic discovery"}`,
          ),
          'Enter an absolute path, or "automatic".',
        ],
        placeholder: "absolute browser executable path",
        action: "save-executable",
        hint: "back",
      }),
      extensions: ({ state: current }) => ({
        kind: "detail",
        title: "Unpacked extensions",
        lines: extensionDetailLines(current.load),
        hint: "back",
      }),
    },
    actions: {
      "open-endpoint": () => ({ kind: "to", screen: "endpoint" }),
      "save-endpoint": async ({ value, signal }) => {
        if (value === undefined) return { kind: "rejected" };
        let endpoint: string | null;
        try {
          const trimmed = value.trim();
          endpoint = trimmed.toLowerCase() === "default" ? null : parseBrowserEndpoint(trimmed).endpoint;
        } catch (error) {
          notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
        const saved = await saveAndApplyBrowserPatch(ctx, generation, ownerSignal, signal, projectTrusted, {
          endpoint,
        });
        if (!saved) return { kind: "rejected" };
        notifyEffectiveSave(ctx, "endpoint", saved.effectiveBrowser.endpoint, saved.effectiveBrowser.endpointSource);
        return { kind: "back" };
      },
      "set-auto-launch": async ({ value, signal }) => {
        if (value !== "On" && value !== "Off") return { kind: "rejected" };
        const saved = await saveAndApplyBrowserPatch(ctx, generation, ownerSignal, signal, projectTrusted, {
          autoLaunch: value === "On",
        });
        if (!saved) return { kind: "rejected" };
        notifyEffectiveSave(
          ctx,
          "auto-launch",
          saved.effectiveBrowser.autoLaunchEnabled ? "On" : "Off",
          saved.effectiveBrowser.autoLaunchSource,
        );
        return { kind: "stay" };
      },
      "set-webmcp": async ({ value, signal }) => {
        if (value !== "On" && value !== "Off") return { kind: "rejected" };
        const saved = await saveAndApplyWebMcpSetting(
          pi,
          ctx,
          generation,
          ownerSignal,
          signal,
          projectTrusted,
          value === "On",
        );
        if (!saved) return { kind: "rejected" };
        ctx.ui.notify(
          saved.effectiveWebMcpEnabled
            ? "Experimental WebMCP enabled. Every page-provided tool call requires confirmation. Choose gateway availability under Browser tools."
            : "Experimental WebMCP disabled. Active WebMCP work was aborted and both gateway tools are unavailable.",
          "warning",
        );
        return { kind: "stay" };
      },
      "open-executable": () => ({ kind: "to", screen: "executable" }),
      "save-executable": async ({ value, signal }) => {
        if (value === undefined) return { kind: "rejected" };
        const trimmed = value.trim();
        const reset = ["automatic", "default", "none"].includes(trimmed.toLowerCase());
        if (!reset && (!trimmed || !isAbsolute(trimmed))) {
          notifySaveFailure(ctx, new Error('Enter an absolute path or "automatic".'));
          return { kind: "rejected" };
        }
        const executablePath = reset ? null : trimmed;
        const saved = await saveAndApplyBrowserPatch(ctx, generation, ownerSignal, signal, projectTrusted, {
          executablePath,
        });
        if (!saved) return { kind: "rejected" };
        notifyEffectiveSave(
          ctx,
          "browser executable",
          saved.effectiveBrowser.executablePath ?? "automatic discovery",
          saved.effectiveBrowser.executablePathSource,
        );
        return { kind: "back" };
      },
      "show-extensions": () => ({ kind: "to", screen: "extensions" }),
    },
  });
  const result = await runMenu(ctx, menu, {
    getState: async ({ signal }) => {
      signal.throwIfAborted();
      const load = await loadSettings({ cwd: ctx.cwd, projectTrusted });
      signal.throwIfAborted();
      return { load };
    },
    signal: ownerSignal,
    isCurrent,
    onError: (currentCtx, error) =>
      currentCtx.ui.notify(
        sanitizeChromeDevtoolsDisplay(`Chrome DevTools browser settings failed: ${formatError(error)}`),
        "error",
      ),
  });
  return { closeParent: result.kind === "closed" && result.reason === "close" };
}

async function saveAndApplyBrowserPatch(
  ctx: CommandContext,
  generation: number,
  ownerSignal: AbortSignal,
  actionSignal: AbortSignal,
  projectTrusted: boolean,
  patch: BrowserSettingsPatch,
) {
  try {
    await ctx.waitForIdle();
    if (!isCurrent(generation, ownerSignal, actionSignal)) return false;
    await saveBrowserSettings(patch);
    if (!isCurrent(generation, ownerSignal, actionSignal)) return false;
    invalidateWebMcpOperations(ctx.sessionManager, "Chrome DevTools browser configuration changed");
    await shutdownManagedBrowser(undefined, { owner: ctx.sessionManager });
    if (!isCurrent(generation, ownerSignal, actionSignal)) return false;
    const loaded = await loadSettings({ cwd: ctx.cwd, projectTrusted });
    if (!isCurrent(generation, ownerSignal, actionSignal)) return false;
    applyRuntimeBrowserSettings(loaded.effectiveBrowser, loaded.paths, projectTrusted);
    syncManagedBrowserSettings(ctx.sessionManager, loaded.effectiveBrowser);
    state.settingsNotice = loaded.notice;
    return loaded;
  } catch (error) {
    if (isCurrent(generation, ownerSignal, actionSignal)) notifySaveFailure(ctx, error);
    return false;
  }
}

async function saveAndApplyWebMcpSetting(
  pi: ExtensionAPI,
  ctx: CommandContext,
  generation: number,
  ownerSignal: AbortSignal,
  actionSignal: AbortSignal,
  projectTrusted: boolean,
  enabled: boolean,
) {
  const previousEnabled = webMcpEnabled(ctx.sessionManager);
  const previousTools = configuredChromeDevtoolsTools(pi);
  try {
    await ctx.waitForIdle();
    if (!isCurrent(generation, ownerSignal, actionSignal)) return false;
    applyRuntimeWebMcpSetting(enabled, ctx.sessionManager);
    applyAvailableChromeDevtoolsTools(pi, previousTools);
    await saveWebMcpSettings(enabled);
    if (!isOwnerCurrent(generation, ownerSignal)) return false;
    const loaded = await loadSettings({ cwd: ctx.cwd, projectTrusted });
    if (!isOwnerCurrent(generation, ownerSignal)) return false;
    state.settingsNotice = loaded.notice;
    return loaded;
  } catch (error) {
    if (!isOwnerCurrent(generation, ownerSignal)) return false;
    let rollbackError: unknown;
    try {
      applyRuntimeWebMcpSetting(previousEnabled, ctx.sessionManager);
      applyAvailableChromeDevtoolsTools(pi, previousTools);
    } catch (caught) {
      rollbackError = caught;
    }
    if (isCurrent(generation, ownerSignal, actionSignal)) {
      notifySaveFailure(
        ctx,
        rollbackError
          ? new Error(`${formatError(error)}; WebMCP rollback failed: ${formatError(rollbackError)}`)
          : error,
      );
    }
    return false;
  }
}

function isOwnerCurrent(generation: number, ownerSignal: AbortSignal) {
  return generation === state.sessionGeneration && !ownerSignal.aborted;
}

function isCurrent(generation: number, ownerSignal: AbortSignal, actionSignal: AbortSignal) {
  return isOwnerCurrent(generation, ownerSignal) && !actionSignal.aborted;
}

function invalidSettingsScreen(load: SettingsLoadResult) {
  const reason = load.userFile.kind === "invalid" ? load.userFile.reason : "The user settings file is unavailable.";
  return {
    kind: "detail" as const,
    title: "Chrome DevTools Browser settings · Read only",
    lines: [
      sanitizeChromeDevtoolsDisplay(
        `Fix the active user settings before saving; the file will not be overwritten. ${reason}`,
      ),
    ],
    hint: "back" as const,
  };
}

function settingsContextLines(load: SettingsLoadResult) {
  const browser = load.effectiveBrowser;
  return [
    `User settings · ${load.paths.user}`,
    `Effective sources: endpoint ${browser.endpointSource} · auto-launch ${browser.autoLaunchSource} · executable ${browser.executablePathSource}`,
    ...(load.notice ? [`Warning: ${load.notice}`] : []),
  ].map((line) => sanitizeChromeDevtoolsDisplay(line));
}

function extensionDetailLines(load: SettingsLoadResult) {
  const browser = load.effectiveBrowser;
  return [
    `Effective source: ${browser.extensionPathsSource}`,
    ...(browser.extensionPaths.length > 0
      ? browser.extensionPaths.map((extensionPath) => `- ${extensionPath}`)
      : ["No unpacked extensions are configured."]),
    "Edit browser.extensionPaths in the user JSON or a trusted project JSON, then run /reload.",
    "Unpacked extensions execute privileged browser code; load only paths you trust.",
  ].map((line) => sanitizeChromeDevtoolsDisplay(line));
}

function notifyEffectiveSave(
  ctx: CommandContext,
  setting: string,
  effectiveValue: string,
  source: BrowserSettingsSource,
) {
  const overrideNotice = source === "environment" ? " The deprecated environment override remains effective." : "";
  ctx.ui.notify(
    sanitizeChromeDevtoolsDisplay(
      `Chrome DevTools ${setting} saved. Effective ${setting}: ${effectiveValue} (${source}).${overrideNotice}`,
    ),
    "info",
  );
}

function notifySaveFailure(ctx: CommandContext, error: unknown) {
  ctx.ui.notify(
    sanitizeChromeDevtoolsDisplay(
      `Chrome DevTools browser settings save failed; previous settings remain active: ${formatError(error)}`,
    ),
    "warning",
  );
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
