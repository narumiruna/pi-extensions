export const ASSISTANT_METADATA_MODES = ["off", "compact", "expanded"] as const;
export const ASSISTANT_STOP_REASONS = ["stop", "toolUse", "length", "error", "aborted"] as const;
export const STAMP_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type StampAssistantMetadataMode = (typeof ASSISTANT_METADATA_MODES)[number];
export type AssistantStopReason = (typeof ASSISTANT_STOP_REASONS)[number];
export type StampThinkingLevel = (typeof STAMP_THINKING_LEVELS)[number];
export type ToolStampOutcome = "success" | "error";

export interface AssistantStampUsageData {
	input?: number;
	output?: number;
	reasoning?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	estimatedCost?: number;
}

export interface AssistantStampDiagnosticSummary {
	type: string;
	errorName?: string;
	errorCode?: string;
}

export interface AssistantMetadataData {
	api: string;
	provider: string;
	model: string;
	responseModel?: string;
	responseId?: string;
	stopReason: AssistantStopReason;
	usage?: AssistantStampUsageData;
	diagnosticCount?: number;
	diagnostics?: AssistantStampDiagnosticSummary[];
}

const MAX_METADATA_TEXT_LENGTH = 160;
const MAX_DIAGNOSTIC_SUMMARIES = 5;
const MAX_DIAGNOSTIC_INSPECTIONS = 32;
const USAGE_FIELDS = [
	"input",
	"output",
	"reasoning",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
	"estimatedCost",
] as const satisfies readonly (keyof AssistantStampUsageData)[];

export function captureAssistantMetadata(value: unknown): AssistantMetadataData | undefined {
	if (!isRecord(value)) return undefined;
	const api = sanitizeMetadataText(value.api);
	const provider = sanitizeMetadataText(value.provider);
	const model = sanitizeMetadataText(value.model);
	if (!api || !provider || !model || !isAssistantStopReason(value.stopReason)) return undefined;

	const responseModel = sanitizeMetadataText(value.responseModel);
	const responseId = sanitizeMetadataText(value.responseId);
	const usage = captureUsage(value.usage);
	const capturedDiagnostics = captureDiagnostics(value.diagnostics);
	return {
		api,
		provider,
		model,
		...(responseModel ? { responseModel } : {}),
		...(responseId ? { responseId } : {}),
		stopReason: value.stopReason,
		...(usage ? { usage } : {}),
		...capturedDiagnostics,
	};
}

export function isAssistantMetadataData(value: unknown): value is AssistantMetadataData {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"api",
			"provider",
			"model",
			"responseModel",
			"responseId",
			"stopReason",
			"usage",
			"diagnosticCount",
			"diagnostics",
		]) ||
		!isSafeMetadataText(value.api) ||
		!isSafeMetadataText(value.provider) ||
		!isSafeMetadataText(value.model) ||
		(Object.hasOwn(value, "responseModel") && !isSafeMetadataText(value.responseModel)) ||
		(Object.hasOwn(value, "responseId") && !isSafeMetadataText(value.responseId)) ||
		!isAssistantStopReason(value.stopReason) ||
		(Object.hasOwn(value, "usage") && !isUsageData(value.usage))
	) {
		return false;
	}

	const diagnosticCount = value.diagnosticCount;
	const diagnostics = value.diagnostics;
	if (
		Object.hasOwn(value, "diagnosticCount") &&
		(!Number.isSafeInteger(diagnosticCount) || (diagnosticCount as number) < 1)
	) {
		return false;
	}
	if (Object.hasOwn(value, "diagnostics")) {
		if (
			!Array.isArray(diagnostics) ||
			diagnostics.length < 1 ||
			diagnostics.length > MAX_DIAGNOSTIC_SUMMARIES ||
			!diagnostics.every(isDiagnosticSummary) ||
			!Number.isSafeInteger(diagnosticCount) ||
			(diagnosticCount as number) < diagnostics.length
		) {
			return false;
		}
	}
	return true;
}

export function formatAssistantMetadataLines(
	metadata: Readonly<AssistantMetadataData>,
	mode: StampAssistantMetadataMode,
	debug: boolean,
	thinkingLevel?: StampThinkingLevel,
	showCompactAbnormalOutcome = true,
): string[] {
	if (
		mode === "off" ||
		!isAssistantMetadataData(metadata) ||
		(thinkingLevel !== undefined && !isStampThinkingLevel(thinkingLevel))
	) {
		return [];
	}
	const lines =
		mode === "compact"
			? [formatCompactMetadata(metadata, thinkingLevel, showCompactAbnormalOutcome)]
			: formatExpandedMetadata(metadata, thinkingLevel);
	if (!debug) return lines;
	if (metadata.responseId) lines.push(`debug · response id ${metadata.responseId}`);
	if (metadata.diagnosticCount !== undefined) {
		const showing = metadata.diagnostics?.length ?? 0;
		lines.push(
			showing > 0 && showing < metadata.diagnosticCount
				? `debug · diagnostics ${formatInteger(metadata.diagnosticCount)} (showing ${showing})`
				: `debug · diagnostics ${formatInteger(metadata.diagnosticCount)}`,
		);
		for (const diagnostic of metadata.diagnostics ?? []) {
			lines.push(
				[
					"debug",
					diagnostic.type,
					diagnostic.errorName,
					diagnostic.errorCode ? `code ${diagnostic.errorCode}` : undefined,
				]
					.filter((part): part is string => part !== undefined)
					.join(" · "),
			);
		}
	}
	return lines;
}

export function formatToolStampLabel(
	toolName: string,
	elapsedMilliseconds: number,
	outcome: ToolStampOutcome,
): string | undefined {
	const safeName = sanitizeMetadataText(toolName);
	const elapsed = formatElapsedSeconds(elapsedMilliseconds);
	if (!safeName || !elapsed || (outcome !== "success" && outcome !== "error")) return undefined;
	return `tool ${safeName} · ${elapsed} · ${outcome}`;
}

export function formatElapsedSeconds(elapsedMilliseconds: number): string | undefined {
	if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) return undefined;
	if (elapsedMilliseconds > 0 && elapsedMilliseconds < 100) return "<0.1s";
	const tenths = Math.round(elapsedMilliseconds / 100);
	return `${(tenths / 10).toFixed(1)}s`;
}

export function isStampThinkingLevel(value: unknown): value is StampThinkingLevel {
	return STAMP_THINKING_LEVELS.includes(value as StampThinkingLevel);
}

// Display parsing is shared; persisted snapshots retain their historical normalization below.
export { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";

function normalizePersistedMetadataText(value: string): string {
	return [...value]
		.map((character) =>
			isUnsafeTerminalCodePoint(character.codePointAt(0) ?? 0) ? " " : character,
		)
		.join("");
}

export function sanitizeMetadataText(
	value: unknown,
	maximumLength = MAX_METADATA_TEXT_LENGTH,
): string | undefined {
	if (typeof value !== "string" || maximumLength < 1) return undefined;
	const safe = normalizePersistedMetadataText(value).replace(/\s+/gu, " ").trim();
	if (!safe) return undefined;
	return [...safe].slice(0, maximumLength).join("");
}

function captureUsage(value: unknown): AssistantStampUsageData | undefined {
	if (!isRecord(value)) return undefined;
	const usage: AssistantStampUsageData = {};
	for (const field of USAGE_FIELDS.slice(0, 6)) {
		const amount = value[field];
		if (isReportedTokenCount(amount)) assignUsage(usage, field, amount);
	}
	if (isRecord(value.cost) && isReportedCost(value.cost.total)) {
		usage.estimatedCost = value.cost.total;
	}
	return Object.keys(usage).length > 0 ? usage : undefined;
}

function captureDiagnostics(
	value: unknown,
): Pick<AssistantMetadataData, "diagnosticCount" | "diagnostics"> {
	if (!Array.isArray(value) || value.length === 0) return {};
	const diagnostics: AssistantStampDiagnosticSummary[] = [];
	const inspections = Math.min(value.length, MAX_DIAGNOSTIC_INSPECTIONS);
	for (let index = 0; index < inspections; index += 1) {
		if (diagnostics.length >= MAX_DIAGNOSTIC_SUMMARIES) break;
		const item = value[index];
		if (!isRecord(item)) continue;
		const type = sanitizeMetadataText(item.type);
		if (!type) continue;
		const error = isRecord(item.error) ? item.error : undefined;
		const errorName = sanitizeMetadataText(error?.name);
		const errorCode =
			typeof error?.code === "number" && Number.isFinite(error.code)
				? sanitizeMetadataText(String(error.code))
				: sanitizeMetadataText(error?.code);
		diagnostics.push({
			type,
			...(errorName ? { errorName } : {}),
			...(errorCode ? { errorCode } : {}),
		});
	}
	return {
		diagnosticCount: value.length,
		...(diagnostics.length > 0 ? { diagnostics } : {}),
	};
}

function formatCompactMetadata(
	metadata: Readonly<AssistantMetadataData>,
	thinkingLevel: StampThinkingLevel | undefined,
	showCompactAbnormalOutcome: boolean,
): string {
	const model =
		metadata.responseModel && metadata.responseModel !== metadata.model
			? `${metadata.model} → ${metadata.responseModel}`
			: metadata.model;
	const tokens = metadata.usage?.totalTokens;
	const cost = metadata.usage?.estimatedCost;
	const abnormalStopReason =
		showCompactAbnormalOutcome &&
		(metadata.stopReason === "length" ||
			metadata.stopReason === "error" ||
			metadata.stopReason === "aborted")
			? metadata.stopReason
			: undefined;
	return [
		model,
		thinkingLevel === undefined ? undefined : `thinking ${thinkingLevel}`,
		abnormalStopReason === undefined ? undefined : `stop ${abnormalStopReason}`,
		tokens === undefined ? undefined : `${formatInteger(tokens)} tok`,
		cost === undefined ? undefined : `est ${formatCost(cost)}`,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
}

function formatExpandedMetadata(
	metadata: Readonly<AssistantMetadataData>,
	thinkingLevel: StampThinkingLevel | undefined,
): string[] {
	const provenance = [
		`api ${metadata.api}`,
		`provider ${metadata.provider}`,
		`requested ${metadata.model}`,
		metadata.responseModel ? `response ${metadata.responseModel}` : undefined,
		thinkingLevel === undefined ? undefined : `thinking ${thinkingLevel}`,
		`stop ${metadata.stopReason}`,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	const usage = metadata.usage;
	if (!usage) return [provenance];
	const usageLine = [
		usage.input === undefined ? undefined : `tokens in ${formatInteger(usage.input)}`,
		usage.output === undefined ? undefined : `out ${formatInteger(usage.output)}`,
		usage.reasoning === undefined ? undefined : `reasoning ${formatInteger(usage.reasoning)}`,
		usage.cacheRead === undefined ? undefined : `cache read ${formatInteger(usage.cacheRead)}`,
		usage.cacheWrite === undefined ? undefined : `cache write ${formatInteger(usage.cacheWrite)}`,
		usage.totalTokens === undefined ? undefined : `total ${formatInteger(usage.totalTokens)}`,
		usage.estimatedCost === undefined ? undefined : `est cost ${formatCost(usage.estimatedCost)}`,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	return usageLine ? [provenance, usageLine] : [provenance];
}

function formatInteger(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, useGrouping: true }).format(
		value,
	);
}

function formatCost(value: number): string {
	if (value === 0) return "$0";
	if (value < 0.0001) return "<$0.0001";
	const digits = value < 1 ? 4 : 2;
	return `$${value.toFixed(digits).replace(/(?:\.0+|(?<fraction>\.\d*?[1-9])0+)$/u, "$<fraction>")}`;
}

function isUsageData(value: unknown): value is AssistantStampUsageData {
	if (!isRecord(value) || !hasOnlyKeys(value, USAGE_FIELDS) || Object.keys(value).length === 0) {
		return false;
	}
	for (const field of USAGE_FIELDS) {
		if (!Object.hasOwn(value, field)) continue;
		const amount = value[field];
		if (field === "estimatedCost") {
			if (!isReportedCost(amount)) return false;
		} else if (!isReportedTokenCount(amount)) {
			return false;
		}
	}
	return true;
}

function isDiagnosticSummary(value: unknown): value is AssistantStampDiagnosticSummary {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "errorName", "errorCode"]) &&
		isSafeMetadataText(value.type) &&
		(!Object.hasOwn(value, "errorName") || isSafeMetadataText(value.errorName)) &&
		(!Object.hasOwn(value, "errorCode") || isSafeMetadataText(value.errorCode))
	);
}

function isSafeMetadataText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		[...value].length <= MAX_METADATA_TEXT_LENGTH &&
		sanitizeMetadataText(value) === value
	);
}

function isAssistantStopReason(value: unknown): value is AssistantStopReason {
	return ASSISTANT_STOP_REASONS.includes(value as AssistantStopReason);
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		codePoint === 0x061c ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

function isReportedTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isReportedCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assignUsage<K extends keyof AssistantStampUsageData>(
	usage: AssistantStampUsageData,
	field: K,
	value: NonNullable<AssistantStampUsageData[K]>,
): void {
	usage[field] = value;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
