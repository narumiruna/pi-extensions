import { homedir } from "node:os";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { completeStatuslineArguments } from "./command-contract.js";
import type { StatuslineCommandOptions } from "./commands.js";
import {
  buildExtensionStatusIconAliases,
  type ExtensionStatusIconAliasMap,
  findDuplicateExtensions,
  readInstalledExtensionPackages,
} from "./extension-status.js";
import { type GitStatusSummary, gitStatusSummaryEqual, readGitStatus } from "./git-status.js";
import { type RuntimeState, renderExtensionStatusline, renderStatusline } from "./render.js";
import {
  consumeStatuslineSettingsNotice,
  type LoadedStatuslineSettings,
  loadStatuslineSettings,
  loadStatuslineSettingsForAgent,
  settingsFilePath,
} from "./settings.js";
import type { PalettePreset } from "./types.js";

const STATUSLINE_KEY = "statusline";
const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const GIT_STATUS_EVENT_DEBOUNCE_MS = 250;
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();

type StatuslineCommands = typeof import("./commands.js");
let statuslineCommandsPromise: Promise<StatuslineCommands> | undefined;

function loadStatuslineCommands(): Promise<StatuslineCommands> {
  if (!statuslineCommandsPromise) {
    statuslineCommandsPromise = import("./commands.js").catch((error) => {
      statuslineCommandsPromise = undefined;
      throw error;
    });
  }
  return statuslineCommandsPromise;
}

export default function statusline(pi: ExtensionAPI) {
  let loaded: LoadedStatuslineSettings | undefined;
  let previewPalettePreset: PalettePreset | undefined;
  let activeSessionManager: ExtensionContext["sessionManager"] | undefined;
  const runtime: RuntimeState = {
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    thinkingLevel: "off",
    duplicateExtensions: [],
    extensionStatusIconAliases: EMPTY_EXTENSION_STATUS_ICON_ALIASES,
  };

  let sessionGeneration = 0;
  let menuController = new AbortController();
  let gitStatusRequestId = 0;
  let activeGitStatusTarget: { cwd: string; generation: number } | undefined;
  let gitStatusRefreshInFlight = false;
  let gitStatusAbortController: AbortController | undefined;
  let gitStatusDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingGitStatusRefresh: { cwd: string; generation: number; requestId: number } | undefined;

  const refresh = () => runtime.requestRender?.();
  const ownsRuntime = (ctx: ExtensionContext) => ctx.sessionManager === activeSessionManager;

  const setGitStatus = (summary: GitStatusSummary | undefined) => {
    if (gitStatusSummaryEqual(runtime.gitStatus, summary)) return;
    runtime.gitStatus = summary;
    refresh();
  };

  const clearGitStatusDebounce = () => {
    if (!gitStatusDebounceTimer) return;
    clearTimeout(gitStatusDebounceTimer);
    gitStatusDebounceTimer = undefined;
  };

  const abortGitStatusRefresh = (reason: string) => {
    gitStatusAbortController?.abort(new DOMException(reason, "AbortError"));
  };

  const isActiveGitStatusTarget = (cwd: string, generation: number) =>
    activeGitStatusTarget?.cwd === cwd &&
    activeGitStatusTarget.generation === generation &&
    generation === sessionGeneration;

  const isCurrentGitStatusRequest = (cwd: string, generation: number, requestId: number) =>
    isActiveGitStatusTarget(cwd, generation) && requestId === gitStatusRequestId;

  const runGitStatusRefresh = (cwd: string, generation: number, requestId: number) => {
    if (!isCurrentGitStatusRequest(cwd, generation, requestId)) return;
    if (gitStatusRefreshInFlight) {
      pendingGitStatusRefresh = { cwd, generation, requestId };
      return;
    }

    gitStatusRefreshInFlight = true;
    const abortController = new AbortController();
    gitStatusAbortController = abortController;
    void (async () => {
      try {
        const summary = await readGitStatus(pi, cwd, abortController.signal);
        if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(summary);
      } catch {
        if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(undefined);
      } finally {
        gitStatusRefreshInFlight = false;
        if (gitStatusAbortController === abortController) gitStatusAbortController = undefined;
        const pending = pendingGitStatusRefresh;
        pendingGitStatusRefresh = undefined;
        if (pending) runGitStatusRefresh(pending.cwd, pending.generation, pending.requestId);
      }
    })();
  };

  const refreshGitStatus = (cwd: string, generation = sessionGeneration) => {
    if (!isActiveGitStatusTarget(cwd, generation)) return;
    runGitStatusRefresh(cwd, generation, ++gitStatusRequestId);
  };

  const scheduleGitStatusRefresh = (cwd: string, generation = sessionGeneration) => {
    if (!isActiveGitStatusTarget(cwd, generation)) return;
    const requestId = ++gitStatusRequestId;
    clearGitStatusDebounce();
    gitStatusDebounceTimer = setTimeout(() => {
      gitStatusDebounceTimer = undefined;
      runGitStatusRefresh(cwd, generation, requestId);
    }, GIT_STATUS_EVENT_DEBOUNCE_MS);
  };

  const scheduleGitStatusRefreshForContext = (ctx: ExtensionContext) => {
    if (!activeGitStatusTarget || activeGitStatusTarget.cwd !== ctx.cwd) return;
    scheduleGitStatusRefresh(activeGitStatusTarget.cwd, activeGitStatusTarget.generation);
  };

  const installFooter = (ctx: ExtensionContext) => {
    const generation = ++sessionGeneration;
    menuController.abort(new DOMException("Statusline session context replaced", "AbortError"));
    menuController = new AbortController();
    const cwd = ctx.cwd;
    activeSessionManager = ctx.sessionManager;
    runtime.homeDir = homedir();
    previewPalettePreset = undefined;
    abortGitStatusRefresh("Statusline session context replaced");
    clearGitStatusDebounce();
    activeGitStatusTarget = ctx.mode === "tui" ? { cwd, generation } : undefined;
    runtime.gitStatus = undefined;
    runtime.duplicateExtensions = [];
    runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
    ctx.ui.setStatus(STATUSLINE_KEY, undefined);
    if (!activeGitStatusTarget || !loaded) return;
    const installedPackages = readInstalledExtensionPackages(cwd);
    runtime.duplicateExtensions = findDuplicateExtensions(installedPackages);
    runtime.extensionStatusIconAliases = buildExtensionStatusIconAliases(installedPackages);
    ctx.ui.setFooter((tui, theme, footerData) => {
      runtime.requestRender = () => tui.requestRender();

      const refreshFooterGitStatus = () => refreshGitStatus(cwd, generation);
      const branchUnsubscribe = footerData.onBranchChange(() => {
        runtime.gitStatus = undefined;
        abortGitStatusRefresh("Statusline Git branch changed");
        clearGitStatusDebounce();
        refreshFooterGitStatus();
        tui.requestRender();
      });
      const clock = setInterval(() => {
        clearGitStatusDebounce();
        refreshFooterGitStatus();
        tui.requestRender();
      }, GIT_STATUS_REFRESH_INTERVAL_MS);

      return {
        dispose() {
          branchUnsubscribe();
          clearInterval(clock);
          if (isActiveGitStatusTarget(cwd, generation)) {
            activeGitStatusTarget = undefined;
            abortGitStatusRefresh("Statusline footer disposed");
            clearGitStatusDebounce();
            pendingGitStatusRefresh = undefined;
            runtime.gitStatus = undefined;
            runtime.duplicateExtensions = [];
            runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
            runtime.requestRender = undefined;
          }
        },
        invalidate() {},
        render(width: number): string[] {
          if (!loaded) return [];
          const config = previewPalettePreset
            ? { ...loaded.config, palettePreset: previewPalettePreset }
            : loaded.config;
          const trueColor = getCapabilities().trueColor;
          const mainLine = renderStatusline(width, ctx, footerData, theme, config, runtime, trueColor);
          const lines = mainLine ? mainLine.split("\n") : [];
          lines.push(...renderExtensionStatusline(width, footerData, theme, config, runtime, mainLine, trueColor));
          return lines;
        },
      };
    });
    refreshGitStatus(cwd, generation);
  };

  const agentDir = getAgentDir();
  const configPath = settingsFilePath(agentDir);
  const commandOptions: StatuslineCommandOptions = {
    settingsPath: configPath,
    getLoaded: () => loaded ?? loadStatuslineSettings(configPath),
    getMenuOwner: () => {
      const generation = sessionGeneration;
      return {
        signal: menuController.signal,
        isCurrent: () => generation === sessionGeneration && !menuController.signal.aborted,
      };
    },
    apply(next, ctx) {
      if (ctx.sessionManager !== activeSessionManager) return;
      previewPalettePreset = undefined;
      loaded = next;
      refresh();
    },
    preview(palettePreset, ctx) {
      if (ctx.sessionManager !== activeSessionManager) return;
      previewPalettePreset = palettePreset;
      refresh();
    },
  };
  pi.registerCommand("statusline", {
    description: "Open or inspect the statusline settings",
    getArgumentCompletions: completeStatuslineArguments,
    handler: async (args, ctx) => {
      const commands = await loadStatuslineCommands();
      if (ctx.sessionManager !== activeSessionManager) return;
      await commands.handleStatuslineCommand(args, ctx, commandOptions);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.turnCount = 0;
    runtime.activeTools.clear();
    runtime.isStreaming = false;
    runtime.uiPrompt = undefined;
    loaded = loadStatuslineSettingsForAgent(agentDir);
    const settingsNotice = consumeStatuslineSettingsNotice();
    if (settingsNotice) ctx.ui.notify(settingsNotice, "warning");
    if (loaded.diagnostics.length > 0) {
      ctx.ui.notify(formatSettingsDiagnostics(loaded), "warning");
    }
    runtime.thinkingLevel = pi.getThinkingLevel();
    installFooter(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    installFooter(ctx);
    refresh();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    sessionGeneration += 1;
    menuController.abort(new DOMException("Statusline session shut down", "AbortError"));
    activeSessionManager = undefined;
    previewPalettePreset = undefined;
    activeGitStatusTarget = undefined;
    abortGitStatusRefresh("Statusline session shut down");
    clearGitStatusDebounce();
    pendingGitStatusRefresh = undefined;
    runtime.gitStatus = undefined;
    runtime.activeTools.clear();
    runtime.isStreaming = false;
    runtime.uiPrompt = undefined;
    runtime.duplicateExtensions = [];
    runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
    ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(STATUSLINE_KEY, undefined);
    runtime.requestRender = undefined;
  });

  pi.on("model_select", () => refresh());

  pi.on("session_info_changed", () => refresh());

  pi.on("thinking_level_select", (event) => {
    runtime.thinkingLevel = event.level;
    refresh();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.isStreaming = true;
    refresh();
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.activeTools.clear();
    scheduleGitStatusRefreshForContext(ctx);
    refresh();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.isStreaming = false;
    runtime.activeTools.clear();
    refresh();
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.uiPrompt = { kind: event.kind, title: event.title };
    refresh();
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.uiPrompt = undefined;
    refresh();
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.turnCount += 1;
    runtime.isStreaming = true;
    refresh();
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    scheduleGitStatusRefreshForContext(ctx);
    refresh();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
    runtime.activeTools.set(event.toolName, currentCount + 1);
    refresh();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
    if (currentCount <= 1) runtime.activeTools.delete(event.toolName);
    else runtime.activeTools.set(event.toolName, currentCount - 1);

    scheduleGitStatusRefreshForContext(ctx);
    refresh();
  });
}

function formatSettingsDiagnostics(loaded: LoadedStatuslineSettings): string {
  const details = loaded.diagnostics.slice(0, 5).map((item) => item.message);
  const remaining = loaded.diagnostics.length - details.length;
  return [`pi-statusline settings: ${details.join("; ")}`, ...(remaining > 0 ? [`+${remaining} more`] : [])].join(" ");
}

export {
  buildExtensionStatusIconAliases,
  type ExtensionStatusIconAliasMap,
  extensionColor,
  formatExtensionStatus,
  npmPackageName,
  simplifyExtensionStatusText,
  splitExtensionStatusIcon,
  stripExtensionStatusPrefix,
  wrapExtensionStatusline,
} from "./extension-status.js";
export {
  formatGitBranchText,
  formatGitBranchValue,
  formatGitStatusSummary,
  type GitStatusSummary,
  parseGitRoot,
  parseGitStatusPorcelain,
  readGitStatus,
} from "./git-status.js";
export {
  contextColor,
  formatCount,
  formatToolActivity,
  prContextFromStatuses,
  prLinkFromStatuses,
  shortenModel,
} from "./render.js";
export { normalizeStatuslineSettings, readStatuslineSettings } from "./settings.js";
