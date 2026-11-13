import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configuredApiUrl, hasApiKey } from "./client.js";
import {
  applyAvailableFirecrawlTools,
  availableFirecrawlTools,
  FIRECRAWL_LOAD_TOOL_NAME,
  firecrawlToolExposureMode,
  firecrawlToolMode,
  restoreAvailableFirecrawlPolicy,
} from "./lazy-tools.js";
import {
  DEFAULT_TOOL_MODE,
  type FirecrawlToolMode,
  loadSettings,
  type SettingsLoadResult,
  saveSettings,
  saveToolMode,
  settingsFilePath,
} from "./settings.js";
import { FIRECRAWL_TOOL_NAMES, type FirecrawlToolName } from "./tool-names.js";

type CommandContext = ExtensionCommandContext;
type ToolAvailabilityStatus = "enabled" | "disabled" | "partial";
type ToolSelectorScreen = "tools";
type ToolSelectorAction = "toggle" | "enableAll" | "disableAll";
interface ToolStatusSummary {
  availabilityStatus: ToolAvailabilityStatus;
  availableFirecrawlToolCount: number;
  callableFirecrawlToolCount: number;
  loadedFirecrawlToolCount: number;
  activeNonFirecrawlToolCount: number;
}

type ToolSelectionSaveResult = "saved" | "available-tools-changed" | "failed";

interface FirecrawlSessionState {
  generation: number;
  controller: AbortController;
  notice?: string;
}
const sessionStates = new WeakMap<ExtensionAPI, FirecrawlSessionState>();

function sessionState(pi: ExtensionAPI): FirecrawlSessionState {
  let state = sessionStates.get(pi);
  if (!state) {
    state = { generation: 0, controller: new AbortController() };
    sessionStates.set(pi, state);
  }
  return state;
}

export function advanceFirecrawlSessionGeneration(pi: ExtensionAPI): number {
  const state = sessionState(pi);
  state.controller.abort(new DOMException("Firecrawl session replaced", "AbortError"));
  state.controller = new AbortController();
  return ++state.generation;
}

export function currentFirecrawlSessionGeneration(pi: ExtensionAPI): number {
  return sessionState(pi).generation;
}

export function isCurrentFirecrawlSession(pi: ExtensionAPI, generation: number): boolean {
  return generation === sessionState(pi).generation;
}

export function currentFirecrawlSessionSignal(pi: ExtensionAPI): AbortSignal {
  return sessionState(pi).controller.signal;
}

export function clearSettingsNotice(pi: ExtensionAPI) {
  sessionState(pi).notice = undefined;
}

export function recordSettingsNotice(pi: ExtensionAPI, settings: SettingsLoadResult) {
  sessionState(pi).notice = settings.notice;
}

export async function showToolSelector(pi: ExtensionAPI, ctx: CommandContext) {
  const generation = currentFirecrawlSessionGeneration(pi);
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    throw new Error("/firecrawl tools requires TUI or RPC mode");
  }
  const menuSignal = currentFirecrawlSessionSignal(pi);
  const isCurrent = () => isCurrentFirecrawlSession(pi, generation) && !menuSignal.aborted;
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (!isCurrent()) return;
  const menu = defineMenu<undefined, ToolSelectorScreen, ToolSelectorAction>({
    start: "tools",
    screens: {
      tools: () => {
        const selectedTools = new Set(availableFirecrawlTools(pi));
        return {
          kind: "multiSelect",
          title: toolSelectorTitle(selectedTools),
          items: FIRECRAWL_TOOL_NAMES.map((toolName) => ({
            id: toolName,
            label: toolName,
            selected: selectedTools.has(toolName),
          })),
          action: "toggle",
          actions: [
            {
              id: "enable-all",
              label: "Make all Firecrawl tools available",
              action: "enableAll",
            },
            {
              id: "disable-all",
              label: "Make all Firecrawl tools unavailable",
              action: "disableAll",
            },
            { id: "done", label: "Done", close: true },
          ],
          hint: "close",
          doneLabel: "Done",
        };
      },
    },
    actions: {
      toggle: async ({ itemId, selected }) => {
        if (!isFirecrawlToolName(itemId)) return { kind: "rejected" };
        const acceptedTools = availableFirecrawlTools(pi);
        const selectedTools = new Set(acceptedTools);
        if (selected) selectedTools.add(itemId);
        else selectedTools.delete(itemId);
        const result = await transactSelectedTools(
          pi,
          ctx,
          orderedFirecrawlTools(selectedTools),
          generation,
          acceptedTools,
        );
        return result === "saved" ? { kind: "stay" } : { kind: "rejected" };
      },
      enableAll: async () => {
        const acceptedTools = availableFirecrawlTools(pi);
        const result = await transactSelectedTools(pi, ctx, allFirecrawlTools(), generation, acceptedTools);
        return result === "saved" ? { kind: "stay" } : { kind: "rejected" };
      },
      disableAll: async () => {
        const acceptedTools = availableFirecrawlTools(pi);
        const result = await transactSelectedTools(pi, ctx, [], generation, acceptedTools);
        return result === "saved" ? { kind: "stay" } : { kind: "rejected" };
      },
    },
  });
  const result = await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: menuSignal,
    isCurrent,
  });
  if (result.kind !== "closed" || !isCurrentFirecrawlSession(pi, generation)) return;
  const status = await buildStatusMessage(pi);
  if (!isCurrentFirecrawlSession(pi, generation)) return;
  ctx.ui.notify(status, hasApiKey() ? "info" : "warning");
}

export async function updateFirecrawlTools(
  pi: ExtensionAPI,
  ctx: CommandContext,
  selectedTools: readonly FirecrawlToolName[],
  action: string,
) {
  const generation = currentFirecrawlSessionGeneration(pi);
  const result = await transactSelectedTools(pi, ctx, selectedTools, generation);
  if (result !== "saved" || !isCurrentFirecrawlSession(pi, generation)) return;
  const status = await buildStatusMessage(pi);
  if (!isCurrentFirecrawlSession(pi, generation)) return;
  ctx.ui.notify(
    sanitizeFirecrawlDisplay(`Firecrawl tool catalog ${action}.\n\n${status}`),
    hasApiKey() ? "info" : "warning",
  );
}

export async function setSelectedFirecrawlTools(
  pi: ExtensionAPI,
  ctx: CommandContext,
  selectedTools: readonly FirecrawlToolName[],
  notificationSignal?: AbortSignal,
): Promise<boolean> {
  return (
    (await transactSelectedTools(
      pi,
      ctx,
      selectedTools,
      currentFirecrawlSessionGeneration(pi),
      undefined,
      notificationSignal,
    )) === "saved"
  );
}

export function setFirecrawlCapabilityEnabled(
  pi: ExtensionAPI,
  ctx: CommandContext,
  name: FirecrawlToolName,
  enabled: boolean,
  notificationSignal?: AbortSignal,
): Promise<boolean> {
  const generation = currentFirecrawlSessionGeneration(pi);
  const fallbackTools = availableFirecrawlTools(pi);
  const operation = toolTransactionQueue.then(async () => {
    const current = isCurrentFirecrawlSession(pi, generation);
    // A stale owner may read persisted state, but must not read or mutate runtime state.
    const settings = current ? undefined : await loadSettings();
    const base = current
      ? availableFirecrawlTools(pi)
      : settings?.kind === "loaded"
        ? settings.settings.tools
        : fallbackTools;
    const selected = new Set(base);
    if (enabled) selected.add(name);
    else selected.delete(name);
    return (
      (await transactSelectedToolsNow(
        pi,
        ctx,
        orderedFirecrawlTools(selected),
        generation,
        undefined,
        notificationSignal,
      )) === "saved"
    );
  });
  toolTransactionQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

let toolTransactionQueue = Promise.resolve();

export async function waitForFirecrawlSettings(): Promise<void> {
  await toolTransactionQueue;
}

function transactSelectedTools(
  pi: ExtensionAPI,
  ctx: CommandContext,
  selectedTools: readonly FirecrawlToolName[],
  expectedGeneration: number,
  expectedAvailableTools?: readonly FirecrawlToolName[],
  notificationSignal?: AbortSignal,
): Promise<ToolSelectionSaveResult> {
  const acceptedTools = [...selectedTools];
  const operation = toolTransactionQueue.then(() =>
    transactSelectedToolsNow(pi, ctx, acceptedTools, expectedGeneration, expectedAvailableTools, notificationSignal),
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
  selectedTools: readonly FirecrawlToolName[],
  expectedGeneration: number,
  expectedAvailableTools?: readonly FirecrawlToolName[],
  notificationSignal?: AbortSignal,
): Promise<ToolSelectionSaveResult> {
  if (!isCurrentFirecrawlSession(pi, expectedGeneration)) {
    // Lifecycle waits include accepted writes even when their runtime owner has gone away.
    try {
      await persistSettings(selectedTools);
      return "saved";
    } catch {
      return "failed";
    }
  }
  if (expectedAvailableTools && !arraysEqual(availableFirecrawlTools(pi), expectedAvailableTools)) {
    ctx.ui.notify(
      "Firecrawl tool availability changed while the selector was open. Review the current state and try again.",
      "warning",
    );
    return "available-tools-changed";
  }
  const previousActiveTools = pi.getActiveTools();
  const previousAvailableTools = availableFirecrawlTools(pi);
  const sessionOwner = ctx.sessionManager;
  try {
    applyFirecrawlTools(pi, selectedTools, sessionOwner);
    await persistSettings(selectedTools);
    return isCurrentFirecrawlSession(pi, expectedGeneration) ? "saved" : "failed";
  } catch (error) {
    // Restore only the uncommitted policy. Replacement startup waits for this queue;
    // old work must never re-register tools, change its active set, or publish old UI.
    if (!isCurrentFirecrawlSession(pi, expectedGeneration)) {
      restoreAvailableFirecrawlPolicy(pi, previousAvailableTools, sessionOwner);
      return "failed";
    }
    let rollbackError: unknown;
    try {
      applyAvailableFirecrawlTools(pi, previousAvailableTools, sessionOwner);
      const currentOtherTools = pi
        .getActiveTools()
        .filter(
          (name) => name !== FIRECRAWL_LOAD_TOOL_NAME && !FIRECRAWL_TOOL_NAMES.includes(name as FirecrawlToolName),
        );
      const previousLoadedTools = previousActiveTools.filter((name) =>
        FIRECRAWL_TOOL_NAMES.includes(name as FirecrawlToolName),
      );
      const restoredFirecrawlTools =
        firecrawlToolMode(pi) === "codemode"
          ? previousLoadedTools
          : firecrawlToolExposureMode(pi) === "eager"
            ? previousAvailableTools
            : previousLoadedTools;
      const desired = new Set([
        ...(firecrawlToolMode(pi) === "lazy" ? [FIRECRAWL_LOAD_TOOL_NAME] : []),
        ...restoredFirecrawlTools,
      ]);
      const restoredOrder = [...currentOtherTools];
      // Keep current unrelated order and restore owned tools at their previous anchors.
      for (const [index, name] of previousActiveTools.entries()) {
        if (!desired.has(name)) continue;
        const nextOther = previousActiveTools
          .slice(index + 1)
          .find((candidate) => currentOtherTools.includes(candidate));
        if (nextOther) restoredOrder.splice(restoredOrder.indexOf(nextOther), 0, name);
        else restoredOrder.push(name);
      }
      pi.setActiveTools(unique([...restoredOrder, ...desired]));
    } catch (caught) {
      rollbackError = caught;
    }
    if (!isCurrentFirecrawlSession(pi, expectedGeneration)) return "failed";
    if (notificationSignal?.aborted) return "failed";
    ctx.ui.notify(
      sanitizeFirecrawlDisplay(
        rollbackError
          ? `Firecrawl settings save failed: ${formatError(error)}; active-tool rollback failed: ${formatError(rollbackError)}`
          : `Firecrawl settings save failed; active tools restored: ${formatError(error)}`,
      ),
      "warning",
    );
    return "failed";
  }
}

export function setFirecrawlToolMode(
  pi: ExtensionAPI,
  ctx: CommandContext,
  mode: FirecrawlToolMode,
  notificationSignal?: AbortSignal,
): Promise<boolean> {
  const generation = currentFirecrawlSessionGeneration(pi);
  const fallbackTools = availableFirecrawlTools(pi);
  const operation = toolTransactionQueue.then(async () => {
    // Accepted mode writes are global persistence, not work owned by the old session.
    try {
      await saveToolMode(mode, fallbackTools);
      return true;
    } catch (error) {
      if (!notificationSignal?.aborted && isCurrentFirecrawlSession(pi, generation)) {
        ctx.ui.notify(sanitizeFirecrawlDisplay(`Firecrawl settings save failed: ${formatError(error)}`), "warning");
      }
      return false;
    }
  });
  toolTransactionQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function applyFirecrawlTools(
  pi: ExtensionAPI,
  selectedTools: readonly FirecrawlToolName[],
  sessionOwner?: object,
) {
  applyAvailableFirecrawlTools(pi, selectedTools, sessionOwner);
}

function getToolStatusSummary(pi: ExtensionAPI): ToolStatusSummary {
  const firecrawlToolNames = new Set<string>(FIRECRAWL_TOOL_NAMES);
  const activeToolNames = new Set(pi.getActiveTools());
  const loadedFirecrawlToolCount = FIRECRAWL_TOOL_NAMES.filter((name) => activeToolNames.has(name)).length;
  const availableFirecrawlToolCount = availableFirecrawlTools(pi).length;
  // getAllTools reflects host allowlists/exclusions; callability is distinct from declaration.
  const callableFirecrawlToolCount = new Set(
    pi
      .getAllTools()
      .filter(
        (tool) =>
          firecrawlToolNames.has(tool.name) &&
          (tool.exposure === "codemode" ||
            tool.exposure === "deferred" ||
            ((tool.exposure ?? "direct") === "direct" && activeToolNames.has(tool.name))),
      )
      .map((tool) => tool.name),
  ).size;
  const activeNonFirecrawlToolCount = Array.from(activeToolNames).filter(
    (name) => !firecrawlToolNames.has(name) && name !== FIRECRAWL_LOAD_TOOL_NAME,
  ).length;
  const availabilityStatus =
    availableFirecrawlToolCount === FIRECRAWL_TOOL_NAMES.length
      ? "enabled"
      : availableFirecrawlToolCount === 0
        ? "disabled"
        : "partial";

  return {
    availabilityStatus,
    availableFirecrawlToolCount,
    callableFirecrawlToolCount,
    loadedFirecrawlToolCount,
    activeNonFirecrawlToolCount,
  };
}

export async function buildStatusMessage(pi: ExtensionAPI) {
  const generation = currentFirecrawlSessionGeneration(pi);
  const settings = await loadSettings();
  if (!isCurrentFirecrawlSession(pi, generation)) return "";
  recordSettingsNotice(pi, settings);
  const summary = getToolStatusSummary(pi);
  const persistedSetting = persistedSettingLabel(settings);
  const savedMode = settings.kind === "loaded" ? (settings.settings.toolMode ?? DEFAULT_TOOL_MODE) : DEFAULT_TOOL_MODE;
  return sanitizeFirecrawlDisplay(
    [
      `Firecrawl tools available: ${formatRuntimeStatus(summary)}`,
      `Running tool mode: ${firecrawlToolMode(pi)}`,
      `Saved tool mode: ${savedMode}${settings.kind === "loaded" ? "" : " (default; no valid override)"}`,
      ...(savedMode !== firecrawlToolMode(pi) ? ["Tool mode change pending: /reload required"] : []),
      `Tool exposure: ${firecrawlToolExposureMode(pi)}`,
      `Callable capability tools: ${summary.callableFirecrawlToolCount}/${FIRECRAWL_TOOL_NAMES.length}`,
      `Loaded capability tools this session: ${summary.loadedFirecrawlToolCount}/${FIRECRAWL_TOOL_NAMES.length}`,
      `Loader: ${pi.getActiveTools().includes(FIRECRAWL_LOAD_TOOL_NAME) ? "active" : "inactive"}`,
      `Persisted tool catalog: ${persistedSetting}`,
      `Settings file: ${settingsFilePath()}`,
      ...(sessionState(pi).notice ? [`Settings note: ${sessionState(pi).notice}`] : []),
      `Other active tools preserved: ${summary.activeNonFirecrawlToolCount}`,
      `API key: ${hasApiKey() ? "present" : "missing"} (FIRECRAWL_API_KEY)`,
      `API URL: ${configuredApiUrl()}`,
    ].join("\n"),
  );
}

export function buildConfigMessage() {
  return sanitizeFirecrawlDisplay(
    [
      "Firecrawl configuration:",
      `API key: ${hasApiKey() ? "present" : "missing"} (FIRECRAWL_API_KEY)`,
      `API URL: ${configuredApiUrl()}`,
      "Override API URL with FIRECRAWL_API_URL or FIRECRAWL_BASE_URL.",
      "This extension never logs, displays, or stores your Firecrawl API key.",
    ].join("\n"),
  );
}

export function buildCommandGuide() {
  return [
    "Firecrawl commands:",
    "/firecrawl — open this menu",
    "/firecrawl help — show command usage",
    "/firecrawl config — show API key presence and API URL",
    "/firecrawl quickstart — alias for /firecrawl config",
    "/firecrawl status — show tool and settings status",
    "/firecrawl settings — choose tool mode (applies after /reload) and available tools",
    "/firecrawl tools — choose available Firecrawl tools",
    "/firecrawl toggle — alias for /firecrawl tools",
    "/firecrawl enable — make all Firecrawl tools available",
    "/firecrawl disable — make all Firecrawl capability tools unavailable",
  ].join("\n");
}

function toolSelectorTitle(selectedTools: ReadonlySet<FirecrawlToolName>) {
  return `Available Firecrawl tools (${selectedTools.size}/${FIRECRAWL_TOOL_NAMES.length}). Non-built-in tools run at user risk.`;
}

function isFirecrawlToolName(value: string): value is FirecrawlToolName {
  return FIRECRAWL_TOOL_NAMES.includes(value as FirecrawlToolName);
}

export function allFirecrawlTools() {
  return [...FIRECRAWL_TOOL_NAMES];
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

export function orderedFirecrawlTools(selectedTools: ReadonlySet<FirecrawlToolName>) {
  return FIRECRAWL_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

function formatRuntimeStatus(summary: ToolStatusSummary) {
  return `${summary.availabilityStatus} (${summary.availableFirecrawlToolCount}/${FIRECRAWL_TOOL_NAMES.length} available)`;
}

function persistedSettingLabel(settings: SettingsLoadResult) {
  if (settings.kind === "loaded") return formatPersistedSelection(settings.settings.tools);
  if (settings.kind === "invalid") {
    return `none; current availability policy preserved (invalid settings ignored: ${settings.reason})`;
  }
  return "none; current availability policy preserved";
}

export function formatPersistedSelection(tools: readonly FirecrawlToolName[]) {
  if (tools.length === FIRECRAWL_TOOL_NAMES.length) {
    return `all available (${tools.length}/${FIRECRAWL_TOOL_NAMES.length} selected)`;
  }
  if (tools.length === 0) return `all unavailable (0/${FIRECRAWL_TOOL_NAMES.length} selected)`;
  return `${tools.length}/${FIRECRAWL_TOOL_NAMES.length} selected: ${tools.join(", ")}`;
}

export function sanitizeFirecrawlDisplay(value: string, maxCharacters = 50_000) {
  const characters = Array.from(stripVTControlCharacters(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafeControl =
      (codePoint >= 0 && codePoint <= 8) ||
      (codePoint >= 11 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159);
    return unsafeControl ? "�" : character;
  });
  const limit = Number.isFinite(maxCharacters) ? Math.max(0, Math.floor(maxCharacters)) : 0;
  if (characters.length <= limit) return characters.join("");
  if (limit === 0) return "";
  return `${characters.slice(0, limit - 1).join("")}…`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function persistSettings(selectedTools: readonly FirecrawlToolName[]) {
  await saveSettings({ tools: [...selectedTools], updatedAt: Date.now() });
}
