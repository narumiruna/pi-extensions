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
	{ value: "help", label: "help", description: "Show Langfuse command help" },
	{ value: "config", label: "config", description: "Show the config path and JSON template" },
];

const CONFIG_TEMPLATE = JSON.stringify(
	{
		publicKey: "pk-lf-...",
		secretKey: "sk-lf-...",
		baseUrl: "https://cloud.langfuse.com",
		captureContent: true,
	},
	null,
	2,
);

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
					try {
						await recorder.flush();
						ctx.ui.notify("Langfuse traces flushed.", "info");
					} catch (error) {
						ctx.ui.notify(`Langfuse flush failed: ${formatError(error)}`, "error");
					}
					return;
				}
				if (action === "config") {
					ctx.ui.notify(
						`Langfuse configuration: ${configPath ?? "~/.pi/agent/pi-langfuse.json"}\n${CONFIG_TEMPLATE}`,
						"info",
					);
					return;
				}
				if (action === "help") {
					ctx.ui.notify(
						[
							"Usage: /langfuse [status|flush|help|config]",
							"status: show tracing state without credentials",
							"flush: wait for completed traces to export",
							"config: show the config path and credential-free JSON template",
						].join("\n"),
						"info",
					);
					return;
				}
				ctx.ui.notify("Usage: /langfuse [status|flush|help|config]", "warning");
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
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			});
		});

		pi.on("before_provider_request", (event, ctx) => {
			if (!recorder) return;
			if (!recorder.hasActiveTrace()) {
				recorder.beginAgent({
					prompt: "[automatic continuation]",
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				});
			}
			recorder.beginGeneration({ payload: event.payload });
		});

		pi.on("after_provider_response", (event) => {
			recorder?.recordProviderResponse(event.status);
		});

		pi.on("turn_end", (event) => {
			if (event.message.role === "assistant") recorder?.finishAssistant(event.message);
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
			recorder?.settle();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			const activeRecorder = recorder;
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
				ctx.ui.notify(`Langfuse shutdown export failed: ${formatError(error)}`, "error");
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
