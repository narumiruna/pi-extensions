import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./core.js";
import {
	type ActiveServiceTier,
	correctOpenAIServiceTierMessageCost,
	OPENAI_SERVICE_TIERS,
	openAIServiceTierStatusLabel,
	rewriteOpenAIServiceTierPayload,
	type ServiceTier,
	type ServiceTierAvailability,
	serviceTierAvailability,
	serviceTierSupport,
} from "./openai-service-tier.js";
import { isStaleExtensionContextError } from "./query.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "./settings.js";
import type { PiModel } from "./types.js";

const NO_SERVICE_TIER_REQUEST = Symbol("no-service-tier-request");
type PendingServiceTierRequest = { serviceTier: ServiceTier | undefined; model: PiModel };

export const PRIORITY_USAGE_WARNING =
	"Priority processing is about 1.5× faster and uses more of your plan allowance.";
export const FLEX_USAGE_WARNING =
	"Flex processing costs about 50% less but may be slower and can time out.";
export function registerOpenAIServiceTiers(
	pi: ExtensionAPI,
	settingsRuntime: UsageSettingsRuntime,
	refreshStatus: (ctx: ExtensionContext) => void,
	options: { registerSessionStart?: boolean } = {},
) {
	let sessionController = new AbortController();
	let generation = 0;
	const pendingServiceTierRequests = new Map<string, PendingServiceTierRequest>();

	const setTier = async (
		ctx: ExtensionCommandContext,
		nextTier: ServiceTier,
		callerSignal?: AbortSignal,
	): Promise<boolean> => {
		const ownerGeneration = generation;
		const sessionId = ctx.sessionManager.getSessionId();
		const signal = callerSignal
			? AbortSignal.any([callerSignal, sessionController.signal])
			: sessionController.signal;
		try {
			await settingsRuntime.update({ openaiServiceTier: nextTier }, signal);
		} catch (error) {
			if (isAbortError(error) || isStaleExtensionContextError(error)) return false;
			ctx.ui.notify(`Could not save pi-usage.json: ${errorMessage(error)}`, "error");
			return false;
		}
		if (
			signal.aborted ||
			ownerGeneration !== generation ||
			ctx.sessionManager.getSessionId() !== sessionId
		) {
			return false;
		}
		refreshStatus(ctx);
		ctx.ui.notify(
			nextTier === "default"
				? "OpenAI service tier disabled; standard routing will be used."
				: `${nextTier === "priority" ? "OpenAI Priority" : "OpenAI Flex"} tier enabled. ${usageWarning(nextTier)}`,
			"info",
		);
		return true;
	};

	const toggle = (
		ctx: ExtensionCommandContext,
		tier: ActiveServiceTier,
		callerSignal?: AbortSignal,
	) =>
		setTier(
			ctx,
			settingsRuntime.get().settings.openaiServiceTier === tier ? "default" : tier,
			callerSignal,
		);

	pi.registerCommand("speed", {
		description: "Choose OpenAI speed (fast, flex, none, status)",
		getArgumentCompletions: (prefix) => {
			const values = ["fast", "flex", "none", "status"];
			const normalized = prefix.trim().toLowerCase();
			return values
				.filter((value) => value.startsWith(normalized))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/speed requires TUI or RPC mode.");
			const arg = args.trim().toLowerCase();
			if (!arg) {
				if (settingsRuntime.get().kind === "invalid") {
					ctx.ui.notify(
						"pi-usage.json is invalid; repair it and run /reload before changing service tier.",
						"error",
					);
					return;
				}
				let selected: string | undefined;
				try {
					selected = await ctx.ui.select("OpenAI speed", ["Fast", "Flex", "None"], {
						signal: sessionController.signal,
					});
				} catch (error) {
					if (isAbortError(error) || isStaleExtensionContextError(error)) return;
					throw error;
				}
				if (sessionController.signal.aborted || selected === undefined) return;
				const selectedTier =
					selected === "Fast" ? "priority" : selected === "Flex" ? "flex" : "default";
				if (selectedTier === "default") {
					await setTier(ctx, selectedTier);
					return;
				}
				const availability = serviceTierAvailability(ctx.model, selectedTier);
				if (availability.kind !== "available") {
					ctx.ui.notify(serviceTierAvailabilityMessage(availability), "warning");
					return;
				}
				await setTier(ctx, selectedTier);
				return;
			}
			if (arg === "status") {
				const tier = settingsRuntime.get().settings.openaiServiceTier;
				const supported = serviceTierSupport(ctx.model);
				ctx.ui.notify(
					`OpenAI service tier: ${tier}. ${
						supported.length > 0
							? `Supported for ${ctx.model?.provider}/${ctx.model?.id}: ${supported.join(", ")}.`
							: "The current model does not support OpenAI service tiers."
					}`,
					"info",
				);
				return;
			}
			if (settingsRuntime.get().kind === "invalid") {
				ctx.ui.notify(
					"pi-usage.json is invalid; repair it and run /reload before changing service tier.",
					"error",
				);
				return;
			}
			if (arg === "none") {
				await setTier(ctx, "default");
				return;
			}
			const normalizedTier = arg === "fast" ? "priority" : arg;
			if (normalizedTier !== "priority" && normalizedTier !== "flex") {
				ctx.ui.notify("Usage: /speed [fast|flex|none|status]", "error");
				return;
			}
			const tier = normalizedTier as ActiveServiceTier;
			const availability = serviceTierAvailability(ctx.model, tier);
			if (availability.kind !== "available") {
				ctx.ui.notify(serviceTierAvailabilityMessage(availability), "warning");
				return;
			}
			await setTier(ctx, tier);
		},
	});

	const prepareSession = (ctx: ExtensionContext): Promise<void> => {
		const sessionId = ctx.sessionManager.getSessionId();
		generation += 1;
		sessionController.abort();
		pendingServiceTierRequests.clear();
		sessionController = new AbortController();
		const ownerGeneration = generation;
		return (async () => {
			let state: Readonly<UsageSettingsState>;
			try {
				state = await settingsRuntime.reload(sessionController.signal);
			} catch (error) {
				if (sessionController.signal.aborted || ownerGeneration !== generation) return;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Could not load pi-usage.json; using defaults. ${errorMessage(error)}`,
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
					`Invalid pi-usage.json; using defaults without overwriting it. ${state.issue}`,
					"warning",
				);
			}
			refreshStatus(ctx);
		})();
	};

	if (options.registerSessionStart !== false) {
		pi.on("session_start", async (_event, ctx) => prepareSession(ctx));
	}

	pi.on("before_provider_request", (event, ctx) => {
		const rewritten = rewriteOpenAIServiceTierPayload(
			event.payload,
			ctx.model,
			settingsRuntime.get().settings.openaiServiceTier,
		);
		const key = activeRequestKey(ctx);
		if (key && ctx.model) {
			pendingServiceTierRequests.set(key, {
				serviceTier:
					isRecord(rewritten) && isServiceTier(rewritten.service_tier)
						? rewritten.service_tier
						: undefined,
				model: ctx.model,
			});
		}
		return rewritten;
	});
	pi.on("message_end", (event, ctx) => {
		const request = consumeServiceTierRequest(ctx, event.message, pendingServiceTierRequests);
		if (request === NO_SERVICE_TIER_REQUEST) return undefined;
		const message = correctOpenAIServiceTierMessageCost(
			event.message,
			request.model,
			request.serviceTier ?? "default",
		);
		return message ? { message: message as never } : undefined;
	});
	pi.on("session_shutdown", async () => {
		generation += 1;
		sessionController.abort();
		pendingServiceTierRequests.clear();
		await settingsRuntime.flush();
	});

	return {
		prepareSession,
		availability(model: PiModel | undefined) {
			return serviceTierAvailability(model, settingsRuntime.get().settings.openaiServiceTier);
		},
		tier() {
			return settingsRuntime.get().settings.openaiServiceTier;
		},
		supportedTiers(model: PiModel | undefined) {
			return serviceTierSupport(model);
		},
		decorateStatus(model: PiModel | undefined, status: string) {
			return openAIServiceTierStatusLabel(
				status,
				model,
				settingsRuntime.get().settings.openaiServiceTier,
			);
		},
		toggle,
	};
}

function serviceTierAvailabilityMessage(availability: ServiceTierAvailability): string {
	return availability.kind === "unavailable"
		? availability.reason
		: "The current model does not support OpenAI service tiers.";
}

function usageWarning(tier: ActiveServiceTier): string {
	return tier === "priority" ? PRIORITY_USAGE_WARNING : FLEX_USAGE_WARNING;
}

function activeRequestKey(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	return model ? `${ctx.sessionManager.getSessionId()}:${model.provider}/${model.id}` : undefined;
}

function consumeServiceTierRequest(
	ctx: ExtensionContext,
	message: unknown,
	pending: Map<string, PendingServiceTierRequest>,
): PendingServiceTierRequest | typeof NO_SERVICE_TIER_REQUEST {
	if (!isRecord(message) || message.role !== "assistant") return NO_SERVICE_TIER_REQUEST;
	const key = messageRequestKey(ctx, message);
	if (!key) return NO_SERVICE_TIER_REQUEST;
	const request = pending.get(key);
	pending.delete(key);
	return request ?? NO_SERVICE_TIER_REQUEST;
}

function messageRequestKey(
	ctx: ExtensionContext,
	message: Record<string, unknown>,
): string | undefined {
	if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
	return `${ctx.sessionManager.getSessionId()}:${message.provider}/${message.model}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServiceTier(value: unknown): value is ServiceTier {
	return (OPENAI_SERVICE_TIERS as readonly unknown[]).includes(value);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
