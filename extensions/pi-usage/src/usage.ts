import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	awaitWithDeadline,
	errorMessage,
	runWithConcurrency,
	sanitizeDisplayText,
	UsageCache,
} from "./core.js";
import { formatProviderStates, formatUsageStatusline } from "./format.js";
import {
	adapterForProvider,
	isStaleExtensionContextError,
	providerIsConfigured,
	queryProviderUsage,
	resolveUsageAuth,
	SUPPORTED_ADAPTERS,
} from "./query.js";
import type {
	PiModel,
	ProviderUsageState,
	ResolvedUsageAuth,
	UsageDisplayState,
	UsageProviderAdapter,
} from "./types.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALL_PROVIDER_CONCURRENCY = 2;
const FAILURE_BACKOFF_MS = 30_000;
const MAX_ACCOUNT_STATES = 32;
const STATUS_KEY = "usage";

const REFRESH_CURRENT = "Refresh current usage";
const VIEW_ANOTHER = "View another configured provider…";
const VIEW_ALL = "View all configured providers…";
const CLOSE = "Close";
const MENU_ACTIONS = [REFRESH_CURRENT, VIEW_ANOTHER, VIEW_ALL, CLOSE];

type QueryOutcome = {
	state: ProviderUsageState;
	fingerprint?: string;
	authState?: "unavailable";
};

type StableCurrent = {
	outcome: QueryOutcome;
	model: PiModel | undefined;
};

type LoaderResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export default function usageExtension(pi: ExtensionAPI) {
	const cache = new UsageCache(CACHE_TTL_MS);
	const failureBackoff = new Map<string, { until: number; message: string }>();
	const latestQueries = new Map<string, number>();
	const activeControllers = new Set<AbortController>();
	let querySequence = 0;
	let activeCurrentIdentity: string | undefined;
	let sessionActive = false;
	let statusGeneration = 0;
	let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let statusController: AbortController | undefined;

	const clearStatusTimer = () => {
		if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
		statusRefreshTimer = undefined;
	};

	const safeSetStatus = (ctx: ExtensionContext, value: string | undefined): boolean => {
		try {
			ctx.ui.setStatus(STATUS_KEY, value);
			return true;
		} catch (error) {
			if (isStaleExtensionContextError(error)) return false;
			throw error;
		}
	};

	const clearStatus = (ctx: ExtensionContext) => {
		statusGeneration += 1;
		statusController?.abort();
		statusController = undefined;
		clearStatusTimer();
		safeSetStatus(ctx, undefined);
	};

	const scheduleStatusRefresh = (ctx: ExtensionContext, model: PiModel) => {
		clearStatusTimer();
		const generation = statusGeneration;
		statusRefreshTimer = setTimeout(() => {
			statusRefreshTimer = undefined;
			if (!sessionActive || generation !== statusGeneration) return;
			startStatusRefresh(ctx, model, true);
		}, CACHE_TTL_MS);
		statusRefreshTimer.unref?.();
	};

	const publishStatus = (
		ctx: ExtensionContext,
		outcome: QueryOutcome,
		model: PiModel,
		shouldSchedule: boolean,
	) => {
		if (outcome.state.status === "unsupported") {
			clearStatusTimer();
			safeSetStatus(ctx, undefined);
			return;
		}
		if (outcome.state.status !== "ready") {
			if (
				safeSetStatus(
					ctx,
					outcome.state.status === "auth-unavailable" ? "auth unavailable" : "usage error",
				)
			) {
				if (shouldSchedule && sessionActive) scheduleStatusRefresh(ctx, model);
			}
			return;
		}
		const value = formatUsageStatusline(outcome.state.report, model);
		if (!safeSetStatus(ctx, value)) return;
		if (shouldSchedule && sessionActive) scheduleStatusRefresh(ctx, model);
	};

	const transitionCurrentIdentity = (nextIdentity: string, providerId: string) => {
		if (!activeCurrentIdentity || activeCurrentIdentity === nextIdentity) {
			activeCurrentIdentity = nextIdentity;
			return;
		}
		const previousProviderId = activeCurrentIdentity.split(":", 1)[0] ?? "";
		for (const id of new Set([previousProviderId, providerId])) {
			if (!id) continue;
			cache.clearProvider(id);
			for (const key of failureBackoff.keys()) {
				if (key.startsWith(`${id}:`)) failureBackoff.delete(key);
			}
			for (const key of latestQueries.keys()) {
				if (key.startsWith(`${id}:`)) latestQueries.delete(key);
			}
		}
		activeCurrentIdentity = nextIdentity;
	};

	const queryAdapterState = async (
		ctx: ExtensionContext,
		adapter: UsageProviderAdapter,
		displayState: UsageDisplayState,
		force: boolean,
		signal: AbortSignal,
	): Promise<QueryOutcome> => {
		const startedAt = Date.now();
		let auth: ResolvedUsageAuth | undefined;
		try {
			auth = await awaitWithDeadline(
				resolveUsageAuth(ctx, adapter),
				signal,
				DEFAULT_TIMEOUT_MS,
				`resolving ${adapter.displayName} runtime auth`,
			);
		} catch (error) {
			if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
			if (displayState === "current") {
				transitionCurrentIdentity(`${adapter.id}:auth-error`, adapter.id);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: isTimeoutError(error) ? "query-failed" : "auth-unavailable",
					message: errorMessage(error),
				},
			};
		}
		if (!auth) {
			if (displayState === "current") {
				transitionCurrentIdentity(`${adapter.id}:unavailable`, adapter.id);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "auth-unavailable",
					message: `No runtime credential is configured for ${adapter.displayName}.`,
				},
				authState: "unavailable",
			};
		}
		if (displayState === "current") {
			transitionCurrentIdentity(`${adapter.id}:${auth.fingerprint}`, adapter.id);
		}

		const cached = !force ? cache.get(adapter.id, auth.fingerprint) : undefined;
		if (cached) {
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "ready",
					report: cached,
				},
				fingerprint: auth.fingerprint,
			};
		}

		const failureKey = `${adapter.id}:${auth.fingerprint}`;
		const previousFailure = failureBackoff.get(failureKey);
		if (!force && previousFailure && previousFailure.until > Date.now()) {
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "query-failed",
					message: previousFailure.message,
				},
				fingerprint: auth.fingerprint,
			};
		}
		failureBackoff.delete(failureKey);
		querySequence += 1;
		const queryId = querySequence;
		setBoundedMap(latestQueries, failureKey, queryId, MAX_ACCOUNT_STATES);

		try {
			const remainingMs = Math.max(1, DEFAULT_TIMEOUT_MS - (Date.now() - startedAt));
			const report = await queryProviderUsage(adapter, auth, signal, remainingMs);
			if (latestQueries.get(failureKey) === queryId) {
				cache.set(adapter.id, auth.fingerprint, report);
				failureBackoff.delete(failureKey);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "ready",
					report,
				},
				fingerprint: auth.fingerprint,
			};
		} catch (error) {
			if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
			const message = errorMessage(error);
			const now = Date.now();
			for (const [key, failure] of failureBackoff) {
				if (failure.until <= now) failureBackoff.delete(key);
			}
			if (latestQueries.get(failureKey) === queryId) {
				setBoundedMap(
					failureBackoff,
					failureKey,
					{ until: now + FAILURE_BACKOFF_MS, message },
					MAX_ACCOUNT_STATES,
				);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "query-failed",
					message,
				},
				fingerprint: auth.fingerprint,
			};
		}
	};

	const queryCurrentState = async (
		ctx: ExtensionContext,
		model: PiModel | undefined,
		force: boolean,
		signal: AbortSignal,
	): Promise<QueryOutcome> => {
		const adapter = adapterForProvider(model?.provider);
		if (!adapter) {
			const providerId = model?.provider ?? "none";
			transitionCurrentIdentity(`unsupported:${providerId}`, providerId);
			return {
				state: {
					providerId,
					providerName: providerDisplayName(ctx, providerId),
					displayState: "current",
					status: "unsupported",
					message: model
						? `Usage reporting is not supported for ${providerDisplayName(ctx, providerId)}.`
						: "No model is selected.",
				},
			};
		}
		return queryAdapterState(ctx, adapter, "current", force, signal);
	};

	const refreshCurrentStatus = async (
		ctx: ExtensionContext,
		model: PiModel | undefined,
		force: boolean,
	) => {
		const adapter = adapterForProvider(model?.provider);
		if (!adapter || !model) {
			const providerId = model?.provider ?? "none";
			transitionCurrentIdentity(`unsupported:${providerId}`, providerId);
			clearStatus(ctx);
			return;
		}
		statusGeneration += 1;
		const generation = statusGeneration;
		statusController?.abort();
		const controller = new AbortController();
		statusController = controller;
		activeControllers.add(controller);
		try {
			if (!safeSetStatus(ctx, "checking")) return;
			const outcome = await queryCurrentState(ctx, model, force, controller.signal);
			if (!sessionActive || generation !== statusGeneration || controller.signal.aborted) return;
			if (!(await outcomeStillCurrent(ctx, model, generation, outcome, controller.signal))) {
				if (sessionActive && generation === statusGeneration) {
					queueMicrotask(() => startStatusRefresh(ctx, ctx.model, false));
				}
				return;
			}
			publishStatus(ctx, outcome, model, true);
		} finally {
			activeControllers.delete(controller);
			if (statusController === controller) statusController = undefined;
		}
	};

	const startStatusRefresh = (
		ctx: ExtensionContext,
		model: PiModel | undefined,
		force: boolean,
	) => {
		void refreshCurrentStatus(ctx, model, force).catch((error) => {
			if (isStaleExtensionContextError(error) || isAbortError(error)) return;
			safeSetStatus(ctx, "usage error");
		});
	};

	const runMenuOperation = async <T>(
		ctx: ExtensionCommandContext,
		label: string,
		parentSignal: AbortSignal,
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<T | undefined> => {
		if (ctx.mode !== "tui") return operation(parentSignal);
		const result = await ctx.ui.custom<LoaderResult<T> | null>((tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(tui, theme, label);
			let finished = false;
			const finish = (value: LoaderResult<T> | null) => {
				if (finished) return;
				finished = true;
				done(value);
			};
			loader.onAbort = () => finish(null);
			const signal = AbortSignal.any([parentSignal, loader.signal]);
			void operation(signal)
				.then((value) => finish({ ok: true, value }))
				.catch((error) => {
					if (isAbortError(error)) finish(null);
					else finish({ ok: false, error });
				});
			return loader;
		});
		if (!result) return undefined;
		if (!result.ok) throw result.error;
		return result.value;
	};

	const outcomeStillCurrent = async (
		ctx: ExtensionContext,
		model: PiModel | undefined,
		generation: number,
		outcome: QueryOutcome,
		signal: AbortSignal,
	): Promise<boolean> => {
		if (generation !== statusGeneration || modelIdentity(ctx.model) !== modelIdentity(model)) {
			return false;
		}
		const adapter = adapterForProvider(model?.provider);
		if (outcome.authState === "unavailable") {
			if (!adapter) return false;
			try {
				const auth = await awaitWithDeadline(
					resolveUsageAuth(ctx, adapter),
					signal,
					DEFAULT_TIMEOUT_MS,
					`revalidating ${adapter.displayName} runtime auth`,
				);
				return (
					generation === statusGeneration &&
					modelIdentity(ctx.model) === modelIdentity(model) &&
					auth === undefined
				);
			} catch (error) {
				if (isAbortError(error) || isStaleExtensionContextError(error)) throw error;
				return false;
			}
		}
		if (!outcome.fingerprint) return true;
		if (!adapter) return false;
		try {
			const auth = await awaitWithDeadline(
				resolveUsageAuth(ctx, adapter),
				signal,
				DEFAULT_TIMEOUT_MS,
				`revalidating ${adapter.displayName} runtime auth`,
			);
			return (
				generation === statusGeneration &&
				modelIdentity(ctx.model) === modelIdentity(model) &&
				auth?.fingerprint === outcome.fingerprint
			);
		} catch (error) {
			if (isAbortError(error) || isStaleExtensionContextError(error)) throw error;
			return false;
		}
	};

	const queryStableCurrent = async (
		ctx: ExtensionCommandContext,
		force: boolean,
		controller: AbortController,
		label: string,
	): Promise<StableCurrent | undefined> => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const model = ctx.model;
			const generation = statusGeneration;
			const result = await runMenuOperation(ctx, label, controller.signal, async (signal) => {
				const outcome = await queryCurrentState(ctx, model, force, signal);
				return {
					outcome,
					stable: await outcomeStillCurrent(ctx, model, generation, outcome, signal),
				};
			});
			if (!result) return undefined;
			if (result.stable) return { outcome: result.outcome, model };
			force = false;
		}
		ctx.ui.notify("The active model or account kept changing; reopen /usage to retry.", "warning");
		return undefined;
	};

	const publishStableCurrent = (ctx: ExtensionCommandContext, current: StableCurrent) => {
		if (current.model) publishStatus(ctx, current.outcome, current.model, sessionActive);
		else safeSetStatus(ctx, undefined);
	};

	const showMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/usage requires an interactive Pi mode.", "warning");
			return;
		}
		statusGeneration += 1;
		statusController?.abort();
		statusController = undefined;
		clearStatusTimer();
		const controller = new AbortController();
		activeControllers.add(controller);
		try {
			let stableCurrent = await queryStableCurrent(
				ctx,
				false,
				controller,
				"Checking current usage…",
			);
			if (!stableCurrent) return;
			publishStableCurrent(ctx, stableCurrent);
			let current = stableCurrent.outcome;
			let visibleStates: ProviderUsageState[] = [current.state];

			while (!controller.signal.aborted) {
				const action = await ctx.ui.select(formatProviderStates(visibleStates), [...MENU_ACTIONS]);
				if (!action || action === CLOSE) return;
				if (action === REFRESH_CURRENT) {
					stableCurrent = await queryStableCurrent(
						ctx,
						true,
						controller,
						"Refreshing current usage…",
					);
					if (!stableCurrent) continue;
					publishStableCurrent(ctx, stableCurrent);
					current = stableCurrent.outcome;
					visibleStates = [current.state];
					continue;
				}
				if (action === VIEW_ANOTHER) {
					const others = configuredAdapters(ctx).filter(
						(adapter) => adapter.id !== ctx.model?.provider,
					);
					if (others.length === 0) {
						ctx.ui.notify("No other supported provider has configured runtime auth.", "info");
						continue;
					}
					const choice = await ctx.ui.select(
						"Select a configured provider",
						others.map((adapter) => adapter.displayName),
					);
					const adapter = others.find((candidate) => candidate.displayName === choice);
					if (!adapter) continue;
					const outcome = await runMenuOperation(
						ctx,
						`Checking ${adapter.displayName} usage…`,
						controller.signal,
						(signal) => queryAdapterState(ctx, adapter, "configured", false, signal),
					);
					if (!outcome) continue;
					const revalidated = await queryStableCurrent(
						ctx,
						false,
						controller,
						"Revalidating current usage…",
					);
					if (!revalidated) continue;
					stableCurrent = revalidated;
					current = revalidated.outcome;
					visibleStates =
						outcome.state.providerId === current.state.providerId
							? [current.state]
							: [current.state, { ...outcome.state, displayState: "configured" }];
					continue;
				}
				if (action === VIEW_ALL) {
					const adapters = configuredAdapters(ctx);
					const currentProviderId = ctx.model?.provider;
					const settled = await runMenuOperation(
						ctx,
						"Checking configured provider usage…",
						controller.signal,
						(signal) =>
							runWithConcurrency(
								adapters,
								ALL_PROVIDER_CONCURRENCY,
								(adapter, _index, workerSignal) =>
									queryAdapterState(
										ctx,
										adapter,
										adapter.id === currentProviderId ? "current" : "configured",
										true,
										workerSignal,
									),
								signal,
							),
					);
					if (!settled) continue;
					const queriedStates: ProviderUsageState[] = settled.map((result, index) => {
						if (result.status === "fulfilled") {
							return { ...result.value.state, displayState: "configured" };
						}
						const adapter = adapters[index] as UsageProviderAdapter;
						return {
							providerId: adapter.id,
							providerName: adapter.displayName,
							displayState: "configured",
							status: "query-failed",
							message: errorMessage(result.reason),
						};
					});
					const revalidated = await queryStableCurrent(
						ctx,
						false,
						controller,
						"Revalidating current usage…",
					);
					if (!revalidated) continue;
					stableCurrent = revalidated;
					current = revalidated.outcome;
					visibleStates = [
						current.state,
						...queriedStates.filter((state) => state.providerId !== current.state.providerId),
					];
				}
			}
		} finally {
			controller.abort();
			activeControllers.delete(controller);
		}
	};

	const commandHandler = async (args: string, ctx: ExtensionCommandContext) => {
		if (args.trim()) {
			ctx.ui.notify("/usage does not accept arguments; choose an action from its menu.", "warning");
			return;
		}
		try {
			await showMenu(ctx);
		} catch (error) {
			if (isStaleExtensionContextError(error) || isAbortError(error)) return;
			throw error;
		}
	};

	pi.registerCommand("usage", {
		description: "Show usage for the current runtime account",
		handler: commandHandler,
	});
	pi.registerCommand("codex-status", {
		description: "Open /usage (temporary compatibility alias)",
		handler: commandHandler,
	});

	pi.on("session_start", (_event, ctx) => {
		sessionActive = true;
		startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("session_tree", (_event, ctx) => {
		startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("model_select", (event, ctx) => {
		startStatusRefresh(ctx, event.model, false);
	});
	pi.on("turn_start", (_event, ctx) => {
		startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
		statusGeneration += 1;
		clearStatusTimer();
		for (const controller of activeControllers) controller.abort();
		activeControllers.clear();
		statusController = undefined;
		cache.clear();
		failureBackoff.clear();
		latestQueries.clear();
		activeCurrentIdentity = undefined;
		safeSetStatus(ctx, undefined);
	});
}

function configuredAdapters(ctx: ExtensionContext): UsageProviderAdapter[] {
	return SUPPORTED_ADAPTERS.filter(
		(adapter) => adapter.id === ctx.model?.provider || providerIsConfigured(ctx, adapter.id),
	);
}

function providerDisplayName(ctx: ExtensionContext, providerId: string): string {
	try {
		return sanitizeDisplayText(ctx.modelRegistry.getProviderDisplayName(providerId), 80);
	} catch {
		return sanitizeDisplayText(providerId, 80);
	}
}

function setBoundedMap<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
	map.delete(key);
	while (map.size >= limit) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
	map.set(key, value);
}

function modelIdentity(model: PiModel | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}
