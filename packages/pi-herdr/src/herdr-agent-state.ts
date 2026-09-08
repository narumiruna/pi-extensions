import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBestEffortSender, type HerdrRequest } from "./herdr-client.js";
import {
	createHerdrMetadataClearSnapshot,
	createHerdrMetadataRequest,
	createHerdrMetadataSnapshot,
	HERDR_METADATA_REFRESH_MS,
	type HerdrMetadataSnapshot,
	herdrMetadataSnapshotsEqual,
} from "./herdr-metadata.js";
import { createHerdrWidgetObserver, type HerdrWidgetObserver } from "./herdr-observer.js";

import {
	createHerdrSettingsController,
	type HerdrSettingsOptions,
} from "./herdr-settings-controller.js";

const SOURCE = "herdr:pi";

export type AgentState = "working" | "blocked" | "idle";

interface HerdrEnvironment {
	enabled: boolean;
	paneId: string;
	socketEndpoint: string;
}

interface QueuedState {
	state: AgentState;
	message?: string;
	seq: number;
	signal: AbortSignal;
}

interface QueuedMetadata {
	snapshot: HerdrMetadataSnapshot;
	seq: number;
	signal: AbortSignal;
	generation: number;
}

export interface HerdrAgentStateOptions extends HerdrSettingsOptions {
	environment?: HerdrEnvironment;
	now?: () => number;
	random?: () => number;
	sendRequest?: (request: HerdrRequest, signal: AbortSignal) => Promise<void>;
	widgetObserver?: HerdrWidgetObserver;
}

let reportSeq = Date.now() * 1000;

function nextReportSeq(): number {
	reportSeq += 1;
	return reportSeq;
}

export function resolveSocketEndpoint(
	socketPath: string | undefined,
	platform: NodeJS.Platform = process.platform,
): string {
	if (!socketPath || platform !== "win32") return socketPath ?? "";
	const normalized = socketPath.toLowerCase();
	if (normalized.startsWith("\\\\.\\pipe\\") || normalized.startsWith("\\\\?\\pipe\\")) {
		return socketPath;
	}
	return `\\\\.\\pipe\\${socketPath}`;
}

function readEnvironment(environment: NodeJS.ProcessEnv = process.env): HerdrEnvironment {
	const socketPath = environment.HERDR_SOCKET_PATH;
	const paneId = environment.HERDR_PANE_ID;
	return {
		enabled: environment.HERDR_ENV === "1" && !!socketPath && !!paneId,
		paneId: paneId ?? "",
		socketEndpoint: resolveSocketEndpoint(socketPath),
	};
}

export function createHerdrAgentStateExtension(
	options: HerdrAgentStateOptions = {},
): (pi: ExtensionAPI) => void {
	const environment = options.environment ?? readEnvironment();
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	const sendRequest = options.sendRequest ?? createBestEffortSender(environment.socketEndpoint);
	const widgetObserver =
		options.widgetObserver ??
		createHerdrWidgetObserver({
			environment,
			now,
			random,
		});

	return function herdrAgentState(pi: ExtensionAPI): void {
		if (!environment.enabled) return;
		const widget = createHerdrSettingsController(pi, widgetObserver, options);

		let sessionGeneration = 0;
		let sessionController = new AbortController();
		let activeSession: ExtensionContext["sessionManager"] | undefined;
		let currentAgentSessionId: string | undefined;
		let currentAgentSessionPath: string | undefined;
		let agentActive = false;
		let blockedCount = 0;
		let blockedMessage: string | undefined;
		let lastState: AgentState | undefined;
		let lastMessage: string | undefined;
		let rootSession = false;
		let queuedState: QueuedState | undefined;
		let drainTask: Promise<void> | undefined;
		let queuedMetadata: QueuedMetadata | undefined;
		let metadataDrainTask: Promise<void> | undefined;
		let lastMetadataSnapshot: HerdrMetadataSnapshot | undefined;
		let metadataRefreshTimer: ReturnType<typeof setTimeout> | undefined;
		let shutdownClearController: AbortController | undefined;
		let shutdownSession: ExtensionContext["sessionManager"] | undefined;
		let shutdownTask: Promise<void> | undefined;

		function requestId(kind?: "session"): string {
			const segment = kind ? `${kind}:` : "";
			return `${SOURCE}:${segment}${now()}:${random().toString(36).slice(2)}`;
		}

		function updateSessionRef(ctx: ExtensionContext): void {
			try {
				const file = ctx.sessionManager.getSessionFile();
				currentAgentSessionPath =
					typeof file === "string" && path.isAbsolute(file) ? file : undefined;
			} catch {
				currentAgentSessionPath = undefined;
			}

			try {
				const id = ctx.sessionManager.getSessionId();
				currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
			} catch {
				currentAgentSessionId = undefined;
			}
		}

		function currentSessionRef(): Record<string, unknown> | undefined {
			if (currentAgentSessionPath) return { agent_session_path: currentAgentSessionPath };
			if (currentAgentSessionId) return { agent_session_id: currentAgentSessionId };
			return undefined;
		}

		function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
			return { ...params, ...currentSessionRef() };
		}

		async function safeSend(request: HerdrRequest, signal: AbortSignal): Promise<void> {
			try {
				await sendRequest(request, signal);
			} catch {
				// Herdr reporting is best-effort and must not interrupt Pi.
			}
		}

		function reportSession(sessionStartSource?: string): Promise<void> {
			const sessionRef = currentSessionRef();
			if (!sessionRef) return Promise.resolve();
			return safeSend(
				{
					id: requestId("session"),
					method: "pane.report_agent_session",
					params: {
						pane_id: environment.paneId,
						source: SOURCE,
						agent: "pi",
						seq: nextReportSeq(),
						session_start_source: sessionStartSource,
						...sessionRef,
					},
				},
				sessionController.signal,
			);
		}

		function stateRequest(state: QueuedState): HerdrRequest {
			return {
				id: requestId(),
				method: "pane.report_agent",
				params: withSessionRef({
					pane_id: environment.paneId,
					source: SOURCE,
					agent: "pi",
					state: state.state,
					message: state.message,
					seq: state.seq,
				}),
			};
		}

		function readMetadataSnapshot(ctx: ExtensionContext): HerdrMetadataSnapshot {
			let session: string | undefined;
			let contextUsagePercent: number | null | undefined;
			try {
				session = pi.getSessionName();
			} catch {
				// Metadata is best-effort and optional Pi fields can be unavailable.
			}
			try {
				contextUsagePercent = ctx.getContextUsage()?.percent;
			} catch {
				// Clear unknown usage instead of retaining a stale percentage.
			}
			return createHerdrMetadataSnapshot({
				model: ctx.model?.id,
				provider: ctx.model?.provider,
				thinking: ctx.thinkingLevel,
				session,
				contextUsagePercent,
			});
		}

		function metadataRequest(metadata: QueuedMetadata): HerdrRequest {
			return createHerdrMetadataRequest({
				id: requestId(),
				paneId: environment.paneId,
				source: SOURCE,
				seq: metadata.seq,
				snapshot: metadata.snapshot,
			});
		}

		async function drainStateQueue(): Promise<void> {
			while (queuedState) {
				const next = queuedState;
				queuedState = undefined;
				if (!next.signal.aborted) await safeSend(stateRequest(next), next.signal);
			}
		}

		function queueState(state: AgentState, message?: string): void {
			queuedState = {
				state,
				message,
				seq: nextReportSeq(),
				signal: sessionController.signal,
			};
			if (drainTask) return;
			drainTask = drainStateQueue().finally(() => {
				drainTask = undefined;
				if (queuedState) queueState(queuedState.state, queuedState.message);
			});
		}

		async function drainMetadataQueue(): Promise<void> {
			while (queuedMetadata) {
				const next = queuedMetadata;
				queuedMetadata = undefined;
				if (next.signal.aborted || next.generation !== sessionGeneration || !rootSession) {
					continue;
				}
				await safeSend(metadataRequest(next), next.signal);
			}
		}

		function startMetadataDrain(): void {
			if (metadataDrainTask) return;
			metadataDrainTask = drainMetadataQueue().finally(() => {
				metadataDrainTask = undefined;
				if (queuedMetadata) startMetadataDrain();
			});
		}

		function scheduleMetadataRefresh(generation: number): void {
			if (metadataRefreshTimer) clearTimeout(metadataRefreshTimer);
			metadataRefreshTimer = setTimeout(() => {
				metadataRefreshTimer = undefined;
				if (
					generation !== sessionGeneration ||
					sessionController.signal.aborted ||
					!rootSession ||
					!lastMetadataSnapshot
				) {
					return;
				}
				queueMetadata(lastMetadataSnapshot, true);
			}, HERDR_METADATA_REFRESH_MS);
			metadataRefreshTimer.unref?.();
		}

		function queueMetadata(snapshot: HerdrMetadataSnapshot, force = false): void {
			if (!rootSession || sessionController.signal.aborted) return;
			if (!force && herdrMetadataSnapshotsEqual(lastMetadataSnapshot, snapshot)) return;
			lastMetadataSnapshot = snapshot;
			queuedMetadata = {
				snapshot,
				seq: nextReportSeq(),
				signal: sessionController.signal,
				generation: sessionGeneration,
			};
			scheduleMetadataRefresh(sessionGeneration);
			startMetadataDrain();
		}

		function owns(ctx: ExtensionContext): boolean {
			return rootSession && ctx.sessionManager === activeSession;
		}

		function publishMetadata(ctx: ExtensionContext): void {
			if (!owns(ctx)) return;
			queueMetadata(readMetadataSnapshot(ctx));
		}

		function desiredState(): { state: AgentState; message?: string } {
			if (blockedCount > 0) return { state: "blocked", message: blockedMessage };
			if (agentActive) return { state: "working" };
			return { state: "idle" };
		}

		function publishState(force = false): void {
			const next = desiredState();
			if (!force && next.state === lastState && next.message === lastMessage) return;
			lastState = next.state;
			lastMessage = next.message;
			queueState(next.state, next.message);
		}

		pi.on("ui_prompt_start", (event, ctx) => {
			if (!owns(ctx)) return;
			blockedCount += 1;
			blockedMessage = event.title?.trim() || event.kind;
			publishState();
		});

		pi.on("ui_prompt_end", (_event, ctx) => {
			if (!owns(ctx)) return;
			blockedCount = Math.max(0, blockedCount - 1);
			if (blockedCount === 0) blockedMessage = undefined;
			publishState();
		});

		pi.on("session_start", async (event, ctx) => {
			const generation = ++sessionGeneration;
			const replaced = new DOMException("Herdr session replaced", "AbortError");
			sessionController.abort(replaced);
			shutdownClearController?.abort(replaced);
			shutdownClearController = undefined;
			if (metadataRefreshTimer) clearTimeout(metadataRefreshTimer);
			metadataRefreshTimer = undefined;
			queuedMetadata = undefined;
			lastMetadataSnapshot = undefined;
			sessionController = new AbortController();
			activeSession = ctx.sessionManager;
			rootSession = ctx.mode === "tui";
			const widgetStart = widget.start(ctx);
			agentActive = false;
			blockedCount = 0;
			blockedMessage = undefined;
			lastState = undefined;
			lastMessage = undefined;
			if (!rootSession) {
				await widgetStart;
				return;
			}

			updateSessionRef(ctx);
			const sessionReport = reportSession(event.reason);
			publishMetadata(ctx);
			await Promise.all([sessionReport, widgetStart]);
			if (generation !== sessionGeneration || sessionController.signal.aborted || !rootSession) {
				return;
			}
			agentActive = !ctx.isIdle();
			publishState(true);
		});

		pi.on("agent_start", (_event, ctx) => {
			if (!owns(ctx)) return;
			updateSessionRef(ctx);
			void reportSession();
			agentActive = true;
			publishState();
		});

		pi.on("agent_settled", (_event, ctx) => {
			if (!owns(ctx)) return;
			publishMetadata(ctx);
			if (!ctx.isIdle()) return;
			agentActive = false;
			publishState();
		});

		pi.on("session_info_changed", (_event, ctx) => publishMetadata(ctx));
		pi.on("model_select", (_event, ctx) => publishMetadata(ctx));
		pi.on("thinking_level_select", (_event, ctx) => publishMetadata(ctx));
		pi.on("session_compact", (_event, ctx) => publishMetadata(ctx));

		pi.on("session_shutdown", async (_event, ctx) => {
			if (ctx.sessionManager !== activeSession) {
				await Promise.allSettled([widget.shutdown(ctx)]);
				return;
			}
			if (shutdownTask && shutdownSession === ctx.sessionManager) {
				await shutdownTask;
				return;
			}

			const session = ctx.sessionManager;
			const task = (async () => {
				const shouldClearMetadata = rootSession;
				const shutdownGeneration = ++sessionGeneration;
				rootSession = false;
				if (metadataRefreshTimer) clearTimeout(metadataRefreshTimer);
				metadataRefreshTimer = undefined;
				sessionController.abort(new DOMException("Herdr session shut down", "AbortError"));
				queuedState = undefined;
				queuedMetadata = undefined;
				await Promise.allSettled([drainTask, metadataDrainTask, widget.shutdown(ctx)]);
				const stillOwnsShutdown =
					shutdownGeneration === sessionGeneration && activeSession === session && !rootSession;
				if (shouldClearMetadata && stillOwnsShutdown) {
					const controller = new AbortController();
					shutdownClearController = controller;
					await safeSend(
						createHerdrMetadataRequest({
							id: requestId(),
							paneId: environment.paneId,
							source: SOURCE,
							seq: nextReportSeq(),
							snapshot: createHerdrMetadataClearSnapshot(),
						}),
						controller.signal,
					);
					if (shutdownClearController === controller) shutdownClearController = undefined;
				}
				if (shutdownGeneration !== sessionGeneration || activeSession !== session || rootSession) {
					return;
				}
				lastMetadataSnapshot = undefined;
				currentAgentSessionId = undefined;
				currentAgentSessionPath = undefined;
				activeSession = undefined;
			})();
			shutdownSession = session;
			shutdownTask = task;
			await task;
			if (shutdownTask === task) {
				shutdownTask = undefined;
				shutdownSession = undefined;
			}
		});
	};
}

export default function herdrAgentState(pi: ExtensionAPI): void {
	createHerdrAgentStateExtension()(pi);
}
