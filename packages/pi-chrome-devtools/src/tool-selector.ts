import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  browserCandidateHint,
  browserLifecycleState,
  browserSettingsForOwner,
  devToolsEndpoint,
  endpointConfigHint,
  endpointSourceLabel,
  launchAttemptLines,
  launchHint,
  launchModeLabel,
  managedBrowserForOwner,
} from "./browser-manager.js";
import { sanitizeChromeDevtoolsDisplay } from "./display.js";
import {
  applyAvailableChromeDevtoolsTools,
  availableChromeDevtoolsTools,
  CHROME_DEVTOOLS_LOAD_TOOL_NAME,
  chromeDevtoolsToolExposureMode,
  chromeDevtoolsToolMode,
  configuredChromeDevtoolsTools,
} from "./lazy-tools.js";
import { invalidateWebMcpOperations, state, webMcpEnabled } from "./runtime.js";
import {
  loadSettings,
  type SettingsLoadResult,
  saveSettings,
  settingsFilePath,
  ToolCatalogApplicationError,
} from "./settings.js";
import {
  CHROME_DEVTOOLS_TOOL_NAMES,
  type ChromeDevToolsToolName,
  CORE_CHROME_DEVTOOLS_TOOL_NAMES,
  isWebMcpToolName,
} from "./tool-names.js";

export { sanitizeChromeDevtoolsDisplay };

type CommandContext = ExtensionCommandContext;

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

interface ToolStatusSummary {
  availabilityStatus: "enabled" | "disabled" | "partial";
  availableChromeToolCount: number;
  loadedChromeToolCount: number;
  activeNonChromeToolCount: number;
  capabilityCount: number;
}

type ToolSelectionSaveResult = "saved" | "active-tools-changed" | "failed";

export async function updateChromeDevtoolsTools(
  pi: ExtensionAPI,
  ctx: CommandContext,
  selectedTools: readonly ChromeDevToolsToolName[],
  action: string,
) {
  const generation = state.sessionGeneration;
  const result = await transactSelectedTools(pi, ctx, selectedTools, generation);
  if (result !== "saved" || generation !== state.sessionGeneration) return;
  const status = await buildToolStatusMessage(pi, ctx.sessionManager);
  if (generation !== state.sessionGeneration) return;
  ctx.ui.notify(`Chrome DevTools tool catalog ${action}.\n\n${status}`, "info");
}

export async function setSelectedChromeDevtoolsTools(
  pi: ExtensionAPI,
  ctx: CommandContext,
  selectedTools: readonly ChromeDevToolsToolName[],
  expectedActiveTools: readonly ChromeDevToolsToolName[],
): Promise<ToolSelectionSaveResult> {
  return transactSelectedTools(pi, ctx, selectedTools, state.sessionGeneration, expectedActiveTools);
}

let toolTransactionQueue = Promise.resolve();

export async function waitForChromeDevtoolsSettings(): Promise<void> {
  await toolTransactionQueue;
}

function transactSelectedTools(
  pi: ExtensionAPI,
  ctx: CommandContext,
  selectedTools: readonly ChromeDevToolsToolName[],
  expectedGeneration: number,
  expectedActiveTools?: readonly ChromeDevToolsToolName[],
): Promise<ToolSelectionSaveResult> {
  const acceptedTools = [...selectedTools];
  const expectedTools = expectedActiveTools ? [...expectedActiveTools] : undefined;
  const operation = toolTransactionQueue.then(() =>
    transactSelectedToolsNow(pi, ctx, acceptedTools, expectedGeneration, expectedTools),
  );
  toolTransactionQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function transactSelectedToolsNow(
  pi: ExtensionAPI,
  ctx: CommandContext,
  selectedTools: readonly ChromeDevToolsToolName[],
  expectedGeneration: number,
  expectedActiveTools?: readonly ChromeDevToolsToolName[],
): Promise<ToolSelectionSaveResult> {
  if (expectedGeneration !== state.sessionGeneration) {
    // Accepted durable intents outlive their UI/session; never apply to a replacement runtime.
    try {
      if (expectedActiveTools) {
        // Earlier accepted intents can be durable without publishing to this
        // retired API. Compare the policy the replacement will actually load.
        const settings = await loadSettings();
        if (settings.userFile.kind !== "invalid") {
          const catalog = new Set(
            settings.kind === "loaded" && settings.settings.tools
              ? settings.settings.tools
              : CHROME_DEVTOOLS_TOOL_NAMES,
          );
          const current = CHROME_DEVTOOLS_TOOL_NAMES.filter(
            (name) => catalog.has(name) && (settings.effectiveWebMcpEnabled || !isWebMcpToolName(name)),
          );
          if (!arraysEqual(current, expectedActiveTools)) return "active-tools-changed";
        }
      }
      await persistSettings(selectedTools);
    } catch {
      // No live owner remains to notify; storage stays unchanged on failure.
    }
    return "failed";
  }
  if (expectedActiveTools && !arraysEqual(availableChromeDevtoolsTools(pi), expectedActiveTools)) {
    ctx.ui.notify(
      "Browser tool selection changed while review was open. Review the current state, then apply again.",
      "warning",
    );
    return "active-tools-changed";
  }
  try {
    await persistSettings(selectedTools, () => {
      if (expectedGeneration !== state.sessionGeneration) return;
      // Capture at publication, not before I/O: host edits during the save are
      // current intent. A persistence failure never touches runtime policy.
      const previousActiveTools = pi.getActiveTools();
      const previousAvailableTools = availableChromeDevtoolsTools(pi);
      const previousConfiguredTools = configuredChromeDevtoolsTools(pi);
      try {
        const previousWebMcpTools = previousAvailableTools.filter(isWebMcpToolName);
        applyChromeDevtoolsTools(pi, selectedTools);
        const publishedWebMcpTools = availableChromeDevtoolsTools(pi).filter(isWebMcpToolName);
        // Abort is irreversible: rejected publication must leave current work
        // alive, and gated configured names are not an effective policy change.
        if (!arraysEqual(previousWebMcpTools, publishedWebMcpTools)) {
          invalidateWebMcpOperations(ctx.sessionManager, "Chrome DevTools WebMCP gateway availability changed");
        }
      } catch (error) {
        if (expectedGeneration === state.sessionGeneration) {
          try {
            applyAvailableChromeDevtoolsTools(pi, previousConfiguredTools, previousActiveTools);
          } catch (rollbackError) {
            throw new Error(`${formatError(error)}; active-tool rollback failed: ${formatError(rollbackError)}`, {
              cause: error,
            });
          }
        }
        // The storage queue restores only the tool-owned durable fields before
        // it releases dependent settings reads or replacement session starts.
        throw error;
      }
    });
    return expectedGeneration === state.sessionGeneration ? "saved" : "failed";
  } catch (error) {
    if (expectedGeneration !== state.sessionGeneration) return "failed";
    ctx.ui.notify(
      sanitizeChromeDevtoolsDisplay(
        error instanceof ToolCatalogApplicationError
          ? `Chrome DevTools tool application failed: ${formatError(error)}`
          : `Chrome DevTools settings save failed; active tools unchanged: ${formatError(error)}`,
      ),
      "warning",
    );
    return "failed";
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function applyChromeDevtoolsTools(pi: ExtensionAPI, selectedTools: readonly ChromeDevToolsToolName[]) {
  applyAvailableChromeDevtoolsTools(pi, selectedTools);
}

function getToolStatusSummary(pi: ExtensionAPI, owner: object): ToolStatusSummary {
  const chromeToolNames = new Set<string>(CHROME_DEVTOOLS_TOOL_NAMES);
  const activeToolNames = new Set(pi.getActiveTools());
  const loadedChromeToolCount = CHROME_DEVTOOLS_TOOL_NAMES.filter((name) => activeToolNames.has(name)).length;
  const availableChromeToolCount = availableChromeDevtoolsTools(pi).length;
  const activeNonChromeToolCount = Array.from(activeToolNames).filter(
    (name) => !chromeToolNames.has(name) && name !== CHROME_DEVTOOLS_LOAD_TOOL_NAME,
  ).length;
  const capabilityCount = effectiveCatalog(owner).length;
  const availabilityStatus =
    availableChromeToolCount === capabilityCount ? "enabled" : availableChromeToolCount === 0 ? "disabled" : "partial";

  return {
    availabilityStatus,
    availableChromeToolCount,
    loadedChromeToolCount,
    activeNonChromeToolCount,
    capabilityCount,
  };
}

export async function buildToolStatusMessage(pi: ExtensionAPI, owner: object) {
  const generation = state.sessionGeneration;
  await waitForChromeDevtoolsSettings();
  if (generation !== state.sessionGeneration) return "";
  const settings = await loadSettings();
  // Command callers discard replaced-session output; avoid retired API reads.
  if (generation !== state.sessionGeneration) return "";
  // Do not combine a pre-save runtime summary with a post-save document.
  // All saved labels use this one snapshot; no I/O follows the runtime read.
  const summary = getToolStatusSummary(pi, owner);
  const persistedSetting = persistedSettingLabel(settings);
  const savedMode =
    settings.userFile.kind === "invalid"
      ? undefined
      : settings.kind === "loaded"
        ? settings.settings.toolMode
        : "codemode";
  return sanitizeChromeDevtoolsDisplay(
    [
      `Chrome DevTools tools available: ${formatRuntimeStatus(summary)}`,
      `Running tool mode: ${chromeDevtoolsToolMode(pi)}`,
      `Tool exposure: ${chromeDevtoolsToolExposureMode(pi)}`,
      `Saved tool mode: ${savedMode ?? "unavailable (invalid user settings)"}`,
      ...(savedMode !== undefined && savedMode !== chromeDevtoolsToolMode(pi)
        ? ["Tool mode change pending; /reload or session replacement required."]
        : []),
      `Loaded capability tools this session: ${summary.loadedChromeToolCount}/${summary.capabilityCount}`,
      `WebMCP: ${webMcpEnabled(owner) ? "enabled · experimental · confirmation required for every call" : "disabled · experimental"}`,
      `Loader: ${pi.getActiveTools().includes(CHROME_DEVTOOLS_LOAD_TOOL_NAME) ? "active" : "inactive"}`,
      `Persisted tool catalog: ${persistedSetting}`,
      ...browserSettingsStatusLines(owner),
      ...(state.settingsNotice ? [`Settings note: ${state.settingsNotice}`] : []),
      `Other active tools preserved: ${summary.activeNonChromeToolCount}`,
      `Endpoint: ${devToolsEndpoint(owner)}`,
      `Endpoint source: ${endpointSourceLabel(owner)}`,
      `Launch mode: ${launchModeLabel(owner)}`,
      ...launchAttemptLines(owner),
    ].join("\n"),
  );
}

export function buildQuickstartMessage(owner: object) {
  return buildSettingsSetupMessage(owner);
}

export function buildBrowserStatusMessage(owner?: object) {
  const browser = browserSettingsForOwner(owner);
  const lifecycle = browserLifecycleState(owner);
  const webMcpIsEnabled = owner ? webMcpEnabled(owner) : false;
  const browserState =
    lifecycle === "starting"
      ? "starting managed browser"
      : lifecycle === "running"
        ? "managed browser running"
        : lifecycle === "exited"
          ? "managed browser exited"
          : lifecycle === "failed"
            ? "last launch failed"
            : "not started; connection has not been checked";
  const needsRecovery = lifecycle === "exited" || lifecycle === "failed";
  return sanitizeChromeDevtoolsDisplay(
    [
      `Browser: ${browserState}`,
      "Viewing this status does not probe the endpoint or launch Chrome.",
      `Endpoint: ${devToolsEndpoint(owner)}`,
      `Endpoint source: ${endpointSourceLabel(owner)}`,
      `Launch mode: ${launchModeLabel(owner)}`,
      `Unpacked extensions: ${browser.extensionPaths.length} (${browser.extensionPathsSource})`,
      `WebMCP: ${webMcpIsEnabled ? "enabled · experimental" : "disabled · experimental"}`,
      ...(webMcpIsEnabled && !managedBrowserForOwner(owner)?.ready
        ? ["WebMCP warning: attached browser profiles may contain everyday authenticated sessions and sensitive state."]
        : []),
      ...(browser.extensionPaths.length > 0
        ? ["Unpacked extensions execute trusted browser code in an isolated managed browser."]
        : []),
      ...launchAttemptLines(owner),
      ...(needsRecovery ? [launchHint(owner), endpointConfigHint()] : []),
    ].join("\n"),
  );
}

export function buildSettingsSetupMessage(owner: object) {
  return sanitizeChromeDevtoolsDisplay(
    [
      `Chrome DevTools endpoint: ${devToolsEndpoint(owner)}`,
      `Endpoint source: ${endpointSourceLabel(owner)}`,
      `Launch mode: ${launchModeLabel(owner)}`,
      ...browserSettingsStatusLines(owner),
      launchHint(owner),
      browserCandidateHint(owner),
      ...launchAttemptLines(owner),
      endpointConfigHint(),
    ].join("\n"),
  );
}

function browserSettingsStatusLines(owner: object) {
  const browser = browserSettingsForOwner(owner);
  const extensionPaths = browser.extensionPaths;
  const extensionLines =
    extensionPaths.length > 0 ? extensionPaths.map((extensionPath) => `  - ${extensionPath}`) : ["  - none"];
  return [
    `Settings file: ${state.settingsFilePath ?? settingsFilePath()} (user)`,
    ...(state.projectSettingsFilePath
      ? [
          `Project settings: ${state.projectSettingsFilePath} (${state.projectSettingsTrusted ? "trusted" : "untrusted; ignored"})`,
        ]
      : []),
    `Auto-launch: ${browser.autoLaunchEnabled ? "on" : "off"} (${browser.autoLaunchSource})`,
    `Browser executable: ${browser.executablePath ?? "automatic discovery"} (${browser.executablePathSource})`,
    `Unpacked extensions (${browser.extensionPathsSource}):`,
    ...extensionLines,
    `WebMCP: ${webMcpEnabled(owner) ? "enabled · experimental · every call requires confirmation" : "disabled · experimental"}`,
    "Confirmed menu settings apply before the next browser connection; manual JSON edits require /reload or session replacement.",
    ...(extensionPaths.length > 0
      ? ["Unpacked extensions require Chrome for Testing or Chromium and execute trusted browser code."]
      : []),
  ];
}

export function buildCommandGuide(owner: object) {
  return [
    "Chrome DevTools commands:",
    `WebMCP: ${webMcpEnabled(owner) ? "enabled" : "disabled"} · experimental · every page-provided call requires confirmation`,
    "/chrome-devtools — open this menu",
    "/chrome-devtools help — show command usage",
    "/chrome-devtools quickstart — show endpoint and launch help",
    "/chrome-devtools status — show tool and settings status",
    "/chrome-devtools settings — edit browser connection settings",
    "/chrome-devtools tools — choose available Chrome DevTools tools",
    "/chrome-devtools toggle|select — compatibility aliases for tools",
    "/chrome-devtools enable|on — make all Chrome DevTools tools available",
    "/chrome-devtools disable|off — make all Chrome DevTools capability tools unavailable",
  ].join("\n");
}

export function allChromeDevtoolsTools(owner: object) {
  return effectiveCatalog(owner);
}

export function orderedChromeDevtoolsTools(selectedTools: ReadonlySet<ChromeDevToolsToolName>) {
  return CHROME_DEVTOOLS_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

function formatRuntimeStatus(summary: ToolStatusSummary) {
  return `${summary.availabilityStatus} (${summary.availableChromeToolCount}/${summary.capabilityCount} available)`;
}

function persistedSettingLabel(settings: SettingsLoadResult) {
  if (settings.kind === "loaded" && settings.settings.tools) {
    return formatPersistedSelection(settings.settings.tools);
  }
  if (settings.kind === "invalid") {
    return `none; current active-tool policy preserved (invalid settings ignored: ${settings.reason})`;
  }
  return "none; default catalog restored on /reload or session replacement";
}

function formatPersistedSelection(tools: readonly ChromeDevToolsToolName[]) {
  if (tools.length === CHROME_DEVTOOLS_TOOL_NAMES.length) {
    return `all available (${tools.length}/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected)`;
  }
  if (tools.length === 0) return `all unavailable (0/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected)`;
  return `${tools.length}/${CHROME_DEVTOOLS_TOOL_NAMES.length} selected: ${tools.join(", ")}`;
}

function effectiveCatalog(owner: object): ChromeDevToolsToolName[] {
  return webMcpEnabled(owner) ? [...CHROME_DEVTOOLS_TOOL_NAMES] : [...CORE_CHROME_DEVTOOLS_TOOL_NAMES];
}

async function persistSettings(selectedTools: readonly ChromeDevToolsToolName[], applyAfterSave?: () => void) {
  await saveSettings({ tools: [...selectedTools], updatedAt: Date.now() }, {}, applyAfterSave);
}
