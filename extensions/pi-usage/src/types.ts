import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PiModel = NonNullable<ExtensionContext["model"]>;
export type UsageModel = Pick<PiModel, "id" | "name" | "provider">;

export type UsageSemanticsKind = "consumer-subscription" | "api-key" | "project";
export type UsageUnit = "percent" | "usd" | "count";
export type UsageDisplayState = "current" | "configured";

export interface UsageSemantics {
	kind: UsageSemanticsKind;
	label: string;
}

export interface UsageBucket {
	id: string;
	label: string;
	groupId?: string;
	groupLabel?: string;
	modelKeys?: string[];
	used?: number;
	remaining?: number;
	limit?: number;
	unit: UsageUnit;
	period?: string;
	windowMinutes?: number;
	resetsAt?: number;
}

export interface UsageMetric {
	id: string;
	label: string;
	value: number | string;
	unit?: UsageUnit;
}

export interface UsageReport {
	providerId: string;
	providerName: string;
	capturedAt: number;
	source: string;
	semantics: UsageSemantics;
	accountLabel?: string;
	buckets: UsageBucket[];
	metrics: UsageMetric[];
	notes?: string[];
}

export interface ResolvedUsageAuth {
	apiKey?: string;
	headers: Record<string, string>;
	fingerprint: string;
	secrets: string[];
	model: PiModel;
}

export interface UsageProviderAdapter {
	id: string;
	displayName: string;
	semantics: UsageSemantics;
	query(auth: ResolvedUsageAuth, signal: AbortSignal, timeoutMs: number): Promise<UsageReport>;
}

export type ProviderUsageState =
	| {
			providerId: string;
			providerName: string;
			displayState: UsageDisplayState;
			status: "ready";
			report: UsageReport;
	  }
	| {
			providerId: string;
			providerName: string;
			displayState: UsageDisplayState;
			status: "unsupported" | "auth-unavailable" | "query-failed";
			message: string;
	  };

export type OpenRouterKeyPayload = {
	data?: unknown;
};

export type CodexBackendPayload = {
	plan_type?: unknown;
	rate_limit?: unknown;
	additional_rate_limits?: unknown;
	credits?: unknown;
	rate_limit_reset_credits?: unknown;
};
