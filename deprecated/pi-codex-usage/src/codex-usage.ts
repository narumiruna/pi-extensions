import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatCodexUsageStatusline, formatQueryErrors, showReport } from "./format.js";
import { isOpenAICodexModel, isStaleExtensionContextError, queryUsage } from "./query.js";
import type {
	CachedReport,
	CodexUsageModel,
	CodexUsageReport,
	QueryUsageOptions,
} from "./types.js";

const COMMAND_NAME = "codex-status";
const DEFAULT_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const STATUS_KEY = "codex-usage";
export const DEPRECATION_WARNING_MESSAGE = [
	"@narumitw/pi-codex-usage is deprecated and will be replaced by @narumitw/pi-usage.",
	"Please migrate by running:",
	"  pi uninstall npm:@narumitw/pi-codex-usage",
	"  pi install npm:@narumitw/pi-usage",
	"Do not load both extensions at the same time.",
].join("\n");

interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "--refresh", label: "--refresh", description: "Refresh usage instead of cached data" },
	{
		value: "--no-statusline",
		label: "--no-statusline",
		description: "Do not update the statusline",
	},
	{
		value: "--clear-statusline",
		label: "--clear-statusline",
		description: "Clear the usage statusline",
	},
	{ value: "--timeout ", label: "--timeout", description: "Set query timeout in seconds" },
];

export default function codexUsage(pi: ExtensionAPI) {
	let cache: CachedReport | undefined;
	let statuslineClearTimer: ReturnType<typeof setTimeout> | undefined;
	let statuslineRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let statuslineRequestId = 0;
	let sessionActive = false;
	let activeStatuslineContext: ExtensionContext | undefined;
	let deprecationWarningShown = false;

	const clearStatuslineTimers = () => {
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
		statuslineClearTimer = undefined;
		statuslineRefreshTimer = undefined;
	};

	const handleStaleContextError = (ctx: ExtensionContext, error: unknown): boolean => {
		if (!isStaleExtensionContextError(error)) return false;
		if (ctx === activeStatuslineContext) {
			statuslineRequestId += 1;
			clearStatuslineTimers();
			activeStatuslineContext = undefined;
		}
		return true;
	};

	const rethrowUnlessStaleContextError = (ctx: ExtensionContext) => (error: unknown) => {
		if (!handleStaleContextError(ctx, error)) throw error;
	};

	const setStatuslineValue = (ctx: ExtensionContext, value: string | undefined): boolean => {
		try {
			ctx.ui.setStatus(STATUS_KEY, value);
			return true;
		} catch (error) {
			if (handleStaleContextError(ctx, error)) return false;
			throw error;
		}
	};

	const clearUsageStatusline = (ctx: ExtensionContext) => {
		statuslineRequestId += 1;
		clearStatuslineTimers();
		activeStatuslineContext = undefined;
		setStatuslineValue(ctx, undefined);
	};

	const scheduleTemporaryStatuslineClear = (ctx: ExtensionContext) => {
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		const requestId = statuslineRequestId;
		statuslineClearTimer = setTimeout(() => {
			statuslineClearTimer = undefined;
			if (!sessionActive || requestId !== statuslineRequestId) return;
			setStatuslineValue(ctx, undefined);
		}, CACHE_TTL_MS);
		statuslineClearTimer.unref?.();
	};

	const scheduleStatuslineRefresh = (ctx: ExtensionContext, model: CodexUsageModel | undefined) => {
		if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
		const requestId = statuslineRequestId;
		statuslineRefreshTimer = setTimeout(() => {
			statuslineRefreshTimer = undefined;
			if (!sessionActive || requestId !== statuslineRequestId) return;
			void refreshCurrentCodexUsageStatusline(ctx, true, model).catch(
				rethrowUnlessStaleContextError(ctx),
			);
		}, CACHE_TTL_MS);
		statuslineRefreshTimer.unref?.();
	};

	const setUsageStatusline = (
		ctx: ExtensionContext,
		report: CodexUsageReport,
		options: { autoRefresh: boolean; model: CodexUsageModel | undefined },
	) => {
		if (!setStatuslineValue(ctx, formatCodexUsageStatusline(report, options.model))) return;
		activeStatuslineContext = ctx;
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		statuslineClearTimer = undefined;
		if (options.autoRefresh) scheduleStatuslineRefresh(ctx, options.model);
		else scheduleTemporaryStatuslineClear(ctx);
	};

	const refreshCurrentCodexUsageStatusline = async (
		ctx: ExtensionContext,
		force: boolean,
		model?: CodexUsageModel,
	) => {
		if (!sessionActive) return;
		activeStatuslineContext = ctx;
		const selectedModel = model ?? ctx.model;
		if (!isOpenAICodexModel(selectedModel)) {
			clearUsageStatusline(ctx);
			return;
		}

		const requestId = statuslineRequestId + 1;
		statuslineRequestId = requestId;
		const cached = cache && Date.now() - cache.createdAt < CACHE_TTL_MS ? cache : undefined;
		if (cached && !force) {
			setUsageStatusline(ctx, cached.report, { autoRefresh: true, model: selectedModel });
			return;
		}

		if (!setStatuslineValue(ctx, "checking")) return;
		const result = await queryUsage(ctx, { timeoutMs: DEFAULT_TIMEOUT_MS });
		if (!sessionActive || requestId !== statuslineRequestId) return;

		if (!result.ok) {
			if (setStatuslineValue(ctx, "usage error")) {
				scheduleStatuslineRefresh(ctx, selectedModel);
			}
			return;
		}

		cache = { createdAt: Date.now(), report: result.report };
		setUsageStatusline(ctx, result.report, { autoRefresh: true, model: selectedModel });
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Show Codex ChatGPT subscription usage and rate-limit windows",
		getArgumentCompletions: completeCodexStatusArguments,
		handler: async (args, ctx) => {
			try {
				const options = parseArgs(args);
				if (!options.ok) {
					ctx.ui.notify(options.error, "warning");
					return;
				}

				if (options.value.clearStatusline) {
					clearUsageStatusline(ctx);
					ctx.ui.notify("Codex usage statusline cleared.", "info");
					return;
				}

				const cached = cache && Date.now() - cache.createdAt < CACHE_TTL_MS ? cache : undefined;
				if (cached && !options.value.refresh) {
					if (options.value.statusline) {
						setUsageStatusline(ctx, cached.report, {
							autoRefresh: isOpenAICodexModel(ctx.model),
							model: ctx.model,
						});
					}
					showReport(ctx, cached.report, true);
					return;
				}

				let keepStatusline = false;
				const statuslineStarted = options.value.statusline && setStatuslineValue(ctx, "checking");
				try {
					const result = await queryUsage(ctx, options.value);
					if (!result.ok) {
						ctx.ui.notify(formatQueryErrors(result.errors), "error");
						return;
					}

					cache = { createdAt: Date.now(), report: result.report };
					if (options.value.statusline) {
						setUsageStatusline(ctx, result.report, {
							autoRefresh: isOpenAICodexModel(ctx.model),
							model: ctx.model,
						});
						keepStatusline = true;
					}
					showReport(ctx, result.report, false);
				} finally {
					if (statuslineStarted && !keepStatusline) setStatuslineValue(ctx, undefined);
				}
			} catch (error) {
				if (handleStaleContextError(ctx, error)) return;
				throw error;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!deprecationWarningShown) {
			ctx.ui.notify(DEPRECATION_WARNING_MESSAGE, "warning");
			deprecationWarningShown = true;
		}
		sessionActive = true;
		if (isOpenAICodexModel(ctx.model)) {
			void refreshCurrentCodexUsageStatusline(ctx, false, ctx.model).catch(
				rethrowUnlessStaleContextError(ctx),
			);
		} else {
			clearUsageStatusline(ctx);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) {
			void refreshCurrentCodexUsageStatusline(ctx, false, ctx.model).catch(
				rethrowUnlessStaleContextError(ctx),
			);
		} else {
			clearUsageStatusline(ctx);
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (isOpenAICodexModel(event.model)) {
			void refreshCurrentCodexUsageStatusline(ctx, false, event.model).catch(
				rethrowUnlessStaleContextError(ctx),
			);
		} else {
			clearUsageStatusline(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
		clearUsageStatusline(ctx);
	});
}

export function completeCodexStatusArguments(
	argumentPrefix: string,
): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	if (prefix === "") return [...COMMAND_COMPLETIONS];

	const trailingSpace = /\s$/.test(prefix);
	const tokens = prefix.trimEnd().split(/\s+/).filter(Boolean);
	const previous = tokens.at(-1);
	if (previous === "--timeout" && trailingSpace) return null;
	if (!trailingSpace && tokens.at(-2) === "--timeout") return null;

	const current = trailingSpace ? "" : (previous ?? "");
	if (current && !current.startsWith("-")) return null;

	const currentRaw = trailingSpace ? "" : (prefix.match(/\S+$/)?.[0] ?? "");
	const completionPrefix = trailingSpace
		? prefix
		: prefix.slice(0, prefix.length - currentRaw.length);
	const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(current));
	return matches.length > 0
		? matches.map((item) => ({ ...item, value: `${completionPrefix}${item.value}` }))
		: null;
}

export function parseArgs(
	args: string,
): { ok: true; value: QueryUsageOptions } | { ok: false; error: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let clearStatusline = false;
	let refresh = false;
	let statusline = true;
	let timeoutMs = DEFAULT_TIMEOUT_MS;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--clear-statusline") {
			clearStatusline = true;
			continue;
		}
		if (token === "--no-statusline") {
			statusline = false;
			continue;
		}
		if (token === "--refresh") {
			refresh = true;
			continue;
		}
		if (token === "--timeout") {
			const rawValue = tokens[index + 1];
			if (!rawValue)
				return { ok: false, error: "Usage: /codex-status [--refresh] [--timeout seconds]" };
			const parsed = Number(rawValue);
			if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 120) {
				return { ok: false, error: "--timeout must be a number of seconds between 1 and 120." };
			}
			timeoutMs = Math.round(parsed * 1000);
			index += 1;
			continue;
		}
		return {
			ok: false,
			error: `Unknown option: ${token}. Usage: /codex-status [--refresh] [--no-statusline] [--clear-statusline] [--timeout seconds]`,
		};
	}

	return { ok: true, value: { clearStatusline, refresh, statusline, timeoutMs } };
}

export { formatCodexUsageReport, formatCodexUsageStatusline } from "./format.js";
export { normalizeAppServerResponse, normalizeBackendPayload } from "./normalize.js";
export { isStaleExtensionContextError } from "./query.js";
export type {
	CodexUsageModel,
	CodexUsageReport,
	NormalizedCredits,
	NormalizedRateLimitResetCredit,
	NormalizedRateLimitResetCredits,
	NormalizedRateLimitSnapshot,
	NormalizedRateLimitWindow,
} from "./types.js";
