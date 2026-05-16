import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const COMMAND_NAME = "codex-status";
const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const STATUS_KEY = "codex-usage";
const BAR_SEGMENTS = 20;
const MAX_ERROR_BODY_CHARS = 600;

type UsageSource = "pi-auth" | "codex-app-server";
type PiModel = NonNullable<ExtensionContext["model"]>;

type QueryUsageOptions = {
	clearStatusline: boolean;
	refresh: boolean;
	statusline: boolean;
	timeoutMs: number;
};

type CachedReport = {
	createdAt: number;
	report: CodexUsageReport;
};

type QueryUsageResult =
	| { ok: true; report: CodexUsageReport }
	| { ok: false; errors: UsageQueryError[] };

type UsageQueryError = {
	source: UsageSource;
	message: string;
	cause?: unknown;
};

export type CodexUsageReport = {
	source: UsageSource;
	capturedAt: number;
	planType?: string;
	snapshots: NormalizedRateLimitSnapshot[];
};

export type NormalizedRateLimitSnapshot = {
	limitId: string;
	limitName?: string;
	primary?: NormalizedRateLimitWindow;
	secondary?: NormalizedRateLimitWindow;
	credits?: NormalizedCredits;
};

export type NormalizedRateLimitWindow = {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
};

export type NormalizedCredits = {
	hasCredits: boolean;
	unlimited: boolean;
	balance?: string;
};

type RateLimitStatusPayload = {
	plan_type?: unknown;
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
	credits?: unknown;
};

type BackendRateLimitDetails = {
	primary_window?: unknown;
	secondary_window?: unknown;
};

type BackendWindowSnapshot = {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
};

type BackendAdditionalRateLimit = {
	limit_name?: unknown;
	metered_feature?: unknown;
	rate_limit?: unknown;
};

type BackendCreditsSnapshot = {
	has_credits?: unknown;
	unlimited?: unknown;
	balance?: unknown;
};

type AppServerRateLimitResponse = {
	rateLimits?: unknown;
	rateLimitsByLimitId?: unknown;
};

type AppServerRateLimitSnapshot = {
	limitId?: unknown;
	limitName?: unknown;
	primary?: unknown;
	secondary?: unknown;
	credits?: unknown;
	planType?: unknown;
};

type AppServerWindowSnapshot = {
	usedPercent?: unknown;
	windowDurationMins?: unknown;
	resetsAt?: unknown;
};

type AppServerCreditsSnapshot = {
	hasCredits?: unknown;
	unlimited?: unknown;
	balance?: unknown;
};

type RpcResponse = {
	id?: unknown;
	result?: unknown;
	error?: { message?: unknown; code?: unknown };
};

type PendingRpc = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

export default function codexUsage(pi: ExtensionAPI) {
	let cache: CachedReport | undefined;
	let statuslineClearTimer: ReturnType<typeof setTimeout> | undefined;
	let statuslineRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let statuslineRequestId = 0;

	const clearStatuslineTimers = () => {
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
		statuslineClearTimer = undefined;
		statuslineRefreshTimer = undefined;
	};

	const clearUsageStatusline = (ctx: ExtensionContext) => {
		statuslineRequestId += 1;
		clearStatuslineTimers();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const scheduleTemporaryStatuslineClear = (ctx: ExtensionContext) => {
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		statuslineClearTimer = setTimeout(() => {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			statuslineClearTimer = undefined;
		}, CACHE_TTL_MS);
		statuslineClearTimer.unref?.();
	};

	const scheduleStatuslineRefresh = (ctx: ExtensionContext) => {
		if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
		statuslineRefreshTimer = setTimeout(() => {
			void refreshCurrentCodexUsageStatusline(ctx, true);
		}, CACHE_TTL_MS);
		statuslineRefreshTimer.unref?.();
	};

	const setUsageStatusline = (
		ctx: ExtensionContext,
		report: CodexUsageReport,
		options: { autoRefresh: boolean },
	) => {
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		statuslineClearTimer = undefined;
		ctx.ui.setStatus(STATUS_KEY, formatCodexUsageStatusline(report));
		if (options.autoRefresh) scheduleStatuslineRefresh(ctx);
		else scheduleTemporaryStatuslineClear(ctx);
	};

	const refreshCurrentCodexUsageStatusline = async (ctx: ExtensionContext, force: boolean) => {
		if (!isOpenAICodexModel(ctx.model)) {
			clearUsageStatusline(ctx);
			return;
		}

		const requestId = statuslineRequestId + 1;
		statuslineRequestId = requestId;
		const cached = cache && Date.now() - cache.createdAt < CACHE_TTL_MS ? cache : undefined;
		if (cached && !force) {
			setUsageStatusline(ctx, cached.report, { autoRefresh: true });
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, "codex usage: checking");
		const result = await queryUsage(ctx, { timeoutMs: DEFAULT_TIMEOUT_MS });
		if (requestId !== statuslineRequestId) return;
		if (!isOpenAICodexModel(ctx.model)) {
			clearUsageStatusline(ctx);
			return;
		}

		if (!result.ok) {
			ctx.ui.setStatus(STATUS_KEY, "codex usage error");
			scheduleStatuslineRefresh(ctx);
			return;
		}

		cache = { createdAt: Date.now(), report: result.report };
		setUsageStatusline(ctx, result.report, { autoRefresh: true });
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Show Codex ChatGPT subscription usage and rate-limit windows",
		handler: async (args, ctx) => {
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
					setUsageStatusline(ctx, cached.report, { autoRefresh: isOpenAICodexModel(ctx.model) });
				}
				showReport(ctx, cached.report, true);
				return;
			}

			let keepStatusline = false;
			if (options.value.statusline) ctx.ui.setStatus(STATUS_KEY, "codex usage: checking");
			try {
				const result = await queryUsage(ctx, options.value);
				if (!result.ok) {
					ctx.ui.notify(formatQueryErrors(result.errors), "error");
					return;
				}

				cache = { createdAt: Date.now(), report: result.report };
				if (options.value.statusline) {
					setUsageStatusline(ctx, result.report, { autoRefresh: isOpenAICodexModel(ctx.model) });
					keepStatusline = true;
				}
				showReport(ctx, result.report, false);
			} finally {
				if (options.value.statusline && !keepStatusline) ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) void refreshCurrentCodexUsageStatusline(ctx, false);
		else clearUsageStatusline(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) void refreshCurrentCodexUsageStatusline(ctx, false);
		else clearUsageStatusline(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		if (isOpenAICodexModel(event.model)) void refreshCurrentCodexUsageStatusline(ctx, false);
		else clearUsageStatusline(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => clearUsageStatusline(ctx));
}

function parseArgs(
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

function isOpenAICodexModel(model: ExtensionContext["model"]): boolean {
	return model?.provider === CODEX_PROVIDER_ID;
}

async function queryUsage(
	ctx: ExtensionContext,
	options: Pick<QueryUsageOptions, "timeoutMs">,
): Promise<QueryUsageResult> {
	const errors: UsageQueryError[] = [];

	try {
		const report = await queryViaPiAuth(ctx, options.timeoutMs);
		return { ok: true, report };
	} catch (cause) {
		errors.push({ source: "pi-auth", message: errorMessage(cause), cause });
	}

	try {
		const report = await queryViaCodexAppServer(options.timeoutMs);
		return { ok: true, report };
	} catch (cause) {
		errors.push({ source: "codex-app-server", message: errorMessage(cause), cause });
	}

	return { ok: false, errors };
}

async function queryViaPiAuth(
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<CodexUsageReport> {
	const auth = await resolvePiCodexAuth(ctx);
	if (!auth) {
		throw new Error(
			"No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
		);
	}

	const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers: auth.headers }, timeoutMs);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
		);
	}

	const payload = parseJsonObject(text, "Codex usage endpoint response");
	return normalizeBackendPayload(payload as RateLimitStatusPayload, Date.now(), "pi-auth");
}

async function resolvePiCodexAuth(
	ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
	const models = codexAuthCandidateModels(ctx);
	const errors: string[] = [];

	for (const model of models) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			errors.push(auth.error);
			continue;
		}

		const headers = { ...(auth.headers ?? {}) };
		if (!hasHeader(headers, "Authorization") && auth.apiKey) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
		if (!hasHeader(headers, "User-Agent")) {
			headers["User-Agent"] = "pi-codex-usage";
		}
		if (hasHeader(headers, "Authorization")) {
			return { headers };
		}
	}

	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
	return undefined;
}

function codexAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: PiModel | undefined) => {
		if (!model || model.provider !== CODEX_PROVIDER_ID) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};

	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable()) add(model);
	for (const model of ctx.modelRegistry.getAll()) add(model);
	return candidates;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(
				`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching Codex usage.`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function queryViaCodexAppServer(timeoutMs: number): Promise<CodexUsageReport> {
	const client = new CodexAppServerClient(timeoutMs);
	try {
		await client.start();
		await client.request("initialize", {
			clientInfo: {
				name: "pi_codex_usage",
				title: "Pi Codex Usage",
				version: "0.1.0",
			},
			capabilities: {
				experimentalApi: false,
				requestAttestation: false,
				optOutNotificationMethods: [],
			},
		});
		client.notify("initialized");
		const result = await client.request("account/rateLimits/read", undefined);
		return normalizeAppServerResponse(
			assertObject(result, "account/rateLimits/read result") as AppServerRateLimitResponse,
			Date.now(),
		);
	} finally {
		client.dispose();
	}
}

class CodexAppServerClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private stderr = "";
	private readonly pending = new Map<number, PendingRpc>();
	private startPromise?: Promise<void>;
	private exitError?: Error;
	private readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		this.timeoutMs = timeoutMs;
	}

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise;

		this.startPromise = new Promise((resolve, reject) => {
			const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;

			const startupTimeout = setTimeout(() => {
				reject(
					new Error(
						`Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`,
					),
				);
			}, this.timeoutMs);

			child.once("spawn", () => {
				clearTimeout(startupTimeout);
				resolve();
			});

			child.once("error", (error) => {
				clearTimeout(startupTimeout);
				reject(new Error(`Failed to start codex app-server: ${error.message}`));
				this.rejectAll(error);
			});

			child.once("exit", (code, signal) => {
				const suffix = this.stderr ? ` stderr: ${redactErrorBody(this.stderr)}` : "";
				this.exitError = new Error(
					`codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"}).${suffix}`,
				);
				this.rejectAll(this.exitError);
			});

			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
			});

			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => this.handleLine(line));
		});

		return this.startPromise;
	}

	request(method: string, params: unknown): Promise<unknown> {
		const child = this.child;
		if (!child?.stdin.writable) {
			throw new Error("codex app-server is not running.");
		}
		if (this.exitError) throw this.exitError;

		const id = this.nextId++;
		const payload = params === undefined ? { method, id } : { method, id, params };
		const response = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`),
				);
			}, this.timeoutMs);

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
		});

		child.stdin.write(`${JSON.stringify(payload)}\n`);
		return response;
	}

	notify(method: string): void {
		const child = this.child;
		if (!child?.stdin.writable) return;
		child.stdin.write(`${JSON.stringify({ method })}\n`);
	}

	dispose(): void {
		for (const [id, pending] of this.pending) {
			pending.reject(new Error(`codex app-server request ${id} cancelled.`));
		}
		this.pending.clear();

		const child = this.child;
		if (!child) return;
		child.stdin.end();
		if (!child.killed) child.kill();
		this.child = undefined;
	}

	private handleLine(line: string): void {
		let parsed: RpcResponse;
		try {
			parsed = JSON.parse(line) as RpcResponse;
		} catch {
			return;
		}

		if (typeof parsed.id !== "number") return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);

		if (parsed.error) {
			const message =
				typeof parsed.error.message === "string" ? parsed.error.message : "unknown error";
			pending.reject(new Error(`codex app-server request failed: ${message}`));
			return;
		}

		pending.resolve(parsed.result);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

export function normalizeBackendPayload(
	payload: RateLimitStatusPayload,
	capturedAt: number,
	source: UsageSource,
): CodexUsageReport {
	const snapshots: NormalizedRateLimitSnapshot[] = [];
	const planType = asString(payload.plan_type);
	const primary = normalizeBackendSnapshot("codex", undefined, payload.rate_limit, payload.credits);
	if (primary) snapshots.push(primary);

	const additional = Array.isArray(payload.additional_rate_limits)
		? payload.additional_rate_limits
		: [];
	for (const item of additional) {
		const additionalLimit = assertObject(
			item,
			"additional rate limit",
		) as BackendAdditionalRateLimit;
		const limitId =
			asString(additionalLimit.metered_feature) ?? asString(additionalLimit.limit_name);
		if (!limitId) continue;
		const snapshot = normalizeBackendSnapshot(
			limitId,
			asString(additionalLimit.limit_name),
			additionalLimit.rate_limit,
			undefined,
		);
		if (snapshot) snapshots.push(snapshot);
	}

	if (snapshots.length === 0) {
		throw new Error("Codex usage endpoint returned no displayable rate-limit windows.");
	}

	return { source, capturedAt, planType, snapshots };
}

function normalizeBackendSnapshot(
	limitId: string,
	limitName: string | undefined,
	rateLimit: unknown,
	credits: unknown,
): NormalizedRateLimitSnapshot | undefined {
	if (rateLimit === null || rateLimit === undefined) {
		const normalizedCredits = normalizeBackendCredits(credits);
		return normalizedCredits ? { limitId, limitName, credits: normalizedCredits } : undefined;
	}

	const details = assertObject(rateLimit, "rate limit") as BackendRateLimitDetails;
	const primary = normalizeBackendWindow(details.primary_window);
	const secondary = normalizeBackendWindow(details.secondary_window);
	const normalizedCredits = normalizeBackendCredits(credits);

	if (!primary && !secondary && !normalizedCredits) return undefined;
	return { limitId, limitName, primary, secondary, credits: normalizedCredits };
}

function normalizeBackendWindow(value: unknown): NormalizedRateLimitWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = assertObject(value, "rate-limit window") as BackendWindowSnapshot;
	const usedPercent = asNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const limitSeconds = asNumber(window.limit_window_seconds);
	const resetsAt = asNumber(window.reset_at);
	return {
		usedPercent,
		windowMinutes: limitSeconds && limitSeconds > 0 ? Math.ceil(limitSeconds / 60) : undefined,
		resetsAt,
	};
}

function normalizeBackendCredits(value: unknown): NormalizedCredits | undefined {
	if (value === null || value === undefined) return undefined;
	const credits = assertObject(value, "credits") as BackendCreditsSnapshot;
	const hasCredits = asBoolean(credits.has_credits);
	const unlimited = asBoolean(credits.unlimited);
	if (hasCredits === undefined || unlimited === undefined) return undefined;
	return { hasCredits, unlimited, balance: asString(credits.balance) };
}

export function normalizeAppServerResponse(
	response: AppServerRateLimitResponse,
	capturedAt: number,
): CodexUsageReport {
	const snapshots: NormalizedRateLimitSnapshot[] = [];
	const addSnapshot = (raw: unknown, fallbackId: string) => {
		const snapshot = normalizeAppServerSnapshot(raw, fallbackId);
		if (!snapshot) return;
		const existingIndex = snapshots.findIndex((item) => item.limitId === snapshot.limitId);
		if (existingIndex >= 0)
			snapshots[existingIndex] = mergeSnapshot(snapshots[existingIndex], snapshot);
		else snapshots.push(snapshot);
	};

	addSnapshot(response.rateLimits, "codex");
	if (response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object") {
		for (const [limitId, raw] of Object.entries(response.rateLimitsByLimitId)) {
			addSnapshot(raw, limitId);
		}
	}

	if (snapshots.length === 0) {
		throw new Error("codex app-server returned no displayable rate-limit windows.");
	}

	const planType = asAppServerPlanType(response.rateLimits);
	return { source: "codex-app-server", capturedAt, planType, snapshots };
}

function asAppServerPlanType(raw: unknown): string | undefined {
	if (raw === null || raw === undefined) return undefined;
	const snapshot = assertObject(
		raw,
		"app-server rate-limit snapshot",
	) as AppServerRateLimitSnapshot;
	return asString(snapshot.planType);
}

function normalizeAppServerSnapshot(
	raw: unknown,
	fallbackId: string,
): NormalizedRateLimitSnapshot | undefined {
	if (raw === null || raw === undefined) return undefined;
	const snapshot = assertObject(
		raw,
		"app-server rate-limit snapshot",
	) as AppServerRateLimitSnapshot;
	const limitId = asString(snapshot.limitId) ?? fallbackId;
	const limitName = asString(snapshot.limitName);
	const primary = normalizeAppServerWindow(snapshot.primary);
	const secondary = normalizeAppServerWindow(snapshot.secondary);
	const credits = normalizeAppServerCredits(snapshot.credits);
	if (!primary && !secondary && !credits) return undefined;
	return { limitId, limitName, primary, secondary, credits };
}

function normalizeAppServerWindow(value: unknown): NormalizedRateLimitWindow | undefined {
	if (value === null || value === undefined) return undefined;
	const window = assertObject(value, "app-server rate-limit window") as AppServerWindowSnapshot;
	const usedPercent = asNumber(window.usedPercent);
	if (usedPercent === undefined) return undefined;
	return {
		usedPercent,
		windowMinutes: asNumber(window.windowDurationMins),
		resetsAt: asNumber(window.resetsAt),
	};
}

function normalizeAppServerCredits(value: unknown): NormalizedCredits | undefined {
	if (value === null || value === undefined) return undefined;
	const credits = assertObject(value, "app-server credits") as AppServerCreditsSnapshot;
	const hasCredits = asBoolean(credits.hasCredits);
	const unlimited = asBoolean(credits.unlimited);
	if (hasCredits === undefined || unlimited === undefined) return undefined;
	return { hasCredits, unlimited, balance: asString(credits.balance) };
}

function mergeSnapshot(
	left: NormalizedRateLimitSnapshot,
	right: NormalizedRateLimitSnapshot,
): NormalizedRateLimitSnapshot {
	return {
		limitId: right.limitId || left.limitId,
		limitName: right.limitName ?? left.limitName,
		primary: right.primary ?? left.primary,
		secondary: right.secondary ?? left.secondary,
		credits: right.credits ?? left.credits,
	};
}

export function formatCodexUsageReport(report: CodexUsageReport, cacheAgeMs?: number): string {
	const lines = ["Codex usage"];
	const source = report.source === "pi-auth" ? "Pi auth direct" : "Codex app-server";
	lines.push(
		`Source: ${source}${cacheAgeMs === undefined ? "" : ` (cached ${formatDuration(cacheAgeMs)} ago)`}`,
	);
	if (report.planType) lines.push(`Plan: ${formatPlanType(report.planType)}`);
	lines.push("");

	for (const snapshot of report.snapshots) {
		const label = snapshot.limitName ?? snapshot.limitId;
		if (report.snapshots.length > 1 || !label.toLowerCase().includes("codex")) {
			lines.push(`${label}:`);
		}
		if (snapshot.primary)
			lines.push(
				`  ${windowLabel(snapshot.primary, "5h")} limit: ${formatWindow(snapshot.primary)}`,
			);
		if (snapshot.secondary) {
			lines.push(
				`  ${windowLabel(snapshot.secondary, "weekly")} limit: ${formatWindow(snapshot.secondary)}`,
			);
		}
		if (snapshot.credits && shouldShowCredits(snapshot.credits)) {
			lines.push(`  Credits: ${formatCredits(snapshot.credits)}`);
		}
		if (!snapshot.primary && !snapshot.secondary && !snapshot.credits) {
			lines.push("  Limits: not available for this account");
		}
	}

	return lines.join("\n");
}

export function formatCodexUsageStatusline(report: CodexUsageReport): string {
	const snapshot =
		report.snapshots.find((item) => item.limitId.toLowerCase() === "codex") ??
		report.snapshots[0];
	if (!snapshot) return "codex usage unavailable";

	const parts = ["codex"];
	if (snapshot.primary) parts.push(`${formatRemainingPercent(snapshot.primary)} 5h`);
	if (snapshot.secondary) parts.push(`${formatRemainingPercent(snapshot.secondary)} wk`);
	if (parts.length === 1 && snapshot.credits) parts.push(formatCredits(snapshot.credits));
	return parts.join(" ");
}

function formatRemainingPercent(window: NormalizedRateLimitWindow): string {
	return `${(100 - clampPercent(window.usedPercent)).toFixed(0)}%`;
}

function showReport(
	ctx: ExtensionCommandContext,
	report: CodexUsageReport,
	fromCache: boolean,
): void {
	const text = formatCodexUsageReport(
		report,
		fromCache ? Date.now() - report.capturedAt : undefined,
	);
	ctx.ui.notify(text, "info");
}

function formatWindow(window: NormalizedRateLimitWindow): string {
	const used = clampPercent(window.usedPercent);
	const remaining = 100 - used;
	const reset = window.resetsAt ? `, resets ${formatReset(window.resetsAt)}` : "";
	return `${progressBar(remaining)} ${remaining.toFixed(0)}% left (${used.toFixed(0)}% used${reset})`;
}

function progressBar(percentRemaining: number): string {
	const filled = Math.round((clampPercent(percentRemaining) / 100) * BAR_SEGMENTS);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function windowLabel(window: NormalizedRateLimitWindow, fallback: string): string {
	if (!window.windowMinutes) return fallback;
	const mins = window.windowMinutes;
	if (mins < 60) return `${mins}m`;
	if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
	if (mins === 60 * 24 * 7) return "weekly";
	if (mins % (60 * 24) === 0) return `${Math.round(mins / (60 * 24))}d`;
	return `${mins}m`;
}

function formatCredits(credits: NormalizedCredits): string {
	if (!credits.hasCredits) return "not enabled";
	if (credits.unlimited) return "unlimited";
	const balance = credits.balance?.trim();
	if (!balance) return "available";
	return `${formatNumber(Number(balance), balance)} credits`;
}

function shouldShowCredits(_credits: NormalizedCredits): boolean {
	return true;
}

function formatReset(epochSeconds: number): string {
	const reset = new Date(epochSeconds * 1000);
	if (Number.isNaN(reset.getTime())) return "at an unknown time";

	const now = new Date();
	const time = reset.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (reset.toDateString() === now.toDateString()) return time;
	const day = reset.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return `${time} on ${day}`;
}

function formatQueryErrors(errors: UsageQueryError[]): string {
	const lines = ["Unable to read Codex usage."];
	for (const error of errors) {
		const source = error.source === "pi-auth" ? "Pi auth direct" : "Codex app-server fallback";
		lines.push(`- ${source}: ${error.message}`);
	}
	lines.push("");
	lines.push(
		"Tip: use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro. If Pi auth is unavailable, install Codex CLI and run codex login for the fallback.",
	);
	return lines.join("\n");
}

function formatPlanType(planType: string): string {
	const key = planType
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_");
	if (key === "pro_lite" || key === "prolite") return "Pro Lite";
	if (key === "team" || key === "self_serve_business_usage_based" || key === "business") {
		return "Business";
	}
	if (key === "enterprise_cbp_usage_based") return "Enterprise";

	const normalized = planType
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();
	if (!normalized) return planType;
	return normalized
		.split(/\s+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join(" ");
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return `${hours}h`;
}

function formatNumber(value: number, fallback: string): string {
	if (!Number.isFinite(value)) return fallback;
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function parseJsonObject(text: string, description: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${description} was not valid JSON: ${errorMessage(error)}`);
	}
	return assertObject(parsed, description);
}

function assertObject(value: unknown, description: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${description} was not an object.`);
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function redactErrorBody(body: string): string {
	return truncateEnd(
		body
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
			.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
			.trim(),
		MAX_ERROR_BODY_CHARS,
	);
}

function truncateEnd(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
