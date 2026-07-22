import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_BASE_URL,
	type LangfuseConfig,
	type LangfuseConfigResult,
	loadLangfuseConfig,
	normalizeLangfuseConfig,
	writeLangfuseConfig,
} from "./config.js";
import { type TraceBackend, TraceRecorder } from "./tracing.js";

interface ExtensionDependencies {
	loadConfig(path?: string): Promise<LangfuseConfigResult>;
	writeConfig(config: LangfuseConfig, path?: string): Promise<LangfuseConfig>;
	createBackend(config: LangfuseConfig): Promise<TraceBackend>;
}

const FLUSH_ACTION = "Flush completed traces for this session";
const SET_UP_ACTION = "Set up Langfuse for this Pi agent directory (restart required)";
const UPDATE_ACTION = "Update Langfuse for this Pi agent directory (restart required)";
const HELP_ACTION = "Show setup and privacy help";

export function createLangfuseExtension(
	dependencies: Partial<ExtensionDependencies> = {},
): (pi: ExtensionAPI) => void {
	const loadConfig = dependencies.loadConfig ?? loadLangfuseConfig;
	const writeConfig = dependencies.writeConfig ?? writeLangfuseConfig;
	const createBackend =
		dependencies.createBackend ??
		(async (config) => {
			const { createProductionBackend } = await import("./runtime.js");
			return createProductionBackend(config);
		});

	return function langfuse(pi: ExtensionAPI) {
		let recorder: TraceRecorder | undefined;
		let activeConfig: LangfuseConfig | undefined;
		let configPath: string | undefined;
		let initializationError: string | undefined;
		let hasStoredConfig = false;
		let configurationNotice: string | undefined;
		let sessionGeneration = 0;

		pi.registerCommand("langfuse", {
			description: "Open interactive Langfuse tracing controls",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						formatNonInteractiveStatus(activeConfig, configPath, initializationError),
						"warning",
					);
					return;
				}

				const menuGeneration = sessionGeneration;
				const menuRecorder = recorder;
				const menuConfig = activeConfig;
				const choice = await ctx.ui.select(
					formatMenuTitle(activeConfig, configPath, initializationError, configurationNotice),
					[
						...(menuRecorder ? [FLUSH_ACTION] : []),
						hasStoredConfig ? UPDATE_ACTION : SET_UP_ACTION,
						HELP_ACTION,
					],
				);
				if (!choice || menuGeneration !== sessionGeneration) return;

				if (choice === FLUSH_ACTION) {
					if (!menuRecorder) {
						ctx.ui.notify("Langfuse tracing is not enabled for this session.", "warning");
						return;
					}
					try {
						await menuRecorder.flush();
						if (menuGeneration !== sessionGeneration) return;
						ctx.ui.notify("Langfuse traces flushed for this session.", "info");
					} catch (error) {
						if (menuGeneration !== sessionGeneration) return;
						ctx.ui.notify(`Langfuse flush failed: ${formatError(error, menuConfig)}`, "error");
					}
					return;
				}

				if (choice === SET_UP_ACTION || choice === UPDATE_ACTION) {
					const loaded = await loadConfig(configPath);
					if (menuGeneration !== sessionGeneration) return;
					configPath = loaded.path;
					const next = await promptForConfig(ctx, loaded.ok ? loaded.config : undefined);
					if (!next || menuGeneration !== sessionGeneration) return;
					try {
						await writeConfig(next, loaded.path);
						if (menuGeneration !== sessionGeneration) return;
						hasStoredConfig = true;
						configurationNotice =
							"Saved; restart each Pi process to use it in subsequent sessions.";
						ctx.ui.notify(
							`Saved Langfuse config to ${loaded.path} for this Pi agent directory. Restart each Pi process to apply it to subsequent sessions.`,
							"info",
						);
					} catch (error) {
						if (menuGeneration !== sessionGeneration) return;
						ctx.ui.notify(`Failed to save Langfuse config: ${formatError(error, next)}`, "error");
					}
					return;
				}

				if (choice === HELP_ACTION) {
					ctx.ui.notify(formatHelp(configPath), "info");
				}
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			sessionGeneration += 1;
			recorder = undefined;
			activeConfig = undefined;
			configPath = undefined;
			initializationError = undefined;
			hasStoredConfig = false;
			configurationNotice = undefined;

			const result = await loadConfig();
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
				activeConfig = result.config;
				recorder = new TraceRecorder(backend, {
					sessionId: ctx.sessionManager.getSessionId(),
					cwd: ctx.cwd,
					mode: ctx.mode,
					captureContent: result.config.captureContent,
				});
			} catch (error) {
				initializationError = `Langfuse tracing could not start: ${formatError(error, result.config)}`;
				ctx.ui.notify(initializationError, "warning");
			}
		});

		pi.on("before_agent_start", (event, ctx) => {
			recorder?.beginAgent({
				prompt: event.prompt,
				images: event.images,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			});
		});

		pi.on("turn_start", (event, ctx) => {
			if (!recorder) return;
			if (!recorder.hasActiveTrace()) {
				recorder.beginAgent({
					prompt: "[automatic continuation]",
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				});
			}
			recorder.beginTurn(event.turnIndex);
		});

		pi.on("before_provider_request", (_event, ctx) => {
			if (!recorder) return;
			if (!recorder.hasActiveTrace()) {
				recorder.beginAgent({
					prompt: "[automatic continuation]",
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				});
			}
			recorder.beginGeneration();
		});

		pi.on("after_provider_response", (event) => {
			recorder?.recordProviderResponse(event.status);
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
			recorder?.beginTool(event.toolCallId, event.toolName);
		});

		pi.on("tool_result", (event) => {
			recorder?.updateToolInput(event.toolCallId, event.input);
		});

		pi.on("tool_execution_end", (event) => {
			recorder?.finishTool(event.toolCallId, {
				content: event.result.content,
				details: event.result.details,
				isError: event.isError,
			});
		});

		pi.on("agent_end", (event) => {
			for (let index = event.messages.length - 1; index >= 0; index -= 1) {
				const message = event.messages[index];
				if (message?.role !== "assistant") continue;
				recorder?.finishAssistant(message);
				break;
			}
		});

		pi.on("agent_settled", () => {
			recorder?.settle();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			sessionGeneration += 1;
			const activeRecorder = recorder;
			const shutdownConfig = activeConfig;
			recorder = undefined;
			activeConfig = undefined;
			if (!activeRecorder) return;
			try {
				if (event.reason === "quit") await activeRecorder.shutdown();
				else {
					activeRecorder.settle();
					await activeRecorder.flush();
				}
			} catch (error) {
				ctx.ui.notify(
					`Langfuse shutdown export failed: ${formatError(error, shutdownConfig)}`,
					"error",
				);
			}
		});
	};
}

async function promptForConfig(
	ctx: ExtensionCommandContext,
	current: LangfuseConfig | undefined,
): Promise<LangfuseConfig | undefined> {
	const secretKey = await ctx.ui.input("Langfuse secret key (leave blank to keep existing):");
	if (secretKey === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}
	const publicKey = await ctx.ui.input("Langfuse public key (leave blank to keep existing):");
	if (publicKey === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}
	const baseUrl = await ctx.ui.input(
		`Langfuse base URL (leave blank for default ${DEFAULT_BASE_URL}):`,
		DEFAULT_BASE_URL,
	);
	if (baseUrl === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}

	const normalized = normalizeLangfuseConfig({
		...current,
		publicKey: publicKey.trim() || current?.publicKey || "",
		secretKey: secretKey.trim() || current?.secretKey || "",
		baseUrl: baseUrl.trim() || DEFAULT_BASE_URL,
		captureContent: current?.captureContent ?? true,
	});
	if (!normalized.ok) {
		ctx.ui.notify(`Invalid Langfuse config: ${normalized.reason}`, "error");
		return undefined;
	}
	return normalized.config;
}

function formatMenuTitle(
	activeConfig: LangfuseConfig | undefined,
	configPath: string | undefined,
	initializationError: string | undefined,
	configurationNotice: string | undefined,
): string {
	const lines = [
		"Langfuse",
		"",
		"Current session:",
		`  Tracing: ${activeConfig ? "enabled" : "disabled"}`,
	];
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
		'Use "captureContent": false in the private config to export metadata only.',
	].join("\n");
}

function formatConfigError(result: Extract<LangfuseConfigResult, { ok: false }>): string {
	const setupHint = result.reason.startsWith("Configuration file not found:")
		? " Run /langfuse and choose Set up Langfuse."
		: "";
	return `Langfuse tracing is disabled: ${result.reason}${setupHint}`;
}

function formatError(error: unknown, config?: LangfuseConfig): string {
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
