import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type LangfuseConfig, type LangfuseConfigResult, loadLangfuseConfig } from "./config.js";
import { type TraceBackend, TraceRecorder } from "./tracing.js";

interface ExtensionDependencies {
	loadConfig(): Promise<LangfuseConfigResult>;
	createBackend(config: LangfuseConfig): Promise<TraceBackend>;
}

const COMMAND_COMPLETIONS = [
	{ value: "status", label: "status", description: "Show Langfuse tracing status" },
	{ value: "flush", label: "flush", description: "Export all completed traces now" },
];

export function createLangfuseExtension(
	dependencies: Partial<ExtensionDependencies> = {},
): (pi: ExtensionAPI) => void {
	const loadConfig = dependencies.loadConfig ?? loadLangfuseConfig;
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

		pi.registerCommand("langfuse", {
			description: "Show or flush Langfuse tracing",
			getArgumentCompletions: (prefix) => {
				const normalized = prefix.trimStart().toLowerCase();
				if (/\s/.test(normalized)) return null;
				const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
				return matches.length > 0 ? matches : null;
			},
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase() || "status";
				if (action === "status") {
					if (activeConfig) {
						ctx.ui.notify(
							[
								"Langfuse tracing is enabled.",
								`Endpoint: ${activeConfig.baseUrl}`,
								`Content capture: ${activeConfig.captureContent ? "enabled" : "disabled"}`,
								`Configuration: ${configPath ?? "unknown"}`,
							].join("\n"),
							"info",
						);
						return;
					}
					ctx.ui.notify(
						initializationError ??
							"Langfuse tracing is disabled because its credentials are not configured.",
						"warning",
					);
					return;
				}
				if (action === "flush") {
					if (!recorder) {
						ctx.ui.notify("Langfuse tracing is not enabled.", "warning");
						return;
					}
					await recorder.flush();
					ctx.ui.notify("Langfuse traces flushed.", "info");
					return;
				}
				ctx.ui.notify("Usage: /langfuse [status|flush]", "warning");
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			recorder = undefined;
			activeConfig = undefined;
			configPath = undefined;
			initializationError = undefined;

			const result = await loadConfig();
			configPath = result.path;
			for (const warning of result.warnings) ctx.ui.notify(warning, "warning");
			if (!result.ok) {
				initializationError = formatConfigError(result);
				ctx.ui.notify(initializationError, "warning");
				return;
			}

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
				initializationError = `Langfuse tracing could not start: ${formatError(error)}`;
				ctx.ui.notify(initializationError, "warning");
			}
		});

		pi.on("before_agent_start", (event, ctx) => {
			recorder?.beginAgent({
				prompt: event.prompt,
				images: event.images,
				systemPrompt: event.systemPrompt,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			});
		});

		pi.on("context", (event, ctx) => {
			if (!recorder) return;
			if (!recorder.hasActiveTrace()) {
				recorder.beginAgent({
					prompt: "[automatic continuation]",
					systemPrompt: ctx.getSystemPrompt(),
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				});
			}
			recorder.beginGeneration({ messages: event.messages });
		});

		pi.on("after_provider_response", (event) => {
			recorder?.recordProviderResponse(event.status);
		});

		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") recorder?.finishAssistant(event.message);
		});

		pi.on("tool_execution_start", (event) => {
			recorder?.beginTool(event.toolCallId, event.toolName, event.args);
		});

		pi.on("tool_execution_end", (event) => {
			recorder?.finishTool(event.toolCallId, {
				content: event.result.content,
				details: event.result.details,
				isError: event.isError,
			});
		});

		pi.on("agent_end", async () => {
			if (!recorder) return;
			recorder.settle();
			await recorder.flush();
		});

		pi.on("session_shutdown", async (event) => {
			const activeRecorder = recorder;
			recorder = undefined;
			activeConfig = undefined;
			if (!activeRecorder) return;
			if (event.reason === "quit") await activeRecorder.shutdown();
			else {
				activeRecorder.settle();
				await activeRecorder.flush();
			}
		});
	};
}

function formatConfigError(result: Extract<LangfuseConfigResult, { ok: false }>): string {
	return `Langfuse tracing is disabled: ${result.reason}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default createLangfuseExtension();
