import { basename } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { BatchError, BatchStore, digestImages, type ProcessedImage } from "./batch.js";
import { ImageProcessor } from "./images.js";
import { readEffectivePiImageSettings } from "./pi-settings.js";
import { ImageDropServer, type ImageDropServerOptions } from "./server.js";
import { type ImageDropSettings, loadSettings } from "./settings.js";

const WIDGET_KEY = "image-drop";

type LatestEventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type LatestExtensionAPI = ExtensionAPI & {
	on(event: "agent_settled", handler: LatestEventHandler): void;
};

type ServerControl = Pick<ImageDropServer, "issueLink" | "broadcastState" | "close">;
type ProcessorControl = Pick<ImageProcessor, "process">;

export interface RuntimeDependencies {
	loadSettings: typeof loadSettings;
	readPiSettings: typeof readEffectivePiImageSettings;
	startServer(options: ImageDropServerOptions): Promise<ServerControl>;
	createProcessor(): ProcessorControl;
}

const DEFAULT_DEPENDENCIES: RuntimeDependencies = {
	loadSettings,
	readPiSettings: readEffectivePiImageSettings,
	startServer: (options) => ImageDropServer.start(options),
	createProcessor: () => new ImageProcessor(2),
};

export class ImageDropRuntime {
	private readonly dependencies: RuntimeDependencies;
	private batch?: BatchStore;
	private settings?: ImageDropSettings;
	private context?: ExtensionContext;
	private server?: ServerControl;
	private serverStarting?: Promise<ServerControl>;
	private processor?: ProcessorControl;
	private sessionAbort = new AbortController();
	private generation = 0;
	private closed = true;
	private lastPiSettingsWarning = "";

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: Partial<RuntimeDependencies> = {},
	) {
		this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	}

	register(): void {
		this.pi.registerCommand("image-drop", {
			description: "Show a local browser link for staging images",
			handler: async (_args, ctx) => {
				this.context = ctx;
				await this.recoverOrphanedReservation(ctx);
				try {
					const server = await this.ensureServer(ctx);
					const link = server.issueLink();
					if (this.batch?.publicState().phase === "empty") {
						ctx.ui.setWidget(WIDGET_KEY, [`🖼️ Image Drop: ${link}`]);
					} else {
						this.updateWidget(ctx);
					}
					ctx.ui.notify(`Image Drop: ${link}`, "info");
				} catch (error) {
					ctx.ui.notify(`Image Drop could not start: ${formatError(error)}`, "error");
				}
			},
		});

		this.pi.on("session_start", async (_event, ctx) => this.start(ctx));
		this.pi.on("session_shutdown", async (_event, ctx) => this.shutdown(ctx));
		this.pi.on("input", async (event, ctx) => this.handleInput(event, ctx));
		this.pi.on("before_agent_start", async () => this.batch?.markPreflightStarted());
		this.pi.on("message_start", async (event, ctx) => this.handleMessageStart(event, ctx));
		(this.pi as LatestExtensionAPI).on("agent_settled", async (_event, ctx) => {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			await this.recoverReservation(ctx, "Queued image message was not delivered; restored it.");
		});
	}

	async start(ctx: ExtensionContext): Promise<void> {
		const generation = ++this.generation;
		const previousBatch = this.batch;
		this.closed = true;
		this.sessionAbort.abort();
		await this.releaseServer();
		previousBatch?.close();
		if (generation !== this.generation) return;
		const result = await this.dependencies.loadSettings();
		if (generation !== this.generation) return;
		this.settings = result.settings;
		this.batch = new BatchStore(result.settings);
		this.processor = this.dependencies.createProcessor();
		this.sessionAbort = new AbortController();
		this.context = ctx;
		this.closed = false;
		this.lastPiSettingsWarning = "";
		const warning = "warning" in result ? result.warning : undefined;
		if (result.kind === "invalid" || warning) {
			ctx.ui.notify(warning ?? "Image Drop settings ignored.", "warning");
		}
		this.updateWidget(ctx);
	}

	async shutdown(ctx: ExtensionContext): Promise<void> {
		const generation = ++this.generation;
		const previousBatch = this.batch;
		this.closed = true;
		this.sessionAbort.abort();
		await this.releaseServer();
		previousBatch?.close();
		if (generation !== this.generation) return;
		this.batch = undefined;
		this.settings = undefined;
		this.processor = undefined;
		this.context = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	getBatchForTesting(): BatchStore | undefined {
		return this.batch;
	}

	async handleInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
		this.context = ctx;
		if (this.closed || event.source !== "interactive" || !event.text.trim() || !this.batch) {
			return { action: "continue" };
		}
		if (this.batch.currentReservation()) {
			await this.recoverOrphanedReservation(ctx);
			if (this.batch.currentReservation()) return { action: "continue" };
			// The current input arrived at the recovery boundary. Preserve it alongside the
			// restored text and require an explicit resubmission rather than consuming it.
			this.restoreEditor(ctx, event.text);
			return { action: "handled" };
		}
		const state = this.batch.publicState();
		if (state.phase === "empty") return { action: "continue" };
		if (state.phase !== "ready") {
			this.restoreEditor(ctx, event.text);
			ctx.ui.notify(this.blockedReason(state.phase), "warning");
			return { action: "handled" };
		}
		if (!supportsImages(ctx)) {
			this.restoreEditor(ctx, event.text);
			ctx.ui.notify("The current model does not support image input.", "warning");
			return { action: "handled" };
		}
		const generation = this.generation;
		const batch = this.batch;
		const piSettings = await this.dependencies.readPiSettings(ctx.cwd, ctx.isProjectTrusted());
		if (generation !== this.generation || batch !== this.batch || this.closed) {
			return { action: "handled" };
		}
		this.notifyPiSettingsWarnings(ctx, piSettings.warnings);
		if (piSettings.blockImages) {
			this.restoreEditor(ctx, event.text);
			ctx.ui.notify("Pi image sending is disabled. Enable images in /settings first.", "warning");
			return { action: "handled" };
		}
		if (!(await this.reprocessForAutoResize(piSettings.autoResize, ctx, event.text))) {
			return { action: "handled" };
		}

		try {
			const reservation = batch.reserveMessage(event.text, event.streamingBehavior);
			this.server?.broadcastState();
			this.updateWidget(ctx);
			return {
				action: "transform",
				text: event.text,
				images: [...(event.images ?? []), ...reservation.images],
			};
		} catch (error) {
			this.restoreEditor(ctx, event.text);
			ctx.ui.notify(formatError(error), "warning");
			return { action: "handled" };
		}
	}

	addReadyImageForTesting(
		id: string,
		name: string,
		source: Buffer,
		processed: ProcessedImage,
	): void {
		if (!this.batch) throw new Error("Runtime has not started");
		this.batch.reserveItems([{ id, name, size: source.byteLength }]);
		this.batch.startProcessing(id, source);
		this.batch.complete(id, processed, true);
		this.server?.broadcastState();
		if (this.context) this.updateWidget(this.context);
	}

	private async reprocessForAutoResize(
		autoResize: boolean,
		ctx: ExtensionContext,
		text: string,
	): Promise<boolean> {
		const batch = this.batch;
		const processor = this.processor;
		const settings = this.settings;
		if (!batch || !processor || !settings) return false;
		let jobs: Array<{ id: string; source: Buffer }>;
		try {
			jobs = batch.beginAutoResizeReprocessing(autoResize);
		} catch (error) {
			this.restoreEditor(ctx, text);
			ctx.ui.notify(formatError(error), "warning");
			return false;
		}
		if (jobs.length === 0) return true;
		const generation = this.generation;
		const signal = this.sessionAbort.signal;
		this.server?.broadcastState();
		this.updateWidget(ctx);
		await Promise.all(
			jobs.map(async ({ id, source }) => {
				try {
					const processed = await processor.process(source, {
						autoResize,
						maxImagePixels: settings.maxImagePixels,
						signal,
					});
					if (generation === this.generation) batch.complete(id, processed, autoResize);
				} catch (error) {
					if (generation !== this.generation || signal.aborted) return;
					try {
						batch.fail(id, formatError(error));
					} catch (failure) {
						if (!(failure instanceof BatchError) || failure.code !== "not-found") throw failure;
					}
				} finally {
					if (generation === this.generation) this.server?.broadcastState();
				}
			}),
		);
		if (generation !== this.generation) return false;
		if (batch.publicState().phase !== "ready") {
			this.restoreEditor(ctx, text);
			ctx.ui.notify(
				"Images could not be updated for the current auto-resize setting.",
				"warning",
			);
			this.updateWidget(ctx);
			return false;
		}
		this.updateWidget(ctx);
		return true;
	}

	private async ensureServer(ctx: ExtensionContext): Promise<ServerControl> {
		if (this.closed || !this.batch || !this.settings || !this.processor) {
			throw new Error("the Pi session is not ready");
		}
		if (this.server) return this.server;
		if (!this.serverStarting) {
			const generation = this.generation;
			const processor = this.processor;
			const starting = this.dependencies.startServer({
				batch: this.batch,
				settings: this.settings,
				projectName: basename(ctx.cwd) || ctx.cwd,
				sessionName: ctx.sessionManager.getSessionName(),
				cwd: ctx.cwd,
				process: (source, options) => processor.process(source, options),
				getAutoResize: () => this.processingSettings(),
				onStateChange: () => {
					if (generation === this.generation && this.context) this.updateWidget(this.context);
				},
			});
			this.serverStarting = starting.then(async (server) => {
				if (generation !== this.generation || this.closed) {
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

	private async processingSettings(): Promise<boolean> {
		const ctx = this.context;
		if (!ctx || this.closed) throw new Error("The Pi session has ended.");
		if (!supportsImages(ctx)) throw new Error("The current model does not support image input.");
		const settings = await this.dependencies.readPiSettings(ctx.cwd, ctx.isProjectTrusted());
		this.notifyPiSettingsWarnings(ctx, settings.warnings);
		if (settings.blockImages) {
			throw new Error("Pi image sending is disabled. Enable images in /settings first.");
		}
		return settings.autoResize;
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
				// A failed or stale startup has no live server left to release.
			}
		}
	}

	private async handleMessageStart(event: unknown, ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		const reservation = this.batch?.currentReservation();
		if (!reservation) return;
		const images = userMessageImages(event);
		if (!containsImageSequence(images, reservation.images.length, reservation.digest)) return;
		this.batch?.commitReservation(reservation.digest);
		this.server?.broadcastState();
		this.updateWidget(ctx);
	}

	private async recoverOrphanedReservation(ctx: ExtensionContext): Promise<void> {
		if (!this.batch?.currentReservation()) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		await this.recoverReservation(ctx, "Restored an image message that did not start.");
	}

	private async recoverReservation(ctx: ExtensionContext, notice: string): Promise<void> {
		const restored = this.batch?.restoreReservation();
		if (!restored) return;
		this.restoreEditor(ctx, restored.text);
		this.server?.broadcastState();
		this.updateWidget(ctx);
		ctx.ui.notify(notice, "warning");
	}

	private restoreEditor(ctx: ExtensionContext, text: string): void {
		try {
			const current = ctx.ui.getEditorText();
			const restored = !current.trim() || current === text ? text : `${current}\n\n${text}`;
			ctx.ui.setEditorText(restored);
		} catch {
			// Session replacement can invalidate a captured UI context; state cleanup still proceeds.
		}
	}

	private updateWidget(ctx: ExtensionContext): void {
		const state = this.batch?.publicState();
		if (!state || state.phase === "empty" || state.phase === "closed") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const ready = state.items.filter((item) => item.status === "ready").length;
		const uploading = state.items.filter(
			(item) => item.status === "uploading" || item.status === "processing",
		).length;
		const errors = state.items.filter((item) => item.status === "error").length;
		let text = `🖼️ ${ready}/${state.items.length} images ready`;
		if (uploading > 0) text += ` · ${uploading} uploading`;
		if (errors > 0) text += ` · ${errors} need attention`;
		if (state.phase === "reserved") text = `🖼️ ${state.items.length} images queued`;
		ctx.ui.setWidget(WIDGET_KEY, [text]);
	}

	private notifyPiSettingsWarnings(ctx: ExtensionContext, warnings: string[]): void {
		const message = warnings.join("\n");
		if (!message) {
			this.lastPiSettingsWarning = "";
			return;
		}
		if (message === this.lastPiSettingsWarning) return;
		this.lastPiSettingsWarning = message;
		ctx.ui.notify(message, "warning");
	}

	private blockedReason(phase: string): string {
		return phase === "blocked"
			? "Resolve or delete failed images before sending."
			: "Wait for every image to finish uploading before sending.";
	}
}

function supportsImages(ctx: ExtensionContext): boolean {
	return ctx.model?.input.includes("image") ?? false;
}

function userMessageImages(event: unknown): ImageContent[] {
	if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "user") return [];
	const content = event.message.content;
	if (!Array.isArray(content)) return [];
	return content.filter(isImageContent);
}

function containsImageSequence(images: ImageContent[], length: number, digest: string): boolean {
	for (let start = 0; start + length <= images.length; start += 1) {
		if (digestImages(images.slice(start, start + length)) === digest) return true;
	}
	return false;
}

function isImageContent(value: unknown): value is ImageContent {
	return (
		isRecord(value) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		typeof value.mimeType === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	if (error instanceof BatchError || error instanceof Error) return error.message;
	return String(error);
}
