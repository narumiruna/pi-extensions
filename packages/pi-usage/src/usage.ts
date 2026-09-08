// This orchestrator intentionally remains over 1,000 lines because its menu, query generations,
// account cache, cancellation, and session lifecycle share one consistency boundary.
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
import {
	abortError,
	awaitWithDeadline,
	errorMessage,
	runWithConcurrency,
	UsageCache,
} from "./core.js";
import { formatProviderStates, formatUsageStatusline } from "./format.js";
import { createOAuthCredentialCandidateReader } from "./oauth-credential-source.js";
import {
	adapterForProvider,
	isStaleExtensionContextError,
	queryProviderUsage,
	resolveUsageAuth,
} from "./query.js";
import {
	createUsageSettingsRuntime,
	type UsageSettingsRuntime,
	type UsageSettingsState,
} from "./settings.js";
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
import { showUsageSettings } from "./usage-settings-ui.js";
import {
	createUsageTargetSelectOptions,
	listUsageTargets,
	resolveUsageTarget,
} from "./usage-targets.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const STATUS_COUNTDOWN_REFRESH_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALL_PROVIDER_CONCURRENCY = 2;
const FAILURE_BACKOFF_MS = 30_000;
const MAX_ACCOUNT_STATES = 32;
const STATUS_KEY = "usage";

const REFRESH_CURRENT = "Refresh current usage";
const VIEW_ANOTHER = "View another configured provider…";
const VIEW_ALL = "View all configured providers…";
const CLOSE = "Close";
const SETTINGS = "Settings";
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
	rememberedTargetId?: string;
};

class UsageTargetSelectionChangedError extends Error {
	override readonly name = "UsageTargetSelectionChangedError";
}

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
	let sessionGeneration = 0;
	let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let statusCountdownTimer: ReturnType<typeof setTimeout> | undefined;
	let statusController: AbortController | undefined;
	let fastRuntime: ReturnType<typeof registerCodexFastMode>;

	const clearStatusRefreshTimer = () => {
		if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
		statusRefreshTimer = undefined;
	};

	const clearStatusCountdownTimer = () => {
		if (statusCountdownTimer) clearTimeout(statusCountdownTimer);
		statusCountdownTimer = undefined;
	};

	const clearStatusTimers = () => {
		clearStatusRefreshTimer();
		clearStatusCountdownTimer();
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
		clearStatusTimers();
		safeSetStatus(ctx, undefined);
	};

	const scheduleStatusRefresh = (ctx: ExtensionContext, model: PiModel) => {
		clearStatusRefreshTimer();
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
		clearStatusCountdownTimer();
		if (adapterForProvider(model.provider)?.publishesStatusline === false) {
			clearStatusRefreshTimer();
			safeSetStatus(ctx, undefined);
			return;
		}
		if (outcome.state.status === "unsupported") {
			clearStatusRefreshTimer();
			safeSetStatus(ctx, undefined);
			return;
		}
		if (outcome.state.status !== "ready") {
			const chip =
				outcome.state.status === "auth-unavailable"
					? "auth unavailable"
					: outcome.state.status === "selection-required"
						? "selection required"
						: `usage err: ${outcome.state.message.slice(0, 50)}`;

			if (safeSetStatus(ctx, chip)) {
				if (shouldSchedule && sessionActive) scheduleStatusRefresh(ctx, model);
			}
			return;
		}
		const showCodexResetCountdown =
			outcome.state.report.providerId === "openai-codex" &&
			settingsRuntime.get().settings.codexStatusResetCountdown;
		const now = Date.now();
		const rawValue = formatUsageStatusline(
			outcome.state.report,
			model,
			now,
			showCodexResetCountdown,
		);
		const value = rawValue ? fastRuntime.decorateStatus(model, rawValue) : undefined;
		if (!safeSetStatus(ctx, value)) return;
		if (shouldSchedule && sessionActive) scheduleStatusRefresh(ctx, model);
		if (
			sessionActive &&
			showCodexResetCountdown &&
			outcome.state.report.buckets.some(
				(bucket) =>
					bucket.resetsAt !== undefined &&
					Number.isFinite(bucket.resetsAt) &&
					bucket.resetsAt * 1_000 > now,
			)
		) {
			const generation = statusGeneration;
			statusCountdownTimer = setTimeout(() => {
				statusCountdownTimer = undefined;
				if (!sessionActive || generation !== statusGeneration) return;
				publishStatus(ctx, outcome, model, false);
			}, STATUS_COUNTDOWN_REFRESH_MS);
			statusCountdownTimer.unref?.();
		}
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
		authRetry = 0,
		deadlineAt = Date.now() + DEFAULT_TIMEOUT_MS,
	): Promise<QueryOutcome> => {
		const expectedSessionGeneration = sessionGeneration;
		const expectedSessionId = ctx.sessionManager.getSessionId();
		const expectedModelIdentity = modelIdentity(ctx.model);
		const expectedTargetId = adapter.targets
			? settingsRuntime.get().settings.selectedTargets[adapter.id]
			: undefined;
		const providerName = providerDisplayName(ctx, adapter.id);
		let auth: ResolvedUsageAuth | undefined;
		try {
			auth = await awaitWithDeadline(
				resolveUsageAuth(ctx, adapter, undefined, credentialReader, credentialCandidates),
				signal,
				Math.max(1, deadlineAt - Date.now()),
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
					providerName,
					displayState,
					status: isTimeoutError(error) ? "query-failed" : "auth-unavailable",
					message: errorMessage(error),
				},
			};
		}
		const requiresRequestBoundaryGuard =
			adapter.targets !== undefined ||
			[
				"baseten",
				"deepseek",
				"minimax",
				"minimax-cn",
				"moonshotai",
				"moonshotai-cn",
				"vercel-ai-gateway",
				"xai",
				"zai",
				"zai-coding-cn",
			].includes(adapter.id);
		const requestContextChanged = () =>
			expectedSessionGeneration !== sessionGeneration ||
			ctx.sessionManager.getSessionId() !== expectedSessionId ||
			modelIdentity(ctx.model) !== expectedModelIdentity ||
			(adapter.targets !== undefined &&
				settingsRuntime.get().settings.selectedTargets[adapter.id] !== expectedTargetId);
		if (requiresRequestBoundaryGuard && requestContextChanged()) throw abortError();
		if (!auth) {
			if (displayState === "current") {
				transitionCurrentIdentity(`${adapter.id}:unavailable`, adapter.id);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName,
					displayState,
					status: "auth-unavailable",
					message: `No runtime credential is configured for ${providerName}.`,
				},
				authState: "unavailable",
			};
		}
		let retryableAuthChanged = false;
		const guard = async () => {
			if (signal.aborted || requestContextChanged()) throw abortError();
			if (!requiresRequestBoundaryGuard) return;
			const revalidated = await awaitWithDeadline(
				resolveUsageAuth(ctx, adapter, undefined, credentialReader, credentialCandidates),
				signal,
				Math.max(1, deadlineAt - Date.now()),
				`revalidating ${providerName} runtime auth`,
			);
			if (signal.aborted || requestContextChanged()) throw abortError();
			if (revalidated?.fingerprint !== auth.fingerprint) {
				if (["deepseek", "minimax", "minimax-cn"].includes(adapter.id)) {
					retryableAuthChanged = true;
					throw new Error(`${providerName} runtime credential changed during the usage query.`);
				}
				throw abortError();
			}
		};
		let queryFingerprint = adapter.targets
			? `${auth.fingerprint}:target:${expectedTargetId ?? "unresolved"}`
			: auth.fingerprint;
		let failureKey = `${adapter.id}:${queryFingerprint}`;
		let queryId: number | undefined;
		try {
			const previousDiscoveryFailure = failureBackoff.get(failureKey);
			if (!force && previousDiscoveryFailure && previousDiscoveryFailure.until > Date.now()) {
				return {
					state: {
						providerId: adapter.id,
						providerName,
						displayState,
						status: "query-failed",
						message: previousDiscoveryFailure.message,
					},
					fingerprint: auth.fingerprint,
					rememberedTargetId: expectedTargetId,
				};
			}
			const target = await resolveUsageTarget(
				adapter,
				auth,
				expectedTargetId,
				signal,
				Math.max(1, deadlineAt - Date.now()),
				guard,
			);
			if (target.kind === "selection-required") {
				if (displayState === "current") {
					transitionCurrentIdentity(`${adapter.id}:${queryFingerprint}`, adapter.id);
				}
				return {
					state: {
						providerId: adapter.id,
						providerName,
						displayState,
						status: "selection-required",
						singularLabel: adapter.targets?.singularLabel ?? "target",
						pluralLabel: adapter.targets?.pluralLabel ?? "targets",
						choices: target.choices,
					},
					fingerprint: auth.fingerprint,
					rememberedTargetId: expectedTargetId,
				};
			}
			queryFingerprint = adapter.targets
				? `${auth.fingerprint}:target:${target.targetId ?? "none"}`
				: auth.fingerprint;
			failureKey = `${adapter.id}:${queryFingerprint}`;
			if (displayState === "current") {
				transitionCurrentIdentity(`${adapter.id}:${queryFingerprint}`, adapter.id);
			}
			const cached = !force ? cache.get(adapter.id, queryFingerprint) : undefined;
			if (cached) {
				return {
					state: {
						providerId: adapter.id,
						providerName,
						displayState,
						status: "ready",
						report: cached,
					},
					fingerprint: auth.fingerprint,
					rememberedTargetId: expectedTargetId,
				};
			}
			const previousFailure = failureBackoff.get(failureKey);
			if (!force && previousFailure && previousFailure.until > Date.now()) {
				return {
					state: {
						providerId: adapter.id,
						providerName,
						displayState,
						status: "query-failed",
						message: previousFailure.message,
					},
					fingerprint: auth.fingerprint,
					rememberedTargetId: expectedTargetId,
				};
			}
			failureBackoff.delete(failureKey);
			querySequence += 1;
			queryId = querySequence;
			setBoundedMap(latestQueries, failureKey, queryId, MAX_ACCOUNT_STATES);
			const report = await queryProviderUsage(
				adapter,
				auth,
				signal,
				Math.max(1, deadlineAt - Date.now()),
				requiresRequestBoundaryGuard ? guard : undefined,
				target.targetId,
			);
			if (requiresRequestBoundaryGuard) await guard();
			const effectiveReport = { ...report, providerName };
			if (latestQueries.get(failureKey) === queryId) {
				cache.set(adapter.id, queryFingerprint, effectiveReport);
				failureBackoff.delete(failureKey);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName,
					displayState,
					status: "ready",
					report: effectiveReport,
				},
				fingerprint: auth.fingerprint,
				rememberedTargetId: expectedTargetId,
			};
		} catch (error) {
			if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
			if (
				retryableAuthChanged &&
				authRetry === 0 &&
				!signal.aborted &&
				!requestContextChanged() &&
				Date.now() < deadlineAt
			) {
				if (queryId !== undefined && latestQueries.get(failureKey) === queryId) {
					latestQueries.delete(failureKey);
				}
				return queryAdapterState(
					ctx,
					adapter,
					displayState,
					true,
					signal,
					authRetry + 1,
					deadlineAt,
				);
			}
			const message = errorMessage(error);
			const now = Date.now();
			for (const [key, failure] of failureBackoff) {
				if (failure.until <= now) failureBackoff.delete(key);
			}
			if (queryId === undefined || latestQueries.get(failureKey) === queryId) {
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
					providerName,
					displayState,
					status: "query-failed",
					message,
				},
				fingerprint: auth.fingerprint,
				rememberedTargetId: expectedTargetId,
			};
		}
	};

	const loadTargetChoices = async (
		ctx: ExtensionContext,
		adapter: UsageProviderAdapter,
		signal: AbortSignal,
	) => {
		if (!adapter.targets) throw new Error("Provider does not support usage targets.");
		const expectedSessionGeneration = sessionGeneration;
		const expectedSessionId = ctx.sessionManager.getSessionId();
		const expectedModel = modelIdentity(ctx.model);
		const expectedTargetId = settingsRuntime.get().settings.selectedTargets[adapter.id];
		const deadlineAt = Date.now() + DEFAULT_TIMEOUT_MS;
		const changed = () =>
			expectedSessionGeneration !== sessionGeneration ||
			ctx.sessionManager.getSessionId() !== expectedSessionId ||
			modelIdentity(ctx.model) !== expectedModel ||
			settingsRuntime.get().settings.selectedTargets[adapter.id] !== expectedTargetId;
		const auth = await awaitWithDeadline(
			resolveUsageAuth(ctx, adapter, undefined, credentialReader, credentialCandidates),
			signal,
			Math.max(1, deadlineAt - Date.now()),
			`resolving ${providerDisplayName(ctx, adapter.id)} runtime auth`,
		);
		if (!auth || signal.aborted || changed()) throw abortError();
		const guard = async () => {
			if (signal.aborted || changed()) throw abortError();
			const revalidated = await awaitWithDeadline(
				resolveUsageAuth(ctx, adapter, undefined, credentialReader, credentialCandidates),
				signal,
				Math.max(1, deadlineAt - Date.now()),
				`revalidating ${providerDisplayName(ctx, adapter.id)} runtime auth`,
			);
			if (signal.aborted || changed() || revalidated?.fingerprint !== auth.fingerprint) {
				throw abortError();
			}
		};
		const choices = await listUsageTargets(
			adapter,
			auth,
			signal,
			Math.max(1, deadlineAt - Date.now()),
			guard,
		);
		return { choices, fingerprint: auth.fingerprint };
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
		if (adapter.publishesStatusline === false) {
			clearStatus(ctx);
			return;
		}
		statusGeneration += 1;
		const generation = statusGeneration;
		clearStatusCountdownTimer();
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
			const message = errorMessage(error);
			console.error("[pi-usage] refresh failed:", message);
			safeSetStatus(ctx, `usage err: ${message.slice(0, 50)}`);
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
		const selectionStillCurrent =
			!adapter?.targets ||
			settingsRuntime.get().settings.selectedTargets[adapter.id] === outcome.rememberedTargetId;
		if (!selectionStillCurrent) return false;
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
					(!adapter.targets ||
						settingsRuntime.get().settings.selectedTargets[adapter.id] ===
							outcome.rememberedTargetId) &&
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
				(!adapter.targets ||
					settingsRuntime.get().settings.selectedTargets[adapter.id] ===
						outcome.rememberedTargetId) &&
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
		clearStatusTimers();
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
			const actionableTargetState = (): ProviderUsageState | undefined => {
				if (visibleStates.length !== 1) return undefined;
				const state = visibleStates[0];
				return state &&
					(state.status === "ready" || state.status === "selection-required") &&
					adapterForProvider(state.providerId)?.targets
					? state
					: undefined;
			};
			const promptForTarget = async (
				state: ProviderUsageState,
				stateFingerprint?: string,
			): Promise<boolean> => {
				const adapter = adapterForProvider(state.providerId);
				if (!adapter?.targets) return false;
				const expectedRememberedTargetId =
					settingsRuntime.get().settings.selectedTargets[adapter.id];
				const snapshot =
					state.status === "selection-required" && stateFingerprint
						? { choices: state.choices, fingerprint: stateFingerprint }
						: await runMenuOperation(
								ctx,
								`Loading ${adapter.targets.pluralLabel}…`,
								controller.signal,
								(signal) => loadTargetChoices(ctx, adapter, signal),
							);
				if (!snapshot || controller.signal.aborted || statusGeneration !== menuGeneration) {
					return false;
				}
				const selectOptions = createUsageTargetSelectOptions(snapshot.choices);
				const selected = await ctx.ui.select(
					`Select ${adapter.targets.singularLabel} for ${providerDisplayName(ctx, adapter.id)}`,
					[...selectOptions.options],
					{ signal: controller.signal },
				);
				if (
					selected === undefined ||
					controller.signal.aborted ||
					statusGeneration !== menuGeneration ||
					settingsRuntime.get().settings.selectedTargets[adapter.id] !== expectedRememberedTargetId
				) {
					return false;
				}
				const targetId = selectOptions.targetIdFor(selected);
				if (!targetId) return false;
				const revalidated = await runMenuOperation(
					ctx,
					`Revalidating ${adapter.targets.singularLabel}…`,
					controller.signal,
					(signal) => loadTargetChoices(ctx, adapter, signal),
				);
				if (
					!revalidated ||
					controller.signal.aborted ||
					statusGeneration !== menuGeneration ||
					settingsRuntime.get().settings.selectedTargets[adapter.id] !== expectedRememberedTargetId
				) {
					return false;
				}
				if (
					revalidated.fingerprint !== snapshot.fingerprint ||
					!revalidated.choices.some((choice) => choice.id === targetId)
				) {
					ctx.ui.notify(
						`${providerDisplayName(ctx, adapter.id)} ${adapter.targets.pluralLabel} changed; choose again.`,
						"warning",
					);
					return false;
				}
				let saved: Readonly<UsageSettingsState> | undefined;
				try {
					saved = await runMenuOperation(
						ctx,
						`Saving ${adapter.targets.singularLabel}…`,
						controller.signal,
						(signal) =>
							settingsRuntime.updateSelectedTarget(adapter.id, targetId, signal, async () => {
								let published: Awaited<ReturnType<typeof loadTargetChoices>>;
								try {
									published = await loadTargetChoices(ctx, adapter, signal);
								} catch (error) {
									if (
										signal.aborted ||
										controller.signal.aborted ||
										statusGeneration !== menuGeneration ||
										isStaleExtensionContextError(error)
									) {
										throw error;
									}
									throw new UsageTargetSelectionChangedError();
								}
								if (
									published.fingerprint !== snapshot.fingerprint ||
									!published.choices.some((choice) => choice.id === targetId)
								) {
									throw new UsageTargetSelectionChangedError();
								}
							}),
					);
				} catch (error) {
					if (error instanceof UsageTargetSelectionChangedError) {
						ctx.ui.notify(
							`${providerDisplayName(ctx, adapter.id)} ${adapter.targets.pluralLabel} changed; choose again.`,
							"warning",
						);
						return false;
					}
					throw error;
				}
				if (!saved || controller.signal.aborted || statusGeneration !== menuGeneration) {
					return false;
				}
				invalidateProviderState(adapter.id);
				return true;
			};
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
				| "settings"
				| "target"
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
						const targetState = actionableTargetState();
						const targetAdapter = adapterForProvider(targetState?.providerId);
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
								{ id: "settings", label: SETTINGS, action: "settings" },
								...(targetState && targetAdapter?.targets
									? [
											{
												id: "target",
												label: `${targetState.status === "selection-required" ? "Select" : "Change"} ${targetAdapter.targets.singularLabel}…`,
												action: "target" as const,
											},
										]
									: []),
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
								label: providerDisplayName(ctx, adapter.id),
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
					target: async () => {
						const targetState = actionableTargetState();
						if (!targetState) return { kind: "rejected" };
						try {
							const stateFingerprint =
								targetState === current.state ? current.fingerprint : undefined;
							if (!(await promptForTarget(targetState, stateFingerprint))) {
								return { kind: "stay" };
							}
							const adapter = adapterForProvider(targetState.providerId);
							if (!adapter) return { kind: "rejected" };
							if (targetState.providerId === ctx.model?.provider) {
								const refreshed = await queryStableCurrent(
									ctx,
									true,
									controller,
									`Checking ${providerDisplayName(ctx, adapter.id)} usage…`,
								);
								if (!refreshed) return { kind: "stay" };
								stableCurrent = refreshed;
								current = refreshed.outcome;
								visibleStates = [current.state];
								publishStableCurrent(ctx, refreshed);
								return { kind: "stay" };
							}
							const outcome = await runMenuOperation(
								ctx,
								`Checking ${providerDisplayName(ctx, adapter.id)} usage…`,
								controller.signal,
								(signal) => queryAdapterState(ctx, adapter, "configured", true, signal),
							);
							if (!outcome) return { kind: "stay" };
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
								outcome.state.providerId === current.state.providerId
									? current.state
									: { ...outcome.state, displayState: "configured" },
							];
							return { kind: "stay" };
						} catch (error) {
							if (isAbortError(error) || isStaleExtensionContextError(error)) {
								return { kind: "stay" };
							}
							ctx.ui.notify(`Could not select target: ${errorMessage(error)}`, "error");
							return { kind: "stay" };
						}
					},
					settings: async () => {
						await showUsageSettings(
							ctx,
							settingsRuntime,
							controller.signal,
							() => statusGeneration === menuGeneration && !controller.signal.aborted,
							(id) => {
								if (
									id === "codexStatusResetCountdown" &&
									stableCurrent &&
									statusGeneration === menuGeneration &&
									!controller.signal.aborted
								) {
									publishStableCurrent(ctx, stableCurrent);
								}
							},
						);
						fastState = settingsRuntime.get();
						const revalidated = await queryStableCurrent(
							ctx,
							false,
							controller,
							"Applying usage settings…",
						);
						if (!revalidated) return { kind: "stay" };
						stableCurrent = revalidated;
						current = revalidated.outcome;
						visibleStates = [current.state];
						publishStableCurrent(ctx, revalidated);
						return { kind: "stay" };
					},
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
						let outcome = await runMenuOperation(
							ctx,
							`Checking ${providerDisplayName(ctx, adapter.id)} usage…`,
							controller.signal,
							(signal) => queryAdapterState(ctx, adapter, "configured", false, signal),
						);
						if (!outcome) return { kind: "back" };
						if (outcome.state.status === "selection-required") {
							if (!(await promptForTarget(outcome.state, outcome.fingerprint))) {
								return { kind: "back" };
							}
							outcome = await runMenuOperation(
								ctx,
								`Checking ${providerDisplayName(ctx, adapter.id)} usage…`,
								controller.signal,
								(signal) => queryAdapterState(ctx, adapter, "configured", true, signal),
							);
							if (!outcome) return { kind: "back" };
						}
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
								providerName: providerDisplayName(ctx, adapter.id),
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
	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration += 1;
		statusGeneration += 1;
		clearStatusTimers();
		for (const controller of activeControllers) controller.abort();
		activeControllers.clear();
		statusController = undefined;
		sessionActive = true;
		const ownerGeneration = sessionGeneration;
		try {
			await fastRuntime.prepareSession(ctx);
		} catch (error) {
			if (isStaleExtensionContextError(error) || ownerGeneration !== sessionGeneration) return;
			throw error;
		}
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
		sessionGeneration += 1;
		statusGeneration += 1;
		clearStatusTimers();
		for (const controller of activeControllers) controller.abort();
		activeControllers.clear();
		statusController = undefined;
		cache.clear();
		failureBackoff.clear();
		latestQueries.clear();
		activeCurrentIdentity = undefined;
		safeSetStatus(ctx, undefined);
	});

	fastRuntime = registerCodexFastMode(
		pi,
		settingsRuntime,
		(ctx) => startStatusRefresh(ctx, ctx.model, false),
		{ registerSessionStart: false },
	);
}
