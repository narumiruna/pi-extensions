import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UsageSource = "pi-auth" | "codex-app-server";
export type PiModel = NonNullable<ExtensionContext["model"]>;
export type CodexUsageModel = Pick<PiModel, "id" | "name" | "provider">;

export type QueryUsageOptions = {
	clearStatusline: boolean;
	refresh: boolean;
	statusline: boolean;
	timeoutMs: number;
};

export type CachedReport = {
	createdAt: number;
	report: CodexUsageReport;
};

export type QueryUsageResult =
	| { ok: true; report: CodexUsageReport }
	| { ok: false; errors: UsageQueryError[] };

export type UsageQueryError = {
	source: UsageSource;
	message: string;
	cause?: unknown;
};

export type CodexUsageReport = {
	source: UsageSource;
	capturedAt: number;
	planType?: string;
	snapshots: NormalizedRateLimitSnapshot[];
	resetCredits?: NormalizedRateLimitResetCredits;
};

export type NormalizedRateLimitResetCredits = {
	availableCount: number;
	credits?: NormalizedRateLimitResetCredit[];
};

export type NormalizedRateLimitResetCredit = {
	id: string;
	resetType?: string;
	status?: string;
	grantedAt?: number;
	expiresAt?: number;
	title?: string;
	description?: string;
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

export type RateLimitStatusPayload = {
	plan_type?: unknown;
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
	credits?: unknown;
	rate_limit_reset_credits?: unknown;
};

export type BackendRateLimitResetCredits = {
	available_count?: unknown;
};

export type BackendRateLimitDetails = {
	primary_window?: unknown;
	secondary_window?: unknown;
};

export type BackendWindowSnapshot = {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
};

export type BackendAdditionalRateLimit = {
	limit_name?: unknown;
	metered_feature?: unknown;
	rate_limit?: unknown;
};

export type BackendCreditsSnapshot = {
	has_credits?: unknown;
	unlimited?: unknown;
	balance?: unknown;
};

export type AppServerRateLimitResponse = {
	rateLimits?: unknown;
	rateLimitsByLimitId?: unknown;
	rateLimitResetCredits?: unknown;
};

export type AppServerRateLimitResetCredits = {
	availableCount?: unknown;
	credits?: unknown;
};

export type AppServerRateLimitResetCredit = {
	id?: unknown;
	resetType?: unknown;
	status?: unknown;
	grantedAt?: unknown;
	expiresAt?: unknown;
	title?: unknown;
	description?: unknown;
};

export type AppServerRateLimitSnapshot = {
	limitId?: unknown;
	limitName?: unknown;
	primary?: unknown;
	secondary?: unknown;
	credits?: unknown;
	planType?: unknown;
};

export type AppServerWindowSnapshot = {
	usedPercent?: unknown;
	windowDurationMins?: unknown;
	resetsAt?: unknown;
};

export type AppServerCreditsSnapshot = {
	hasCredits?: unknown;
	unlimited?: unknown;
	balance?: unknown;
};

export type RpcResponse = {
	id?: unknown;
	result?: unknown;
	error?: { message?: unknown; code?: unknown };
};

export type PendingRpc = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};
