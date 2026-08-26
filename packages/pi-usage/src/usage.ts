import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FAST_USAGE_WARNING, registerCodexFastMode } from "./codex-fast-runtime.js";
import {
	type CodexResetAvailability,
	type CodexResetOption,
	type CodexResetOutcome,
	codexResetActionDescription,
	codexResetCount,
	consumeCodexResetCredit,
	formatCodexResetOutcome,
	genericCodexResetOption,
	listCodexResetCredits,
	resetConfirmationLines,
	resetLabel,
	resetOptionExpiration,
	resolveCodexResetAuth,
} from "./codex-resets.js";
import { awaitWithDeadline, errorMessage, runWithConcurrency, UsageCache } from "./core.js";
import { formatProviderStates, formatUsageStatusline } from "./format.js";
import { createOAuthCredentialCandidateReader } from "./oauth-credential-source.js";
import {
	adapterForProvider,
	isStaleExtensionContextError,
	queryProviderUsage,
	resolveUsageAuth,
} from "./query.js";
import { createUsageSettingsRuntime, type UsageSettingsRuntime } from "./settings.js";
import type {
	PiModel,
	ProviderUsageState,
	ResolvedUsageAuth,
	UsageDisplayState,
	UsageProviderAdapter,
} from "./types.js";
import {
	configuredAdapters,
	isAbortError,
	isTimeoutError,
	modelIdentity,
	providerDisplayName,
	setBoundedMap,
} from "./usage-helpers.js";

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
const REDEEM_CODEX_RESET = "Redeem usage limit reset…";

type UsageExtensionDependencies = {
	credentialReader?: (providerId: string) => unknown;
	createRedemptionId?: () => string;
	settingsRuntime?: UsageSettingsRuntime;
};

type QueryOutcome = {
	state: ProviderUsageState;
	fingerprint?: string;
	authState?: "unavailable";
};

type StableCurrent = {
	outcome: QueryOutcome;
	model: PiModel | undefined;
};

export default function usageExtension(
	pi: ExtensionAPI,
	dependencies: UsageExtensionDependencies = {},
) {
	const credentialReader = dependencies.credentialReader;
	const credentialCandidates = createOAuthCredentialCandidateReader(pi, credentialReader);
	const createRedemptionId = dependencies.createRedemptionId ?? randomUUID;
	const settingsRuntime = dependencies.settingsRuntime ?? createUsageSettingsRuntime();
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
	let fastRuntime: ReturnType<typeof registerCodexFastMode>;

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
		const rawValue = formatUsageStatusline(outcome.state.report, model);
		const value = rawValue ? fastRuntime.decorateStatus(model, rawValue) : undefined;
		if (!safeSetStatus(ctx, value)) return;
		if (shouldSchedule && sessionActive) scheduleStatusRefresh(ctx, model);
	};

	const invalidateProviderState = (providerId: string) => {
		cache.clearProvider(providerId);
		for (const key of failureBackoff.keys()) {
			if (key.startsWith(`${providerId}:`)) failureBackoff.delete(key);
		}
		for (const key of latestQueries.keys()) {
			if (key.startsWith(`${providerId}:`)) latestQueries.delete(key);
		}
	};

	const transitionCurrentIdentity = (nextIdentity: string, providerId: string) => {
		if (!activeCurrentIdentity || activeCurrentIdentity === nextIdentity) {
			activeCurrentIdentity = nextIdentity;
			return;
		}
		const previousProviderId = activeCurrentIdentity.split(":", 1)[0] ?? "";
		for (const id of new Set([previousProviderId, providerId])) {
			if (id) invalidateProviderState(id);
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
				resolveUsageAuth(ctx, adapter, undefined, credentialReader, credentialCandidates),
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
		cancellable = true,
	): Promise<T | undefined> => {
		const { runTask } = await import("@narumitw/pi-tui-kit");
		if (parentSignal.aborted) return undefined;
		const result = await runTask(ctx, {
			label,
			signal: parentSignal,
			cancellable,
			onError: () => undefined,
			task: ({ signal }) => operation(signal),
		});
		switch (result.kind) {
			case "completed":
				return result.value;
			case "cancelled":
			case "stale":
				return undefined;
			case "error":
				throw result.error;
		}
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
					resolveUsageAuth(ctx, adapter, undefined, credentialReader, credentialCandidates),
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
				resolveUsageAuth(ctx, adapter, undefined, credentialReader, credentialCandidates),
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
		if (!ctx.hasUI) throw new Error("/usage requires TUI or RPC mode.");
		statusGeneration += 1;
		const menuGeneration = statusGeneration;
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
			let fastState = settingsRuntime.get();
			let resetAvailability: CodexResetAvailability | undefined;
			let selectedReset: CodexResetOption | undefined;
			let resetAuthFingerprint: string | undefined;
			let resetModelIdentity: string | undefined;
			let redemptionId: string | undefined;
			let resetOutcome: CodexResetOutcome | undefined;
			let resetFailure: string | undefined;
			const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
			if (controller.signal.aborted || statusGeneration !== menuGeneration) return;
			type Screen =
				| "main"
				| "providers"
				| "reset-picker"
				| "reset-confirm"
				| "reset-result"
				| "reset-error";
			type Action =
				| "refresh"
				| "toggle-fast"
				| "another"
				| "all"
				| "provider"
				| "open-resets"
				| "select-reset"
				| "cancel-reset"
				| "consume-reset"
				| "back-to-usage"
				| "back-to-resets";
			const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
				start: "main",
				screens: {
					main: () => {
						const fastAvailability = fastRuntime.availability(ctx.model);
						const fastLines =
							fastAvailability.kind === "available"
								? [`Fast mode: ${fastAvailability.enabled ? "On" : "Off"}`, FAST_USAGE_WARNING]
								: fastAvailability.kind === "unavailable"
									? [`Fast mode: Unavailable · ${fastAvailability.reason}`]
									: [];
						return {
							kind: "actions",
							title: "Provider usage",
							lines: [...formatProviderStates(visibleStates).split("\n"), ...fastLines],
							items: [
								{ id: "refresh", label: REFRESH_CURRENT, action: "refresh" },
								...(fastAvailability.kind === "available"
									? [
											{
												id: "toggle-fast",
												label: fastAvailability.enabled
													? "Turn Fast mode off"
													: "Turn Fast mode on",
												description:
													fastState.kind === "invalid"
														? "Repair pi-usage.json and reload before changing Fast mode."
														: FAST_USAGE_WARNING,
												disabled: fastState.kind === "invalid",
												action: "toggle-fast" as const,
											},
										]
									: []),
								...(current.state.status === "ready" && current.state.providerId === "openai-codex"
									? [
											{
												id: "open-resets",
												label: REDEEM_CODEX_RESET,
												description: codexResetActionDescription(current.state.report),
												disabled: codexResetCount(current.state.report) === 0,
												action: "open-resets" as const,
											},
										]
									: []),
								{ id: "another", label: VIEW_ANOTHER, action: "another" },
								{ id: "all", label: VIEW_ALL, action: "all" },
								{ id: "close", label: CLOSE, close: true },
							],
							hint: "close",
						};
					},
					providers: () => ({
						kind: "actions",
						title: "Select a configured provider",
						items: configuredAdapters(ctx)
							.filter((adapter) => adapter.id !== ctx.model?.provider)
							.map((adapter) => ({
								id: adapter.id,
								label: adapter.displayName,
								action: "provider" as const,
							})),
						hint: "back",
					}),
					"reset-picker": () => ({
						kind: "choice",
						title: "Usage limit resets",
						lines: [
							`${resetAvailability?.availableCount ?? 0} ${resetLabel(resetAvailability?.availableCount ?? 0)} available.`,
						],
						items: (resetAvailability?.options ?? []).map((option, index) => ({
							id: `reset-${index}`,
							label: option.title,
							description: resetOptionExpiration(option),
							details: [option.description],
						})),
						action: "select-reset",
						initialItemId: "reset-0",
						hint: "back",
					}),
					"reset-confirm": () => ({
						kind: "actions",
						title: "Use this reset?",
						lines: resetConfirmationLines(selectedReset),
						items: [
							{ id: "cancel-reset", label: "No, go back", action: "cancel-reset" },
							{ id: "consume-reset", label: "Yes, use reset", action: "consume-reset" },
						],
						hint: "back",
					}),
					"reset-result": () => ({
						kind: "actions",
						title: "Usage limit resets",
						lines: [
							formatCodexResetOutcome(
								resetOutcome,
								current.state.status === "ready"
									? codexResetCount(current.state.report)
									: undefined,
							),
						],
						items: [
							{
								id: "back-to-usage",
								label: "Back to usage",
								action: "back-to-usage",
							},
							{ id: "close", label: CLOSE, close: true },
						],
						hint: "back",
					}),
					"reset-error": () => ({
						kind: "actions",
						title: "Usage limit resets",
						lines: [resetFailure ?? "Couldn't reset usage. Please try again."],
						items: [
							{ id: "consume-reset", label: "Try again", action: "consume-reset" },
							{ id: "back-to-resets", label: "Back", action: "back-to-resets" },
						],
						hint: "back",
					}),
				},
				actions: {
					"toggle-fast": async () => {
						const availability = fastRuntime.availability(ctx.model);
						if (availability.kind !== "available" || fastState.kind === "invalid") {
							return { kind: "rejected" };
						}
						const changed = await fastRuntime.toggle(ctx, !availability.enabled, controller.signal);
						if (!changed) return { kind: "rejected" };
						fastState = settingsRuntime.get();
						return { kind: "stay" };
					},
					"open-resets": async () => {
						const summaryCount =
							current.state.status === "ready" && current.state.providerId === "openai-codex"
								? codexResetCount(current.state.report)
								: undefined;
						try {
							const loaded = await runMenuOperation(
								ctx,
								"Checking usage limit resets…",
								controller.signal,
								async (signal) => {
									const expectedModel = modelIdentity(ctx.model);
									const auth = await awaitWithDeadline(
										resolveCodexResetAuth(ctx, undefined, credentialReader, credentialCandidates),
										signal,
										DEFAULT_TIMEOUT_MS,
										"resolving current Codex reset authentication",
									);
									let availability: CodexResetAvailability;
									try {
										availability = await listCodexResetCredits(auth, signal, DEFAULT_TIMEOUT_MS);
									} catch (error) {
										if (isAbortError(error) || summaryCount === undefined || summaryCount <= 0) {
											throw error;
										}
										availability = {
											availableCount: summaryCount,
											options: [genericCodexResetOption()],
										};
									}
									const revalidated = await awaitWithDeadline(
										resolveCodexResetAuth(ctx, undefined, credentialReader, credentialCandidates),
										signal,
										DEFAULT_TIMEOUT_MS,
										"revalidating current Codex reset authentication",
									);
									if (
										modelIdentity(ctx.model) !== expectedModel ||
										revalidated.fingerprint !== auth.fingerprint
									) {
										throw new Error(
											"The active Codex model or account changed while loading usage limit resets.",
										);
									}
									return { availability, auth, expectedModel };
								},
							);
							if (!loaded) return { kind: "stay" };
							resetAvailability = loaded.availability;
							resetAuthFingerprint = loaded.auth.fingerprint;
							resetModelIdentity = loaded.expectedModel;
							selectedReset = undefined;
							redemptionId = undefined;
							resetOutcome = undefined;
							resetFailure = undefined;
							return {
								kind: "to",
								screen: loaded.availability.availableCount > 0 ? "reset-picker" : "reset-result",
							};
						} catch (error) {
							if (isAbortError(error) || isStaleExtensionContextError(error)) {
								return { kind: "stay" };
							}
							ctx.ui.notify(`Couldn't load usage limit resets: ${errorMessage(error)}`, "error");
							return { kind: "stay" };
						}
					},
					"select-reset": ({ itemId }) => {
						const index = Number(itemId.replace(/^reset-/u, ""));
						const option = Number.isSafeInteger(index)
							? resetAvailability?.options[index]
							: undefined;
						if (!option) return { kind: "rejected" };
						selectedReset = option;
						redemptionId = undefined;
						resetFailure = undefined;
						return { kind: "to", screen: "reset-confirm" };
					},
					"cancel-reset": () => ({ kind: "back" }),
					"consume-reset": async () => {
						if (!selectedReset || !resetAuthFingerprint || !resetModelIdentity) {
							return { kind: "rejected" };
						}
						try {
							redemptionId ??= createRedemptionId();
							const attemptId = redemptionId;
							const option = selectedReset;
							const expectedFingerprint = resetAuthFingerprint;
							const expectedModel = resetModelIdentity;
							const result = await runMenuOperation(
								ctx,
								"Resetting your usage…",
								controller.signal,
								async (signal) => {
									const auth = await awaitWithDeadline(
										resolveCodexResetAuth(ctx, undefined, credentialReader, credentialCandidates),
										signal,
										DEFAULT_TIMEOUT_MS,
										"revalidating current Codex reset authentication",
									);
									if (
										modelIdentity(ctx.model) !== expectedModel ||
										auth.fingerprint !== expectedFingerprint
									) {
										throw new Error(
											"The active Codex model or account changed; the reset was not used.",
										);
									}
									const outcome = await consumeCodexResetCredit(
										auth,
										option,
										attemptId,
										signal,
										DEFAULT_TIMEOUT_MS,
									);
									invalidateProviderState("openai-codex");
									const model = ctx.model;
									if (modelIdentity(model) !== expectedModel) return { outcome };
									const refreshed = await queryCurrentState(ctx, model, true, signal);
									const stable = await outcomeStillCurrent(
										ctx,
										model,
										menuGeneration,
										refreshed,
										signal,
									);
									return stable ? { outcome, refreshed, model } : { outcome };
								},
								false,
							);
							if (!result) return { kind: "close" };
							resetOutcome = result.outcome;
							resetFailure = undefined;
							if (result.refreshed && result.model) {
								stableCurrent = { outcome: result.refreshed, model: result.model };
								current = result.refreshed;
								visibleStates = [current.state];
								publishStableCurrent(ctx, stableCurrent);
							}
							return { kind: "to", screen: "reset-result" };
						} catch (error) {
							if (isAbortError(error) || isStaleExtensionContextError(error)) {
								return { kind: "close" };
							}
							resetFailure = `Couldn't reset usage: ${errorMessage(error)}. Try again with the same request.`;
							return { kind: "to", screen: "reset-error" };
						}
					},
					"back-to-usage": () => ({ kind: "to", screen: "main" }),
					"back-to-resets": () => {
						redemptionId = undefined;
						resetFailure = undefined;
						return { kind: "to", screen: "reset-picker" };
					},
					refresh: async () => {
						const refreshed = await queryStableCurrent(
							ctx,
							true,
							controller,
							"Refreshing current usage…",
						);
						if (!refreshed) return { kind: "stay" };
						stableCurrent = refreshed;
						publishStableCurrent(ctx, refreshed);
						current = refreshed.outcome;
						visibleStates = [current.state];
						return { kind: "stay" };
					},
					another: async () => {
						const others = configuredAdapters(ctx).filter(
							(adapter) => adapter.id !== ctx.model?.provider,
						);
						if (others.length === 0) {
							ctx.ui.notify("No other supported provider has configured runtime auth.", "info");
							return { kind: "stay" };
						}
						return { kind: "to", screen: "providers" };
					},
					provider: async ({ itemId }) => {
						const adapter = configuredAdapters(ctx).find(
							(candidate) => candidate.id === itemId && candidate.id !== ctx.model?.provider,
						);
						if (!adapter) return { kind: "back" };
						const outcome = await runMenuOperation(
							ctx,
							`Checking ${adapter.displayName} usage…`,
							controller.signal,
							(signal) => queryAdapterState(ctx, adapter, "configured", false, signal),
						);
						if (!outcome) return { kind: "back" };
						const revalidated = await queryStableCurrent(
							ctx,
							false,
							controller,
							"Revalidating current usage…",
						);
						if (!revalidated) return { kind: "back" };
						stableCurrent = revalidated;
						current = revalidated.outcome;
						visibleStates = [
							outcome.state.providerId === current.state.providerId
								? current.state
								: { ...outcome.state, displayState: "configured" },
						];
						return { kind: "back" };
					},
					all: async () => {
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
						if (!settled) return { kind: "stay" };
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
						if (!revalidated) return { kind: "stay" };
						stableCurrent = revalidated;
						current = revalidated.outcome;
						visibleStates = [
							current.state,
							...queriedStates.filter((state) => state.providerId !== current.state.providerId),
						];
						return { kind: "stay" };
					},
				},
			});
			await runMenu(ctx, menu, {
				getState: () => undefined,
				signal: controller.signal,
				isCurrent: () => statusGeneration === menuGeneration && !controller.signal.aborted,
			});
		} finally {
			controller.abort(new DOMException("Usage menu closed", "AbortError"));
			activeControllers.delete(controller);
		}
	};

	pi.registerCommand("usage", {
		description: "Show usage for the current runtime account",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(
					"/usage does not accept arguments; choose an action from its menu.",
					"warning",
				);
				return;
			}
			try {
				await showMenu(ctx);
			} catch (error) {
				if (isStaleExtensionContextError(error) || isAbortError(error)) return;
				throw error;
			}
		},
	});
	pi.on("session_start", (_event, ctx) => {
		statusGeneration += 1;
		clearStatusTimer();
		for (const controller of activeControllers) controller.abort();
		activeControllers.clear();
		statusController = undefined;
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

	fastRuntime = registerCodexFastMode(pi, settingsRuntime, (ctx) =>
		startStatusRefresh(ctx, ctx.model, false),
	);
}
