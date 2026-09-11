import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  type LangfuseConfig,
  type LangfuseConfigPatch,
  type LangfuseConfigResult,
  loadLangfuseConfig,
  normalizeLangfuseConfig,
  writeLangfuseConfig,
} from "./config.js";
import { type ContextSnapshot, type GitMetadata, type TraceBackend, TraceRecorder } from "./tracing.js";

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
  const createBackend =
    dependencies.createBackend ??
    (async (config) => {
      const { createProductionBackend } = await import("./runtime.js");
      return createProductionBackend(config);
    });

  return function langfuse(pi: ExtensionAPI) {
    const resolveGit =
      dependencies.resolveGitMetadata ??
      ((cwd: string) => resolveGitMetadata((command, args, options) => pi.exec(command, args, options), cwd));
    let recorder: TraceRecorder | undefined;
    let activeConfig: LangfuseConfig | undefined;
    let configPath: string | undefined;
    let initializationError: string | undefined;
    let hasStoredConfig = false;
    let configurationNotice: string | undefined;
    let sessionGeneration = 0;
    let menuController = new AbortController();
    let configWriteQueue = Promise.resolve();
    let nextAttemptReason: string | undefined;

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
              ...(recorder ? [{ id: "flush", label: FLUSH_ACTION, action: "flush" as const }] : []),
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
            const menuRecorder = recorder;
            const menuConfig = activeConfig;
            if (!menuRecorder) {
              ctx.ui.notify("Langfuse tracing is not enabled for this session.", "warning");
              return { kind: "close" };
            }
            try {
              await menuRecorder.flush();
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

    pi.on("session_start", async (_event, ctx) => {
      const generation = ++sessionGeneration;
      menuController.abort(new DOMException("Langfuse session replaced", "AbortError"));
      menuController = new AbortController();
      recorder = undefined;
      activeConfig = undefined;
      configPath = undefined;
      initializationError = undefined;
      hasStoredConfig = false;
      configurationNotice = undefined;
      nextAttemptReason = undefined;

      await configWriteQueue;
      if (generation !== sessionGeneration) return;
      const result = await loadConfig();
      if (generation !== sessionGeneration) return;
      configPath = result.path;
      for (const warning of result.warnings) ctx.ui.notify(warning, "warning");
      if (!result.ok) {
        initializationError = formatConfigError(result);
        ctx.ui.notify(initializationError, "warning");
        return;
      }

      hasStoredConfig = true;
      try {
        const backend = await createBackend(result.config);
        if (generation !== sessionGeneration) {
          await backend.shutdown().catch(() => undefined);
          return;
        }
        activeConfig = result.config;
        recorder = new TraceRecorder(backend, {
          sessionId: ctx.sessionManager.getSessionId(),
          ...(result.config.userId ? { userId: result.config.userId } : {}),
          cwd: ctx.cwd,
          mode: ctx.mode,
          captureContent: result.config.captureContent,
        });
      } catch (error) {
        if (generation !== sessionGeneration) return;
        initializationError = `Langfuse tracing could not start: ${formatError(error, result.config)}`;
        ctx.ui.notify(initializationError, "warning");
      }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      nextAttemptReason = undefined;
      const activeRecorder = recorder;
      if (!activeRecorder) return;
      const git = await resolveGit(ctx.cwd).catch(() => undefined);
      if (recorder !== activeRecorder) return;
      activeRecorder.beginAgent({
        prompt: event.prompt,
        images: event.images,
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
        git,
        snapshot: contextSnapshot(ctx),
      });
    });

    pi.on("agent_start", () => {
      if (!recorder) return;
      recorder.beginAttempt(nextAttemptReason ? { reason: nextAttemptReason } : undefined);
      nextAttemptReason = undefined;
    });

    pi.on("turn_start", (event, ctx) => {
      if (!recorder) return;
      ensureActiveRun(recorder, ctx);
      recorder.beginTurn(event.turnIndex);
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!recorder) return;
      ensureActiveRun(recorder, ctx);
      recorder.beginGeneration({
        payload: event.payload,
        payloadStage: "before_provider_request",
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
        thinkingLevel: pi.getThinkingLevel(),
      });
    });

    pi.on("after_provider_response", (event) => {
      recorder?.recordProviderResponse(event.status, event.headers);
    });

    pi.on("message_update", (event) => {
      if (isRealOutputDelta(event.assistantMessageEvent)) recorder?.markGenerationFirstOutput();
    });

    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") recorder?.markGenerationEnd();
    });

    pi.on("turn_end", (event) => {
      if (event.message.role === "assistant") recorder?.finishAssistant(event.message);
      recorder?.finishTurn(event.turnIndex, {
        message: event.message,
        toolResultCount: event.toolResults.length,
      });
    });

    pi.on("tool_execution_start", (event) => {
      recorder?.beginTool(event.toolCallId, event.toolName, event.args);
    });

    pi.on("tool_execution_update", (event) => {
      recorder?.recordToolProgress(event.toolCallId);
    });

    pi.on("tool_result", (event) => {
      recorder?.recordToolInput(event.toolCallId, event.input);
    });

    pi.on("tool_execution_end", (event) => {
      recorder?.finishTool(event.toolCallId, {
        content: event.result.content,
        details: event.result.details,
        isError: event.isError,
      });
    });

    pi.on("agent_end", (event) => {
      const message = findLastAssistant(event.messages);
      recorder?.finishAttempt(message);
    });

    pi.on("session_before_compact", (event) => {
      recorder?.beginCompaction({
        reason: event.reason,
        willRetry: event.willRetry,
        tokensBefore: event.preparation.tokensBefore,
        messagesToSummarize: event.preparation.messagesToSummarize.length,
        turnPrefixMessages: event.preparation.turnPrefixMessages.length,
        branchEntries: event.branchEntries.length,
        isSplitTurn: event.preparation.isSplitTurn,
      });
    });

    pi.on("session_compact", (event) => {
      const entry = event.compactionEntry as typeof event.compactionEntry & {
        usage?: Parameters<TraceRecorder["finishCompaction"]>[0]["usage"];
      };
      recorder?.finishCompaction({
        reason: event.reason,
        willRetry: event.willRetry,
        fromExtension: event.fromExtension,
        tokensBefore: entry.tokensBefore,
        details: entry.details,
        usage: entry.usage,
      });
      if (event.willRetry && recorder?.hasActiveTrace()) nextAttemptReason = "post_compaction";
    });

    pi.on("agent_settled", (_event, ctx) => {
      recorder?.settle(contextSnapshot(ctx));
      nextAttemptReason = undefined;
    });

    pi.on("session_shutdown", async (event, ctx) => {
      const generation = ++sessionGeneration;
      menuController.abort(new DOMException("Langfuse session shut down", "AbortError"));
      const activeRecorder = recorder;
      const shutdownConfig = activeConfig;
      const pendingConfigWrite = configWriteQueue;
      const shutdownSnapshot = activeRecorder ? contextSnapshot(ctx) : undefined;
      recorder = undefined;
      activeConfig = undefined;
      await pendingConfigWrite;
      if (!activeRecorder) return;
      try {
        if (event.reason === "quit") await activeRecorder.shutdown(shutdownSnapshot);
        else {
          activeRecorder.interrupt(`Pi session ended before settlement (${event.reason}).`, shutdownSnapshot);
          await activeRecorder.flush();
        }
      } catch (error) {
        if (generation !== sessionGeneration) return;
        ctx.ui.notify(`Langfuse shutdown export failed: ${formatError(error, shutdownConfig)}`, "error");
      }
    });
  };
}

function ensureActiveRun(recorder: TraceRecorder, ctx: ExtensionContext): void {
  if (!recorder.hasActiveTrace()) {
    recorder.beginAgent({
      prompt: "[automatic continuation]",
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
      snapshot: contextSnapshot(ctx),
    });
  }
  if (!recorder.hasActiveAttempt()) recorder.beginAttempt();
}

function contextSnapshot(ctx: ExtensionContext): ContextSnapshot {
  return {
    leafId: typeof ctx.sessionManager.getLeafId === "function" ? ctx.sessionManager.getLeafId() : undefined,
    contextUsage: ctx.getContextUsage(),
  };
}

function findLastAssistant<T extends { role?: string }>(messages: readonly T[]): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function isRealOutputDelta(event: { type: string; delta?: unknown }): boolean {
  return (
    (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
    typeof event.delta === "string" &&
    event.delta.length > 0
  );
}

const GIT_LOOKUP_TIMEOUT_MS = 1_000;
const MAX_GIT_BRANCH_LENGTH = 256;

type GitExecutor = ExtensionAPI["exec"];

export async function resolveGitMetadata(exec: GitExecutor, cwd: string): Promise<GitMetadata | undefined> {
  const [branchResult, commit] = await Promise.all([resolveGitBranch(exec, cwd), resolveGitCommit(exec, cwd)]);
  if (!branchResult.resolved) return undefined;
  if (branchResult.branch) {
    return {
      branch: branchResult.branch,
      ...(commit ? { commit } : {}),
      detached: false,
    };
  }
  return commit ? { commit, detached: true } : undefined;
}

async function resolveGitBranch(exec: GitExecutor, cwd: string): Promise<{ resolved: boolean; branch?: string }> {
  try {
    const result = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      timeout: GIT_LOOKUP_TIMEOUT_MS,
    });
    if (result.killed) return { resolved: false };
    if (result.code === 1) return { resolved: true };
    if (result.code !== 0) return { resolved: false };
    const branch = normalizeGitBranch(result.stdout);
    return branch ? { resolved: true, branch } : { resolved: false };
  } catch {
    return { resolved: false };
  }
}

async function resolveGitCommit(exec: GitExecutor, cwd: string): Promise<string | undefined> {
  try {
    const result = await exec("git", ["rev-parse", "--verify", "--short=12", "HEAD"], {
      cwd,
      timeout: GIT_LOOKUP_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.killed) return undefined;
    const commit = result.stdout.trim();
    return /^[0-9a-f]{4,64}$/iu.test(commit) ? commit.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeGitBranch(value: string): string | undefined {
  const branch = value.trim();
  if (!branch || branch.length > MAX_GIT_BRANCH_LENGTH) return undefined;
  for (const character of branch) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return undefined;
  }
  return branch;
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
