import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActiveToolStatusController } from "./active-tool-status.js";
import { awaitToolSettingsWrites, readToolSettings, toolSettingsPath, updateToolSettings } from "./settings.js";

const COMMAND_NAME = "tool";

export interface ToolExtensionOptions {
  settingsPath?: string;
  readSettings?: typeof readToolSettings;
  updateSettings?: typeof updateToolSettings;
  awaitSettingsWrites?: typeof awaitToolSettingsWrites;
}

export default function toolExtension(pi: ExtensionAPI, options: ToolExtensionOptions = {}) {
  const settingsPath = options.settingsPath ?? toolSettingsPath();
  const loadSettings = options.readSettings ?? readToolSettings;
  const saveSettings = options.updateSettings ?? updateToolSettings;
  const flushSettings = options.awaitSettingsWrites ?? awaitToolSettingsWrites;
  const activeToolStatus = createActiveToolStatusController(pi);
  let generation = 0;
  let sessionController = new AbortController();
  let activeContext: ExtensionContext | undefined;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let activeToolStatusEnabled = false;

  const replaceSessionOwner = (ctx: ExtensionContext) => {
    if (activeContext) activeToolStatus.shutdown(activeContext);
    sessionController.abort(new DOMException("Tool session replaced", "AbortError"));
    sessionController = new AbortController();
    generation += 1;
    activeContext = ctx;
    activeSession = ctx.sessionManager;
    activeToolStatusEnabled = false;
  };

  const ownsSession = (ctx: ExtensionContext) => ctx.sessionManager === activeSession;
  const isCurrent = (expectedGeneration: number) =>
    expectedGeneration === generation && !sessionController.signal.aborted;

  pi.on("session_start", async (_event, ctx) => {
    replaceSessionOwner(ctx);
    const startGeneration = generation;
    const loaded = await loadSettings(settingsPath);
    if (!isCurrent(startGeneration) || !ownsSession(ctx)) return;
    activeToolStatusEnabled = loaded.settings.activeToolStatus;
    activeToolStatus.start(ctx, activeToolStatusEnabled);
    if (loaded.kind === "invalid" && ctx.hasUI) {
      ctx.ui.notify(
        safeDisplayText(`Pi Tool ignored invalid settings and kept the widget off: ${loaded.reason}`),
        "warning",
      );
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ownsSession(ctx)) activeToolStatus.refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    if (ownsSession(ctx)) activeToolStatus.refresh(ctx);
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    if (ownsSession(ctx)) activeToolStatus.refresh(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ownsSession(ctx) && ctx.isIdle()) activeToolStatus.refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    sessionController.abort(new DOMException("Tool session ended", "AbortError"));
    activeToolStatus.shutdown(ctx);
    activeContext = undefined;
    activeSession = undefined;
    await flushSettings(settingsPath);
  });

  const setActiveToolStatus = async (
    ctx: ExtensionContext,
    enabled: boolean,
    expectedGeneration: number,
  ): Promise<boolean> => {
    const ownerContext = activeContext;
    if (!isCurrent(expectedGeneration) || !ownerContext) return false;
    const previous = activeToolStatusEnabled;
    if (enabled === previous) return true;
    activeToolStatusEnabled = enabled;
    activeToolStatus.setEnabled(ownerContext, enabled);
    try {
      await saveSettings({ activeToolStatus: enabled }, { settingsPath });
    } catch (error) {
      if (isCurrent(expectedGeneration) && activeContext === ownerContext) {
        activeToolStatusEnabled = previous;
        activeToolStatus.setEnabled(ownerContext, previous);
        ctx.ui.notify(
          safeDisplayText(`Pi Tool settings were not saved; the widget was restored: ${formatError(error)}`),
          "warning",
        );
      }
      return false;
    }
    return true;
  };

  pi.registerCommand(COMMAND_NAME, {
    description: "Browse tools and configure the active-tool status widget",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("/tool does not accept arguments.");
      if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
        throw new Error("/tool requires TUI or RPC mode.");
      }

      const commandGeneration = generation;
      const signal = sessionController.signal;
      const commandIsCurrent = () => isCurrent(commandGeneration);
      const [{ runMenu }, { createToolCatalog, createToolMenu }] = await Promise.all([
        import("@narumitw/pi-tui-kit"),
        import("./tool-catalog.js"),
      ]);
      if (!commandIsCurrent()) return;
      const catalog = createToolCatalog(
        pi.getAllTools(),
        pi.getActiveTools(),
        ctx.getSystemPromptOptions().toolSnippets ?? {},
      );
      const menu = createToolMenu(catalog, {
        settingsPath,
        isActiveToolStatusEnabled: () => activeToolStatusEnabled,
        toggleActiveToolStatus: (actionCtx, enabled) => setActiveToolStatus(actionCtx, enabled, commandGeneration),
      });
      const onError = (errorCtx: typeof ctx) => {
        if (commandIsCurrent()) errorCtx.ui.notify("The tool menu could not be displayed.", "error");
      };
      const onUnsupportedMode = (_unsupportedCtx: typeof ctx, mode: typeof ctx.mode) => {
        throw new Error(`/tool is unavailable in ${mode} mode; use TUI or RPC mode.`);
      };

      await runMenu(ctx, menu, {
        getState: () => undefined,
        signal,
        isCurrent: commandIsCurrent,
        onError,
        onUnsupportedMode,
      });
    },
  });
}

function safeDisplayText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint >= 0 && codePoint <= 8) ||
      (codePoint >= 11 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159)
      ? "�"
      : character;
  }).join("");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
