import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import {
	buildContextEntries,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	buildReplacementHistory,
	type CodexCheckpointDetails,
	checkpointMarker,
	createCheckpointDetails,
	fallbackSummary,
	latestCheckpoint,
	projectCheckpointContext,
} from "./checkpoint.js";
import { resolveCompactionRoute, usesResponsesCompactionApi } from "./model-api.js";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.js";
import { requestRemoteCompaction } from "./remote.js";
import {
	type CodexCompactSettings,
	type CodexCompactSettingsRuntime,
	type CodexCompactSettingsState,
	createCodexCompactSettingsRuntime,
} from "./settings.js";
import { terminalText } from "./terminal.js";

const STATUS_KEY = "codex-compact";

function activeCheckpoint(ctx: ExtensionContext) {
	return latestCheckpoint(ctx.sessionManager.getBranch());
}

function isCheckpointCompatible(
	details: CodexCheckpointDetails,
	model: Model<Api> | undefined,
): boolean {
	return (
		usesResponsesCompactionApi(model) && model.api === details.api && model.id === details.modelId
	);
}

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
	const leafId = event.branchEntries.at(-1)?.id ?? null;
	const contextEntries = buildContextEntries(event.branchEntries, leafId);
	const keptIndex = contextEntries.findIndex(
		(entry) => entry.id === event.preparation.firstKeptEntryId,
	);
	if (keptIndex < 0) {
		throw new Error("Pi compaction cut point is not present in the active context");
	}
	return contextEntries.slice(keptIndex).flatMap(sessionEntryToContextMessages);
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().flatMap((name) => {
		const tool = available.get(name);
		return tool
			? [
					{
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					},
				]
			: [];
	});
}

function projectedCurrentMessages(
	event: SessionBeforeCompactEvent,
	model: Model<Api>,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
	const leafId = event.branchEntries.at(-1)?.id ?? null;
	const session = buildSessionContext(event.branchEntries, leafId);
	const prior = latestCheckpoint(event.branchEntries);
	if (!prior) return { messages: session.messages };
	if (prior.details.api !== model.api || prior.details.modelId !== model.id) {
		throw new Error("The active opaque checkpoint belongs to a different Responses model");
	}
	const projected = projectCheckpointContext(session.messages, prior.details, prior.entry.summary);
	if (!projected) {
		throw new Error("The previous opaque checkpoint could not be projected safely");
	}
	return { messages: projected, prior: prior.details };
}

function notifyFailure(
	ctx: ExtensionContext,
	error: unknown,
	settings: CodexCompactSettings,
): void {
	if (!ctx.hasUI || !settings.notifyOnFallback) return;
	const message = terminalText(error instanceof Error ? error.message : String(error));
	ctx.ui.notify(`Responses compaction failed; using Pi compaction. ${message}`, "warning");
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
	return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

async function compactRemotely(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	settings: CodexCompactSettings,
	ownerSignal: AbortSignal,
	fetch?: typeof globalThis.fetch,
) {
	const model = ctx.model;
	const route = resolveCompactionRoute(model, settings);
	if (route.kind === "native" || !usesResponsesCompactionApi(model)) return undefined;
	const signal = AbortSignal.any([event.signal, ownerSignal]);
	if (signal.aborted) return { cancel: true };
	const sessionId = ctx.sessionManager.getSessionId();
	ctx.ui.setStatus(
		STATUS_KEY,
		route.protocol === "remote-v2" ? "Responses Remote V2…" : "Responses Compact API…",
	);
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!sessionStillOwned(ctx, sessionId, signal)) return { cancel: true };
		if (!auth.ok) throw new Error(auth.error);
		const provider = ctx.modelRegistry.getProvider(model.provider);
		if (!provider) throw new Error("The active Responses provider is unavailable");
		const current = projectedCurrentMessages(event, model);
		const context: Context = {
			systemPrompt: ctx.getSystemPrompt(),
			messages: convertToLlm(current.messages),
			tools: activeTools(pi),
		};
		const response = await requestRemoteCompaction({
			provider,
			model,
			context,
			protocol: route.protocol,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal,
			priorCheckpoint: current.prior
				? {
						marker: checkpointMarker(current.prior.checkpointId),
						replacementHistory: current.prior.replacementHistory,
					}
				: undefined,
			requestTimeoutMs: settings.requestTimeoutMs,
			maxRetries: settings.maxRetries,
			fetch,
		});
		if (!sessionStillOwned(ctx, sessionId, signal)) return { cancel: true };
		const replacementHistory = buildReplacementHistory(
			response.compactedOutput?.slice(0, -1) ?? response.promptInput,
			response.item,
			{ tokenBudget: settings.replacementTokenBudget },
		);
		const details = createCheckpointDetails({
			provider: model.provider,
			api: route.api,
			modelId: model.id,
			protocol: route.protocol,
			replacementHistory,
			keptMessages: keptMessages(event),
		});
		return {
			compaction: {
				summary: fallbackSummary(details.checkpointId),
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage: response.usage,
				details,
			},
		};
	} catch (error) {
		if (signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) {
			return { cancel: true };
		}
		notifyFailure(ctx, error, settings);
		return undefined;
	} finally {
		if (ctx.sessionManager.getSessionId() === sessionId) ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

export function createCodexCompactExtension(
	options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CodexCompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
	return (pi) => {
		const providerWarnings = new Set<string>();
		const settingsRuntime = options.settingsRuntime ?? createCodexCompactSettingsRuntime();
		let sessionController = new AbortController();
		let generation = 0;

		pi.registerCommand("codex-compact", {
			description: "Compact now or configure Responses compaction",
			handler: async (args, ctx) => {
				if (args.trim()) throw new Error("Usage: /codex-compact");
				const ownerGeneration = generation;
				const controller = sessionController;
				const { showCodexCompactMenu } = await import("./settings-menu.js");
				if (ownerGeneration !== generation || controller.signal.aborted) return;
				await showCodexCompactMenu(settingsRuntime, ctx, {
					signal: controller.signal,
					isCurrent: () => ownerGeneration === generation && !controller.signal.aborted,
				});
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			sessionController.abort();
			sessionController = new AbortController();
			generation += 1;
			const ownerGeneration = generation;
			const sessionId = ctx.sessionManager.getSessionId();
			providerWarnings.clear();
			let state: Readonly<CodexCompactSettingsState>;
			try {
				state = await settingsRuntime.reload(sessionController.signal);
			} catch (error) {
				if (sessionController.signal.aborted || ownerGeneration !== generation) return;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Could not load pi-codex-compact.json; using defaults. ${terminalText(error instanceof Error ? error.message : String(error))}`,
						"warning",
					);
				}
				return;
			}
			if (
				sessionController.signal.aborted ||
				ownerGeneration !== generation ||
				ctx.sessionManager.getSessionId() !== sessionId
			) {
				return;
			}
			if (ctx.hasUI && state.kind === "invalid") {
				ctx.ui.notify(
					`Invalid pi-codex-compact.json; using defaults without overwriting it. ${terminalText(state.issue ?? "unknown validation error")}`,
					"warning",
				);
			}
		});

		pi.on("session_before_compact", (event, ctx) =>
			compactRemotely(
				pi,
				event,
				ctx,
				settingsRuntime.get().settings,
				sessionController.signal,
				options.fetch,
			),
		);

		pi.on("context", (event, ctx) => {
			if (!settingsRuntime.get().settings.enabled) return undefined;
			const checkpoint = activeCheckpoint(ctx);
			if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
			const messages = projectCheckpointContext(
				event.messages,
				checkpoint.details,
				checkpoint.entry.summary,
			);
			return messages ? { messages } : undefined;
		});

		pi.on("before_provider_request", (event, ctx) => {
			if (!settingsRuntime.get().settings.enabled) return undefined;
			const checkpoint = activeCheckpoint(ctx);
			if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
			const marker = checkpointMarker(checkpoint.details.checkpointId);
			if (!hasCheckpointMarker(event.payload, marker)) return undefined;
			return rewriteCheckpointMarker(event.payload, marker, checkpoint.details.replacementHistory);
		});

		pi.on("model_select", (event, ctx) => {
			if (!settingsRuntime.get().settings.enabled) return;
			const checkpoint = activeCheckpoint(ctx);
			if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model)) return;
			const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
			if (providerWarnings.has(key)) return;
			providerWarnings.add(key);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"The active Responses checkpoint cannot replay on this model; Pi will expose only its fallback marker and retained recent messages.",
					"warning",
				);
			}
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			generation += 1;
			sessionController.abort();
			providerWarnings.clear();
			ctx.ui.setStatus(STATUS_KEY, undefined);
			await settingsRuntime.flush();
		});
	};
}

export default createCodexCompactExtension();
