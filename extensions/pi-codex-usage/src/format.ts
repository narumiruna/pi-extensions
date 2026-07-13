import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	CodexUsageModel,
	CodexUsageReport,
	NormalizedCredits,
	NormalizedRateLimitSnapshot,
	NormalizedRateLimitWindow,
	UsageQueryError,
} from "./types.js";

const USAGE_SETTINGS_URL = "https://chatgpt.com/codex/settings/usage";
const BAR_SEGMENTS = 20;
const LIMIT_VALUE_COLUMN = 29;
const RESET_FOREGROUND = "\x1b[39m";

function isOpenAICodexModel(model: Pick<CodexUsageModel, "provider"> | undefined): boolean {
	return model?.provider === "openai-codex";
}

export function formatCodexUsageReport(report: CodexUsageReport, _cacheAgeMs?: number): string {
	const lines = [
		"  >_ OpenAI Codex Usage",
		"",
		`Visit ${USAGE_SETTINGS_URL} for up-to-date`,
		"information on rate limits and credits",
		"",
	];

	for (const snapshot of report.snapshots) {
		const label = snapshot.limitName ?? snapshot.limitId;
		if (!isPrimaryCodexSnapshot(snapshot)) {
			lines.push(`  ${label} limit:`);
		}
		if (snapshot.primary) lines.push(formatWindowLine(snapshot.primary, "5h"));
		if (snapshot.secondary) lines.push(formatWindowLine(snapshot.secondary, "weekly"));
		if (!snapshot.primary && !snapshot.secondary) {
			lines.push("  Limits unavailable for this account");
		}
	}

	if (report.resetCredits) {
		if (report.snapshots.length > 0) lines.push("");
		lines.push(
			`  ${"Usage limit resets:".padEnd(LIMIT_VALUE_COLUMN)}${report.resetCredits.availableCount} available`,
		);
	}

	return lines.join("\n");
}

export function formatCodexUsageStatusline(
	report: CodexUsageReport,
	model?: CodexUsageModel,
): string {
	const snapshot = selectSnapshotForModel(report, model);
	if (!snapshot) return "usage unavailable";

	const parts = [formatStatuslinePrefix(snapshot)];
	if (snapshot.primary) {
		parts.push(
			`${formatRemainingPercent(snapshot.primary)} ${formatWindowLabel(snapshot.primary, "5h", true)}`,
		);
	}
	if (snapshot.secondary) {
		parts.push(
			`${formatRemainingPercent(snapshot.secondary)} ${formatWindowLabel(snapshot.secondary, "weekly", true)}`,
		);
	}
	if (parts.length === 1 && snapshot.credits) parts.push(formatCredits(snapshot.credits));
	return parts.join(" ");
}

function selectSnapshotForModel(
	report: CodexUsageReport,
	model: CodexUsageModel | undefined,
): NormalizedRateLimitSnapshot | undefined {
	const codexSnapshot = report.snapshots.find(isPrimaryCodexSnapshot);
	if (!model || !isOpenAICodexModel(model)) return codexSnapshot ?? report.snapshots[0];

	const modelKeys = normalizedModelUsageKeys(model);
	const exactMatch = report.snapshots.find((snapshot) =>
		normalizedSnapshotUsageKeys(snapshot).some((key) => modelKeys.has(key)),
	);
	if (exactMatch) return exactMatch;

	const variants = codexModelVariantKeys(modelKeys);
	for (const variant of variants) {
		const matches = report.snapshots.filter(
			(snapshot) =>
				!isPrimaryCodexSnapshot(snapshot) &&
				normalizedSnapshotUsageKeys(snapshot).some((key) => normalizedKeyHasToken(key, variant)),
		);
		if (matches.length === 1) return matches[0];
	}

	return codexSnapshot ?? report.snapshots[0];
}

function normalizedModelUsageKeys(model: CodexUsageModel): Set<string> {
	const keys = new Set<string>();
	addNormalizedUsageKey(keys, model.id);
	addNormalizedUsageKey(keys, model.name);

	for (const key of [...keys]) {
		const codexIndex = key.indexOf("codex");
		if (codexIndex >= 0) keys.add(key.slice(codexIndex));
	}

	return keys;
}

function normalizedSnapshotUsageKeys(snapshot: NormalizedRateLimitSnapshot): string[] {
	return [normalizedUsageKey(snapshot.limitId), normalizedUsageKey(snapshot.limitName)].filter(
		(key): key is string => key !== undefined,
	);
}

function addNormalizedUsageKey(keys: Set<string>, value: string | undefined): void {
	const key = normalizedUsageKey(value);
	if (key) keys.add(key);
}

function normalizedUsageKey(value: string | undefined): string | undefined {
	const key = value
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return key || undefined;
}

function codexModelVariantKeys(modelKeys: Set<string>): string[] {
	const variants = new Set<string>();
	for (const key of modelKeys) {
		const match = key.match(/(?:^|-)codex-(.+)$/);
		if (match?.[1]) variants.add(match[1]);
	}
	return [...variants];
}

function normalizedKeyHasToken(key: string, token: string): boolean {
	return (
		key === token ||
		key.startsWith(`${token}-`) ||
		key.endsWith(`-${token}`) ||
		key.includes(`-${token}-`)
	);
}

function formatStatuslinePrefix(snapshot: NormalizedRateLimitSnapshot): string {
	if (isPrimaryCodexSnapshot(snapshot)) return "codex";
	const label = snapshot.limitName ?? snapshot.limitId;
	return `codex ${compactLimitLabel(label)}`;
}

function compactLimitLabel(label: string): string {
	const normalized = label.replace(/[_-]+/g, " ").trim();
	const codexVariant = normalized.match(/\bcodex\s+(.+)$/i)?.[1]?.trim();
	const compact = codexVariant || normalized;
	return compact.toLowerCase().replace(/\s+/g, " ");
}

function formatRemainingPercent(window: NormalizedRateLimitWindow): string {
	return `${(100 - clampPercent(window.usedPercent)).toFixed(0)}%`;
}

export function showReport(
	ctx: ExtensionCommandContext,
	report: CodexUsageReport,
	fromCache: boolean,
): void {
	const text = formatCodexUsageReport(
		report,
		fromCache ? Date.now() - report.capturedAt : undefined,
	);
	ctx.ui.notify(ctx.hasUI ? brightenInfoNotification(text) : text, "info");
}

function brightenInfoNotification(text: string): string {
	return `${RESET_FOREGROUND}${text}`;
}

function isPrimaryCodexSnapshot(snapshot: NormalizedRateLimitSnapshot): boolean {
	return (
		normalizedUsageKey(snapshot.limitId) === "codex" ||
		normalizedUsageKey(snapshot.limitName) === "codex"
	);
}

function formatWindowLine(
	window: NormalizedRateLimitWindow,
	fallback: "5h" | "weekly",
): string {
	const label = `${formatWindowLabel(window, fallback, false)} limit:`;
	return `  ${label.padEnd(LIMIT_VALUE_COLUMN)}${formatWindow(window)}`;
}

function formatWindowLabel(
	window: NormalizedRateLimitWindow,
	fallback: "5h" | "weekly",
	compact: boolean,
): string {
	const minutes = window.windowMinutes;
	if (!minutes || !Number.isFinite(minutes) || minutes <= 0) {
		return compact && fallback === "weekly" ? "wk" : capitalize(fallback);
	}
	if (minutes === 10_080) return compact ? "wk" : "Weekly";
	if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function capitalize(value: string): string {
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function formatWindow(window: NormalizedRateLimitWindow): string {
	const remaining = 100 - clampPercent(window.usedPercent);
	const reset = window.resetsAt ? ` (resets ${formatReset(window.resetsAt)})` : "";
	return `${progressBar(remaining)} ${remaining.toFixed(0)}% left${reset}`;
}

function progressBar(percentRemaining: number): string {
	const filled = Math.round((clampPercent(percentRemaining) / 100) * BAR_SEGMENTS);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function formatCredits(credits: NormalizedCredits): string {
	if (!credits.hasCredits) return "no credits";
	if (credits.unlimited) return "unlimited credits";
	const balance = credits.balance?.trim();
	if (!balance) return "credits available";
	return `${formatNumber(Number(balance), balance)} credits`;
}

function formatReset(epochSeconds: number): string {
	const reset = new Date(epochSeconds * 1000);
	if (Number.isNaN(reset.getTime())) return "at an unknown time";

	const now = new Date();
	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	if (reset.toDateString() === now.toDateString()) return time;
	const day = reset.getDate().toString();
	const month = reset.toLocaleDateString(undefined, { month: "short" });
	return `${time} on ${day} ${month}`;
}

export function formatQueryErrors(errors: UsageQueryError[]): string {
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

function formatNumber(value: number, fallback: string): string {
	if (!Number.isFinite(value)) return fallback;
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}
