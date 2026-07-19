import { basename } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const WIDGET_KEY = "webui";

type ServerControl = Pick<WebUIServer, "issueLink" | "close">;
type LatestEventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type LatestExtensionAPI = ExtensionAPI & {
	on(event: "agent_settled", handler: LatestEventHandler): void;
};

export interface RuntimeDependencies {
	startServer(options: WebUIServerOptions): Promise<ServerControl>;
	readPiSettings(cwd: string, projectTrusted: boolean): Promise<EffectivePiImageSettings>;
	processImages(
		inputs: BrowserImageInput[],
		options?: ProcessBrowserImageOptions,
	): Promise<ImageContent[]>;
}

const DEFAULT_DEPENDENCIES: RuntimeDependencies = {
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

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: Partial<RuntimeDependencies> = {},
	) {
		this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	}

	register(): void {
		this.pi.registerCommand("webui", {
			description: "Open a lightweight local web companion for this Pi session",
			handler: async (_args, ctx) => {
				this.context = ctx;
				try {
					const server = await this.ensureServer();
					const link = server.issueLink();
					ctx.ui.setWidget(WIDGET_KEY, [`🌐 Pi WebUI: ${link}`]);
					ctx.ui.notify(`Pi WebUI: ${link}`, "info");
				} catch (error) {
					ctx.ui.notify(`Pi WebUI could not start: ${formatError(error)}`, "error");
				}
			},
		});

		this.pi.on("session_start", async (_event, ctx) => this.start(ctx));
		this.pi.on("session_shutdown", async (_event, ctx) => this.shutdown(ctx));
		this.pi.on("session_tree", async (_event, ctx) => {
			this.captureContext(ctx);
			this.conversation?.replaceBranch(projectBranchMessages(ctx.sessionManager.getBranch()));
		});
		this.pi.on("session_info_changed", async (event, ctx) => {
			this.captureContext(ctx);
			this.conversation?.updateSession({ name: event.name });
		});
		this.pi.on("message_start", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordMessage(event, false);
		});
		this.pi.on("message_update", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordMessage(event, false);
		});
		this.pi.on("message_end", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordMessage(event, true);
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
		previousConversation?.close();
		await this.releaseServer();
		if (generation !== this.generation) return;
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
	}

	async shutdown(ctx: ExtensionContext): Promise<void> {
		++this.generation;
		this.closed = true;
		this.sessionAbort.abort();
		this.conversation?.close();
		await this.releaseServer();
		this.context = undefined;
		this.conversation = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	private captureContext(ctx: ExtensionContext): void {
		if (!this.closed) this.context = ctx;
	}

	private recordMessage(event: unknown, final: boolean): void {
		if (!isRecord(event) || !("message" in event)) return;
		try {
			this.conversation?.recordMessage(event.message, final);
		} catch {
			// Unknown custom message shapes do not block the supported transcript.
		}
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
