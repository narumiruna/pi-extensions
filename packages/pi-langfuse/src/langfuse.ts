import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  type LangfuseConfig,
  type LangfuseConfigPatch,
  type LangfuseConfigResult,
  loadLangfuseConfig,
  normalizeLangfuseConfig,
  writeLangfuseConfig,
} from "./config.js";
import { createPiLangfuseSessionController, type PiLangfuseSessionController } from "./pi-session.js";
import { createLangfuseRuntimeFromBackend } from "./runtime-core.js";
import type { GitMetadata, TraceBackend } from "./tracing.js";

export { resolveGitMetadata } from "./git.js";

interface ExtensionDependencies {
  loadConfig(path?: string): Promise<LangfuseConfigResult>;
  writeConfig(config: LangfuseConfigPatch, path?: string): Promise<unknown>;
  createBackend(config: LangfuseConfig): Promise<TraceBackend>;
  resolveGitMetadata(cwd: string): Promise<GitMetadata | undefined>;
}

const FLUSH_ACTION = "Flush completed traces for this session";
const SET_UP_ACTION = "Set up Langfuse for this Pi agent directory (restart required)";
const UPDATE_ACTION = "Update Langfuse for this Pi agent directory (restart required)";
const HELP_ACTION = "Show setup and privacy help";

export function createLangfuseExtension(dependencies: Partial<ExtensionDependencies> = {}): (pi: ExtensionAPI) => void {
  const loadConfig = dependencies.loadConfig ?? loadLangfuseConfig;
  const writeConfig = dependencies.writeConfig ?? writeLangfuseConfig;
  const resolveInjectedGitMetadata = dependencies.resolveGitMetadata;

  return function langfuse(pi: ExtensionAPI) {
    let activeConfig: LangfuseConfig | undefined;
    let loadingConfig: LangfuseConfig | undefined;
    let runtimeConfigForShutdown: LangfuseConfig | undefined;
    let shutdownConfig: LangfuseConfig | undefined;
    let configPath: string | undefined;
    let initializationError: string | undefined;
    let hasStoredConfig = false;
    let configurationNotice: string | undefined;
    let sessionGeneration = 0;
    let menuController = new AbortController();
    let configWriteQueue = Promise.resolve();

    const tracing: PiLangfuseSessionController = createPiLangfuseSessionController({
      onSessionStart() {
        sessionGeneration += 1;
        menuController.abort(new DOMException("Langfuse session replaced", "AbortError"));
        menuController = new AbortController();
        activeConfig = undefined;
        loadingConfig = undefined;
        shutdownConfig = undefined;
        configPath = undefined;
        initializationError = undefined;
        hasStoredConfig = false;
        configurationNotice = undefined;
      },
      onSessionShutdown() {
        sessionGeneration += 1;
        menuController.abort(new DOMException("Langfuse session shut down", "AbortError"));
        shutdownConfig = activeConfig ?? runtimeConfigForShutdown ?? loadingConfig;
        activeConfig = undefined;
      },
      async resolveSession(ctx, isCurrent) {
        await configWriteQueue;
        if (!isCurrent()) return undefined;
        const result = await loadConfig();
        if (!isCurrent()) return undefined;
        configPath = result.path;
        for (const warning of result.warnings) ctx.ui.notify(warning, "warning");
        if (!result.ok) {
          initializationError = formatConfigError(result);
          ctx.ui.notify(initializationError, "warning");
          return undefined;
        }

        hasStoredConfig = true;
        loadingConfig = result.config;
        const createBackend = dependencies.createBackend;
        const ownsRuntime = createBackend !== undefined;
        const runtime = createBackend
          ? createLangfuseRuntimeFromBackend(await createBackend(result.config))
          : await (await import("./runtime.js")).createLangfuseRuntime({ config: result.config, env: false });
        if (isCurrent() || !runtimeConfigForShutdown) runtimeConfigForShutdown = result.config;
        if (isCurrent()) {
          activeConfig = result.config;
          loadingConfig = undefined;
        }
        return {
          runtime,
          releaseIfStale: async (reason) => {
            if (ownsRuntime || reason === "quit") await runtime.shutdown();
          },
          options: {
            ...(result.config.userId ? { userId: result.config.userId } : {}),
            captureContent: result.config.captureContent,
          },
        };
      },
      ...(resolveInjectedGitMetadata
        ? { resolveGitMetadata: (_pi: ExtensionAPI, cwd: string) => resolveInjectedGitMetadata(cwd) }
        : {}),
      onInitializationError(error, ctx) {
        const config = loadingConfig;
        loadingConfig = undefined;
        initializationError = `Langfuse tracing could not start: ${formatError(error, config)}`;
        ctx.ui.notify(initializationError, "warning");
      },
      beforeSessionDispose: async () => {
        await configWriteQueue;
      },
      onShutdownError(error, ctx) {
        ctx.ui.notify(`Langfuse shutdown export failed: ${formatError(error, shutdownConfig)}`, "error");
      },
      flushOnReplacement: true,
      shutdownRuntimeOnQuit: true,
    });

    async function showLangfuseMenu(ctx: ExtensionCommandContext) {
      if (!ctx.hasUI) {
        ctx.ui.notify(formatNonInteractiveStatus(activeConfig, configPath, initializationError), "warning");
        return;
      }
      const menuGeneration = sessionGeneration;
      const menuSignal = menuController.signal;
      const isCurrent = () => menuGeneration === sessionGeneration && !menuSignal.aborted;
      const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
      if (!isCurrent()) return;
      type Screen = "main";
      type Action = "flush" | "configure" | "help";
      const menu = defineMenu<undefined, Screen, Action>({
        start: "main",
        screens: {
          main: () => ({
            kind: "actions",
            title: "Langfuse",
            lines: formatMenuTitle(activeConfig, configPath, initializationError, configurationNotice)
              .split("\n")
              .slice(1),
            items: [
              ...(tracing.active ? [{ id: "flush", label: FLUSH_ACTION, action: "flush" as const }] : []),
              {
                id: "configure",
                label: hasStoredConfig ? UPDATE_ACTION : SET_UP_ACTION,
                action: "configure",
              },
              { id: "help", label: HELP_ACTION, action: "help" },
            ],
            hint: "close",
          }),
        },
        actions: {
          flush: async () => {
            const menuConfig = activeConfig;
            if (!tracing.active) {
              ctx.ui.notify("Langfuse tracing is not enabled for this session.", "warning");
              return { kind: "close" };
            }
            try {
              await tracing.flush();
              if (menuGeneration !== sessionGeneration) return { kind: "close" };
              ctx.ui.notify("Langfuse traces flushed for this session.", "info");
            } catch (error) {
              if (menuGeneration !== sessionGeneration) return { kind: "close" };
              ctx.ui.notify(`Langfuse flush failed: ${formatError(error, menuConfig)}`, "error");
            }
            return { kind: "close" };
          },
          configure: async () => {
            const loaded = await loadConfig(configPath);
            if (menuGeneration !== sessionGeneration) return { kind: "close" };
            configPath = loaded.path;
            const next = await promptForConfig(
              ctx,
              loaded.ok ? loaded.config : undefined,
              () => menuGeneration === sessionGeneration,
            );
            if (!next || menuGeneration !== sessionGeneration) return { kind: "close" };
            try {
              const write = configWriteQueue.then(() => writeConfig(next, loaded.path));
              configWriteQueue = write.then(
                () => undefined,
                () => undefined,
              );
              await write;
              if (menuGeneration !== sessionGeneration) return { kind: "close" };
              hasStoredConfig = true;
              configurationNotice = "Saved; restart each Pi process to use it in subsequent sessions.";
              ctx.ui.notify(
                `Saved Langfuse config to ${loaded.path} for this Pi agent directory. Restart each Pi process to apply it to subsequent sessions.`,
                "info",
              );
            } catch (error) {
              if (menuGeneration !== sessionGeneration) return { kind: "close" };
              ctx.ui.notify(`Failed to save Langfuse config: ${formatError(error, next)}`, "error");
            }
            return { kind: "close" };
          },
          help: async () => {
            ctx.ui.notify(formatHelp(configPath), "info");
            return { kind: "close" };
          },
        },
      });
      await runMenu(ctx, menu, {
        getState: () => undefined,
        signal: menuSignal,
        isCurrent,
      });
    }

    pi.registerCommand("langfuse", {
      description: "Open interactive Langfuse tracing controls",
      handler: async (_args, ctx) => showLangfuseMenu(ctx),
    });

    tracing.extension(pi);
  };
}

async function promptForConfig(
  ctx: ExtensionCommandContext,
  current: LangfuseConfig | undefined,
  isCurrent: () => boolean,
): Promise<LangfuseConfigPatch | undefined> {
  const secretKey = await ctx.ui.input("Langfuse secret key (leave blank to keep existing):");
  if (!isCurrent()) return undefined;
  if (secretKey === undefined) {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }
  const publicKey = await ctx.ui.input("Langfuse public key (leave blank to keep existing):");
  if (!isCurrent()) return undefined;
  if (publicKey === undefined) {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }
  const baseUrl = await ctx.ui.input(
    `Langfuse base URL (leave blank for default ${DEFAULT_BASE_URL}):`,
    DEFAULT_BASE_URL,
  );
  if (!isCurrent()) return undefined;
  if (baseUrl === undefined) {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }

  const patch: LangfuseConfigPatch = {
    ...(publicKey.trim() ? { publicKey: publicKey.trim() } : {}),
    ...(secretKey.trim() ? { secretKey: secretKey.trim() } : {}),
    baseUrl: baseUrl.trim() || DEFAULT_BASE_URL,
  };
  const normalized = normalizeLangfuseConfig({ ...current, ...patch });
  if (!normalized.ok) {
    ctx.ui.notify(`Invalid Langfuse config: ${normalized.reason}`, "error");
    return undefined;
  }
  return patch;
}

function formatMenuTitle(
  activeConfig: LangfuseConfig | undefined,
  configPath: string | undefined,
  initializationError: string | undefined,
  configurationNotice: string | undefined,
): string {
  const lines = ["Langfuse", "", "Current session:", `  Tracing: ${activeConfig ? "enabled" : "disabled"}`];
  if (activeConfig) {
    lines.push(
      `  Endpoint: ${activeConfig.baseUrl}`,
      `  Content capture: ${activeConfig.captureContent ? "enabled" : "disabled"}`,
    );
  } else if (configurationNotice) {
    lines.push("  State: tracing remains disabled until Pi restarts.");
  } else if (initializationError) {
    lines.push(`  Reason: ${initializationError}`);
  }
  lines.push(
    "",
    "Agent-directory configuration:",
    `  Configuration: ${configPath ?? "unknown"}`,
    "  Scope: this Pi agent directory; restart each Pi process to apply changes.",
  );
  if (configurationNotice) lines.push(`  Pending: ${configurationNotice}`);
  lines.push("", "What do you want to do?");
  return lines.join("\n");
}

function formatNonInteractiveStatus(
  activeConfig: LangfuseConfig | undefined,
  configPath: string | undefined,
  initializationError: string | undefined,
): string {
  return [
    "/langfuse requires interactive UI.",
    `Current session tracing: ${activeConfig ? "enabled" : "disabled"}`,
    ...(activeConfig
      ? [
          `Endpoint: ${activeConfig.baseUrl}`,
          `Content capture: ${activeConfig.captureContent ? "enabled" : "disabled"}`,
        ]
      : initializationError
        ? [`Reason: ${initializationError}`]
        : []),
    `Configuration: ${configPath ?? "unknown"}`,
    "Edit the private config manually, then restart each Pi process to apply it to subsequent sessions.",
  ].join("\n");
}

function formatHelp(configPath: string | undefined): string {
  return [
    "Langfuse setup and privacy:",
    "Run /langfuse in interactive Pi to manage tracing for the current session.",
    `Configuration: ${configPath ?? "pi-langfuse.json"}`,
    "The file belongs to this Pi agent directory; restart each Pi process after changing it.",
    "Trace content may contain prompts, responses, tool arguments, tool results, and source code.",
    "Git branch, commit, cwd, model, and usage remain in metadata when content capture is disabled.",
    'Use "captureContent": false in the private config to export metadata only.',
  ].join("\n");
}

function formatConfigError(result: Extract<LangfuseConfigResult, { ok: false }>): string {
  const setupHint = result.reason.startsWith("Configuration file not found:")
    ? " Run /langfuse and choose Set up Langfuse."
    : "";
  return `Langfuse tracing is disabled: ${result.reason}${setupHint}`;
}

function formatError(error: unknown, config?: LangfuseConfigPatch): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [config?.publicKey, config?.secretKey]
    .filter((secret): secret is string => Boolean(secret))
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    message = message.split(secret).join("[LANGFUSE_KEY_REDACTED]");
  }
  return message;
}

export default createLangfuseExtension();
