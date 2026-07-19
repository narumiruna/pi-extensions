import { basename } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { ConversationProjection, projectBranchMessages } from "./conversation.js";
import {
	type BrowserImageInput,
	type ProcessBrowserImageOptions,
	processBrowserImages,
} from "./images.js";
import { type EffectivePiImageSettings, readEffectivePiImageSettings } from "./pi-settings.js";
import {
	type WebSendRequest,
	type WebSendResult,
	WebUIServer,
	type WebUIServerOptions,
} from "./server.js";
import {
	DEFAULT_SETTINGS,
	initializeSettings,
	loadSettings,
	type SettingsLoadResult,
	saveSettings,
	type WebUISettings,
} from "./settings.js";

const WIDGET_KEY = "webui";
const COMMAND_USAGE = "Usage: /webui [settings|status|help|init]";
const COMMAND_COMPLETIONS = [
	{ value: "settings", label: "settings", description: "Open WebUI settings" },
	{ value: "status", label: "status", description: "Show effective WebUI settings and state" },
	{ value: "help", label: "help", description: "Show WebUI command help" },
	{ value: "init", label: "init", description: "Create the default WebUI settings file" },
];

type ServerControl = Pick<WebUIServer, "issueLink" | "close">;
type LatestEventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type LatestExtensionAPI = ExtensionAPI & {
	on(event: "agent_settled", handler: LatestEventHandler): void;
};

export interface RuntimeDependencies {
	loadSettings: typeof loadSettings;
	saveSettings: typeof saveSettings;
	initializeSettings: typeof initializeSettings;
	startServer(options: WebUIServerOptions): Promise<ServerControl>;
	readPiSettings(cwd: string, projectTrusted: boolean): Promise<EffectivePiImageSettings>;
	processImages(
		inputs: BrowserImageInput[],
		options?: ProcessBrowserImageOptions,
	): Promise<ImageContent[]>;
}

const DEFAULT_DEPENDENCIES: RuntimeDependencies = {
	loadSettings,
	saveSettings,
	initializeSettings,
	startServer: (options) => WebUIServer.start(options),
	readPiSettings: readEffectivePiImageSettings,
	processImages: processBrowserImages,
};

export class WebUIRuntime {
	private readonly dependencies: RuntimeDependencies;
	private context?: ExtensionContext;
	private conversation?: ConversationProjection;
	private server?: ServerControl;
	private serverStarting?: Promise<ServerControl>;
	private sessionAbort = new AbortController();
	private generation = 0;
	private closed = true;
	private lastSettingsWarning = "";
	private nextLiveMessageId = 0;
	private readonly activeMessageIds = new Map<string, string>();
	private readonly finalMessageTimers = new Set<ReturnType<typeof setTimeout>>();
	private settings: WebUISettings = { ...DEFAULT_SETTINGS };
	private settingsDocument?: Record<string, unknown> = {};
	private settingsPath = "pi-webui.json";
	private settingsSource: SettingsLoadResult["source"] = "defaults";
	private settingsSaveQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: Partial<RuntimeDependencies> = {},
	) {
		this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	}

	register(): void {
		this.pi.registerCommand("webui", {
			description: "Open or configure the local web companion for this Pi session",
			getArgumentCompletions: (prefix) => {
				const normalized = prefix.trimStart().toLowerCase();
				if (/\s/.test(normalized)) return null;
				const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
				return matches.length > 0 ? matches : null;
			},
			handler: async (args, ctx) => {
				this.context = ctx;
				const action = args.trim().toLowerCase();
				try {
					if (!action) {
						await this.presentLink(ctx);
						return;
					}
					if (action === "settings") {
						await this.showSettings(ctx);
						return;
					}
					if (action === "status") {
						this.showStatus(ctx);
						return;
					}
					if (action === "help") {
						this.showHelp(ctx);
						return;
					}
					if (action === "init") {
						await this.initializeSettings(ctx);
						return;
					}
					if (ctx.hasUI) ctx.ui.notify(COMMAND_USAGE, "warning");
				} catch (error) {
					if (!action) {
						ctx.ui.notify(`Pi WebUI could not start: ${formatError(error)}`, "error");
					} else if (ctx.hasUI) {
						ctx.ui.notify(`Pi WebUI command failed: ${formatError(error)}`, "error");
					}
				}
			},
		});

		this.pi.on("session_start", async (_event, ctx) => this.start(ctx));
		this.pi.on("session_shutdown", async (_event, ctx) => this.shutdown(ctx));
		this.pi.on("session_tree", async (_event, ctx) => {
			this.captureContext(ctx);
			this.cancelPendingMessages();
			this.conversation?.replaceBranch(projectBranchMessages(ctx.sessionManager.getBranch()));
		});
		this.pi.on("session_info_changed", async (event, ctx) => {
			this.captureContext(ctx);
			this.conversation?.updateSession({ name: event.name });
		});
		this.pi.on("message_start", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordMessage("start", event);
		});
		this.pi.on("message_update", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordMessage("update", event);
		});
		this.pi.on("message_end", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordMessage("end", event);
		});
		this.pi.on("tool_execution_start", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordTool("start", event);
		});
		this.pi.on("tool_execution_update", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordTool("update", event);
		});
		this.pi.on("tool_execution_end", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordTool("end", event);
		});
		this.pi.on("agent_start", async (_event, ctx) => {
			this.captureContext(ctx);
			this.conversation?.setActivity("running");
		});
		(this.pi as LatestExtensionAPI).on("agent_settled", async (_event, ctx) => {
			this.captureContext(ctx);
			if (ctx.isIdle() && !ctx.hasPendingMessages()) this.conversation?.setActivity("idle");
		});
	}

	async start(ctx: ExtensionContext): Promise<void> {
		const generation = ++this.generation;
		const previousConversation = this.conversation;
		this.closed = true;
		this.sessionAbort.abort();
		this.cancelPendingMessages();
		previousConversation?.close();
		await this.releaseServer();
		if (generation !== this.generation) return;
		const settingsResult = await this.dependencies.loadSettings();
		if (generation !== this.generation) return;
		this.applySettingsResult(settingsResult);
		this.sessionAbort = new AbortController();
		this.context = ctx;
		this.conversation = new ConversationProjection(
			{
				id: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				projectName: basename(ctx.cwd) || ctx.cwd,
				...(ctx.sessionManager.getSessionName()
					? { name: ctx.sessionManager.getSessionName() }
					: {}),
			},
			projectBranchMessages(ctx.sessionManager.getBranch()),
		);
		this.closed = false;
		this.lastSettingsWarning = "";
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (settingsResult.warning) ctx.ui.notify(settingsResult.warning, "warning");
		if (!this.settings.startOnSessionStart) return;
		try {
			await this.presentLink(ctx);
		} catch (error) {
			if (generation !== this.generation || this.closed) return;
			ctx.ui.notify(`Pi WebUI could not start: ${formatError(error)}`, "error");
		}
	}

	async shutdown(ctx: ExtensionContext): Promise<void> {
		const generation = ++this.generation;
		this.closed = true;
		this.sessionAbort.abort();
		this.cancelPendingMessages();
		this.conversation?.close();
		await this.releaseServer();
		if (generation !== this.generation) return;
		this.context = undefined;
		this.conversation = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	private captureContext(ctx: ExtensionContext): void {
		if (!this.closed) this.context = ctx;
	}

	private recordMessage(phase: "start" | "update" | "end", event: unknown): void {
		if (!isRecord(event) || !isRecord(event.message) || typeof event.message.role !== "string") {
			return;
		}
		const key = messageLifecycleKey(event.message);
		let id = this.activeMessageIds.get(key);
		if (phase === "start" || !id) {
			id = `web-live:${++this.nextLiveMessageId}`;
			this.activeMessageIds.set(key, id);
		}
		if (phase !== "end") {
			this.recordProjectedMessage(event.message, false, id);
			return;
		}
		this.activeMessageIds.delete(key);
		const generation = this.generation;
		const timer = setTimeout(() => {
			this.finalMessageTimers.delete(timer);
			if (generation !== this.generation || this.closed) return;
			this.recordProjectedMessage(event.message, true, id);
		}, 0);
		this.finalMessageTimers.add(timer);
	}

	private recordProjectedMessage(message: unknown, final: boolean, id: string): void {
		try {
			this.conversation?.recordMessage(message, final, id);
		} catch {
			// Unknown custom message shapes do not block the supported transcript.
		}
	}

	private cancelPendingMessages(): void {
		this.activeMessageIds.clear();
		for (const timer of this.finalMessageTimers) clearTimeout(timer);
		this.finalMessageTimers.clear();
	}

	private recordTool(phase: "start" | "update" | "end", event: unknown): void {
		if (
			!isRecord(event) ||
			typeof event.toolCallId !== "string" ||
			typeof event.toolName !== "string"
		)
			return;
		const result =
			phase === "update" ? event.partialResult : phase === "end" ? event.result : undefined;
		this.conversation?.recordTool(
			phase,
			event.toolCallId,
			event.toolName,
			event.args,
			result,
			typeof event.isError === "boolean" ? event.isError : undefined,
		);
	}

	private async presentLink(ctx: ExtensionContext): Promise<void> {
		const server = await this.ensureServer();
		const link = server.issueLink();
		ctx.ui.setWidget(WIDGET_KEY, [`🌐 Pi WebUI: ${link}`]);
		ctx.ui.notify(`Pi WebUI: ${link}`, "info");
	}

	private async showSettings(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) {
				ctx.ui.notify(`Edit WebUI settings manually: ${this.settingsPath}`, "info");
			}
			return;
		}

		const items: SettingItem[] = [
			{
				id: "startOnSessionStart",
				label: "Start on session start",
				description: "Start WebUI and display a link for each newly initialized Pi session",
				currentValue: String(this.settings.startOnSessionStart),
				values: ["true", "false"],
			},
		];

		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Pi WebUI Settings")), 1, 1));
			const list = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, value) => {
					if (id !== "startOnSessionStart") return;
					const requested = value === "true";
					const operation = this.settingsSaveQueue.then(async () => {
						const previous = this.settings.startOnSessionStart;
						try {
							if (!this.settingsDocument) {
								throw new Error("the invalid settings file must be repaired manually first");
							}
							const next = { startOnSessionStart: requested };
							const document = await this.dependencies.saveSettings(
								next,
								this.settingsDocument,
								this.settingsPath,
							);
							this.settings = next;
							this.settingsDocument = document;
							this.settingsSource = "settings file";
						} catch (error) {
							list.updateValue(id, String(previous));
							ctx.ui.notify(`WebUI settings save failed: ${formatError(error)}`, "error");
							tui.requestRender();
						}
					});
					this.settingsSaveQueue = operation.catch(() => undefined);
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(list);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput(data: string) {
					list.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	private showStatus(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI) return;
		const source =
			this.settingsDocument === undefined ? "defaults (invalid file ignored)" : this.settingsSource;
		ctx.ui.notify(
			[
				"Pi WebUI status",
				`startOnSessionStart: ${this.settings.startOnSessionStart} (${source})`,
				`Settings: ${this.settingsPath}`,
				`Server: ${this.server ? "running" : "stopped"}`,
			].join("\n"),
			"info",
		);
	}

	private showHelp(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(
			[
				COMMAND_USAGE,
				"/webui: start or reuse the current session server and display a fresh one-time link",
				"settings: edit WebUI settings in TUI mode",
				"status: show effective settings, source, path, and current server state",
				"init: create the defaults file without overwriting existing content",
				'Accepted JSON: { "startOnSessionStart": false }',
				`Settings path: ${this.settingsPath}`,
				"The default is false. Changes apply on the next session initialization or reload.",
			].join("\n"),
			"info",
		);
	}

	private async initializeSettings(ctx: ExtensionCommandContext): Promise<void> {
		const result = await this.dependencies.initializeSettings(this.settingsPath);
		if (ctx.hasUI) {
			ctx.ui.notify(
				result === "created"
					? `Created WebUI settings: ${this.settingsPath}`
					: `WebUI settings already exists and was not overwritten: ${this.settingsPath}`,
				"info",
			);
		}
		const loaded = await this.dependencies.loadSettings(this.settingsPath);
		this.applySettingsResult(loaded);
		if (loaded.warning && ctx.hasUI) ctx.ui.notify(loaded.warning, "warning");
		if (ctx.mode === "tui") await this.showSettings(ctx);
	}

	private applySettingsResult(result: SettingsLoadResult): void {
		this.settings = { ...result.settings };
		this.settingsDocument = result.kind === "invalid" ? undefined : { ...(result.document ?? {}) };
		this.settingsPath = result.path;
		this.settingsSource = result.source;
	}

	private async ensureServer(): Promise<ServerControl> {
		if (this.closed || !this.conversation) throw new Error("the Pi session is not ready");
		if (this.server) return this.server;
		if (!this.serverStarting) {
			const generation = this.generation;
			const conversation = this.conversation;
			const starting = this.dependencies.startServer({
				conversation,
				send: (request) => this.sendBrowserMessage(request, generation),
			});
			this.serverStarting = starting.then(async (server) => {
				if (generation !== this.generation || this.closed || conversation !== this.conversation) {
					await server.close();
					throw new Error("the Pi session changed while the server was starting");
				}
				this.server = server;
				return server;
			});
		}
		const starting = this.serverStarting;
		try {
			return await starting;
		} finally {
			if (this.serverStarting === starting) this.serverStarting = undefined;
		}
	}

	private async sendBrowserMessage(
		request: WebSendRequest,
		generation: number,
	): Promise<WebSendResult> {
		const ctx = this.context;
		if (!ctx || this.closed || generation !== this.generation) {
			throw new Error("The Pi session has ended.");
		}

		const signal = request.signal
			? AbortSignal.any([this.sessionAbort.signal, request.signal])
			: this.sessionAbort.signal;
		if (signal.aborted) throw new Error("The browser message was cancelled.");
		await this.preflightIdlePrompt(ctx, request, generation, signal);
		let images: ImageContent[] = [];
		if (request.images.length > 0) {
			const settings = await this.dependencies.readPiSettings(ctx.cwd, ctx.isProjectTrusted());
			this.notifySettingsWarnings(ctx, settings.warnings);
			images = await this.dependencies.processImages(request.images, {
				autoResize: settings.autoResize,
				blockImages: settings.blockImages,
				supportsImages: ctx.model?.input.includes("image") ?? false,
				signal,
			});
			await this.validateCurrentModel(ctx, generation, signal, true);
		}
		if (signal.aborted) throw new Error("The browser message was cancelled.");
		if (!this.context || this.closed || generation !== this.generation) {
			throw new Error("The Pi session changed while the message was being prepared.");
		}

		const text = request.text;
		const content: string | Array<TextContent | ImageContent> =
			images.length === 0
				? text
				: [...(text.trim() ? ([{ type: "text", text }] satisfies TextContent[]) : []), ...images];
		if (request.delivery === "steer") {
			this.pi.sendUserMessage(content, { deliverAs: "steer" });
			return { delivery: "steer" };
		}
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			this.pi.sendUserMessage(content, { deliverAs: "followUp" });
			return { delivery: "followUp" };
		}
		this.pi.sendUserMessage(content, { deliverAs: "followUp" });
		return { delivery: "immediate" };
	}

	private async preflightIdlePrompt(
		ctx: ExtensionContext,
		request: WebSendRequest,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		if (request.delivery === "steer" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		await this.validateCurrentModel(ctx, generation, signal, false);
	}

	private async validateCurrentModel(
		ctx: ExtensionContext,
		generation: number,
		signal: AbortSignal,
		requireImages: boolean,
	): Promise<void> {
		const model = ctx.model;
		if (!model) throw new Error("No model is selected in Pi.");
		if (requireImages && !model.input.includes("image")) {
			throw new Error("The selected Pi model does not support images.");
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
			if (!apiKey) throw new Error(`No authentication is available for "${model.provider}".`);
		}
		if (signal.aborted) throw new Error("The browser message was cancelled.");
		if (!this.context || this.closed || generation !== this.generation) {
			throw new Error("The Pi session changed while the message was being prepared.");
		}
		if (ctx.model !== model) throw new Error("The Pi model changed; retry the browser message.");
	}

	private notifySettingsWarnings(ctx: ExtensionContext, warnings: string[]): void {
		const message = warnings.join("\n");
		if (!message || message === this.lastSettingsWarning) return;
		this.lastSettingsWarning = message;
		ctx.ui.notify(message, "warning");
	}

	private async releaseServer(): Promise<void> {
		const server = this.server;
		const starting = this.serverStarting;
		this.server = undefined;
		this.serverStarting = undefined;
		if (server) await server.close();
		if (starting) {
			try {
				await (await starting).close();
			} catch {
				// Failed and generation-stale startups have no remaining live server.
			}
		}
	}
}

function messageLifecycleKey(message: Record<string, unknown>): string {
	return `${message.role}:${typeof message.timestamp === "number" ? message.timestamp : "untimed"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
