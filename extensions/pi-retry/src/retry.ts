import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const UNKNOWN_NO_DETAILS_RE = /Unknown error \(no error details in response\)/i;
const CODEX_WEBSOCKET_CONNECTION_LIMIT_RE =
	/websocket[_\s-]*connection[_\s-]*limit[_\s-]*reached|create a new websocket connection to continue/i;
const CODEX_GENERIC_PROCESSING_ERROR_RE =
	/Codex error:[\s\S]*An error occurred while processing your request/i;
const CODEX_GENERIC_RETRY_PROMPT_RE = /You can retry your request/i;
const RETRYABLE_HINT = "provider returned error";
const UNKNOWN_ERROR_TAG = "[unknown-error-retry]";
const CODEX_WEBSOCKET_CONNECTION_LIMIT_TAG = "[codex-websocket-limit-retry]";
const CODEX_GENERIC_RETRY_TAG = "[codex-generic-retry]";
const STALL_WATCHDOG_TAG = "[stall-watchdog-retry]";
const STATUS_KEY = "unknown-error-retry";
const STATUS_VISIBLE_MS = 8_000;
const INCOMING_STATUS_VISIBLE_MS = 1_500;
const DEFAULT_STALL_TIMEOUT_MS = 90_000;
const STALL_TIMEOUT_FLAG = "retry-stall-timeout-ms";
const STALL_TIMEOUT_ENV = "PI_RETRY_STALL_TIMEOUT_MS";

type StatusContext = Pick<ExtensionContext, "hasUI" | "ui">;

type RetryPolicyContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

type WatchdogContext = StatusContext & Pick<ExtensionContext, "abort" | "isIdle">;

export type RetryPolicy = {
	enabled: boolean | undefined;
	errors: string[];
};

export type RetryOptions = {
	readRetryPolicy?: (ctx: RetryPolicyContext) => RetryPolicy;
};

type MessageShape = {
	role?: string;
	stopReason?: string;
	errorMessage?: unknown;
	[key: string]: unknown;
};

type StatusMode = "incoming" | "retry";

export function parseStallTimeoutMs(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") return undefined;

	const normalized = value.trim().toLowerCase();
	if (normalized === "0" || normalized === "off" || normalized === "false") return 0;

	const timeoutMs = Number(normalized);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return undefined;
	return Math.trunc(timeoutMs);
}

export function readPiRetryPolicy(ctx: RetryPolicyContext, agentDir = getAgentDir()): RetryPolicy {
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const errors = settingsManager
		.drainErrors()
		.map(({ scope, error }) => `${scope} settings: ${error.message}`);
	return {
		enabled: settingsManager.getRetrySettings().enabled,
		errors,
	};
}

export default function retry(pi: ExtensionAPI, options: RetryOptions = {}) {
	pi.registerFlag(STALL_TIMEOUT_FLAG, {
		description: `Abort and auto-retry stalled provider streams after this many ms; use 0/off/false to disable. Defaults to ${DEFAULT_STALL_TIMEOUT_MS}.`,
		type: "string",
	});

	let clearStatusTimer: NodeJS.Timeout | undefined;
	let statusMode: StatusMode | undefined;
	let stallTimer: NodeJS.Timeout | undefined;
	let providerWatchdogActive = false;
	let waitingForStallAbortMessage = false;
	let retryPolicyEnabled = true;
	let hasResolvedRetryPolicy = false;
	let warnedRetryPolicyDisabled = false;
	let warnedRetryPolicyReadFailure = false;

	const getStallTimeoutMs = () =>
		parseStallTimeoutMs(pi.getFlag(STALL_TIMEOUT_FLAG)) ??
		parseStallTimeoutMs(process.env[STALL_TIMEOUT_ENV]) ??
		DEFAULT_STALL_TIMEOUT_MS;

	const clearStatus = (ctx: StatusContext) => {
		if (clearStatusTimer) clearTimeout(clearStatusTimer);
		clearStatusTimer = undefined;
		statusMode = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const setTransientStatus = (
		ctx: StatusContext,
		mode: StatusMode,
		text: string,
		visibleMs: number,
	) => {
		if (clearStatusTimer) clearTimeout(clearStatusTimer);
		if (statusMode !== mode) ctx.ui.setStatus(STATUS_KEY, text);
		statusMode = mode;
		clearStatusTimer = setTimeout(() => {
			clearStatusTimer = undefined;
			if (statusMode !== mode) return;
			statusMode = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}, visibleMs);
	};

	const showRetryStatus = (ctx: StatusContext) => {
		setTransientStatus(ctx, "retry", "retrying", STATUS_VISIBLE_MS);
	};

	const showIncomingStatus = (ctx: StatusContext) => {
		setTransientStatus(ctx, "incoming", "receiving", INCOMING_STATUS_VISIBLE_MS);
	};

	const clearIncomingStatus = (ctx: StatusContext) => {
		if (statusMode === "incoming") clearStatus(ctx);
	};

	const disarmStallWatchdog = () => {
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = undefined;
	};

	const refreshRetryPolicy = (ctx: RetryPolicyContext & StatusContext) => {
		const policy = (options.readRetryPolicy ?? readPiRetryPolicy)(ctx);
		if (policy.errors.length > 0 && ctx.hasUI && !warnedRetryPolicyReadFailure) {
			warnedRetryPolicyReadFailure = true;
			const fallbackBehavior = hasResolvedRetryPolicy
				? "preserving the last known policy"
				: "using Pi's fallback policy";
			ctx.ui.notify(
				`pi-retry could not read Pi retry settings; ${fallbackBehavior}. ${policy.errors.join("; ")}`,
				"warning",
			);
		}
		if (policy.enabled === undefined) return;
		if (policy.errors.length > 0 && hasResolvedRetryPolicy) return;

		retryPolicyEnabled = policy.enabled;
		hasResolvedRetryPolicy = true;
		if (retryPolicyEnabled) return;

		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		clearStatus(ctx);
		if (ctx.hasUI && !warnedRetryPolicyDisabled) {
			warnedRetryPolicyDisabled = true;
			ctx.ui.notify(
				'pi-retry requires Pi setting "retry.enabled": true; retry hints and stall recovery are inactive while it is disabled.',
				"warning",
			);
		}
	};

	const armStallWatchdog = (ctx: WatchdogContext) => {
		disarmStallWatchdog();
		if (!retryPolicyEnabled) {
			providerWatchdogActive = false;
			return;
		}

		const timeoutMs = getStallTimeoutMs();
		if (timeoutMs === 0) {
			providerWatchdogActive = false;
			return;
		}

		providerWatchdogActive = true;
		stallTimer = setTimeout(() => {
			stallTimer = undefined;
			providerWatchdogActive = false;
			if (ctx.isIdle()) return;

			waitingForStallAbortMessage = true;
			if (ctx.hasUI) showRetryStatus(ctx);
			ctx.abort();
		}, timeoutMs);
	};

	const observeProviderOrStreamEvent = (ctx: WatchdogContext) => {
		if (!providerWatchdogActive || waitingForStallAbortMessage) return;
		if (ctx.isIdle()) {
			disarmStallWatchdog();
			providerWatchdogActive = false;
			clearIncomingStatus(ctx);
			return;
		}
		if (ctx.hasUI) showIncomingStatus(ctx);
		armStallWatchdog(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		clearStatus(ctx);
		refreshRetryPolicy(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		clearStatus(ctx);
	});

	pi.on("before_provider_request", (_event, ctx) => {
		refreshRetryPolicy(ctx);
		if (ctx.hasUI) clearIncomingStatus(ctx);
		armStallWatchdog(ctx);
	});

	pi.on("after_provider_response", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("message_start", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("message_update", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		if (ctx.hasUI) clearIncomingStatus(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as unknown as MessageShape;

		if (message.role !== "assistant") return;
		disarmStallWatchdog();
		providerWatchdogActive = false;
		if (ctx.hasUI) clearIncomingStatus(ctx);

		if (waitingForStallAbortMessage) {
			waitingForStallAbortMessage = false;
			const originalErrorMessage =
				typeof message.errorMessage === "string"
					? message.errorMessage
					: "Provider stream stalled while Pi was waiting for a response.";

			if (!originalErrorMessage.includes(STALL_WATCHDOG_TAG)) {
				const errorMessage = `${originalErrorMessage}\n\n${STALL_WATCHDOG_TAG} ${RETRYABLE_HINT}; treating stalled provider stream as retryable.`;

				return {
					message: {
						...message,
						stopReason: "error",
						errorMessage,
					} as typeof event.message,
				};
			}
		}

		if (message.stopReason !== "error") return;
		if (typeof message.errorMessage !== "string") return;

		const matchedError = UNKNOWN_NO_DETAILS_RE.test(message.errorMessage)
			? {
					tag: UNKNOWN_ERROR_TAG,
					label: "empty-detail provider failure",
					notification:
						"Matched provider 'Unknown error (no error details in response)'; letting pi auto-retry this turn.",
				}
			: CODEX_WEBSOCKET_CONNECTION_LIMIT_RE.test(message.errorMessage)
				? {
						tag: CODEX_WEBSOCKET_CONNECTION_LIMIT_TAG,
						label: "Codex websocket connection limit",
						notification:
							"Matched Codex websocket connection limit; letting pi auto-retry with a fresh websocket.",
					}
				: CODEX_GENERIC_PROCESSING_ERROR_RE.test(message.errorMessage) &&
						CODEX_GENERIC_RETRY_PROMPT_RE.test(message.errorMessage)
					? {
							tag: CODEX_GENERIC_RETRY_TAG,
							label: "Codex retryable backend failure",
							notification:
								"Matched Codex generic retryable backend failure; letting pi auto-retry this turn.",
						}
					: undefined;
		if (!matchedError) return;

		// Avoid appending the hint repeatedly if a resumed/replayed message already has it.
		if (message.errorMessage.includes(matchedError.tag)) return;

		// pi already has agent-level auto-retry for transient provider errors, but its
		// matcher does not classify a few provider-specific messages as retryable.
		// Adding this hint before the message is finalized makes pi's built-in auto-retry
		// path pick it up, remove the failed assistant message from live agent state, and
		// call agent.continue() with the normal retry settings/backoff.
		const errorMessage = `${message.errorMessage}\n\n${matchedError.tag} ${RETRYABLE_HINT}; treating ${matchedError.label} as retryable.`;

		if (ctx.hasUI && retryPolicyEnabled) {
			showRetryStatus(ctx);
			ctx.ui.notify?.(matchedError.notification, "warning");
		}

		return {
			message: {
				...message,
				errorMessage,
			} as typeof event.message,
		};
	});
}
