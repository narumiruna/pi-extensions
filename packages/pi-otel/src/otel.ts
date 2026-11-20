import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  type LangfuseConfig,
  type LangfuseConfigPatch,
  loadSettings,
  normalizeLangfuseConfig,
  otelSettingsPath,
  type SettingsResult,
  type TracingSettings,
  writeLangfuseConfig,
} from "./config.js";
import { otlpSecrets } from "./otlp-settings.js";
import { createPiLangfuseSessionController, type PiLangfuseSessionController } from "./pi-session.js";
import { createLangfuseRuntimeFromBackend, type LangfuseRuntime } from "./runtime-core.js";
import type { GitMetadata, TraceBackend } from "./tracing.js";

export { resolveGitMetadata } from "./git.js";

interface ExtensionDependencies {
  loadConfig(path?: string): Promise<SettingsResult>;
  writeConfig(config: LangfuseConfigPatch, path?: string): Promise<unknown>;
  createBackend(config: TracingSettings): Promise<TraceBackend>;
  resolveGitMetadata(cwd: string): Promise<GitMetadata | undefined>;
}

const FLUSH_ACTION = "Flush completed traces for this session";
const SET_UP_ACTION = "Set up Langfuse for this Pi agent directory (restart required)";
const UPDATE_ACTION = "Update Langfuse for this Pi agent directory (restart required)";
const HELP_ACTION = "Show setup and privacy help";

export function createOtelExtension(dependencies: Partial<ExtensionDependencies> = {}): (pi: ExtensionAPI) => void {
  const loadConfig = dependencies.loadConfig ?? loadSettings;
  const writeConfig = dependencies.writeConfig ?? writeLangfuseConfig;
  const resolveInjectedGitMetadata = dependencies.resolveGitMetadata;

  return function otel(pi: ExtensionAPI) {
    let activeConfig: TracingSettings | undefined;
    let loadingConfig: TracingSettings | undefined;
    let runtimeConfigForShutdown: TracingSettings | undefined;
    let shutdownConfig: TracingSettings | undefined;
    let configPath: string | undefined;
    let initializationError: string | undefined;
    let storedBackend: "otlp" | "langfuse" | undefined;
    let configurationNotice: string | undefined;
    let sessionGeneration = 0;
    let menuController = new AbortController();
    let configWriteQueue = Promise.resolve();

    const tracing: PiLangfuseSessionController = createPiLangfuseSessionController({
      onSessionStart() {
        sessionGeneration += 1;
        menuController.abort(new DOMException("Pi OTel session replaced", "AbortError"));
        menuController = new AbortController();
        activeConfig = undefined;
        loadingConfig = undefined;
        shutdownConfig = undefined;
        configPath = undefined;
        initializationError = undefined;
        storedBackend = undefined;
        configurationNotice = undefined;
      },
      onSessionShutdown() {
        sessionGeneration += 1;
        menuController.abort(new DOMException("Pi OTel session shut down", "AbortError"));
        shutdownConfig = activeConfig ?? runtimeConfigForShutdown ?? loadingConfig;
        activeConfig = undefined;
      },
      async resolveSession(ctx, isCurrent) {
        await configWriteQueue;
        if (!isCurrent()) return undefined;
        const result = await loadConfig();
        if (!isCurrent()) return undefined;
        configPath = result.path;
        for (const warning of result.warnings) ctx.ui.notify(stripVTControlCharacters(warning), "warning");
        if (!result.ok) {
          initializationError = formatConfigError(result);
          if (!result.missing) ctx.ui.notify(initializationError, "warning");
          return undefined;
        }

        storedBackend = result.config.backend ?? "langfuse";
        loadingConfig = result.config;
        const createBackend = dependencies.createBackend;
        const ownsRuntime = createBackend !== undefined;
        const config = result.config;
        let runtime: LangfuseRuntime;
        if (createBackend) {
          runtime = createLangfuseRuntimeFromBackend(await createBackend(config));
        } else {
          const { createLangfuseRuntime, createOtelRuntime } = await import("./runtime.js");
          if (!isCurrent()) return undefined;
          runtime = await (config.backend === "otlp"
            ? createOtelRuntime(config)
            : createLangfuseRuntime({ config, env: false }));
        }
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
        initializationError = `${backendLabel(config)} tracing could not start: ${formatError(error, config)}`;
        ctx.ui.notify(initializationError, "warning");
      },
      beforeSessionDispose: async () => {
        await configWriteQueue;
      },
      onShutdownError(error, ctx) {
        ctx.ui.notify(
          `${backendLabel(shutdownConfig)} shutdown export failed: ${formatError(error, shutdownConfig)}`,
          "error",
        );
      },
      flushOnReplacement: true,
      shutdownRuntimeOnQuit: true,
    });

    async function showMenu(ctx: ExtensionCommandContext) {
      if (!ctx.hasUI) {
        throw new Error(formatNonInteractiveStatus(activeConfig, configPath, initializationError));
      }
      const menuGeneration = sessionGeneration;
      const menuSignal = menuController.signal;
      const isCurrent = () => menuGeneration === sessionGeneration && !menuSignal.aborted;
      const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
      if (!isCurrent()) return;
      type Screen = "main";
      type Action = "flush" | "configure" | "settings" | "help";
      const menu = defineMenu<undefined, Screen, Action>({
        start: "main",
        screens: {
          main: () => ({
            kind: "actions",
            title: "Pi OTel",
            lines: formatMenuDetails(activeConfig, configPath, initializationError, configurationNotice),
            items: [
              ...(tracing.active ? [{ id: "flush", label: FLUSH_ACTION, action: "flush" as const }] : []),
              ...(storedBackend !== "otlp"
                ? [
                    {
                      id: "configure",
                      label: storedBackend ? UPDATE_ACTION : SET_UP_ACTION,
                      action: "configure" as const,
                    },
                  ]
                : []),
              { id: "settings", label: "Settings (edit private file)", action: "settings" },
              { id: "help", label: HELP_ACTION, action: "help" },
            ],
            hint: "close",
          }),
        },
        actions: {
          flush: async () => {
            const menuConfig = activeConfig;
            const label = backendLabel(menuConfig);
            if (!tracing.active) {
              ctx.ui.notify(`${label} tracing is not enabled for this session.`, "warning");
              return { kind: "close" };
            }
            try {
              await tracing.flush();
              if (!isCurrent()) return { kind: "close" };
              ctx.ui.notify(`${label} traces flushed for this session.`, "info");
            } catch (error) {
              if (!isCurrent()) return { kind: "close" };
              ctx.ui.notify(`${label} flush failed: ${formatError(error, menuConfig)}`, "error");
            }
            return { kind: "close" };
          },
          configure: async () => {
            const loaded = await loadConfig();
            if (!isCurrent()) return { kind: "close" };
            configPath = loaded.path;
            const current = loaded.ok ? loaded.config : undefined;
            storedBackend = current ? (current.backend ?? "langfuse") : undefined;
            if (loaded.legacy || current?.backend === "otlp") {
              ctx.ui.notify(formatSettingsNotice(configPath, loaded.legacy), "info");
              return { kind: "close" };
            }
            const next = await promptForConfig(ctx, current, menuSignal);
            if (!next || !isCurrent()) return { kind: "close" };
            try {
              const write = configWriteQueue.then(() => writeConfig(next, loaded.path));
              configWriteQueue = write.then(
                () => undefined,
                () => undefined,
              );
              await write;
              if (!isCurrent()) return { kind: "close" };
              storedBackend = "langfuse";
              configurationNotice = "Saved; restart each Pi process to use it in subsequent sessions.";
              ctx.ui.notify(
                `Saved Langfuse config to ${stripVTControlCharacters(loaded.path)} for this Pi agent directory. Restart each Pi process to apply it to subsequent sessions.`,
                "info",
              );
            } catch (error) {
              if (!isCurrent()) return { kind: "close" };
              ctx.ui.notify(`Failed to save Langfuse config: ${formatError(error, { ...current, ...next })}`, "error");
            }
            return { kind: "close" };
          },
          settings: async () => {
            ctx.ui.notify(formatSettingsNotice(configPath), "info");
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

    pi.registerCommand("otel", {
      description: "Show OpenTelemetry tracing status, settings, and export controls",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("/otel takes no arguments.");
        await showMenu(ctx);
      },
    });
    pi.registerCommand("langfuse", {
      description: "Deprecated: use /otel instead",
      handler: async (_args, ctx) => {
        if (ctx.hasUI) ctx.ui.notify("/langfuse is deprecated. Use /otel instead.", "warning");
        await showMenu(ctx);
      },
    });

    tracing.extension(pi);
  };
}

async function promptForConfig(
  ctx: ExtensionCommandContext,
  current: LangfuseConfig | undefined,
  signal: AbortSignal,
): Promise<LangfuseConfigPatch | undefined> {
  const secretKey = await ctx.ui.input("Langfuse secret key (leave blank to keep existing):", undefined, { signal });
  if (signal.aborted) return undefined;
  if (secretKey === undefined) {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }
  const publicKey = await ctx.ui.input("Langfuse public key (leave blank to keep existing):", undefined, { signal });
  if (signal.aborted) return undefined;
  if (publicKey === undefined) {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }
  const baseUrl = await ctx.ui.input(
    `Langfuse base URL (leave blank for default ${DEFAULT_BASE_URL}):`,
    DEFAULT_BASE_URL,
    { signal },
  );
  if (signal.aborted) return undefined;
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

function formatMenuDetails(
  activeConfig: TracingSettings | undefined,
  configPath: string | undefined,
  initializationError: string | undefined,
  configurationNotice: string | undefined,
): string[] {
  const lines = ["Current session:", `  Tracing: ${activeConfig ? "enabled" : "disabled"}`];
  if (activeConfig) {
    lines.push(...connectionDetails(activeConfig));
  } else if (configurationNotice) {
    lines.push("  State: tracing remains disabled until Pi restarts.");
  } else if (initializationError) {
    lines.push(`  Reason: ${initializationError}`);
  }
  lines.push(
    "",
    "Agent-directory configuration:",
    `  Configuration: ${displaySettingsPath(configPath)}`,
    "  Scope: this Pi agent directory; restart each Pi process to apply changes.",
  );
  if (configurationNotice) lines.push(`  Pending: ${configurationNotice}`);
  lines.push("", "What do you want to do?");
  return lines;
}

function formatNonInteractiveStatus(
  activeConfig: TracingSettings | undefined,
  configPath: string | undefined,
  initializationError: string | undefined,
): string {
  return [
    "/otel requires interactive UI.",
    `Current session tracing: ${activeConfig ? "enabled" : "disabled"}`,
    ...(activeConfig ? connectionDetails(activeConfig) : initializationError ? [`Reason: ${initializationError}`] : []),
    `Configuration: ${displaySettingsPath(configPath)}`,
    "Edit the private config manually, then restart each Pi process to apply it to subsequent sessions.",
  ].join("\n");
}

function backendLabel(config: TracingSettings | undefined): string {
  return config?.backend === "otlp" ? "OTLP" : "Langfuse";
}

function connectionDetails(settings: TracingSettings): string[] {
  const otlp = settings.backend === "otlp";
  return [
    `Backend: ${backendLabel(settings)}`,
    otlp ? `Endpoint origin: ${new URL(settings.endpoint).origin}` : `Endpoint: ${settings.baseUrl}`,
    ...(otlp && Object.keys(settings.headers).length ? ["Export headers: settings file"] : []),
    `Content capture: ${settings.captureContent ? "enabled" : "disabled"}`,
  ];
}

function displaySettingsPath(path = otelSettingsPath()): string {
  return stripVTControlCharacters(path);
}

function formatSettingsNotice(path: string | undefined, legacy = false): string {
  const canonical = displaySettingsPath();
  return legacy
    ? `Read-only legacy settings: ${displaySettingsPath(path)}. Move the file to ${canonical} before editing it.`
    : `Edit the private settings file: ${canonical}. Restart each Pi process to change its export connection.`;
}

function formatHelp(configPath: string | undefined): string {
  return [
    "Pi OTel setup and privacy:",
    'For an OTLP collector, set backend to "otlp" and enter the full traces endpoint in the settings file.',
    "For Langfuse, use the setup action in /otel or edit the settings file manually.",
    `Configuration: ${displaySettingsPath(configPath)}`,
    "The file belongs to this Pi agent directory; restart each Pi process after changing it.",
    "Trace content may contain prompts, responses, tool arguments, tool results, and source code.",
    "Git branch, commit, cwd, model, and usage remain in metadata when content capture is disabled.",
    'Use "captureContent": false in the private config to export metadata only.',
  ].join("\n");
}

function formatConfigError(result: Extract<SettingsResult, { ok: false }>): string {
  const setupHint =
    result.missing || result.reason.startsWith("Configuration file not found:")
      ? " Run /otel and choose Set up Langfuse, or configure an OTLP endpoint in pi-otel.json."
      : "";
  return `Tracing is disabled: ${stripVTControlCharacters(result.reason)}${setupHint}`;
}

function formatError(error: unknown, config?: TracingSettings | LangfuseConfigPatch): string {
  let message = error instanceof Error ? error.message : String(error);
  const otlp = config?.backend === "otlp";
  const secrets = otlp
    ? [config.endpoint, ...otlpSecrets(config.headers)].sort((left, right) => right.length - left.length)
    : [config?.publicKey, config?.secretKey]
        .filter((secret): secret is string => Boolean(secret))
        .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    message = message.replaceAll(secret, otlp ? "[OTLP_SECRET_REDACTED]" : "[LANGFUSE_KEY_REDACTED]");
  }
  return stripVTControlCharacters(message);
}

export default createOtelExtension();
