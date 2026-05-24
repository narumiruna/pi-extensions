import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const UNKNOWN_NO_DETAILS_RE = /Unknown error \(no error details in response\)/i;
const RETRYABLE_HINT = "provider returned error";
const UNKNOWN_ERROR_TAG = "[unknown-error-retry]";
const STALL_WATCHDOG_TAG = "[stall-watchdog-retry]";
const STATUS_KEY = "unknown-error-retry";
const STATUS_VISIBLE_MS = 8_000;
const INCOMING_STATUS_VISIBLE_MS = 1_500;
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_FLAG = "retry-stall-timeout-ms";
const STALL_TIMEOUT_ENV = "PI_RETRY_STALL_TIMEOUT_MS";

type StatusContext = Pick<ExtensionContext, "hasUI" | "ui">;

type WatchdogContext = StatusContext & Pick<ExtensionContext, "abort" | "isIdle">;

type MessageShape = {
	role?: string;
	stopReason?: string;
	errorMessage?: unknown;
	[key: string]: unknown;
};

type StatusMode = "incoming" | "retry";

function parseStallTimeoutMs(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") return undefined;

	const normalized = value.trim().toLowerCase();
	if (normalized === "0" || normalized === "off" || normalized === "false") return 0;

	const timeoutMs = Number(normalized);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return undefined;
	return Math.trunc(timeoutMs);
}

export default function retry(pi: ExtensionAPI) {
	pi.registerFlag(STALL_TIMEOUT_FLAG, {
		description: `Abort and auto-retry stalled provider streams after this many ms; use 0/off/false to disable. Defaults to ${DEFAULT_STALL_TIMEOUT_MS}.`,
		type: "string",
	});

	let clearStatusTimer: NodeJS.Timeout | undefined;
	let statusMode: StatusMode | undefined;
	let stallTimer: NodeJS.Timeout | undefined;
	let providerWatchdogActive = false;
	let waitingForStallAbortMessage = false;

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

	const setTransientStatus = (ctx: StatusContext, mode: StatusMode, text: string, visibleMs: number) => {
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
		setTransientStatus(ctx, "retry", "🔁 retrying", STATUS_VISIBLE_MS);
	};

	const showIncomingStatus = (ctx: StatusContext) => {
		setTransientStatus(ctx, "incoming", "📥 receiving", INCOMING_STATUS_VISIBLE_MS);
	};

	const clearIncomingStatus = (ctx: StatusContext) => {
		if (statusMode === "incoming") clearStatus(ctx);
	};

	const disarmStallWatchdog = () => {
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = undefined;
	};

	const armStallWatchdog = (ctx: WatchdogContext) => {
		disarmStallWatchdog();

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
	});

	pi.on("session_shutdown", (_event, ctx) => {
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		clearStatus(ctx);
	});

	pi.on("before_provider_request", (_event, ctx) => {
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
		if (!UNKNOWN_NO_DETAILS_RE.test(message.errorMessage)) return;

		// Avoid appending the hint repeatedly if a resumed/replayed message already has it.
		if (message.errorMessage.includes(UNKNOWN_ERROR_TAG)) return;

		// pi already has agent-level auto-retry for transient provider errors, but its
		// matcher does not classify this empty-detail "Unknown error" message as retryable.
		// Adding this hint before the message is finalized makes pi's built-in auto-retry
		// path pick it up, remove the failed assistant message from live agent state, and
		// call agent.continue() with the normal retry settings/backoff.
		const errorMessage = `${message.errorMessage}\n\n${UNKNOWN_ERROR_TAG} ${RETRYABLE_HINT}; treating empty-detail provider failure as retryable.`;

		if (ctx.hasUI) {
			showRetryStatus(ctx);
			ctx.ui.notify?.(
				"Matched provider 'Unknown error (no error details in response)'; letting pi auto-retry this turn.",
				"warning",
			);
		}

		return {
			message: {
				...message,
				errorMessage,
			} as typeof event.message,
		};
	});
}
