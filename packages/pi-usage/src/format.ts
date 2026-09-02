import type {
	ProviderUsageState,
	UsageBucket,
	UsageDisplayState,
	UsageModel,
	UsageReport,
} from "./types.js";

const BAR_SEGMENTS = 20;
const VALUE_COLUMN = 29;

export function formatUsageReport(report: UsageReport, displayState: UsageDisplayState): string {
	const stateLabel = displayState === "current" ? "Current" : "Configured";
	const title =
		report.providerId === "baseten"
			? "Baseten Model APIs Spend"
			: report.providerId === "deepseek"
				? "DeepSeek API Balance"
				: report.providerId === "fireworks"
					? "Fireworks API Spend"
					: report.providerId === "vercel-ai-gateway"
						? "Vercel AI Gateway Credits"
						: report.providerId === "moonshotai" || report.providerId === "moonshotai-cn"
							? `${report.providerName} Balance`
							: report.providerId === "minimax" || report.providerId === "minimax-cn"
								? report.source === "minimax-account-balance"
									? `${report.providerName} API Balance`
									: `${report.providerName} Token Plan`
								: `${report.providerName} Usage`;
	const lines = [`${title} · ${stateLabel}`];
	if (report.accountLabel) lines.push(`Account: ${report.accountLabel}`);
	lines.push(`Semantics: ${report.semantics.label}`, "");

	if (report.providerId === "baseten") formatBasetenReport(lines, report);
	else if (report.providerId === "openai-codex") formatCodexReport(lines, report);
	else if (report.providerId === "deepseek") formatDeepSeekReport(lines, report);
	else if (report.providerId === "fireworks") formatFireworksReport(lines, report);
	else if (report.providerId === "vercel-ai-gateway") formatVercelAIGatewayReport(lines, report);
	else if (report.providerId === "github-copilot") formatGitHubCopilotReport(lines, report);
	else if (report.providerId === "openrouter") formatOpenRouterReport(lines, report);
	else if (report.providerId === "opencode-go") formatOpenCodeZenReport(lines, report);
	else if (report.providerId === "kimi-coding") formatKimiCodingReport(lines, report);
	else if (report.providerId === "moonshotai" || report.providerId === "moonshotai-cn") {
		formatMoonshotReport(lines, report);
	} else if (report.providerId === "minimax" || report.providerId === "minimax-cn") {
		formatMiniMaxReport(lines, report);
	} else if (report.providerId === "xai") formatXaiReport(lines, report);
	else if (report.providerId === "zai" || report.providerId === "zai-coding-cn") {
		formatZaiReport(lines, report);
	} else formatGenericReport(lines, report);

	if (report.notes) {
		for (const note of report.notes) lines.push(note);
	}
	return lines.join("\n").trimEnd();
}

export function formatUsageStatusline(
	report: UsageReport,
	model?: UsageModel,
	now = Date.now(),
	showCodexResetCountdown = true,
): string | undefined {
	if (report.providerId === "baseten") return formatBasetenStatusline(report);
	if (report.providerId === "openai-codex") {
		return formatCodexStatusline(report, model, now, showCodexResetCountdown);
	}
	if (report.providerId === "deepseek") return formatDeepSeekStatusline(report);
	if (report.providerId === "fireworks") return formatFireworksStatusline(report);
	if (report.providerId === "vercel-ai-gateway") return formatVercelAIGatewayStatusline(report);
	if (report.providerId === "github-copilot") return formatGitHubCopilotStatusline(report);
	if (report.providerId === "openrouter") {
		const limit = report.buckets.find((bucket) => bucket.id === "key-limit");
		if (limit?.remaining !== undefined) return `openrouter ${formatUsd(limit.remaining)} left`;
		const total = report.metrics.find((metric) => metric.id === "usage-total");
		if (typeof total?.value === "number") return `openrouter ${formatUsd(total.value)} used`;
	}
	if (report.providerId === "opencode-go") return formatOpenCodeZenStatusline(report);
	if (report.providerId === "kimi-coding") return formatKimiCodingStatusline(report);
	if (report.providerId === "moonshotai" || report.providerId === "moonshotai-cn") {
		return formatMoonshotStatusline(report);
	}
	if (report.providerId === "minimax" || report.providerId === "minimax-cn") {
		return formatMiniMaxStatusline(report, model);
	}
	if (report.providerId === "zai" || report.providerId === "zai-coding-cn") {
		return formatZaiStatusline(report);
	}
	return undefined;
}

export function formatProviderStates(states: readonly ProviderUsageState[]): string {
	return states
		.map((state) => {
			if (state.status === "ready") return formatUsageReport(state.report, state.displayState);
			const label = state.displayState === "current" ? "Current" : "Configured";
			if (state.status === "selection-required") {
				return `${state.providerName} · ${label}\nSelection required: choose this provider's ${state.singularLabel} by viewing it individually.`;
			}
			const status =
				state.status === "auth-unavailable"
					? "Authentication unavailable"
					: state.status === "unsupported"
						? "Unsupported"
						: "Query failed";
			return `${state.providerName} · ${label}\n${status}: ${state.message}`;
		})
		.join("\n\n");
}

function formatBasetenReport(lines: string[], report: UsageReport): void {
	lines.push(`${"Spend window:".padEnd(VALUE_COLUMN)}Last 30 days`);
	for (const metric of report.metrics) {
		lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}USD ${metric.value}`);
	}
}

function formatBasetenStatusline(report: UsageReport): string {
	const subtotal = report.metrics.find((metric) => metric.id === "net-subtotal");
	return subtotal ? `baseten USD ${subtotal.value} net` : "baseten no Model APIs usage";
}

function formatCodexReport(lines: string[], report: UsageReport): void {
	let previousGroup: string | undefined;
	for (const bucket of report.buckets) {
		const group = bucket.groupId ?? bucket.id;
		if (group !== previousGroup && group !== "codex") {
			lines.push(`${bucket.groupLabel ?? group} limit:`);
		}
		previousGroup = group;
		const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
		const label = `${formatWindowLabel(bucket.windowMinutes, fallback, false)} limit:`;
		lines.push(`${label.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
	}
	for (const metric of report.metrics) {
		if (metric.id === "reset-credits") {
			lines.push(`${"Usage limit resets:".padEnd(VALUE_COLUMN)}${metric.value} available`);
		} else if (metric.id === "credits") {
			lines.push(
				`${"Credits:".padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
			);
		}
	}
}

function formatDeepSeekReport(lines: string[], report: UsageReport): void {
	const availability = report.metrics.find((metric) => metric.id === "api-availability");
	lines.push(
		`${"API calls:".padEnd(VALUE_COLUMN)}${availability?.value === "available" ? "Available" : "Unavailable"}`,
	);
	for (const currency of ["CNY", "USD"]) {
		const metrics = report.metrics.filter((metric) => metric.currency === currency);
		if (metrics.length === 0) continue;
		lines.push("", `${currency} balance:`);
		for (const metric of metrics) {
			lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${currency} ${metric.value}`);
		}
	}
}

function formatDeepSeekStatusline(report: UsageReport): string {
	const availability = report.metrics.find((metric) => metric.id === "api-availability");
	if (availability?.value !== "available") return "deepseek API unavailable";
	const totals = ["CNY", "USD"].flatMap((currency) => {
		const metric = report.metrics.find(
			(candidate) => candidate.id === `${currency.toLowerCase()}-total`,
		);
		return metric ? [`${currency} ${metric.value}`] : [];
	});
	return totals.length > 0 ? `deepseek ${totals.join(" · ")}` : "deepseek balance unavailable";
}

function formatFireworksReport(lines: string[], report: UsageReport): void {
	lines.push(`${"Spend window:".padEnd(VALUE_COLUMN)}Last 30 days (rated)`);
	for (const currency of fireworksCurrencies(report)) {
		lines.push("", `${currency} rated spend:`);
		for (const metric of report.metrics) {
			if (metric.currency !== currency) continue;
			lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${currency} ${metric.value}`);
		}
	}
}

function formatFireworksStatusline(report: UsageReport): string {
	const totals = report.metrics.filter((metric) => metric.id.endsWith("-total"));
	if (totals.length === 0) return "fireworks no rated usage";
	return `fireworks ${totals.map((metric) => `${metric.currency} ${metric.value}`).join(" · ")}`;
}

function fireworksCurrencies(report: UsageReport): string[] {
	const currencies: string[] = [];
	for (const metric of report.metrics) {
		if (!metric.currency || currencies.includes(metric.currency)) continue;
		currencies.push(metric.currency);
	}
	return currencies;
}

function formatVercelAIGatewayReport(lines: string[], report: UsageReport): void {
	for (const metric of report.metrics) {
		lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}USD ${metric.value}`);
	}
}

function formatVercelAIGatewayStatusline(report: UsageReport): string {
	const balance = report.metrics.find((metric) => metric.id === "credit-balance");
	return balance ? `vercel USD ${balance.value} left` : "vercel credits unavailable";
}

function formatGitHubCopilotReport(lines: string[], report: UsageReport): void {
	const quota = findGitHubCopilotQuota(report);
	if (!quota || quota.limit === undefined || quota.remaining === undefined) {
		lines.push(`${`${quota?.label ?? "Copilot quota"}:`.padEnd(VALUE_COLUMN)}unlimited`);
		return;
	}
	const percent = percentRemaining(quota);
	const reset = quota.resetsAt ? ` (resets ${formatReset(quota.resetsAt)})` : "";
	lines.push(
		`${`${quota.label}:`.padEnd(VALUE_COLUMN)}${quota.remaining} of ${quota.limit} left · ${percent}%${reset}`,
	);
	const overage = report.metrics.find((metric) => metric.id === "overage-used");
	if (typeof overage?.value === "number" && overage.value > 0) {
		lines.push(`${"Additional usage:".padEnd(VALUE_COLUMN)}${overage.value} ${quota.label}`);
	}
}

function formatGitHubCopilotStatusline(report: UsageReport): string {
	const quota = findGitHubCopilotQuota(report);
	const kind = compactGitHubCopilotQuotaKind(quota);
	if (!quota || quota.limit === undefined || quota.remaining === undefined) {
		return `copilot ${kind} unlimited`;
	}
	const overage = report.metrics.find((metric) => metric.id === "overage-used");
	const overageSuffix =
		typeof overage?.value === "number" && overage.value > 0 ? ` +${overage.value} over` : "";
	return `copilot ${kind === "premium" ? "" : `${kind} `}${quota.remaining}/${quota.limit} ${percentRemaining(quota)}%${overageSuffix}`;
}

function findGitHubCopilotQuota(report: UsageReport): UsageBucket | undefined {
	return report.buckets.find((bucket) =>
		["ai-credits", "premium-requests", "chat-requests"].includes(bucket.id),
	);
}

function compactGitHubCopilotQuotaKind(bucket: UsageBucket | undefined): string {
	if (bucket?.id === "ai-credits") return "credits";
	if (bucket?.id === "chat-requests") return "chat";
	return "premium";
}

function percentRemaining(bucket: UsageBucket): number {
	if (!bucket.limit || bucket.remaining === undefined) return 0;
	return Math.round(clampPercent((bucket.remaining / bucket.limit) * 100));
}

function formatOpenRouterReport(lines: string[], report: UsageReport): void {
	const limit = report.buckets.find((bucket) => bucket.id === "key-limit");
	if (limit) {
		const period = limit.period ? ` (${limit.period})` : "";
		const value =
			limit.remaining === undefined
				? `${formatUsd(limit.limit ?? 0)} cap; remaining unavailable`
				: `${formatUsd(limit.remaining)} of ${formatUsd(limit.limit ?? 0)} left`;
		lines.push(`${`Key limit${period}:`.padEnd(VALUE_COLUMN)}${value}`);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatOpenCodeZenReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		if (bucket.unit === "percent" && bucket.used !== undefined) {
			lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
			continue;
		}
		const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
		const used = bucket.used ?? "unavailable";
		lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${used}% used${reset}`);
	}
}

function formatOpenCodeZenStatusline(report: UsageReport): string | undefined {
	const parts = ["zen"];
	for (const bucket of report.buckets) {
		if (bucket.used === undefined) continue;
		const compact = bucket.id === "rolling" ? "r" : bucket.id === "weekly" ? "w" : "m";
		parts.push(`${clampPercent(bucket.used).toFixed(0)}% ${compact}`);
	}
	return parts.length > 1 ? parts.join(" ") : undefined;
}

function formatKimiCodingReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
		if (bucket.used === undefined || bucket.limit === undefined) {
			lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}unavailable${reset}`);
			continue;
		}
		lines.push(
			`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${bucket.used} of ${bucket.limit} used · ${percentRemaining(bucket)}% left${reset}`,
		);
	}
	const balance = report.metrics.find((metric) => metric.id === "booster-balance");
	const total = report.metrics.find((metric) => metric.id === "booster-total");
	const monthlyUsed = report.metrics.find((metric) => metric.id === "booster-monthly-used");
	const monthlyLimit = report.metrics.find((metric) => metric.id === "booster-monthly-limit");
	if (!balance && !monthlyUsed && !monthlyLimit) return;
	lines.push("", "Extra usage wallet:");
	if (balance) {
		const totalSuffix = total ? ` of ${formatCurrencyMetric(total)}` : "";
		lines.push(`${"Balance:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(balance)}${totalSuffix}`);
	}
	if (monthlyUsed) {
		lines.push(`${"Used this month:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(monthlyUsed)}`);
	}
	if (monthlyLimit) {
		lines.push(`${"Monthly limit:".padEnd(VALUE_COLUMN)}${formatCurrencyMetric(monthlyLimit)}`);
	}
}

function formatKimiCodingStatusline(report: UsageReport): string | undefined {
	const fiveHour = report.buckets.find((bucket) => bucket.id === "five-hour");
	const weekly = report.buckets.find((bucket) => bucket.id === "weekly");
	const subWindow = fiveHour ?? report.buckets.find((bucket) => bucket.id !== "weekly");
	const selected = [subWindow, weekly].filter(
		(bucket, index, buckets): bucket is UsageBucket =>
			bucket !== undefined && buckets.indexOf(bucket) === index,
	);
	const parts = ["kimi"];
	for (const bucket of selected) {
		if (!bucket.limit || bucket.remaining === undefined) continue;
		const fallback = bucket.id === "weekly" ? "weekly" : "5h";
		parts.push(
			`${percentRemaining(bucket)}% ${formatWindowLabel(bucket.windowMinutes, fallback, true)}`,
		);
	}
	return parts.length > 1 ? parts.join(" ") : undefined;
}

function formatMoonshotReport(lines: string[], report: UsageReport): void {
	for (const metric of report.metrics) {
		lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${metric.currency} ${metric.value}`);
	}
}

function formatMoonshotStatusline(report: UsageReport): string {
	const available = report.metrics.find((metric) => metric.id === "available-balance");
	if (!available) return "moonshot balance unavailable";
	return `moonshot ${available.currency ?? ""} ${available.value}`.replace(/\s+/gu, " ");
}

function formatMiniMaxReport(lines: string[], report: UsageReport): void {
	if (report.source === "minimax-account-balance") {
		for (const metric of report.metrics) {
			lines.push(`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${metric.currency} ${metric.value}`);
		}
		return;
	}
	let previousGroup: string | undefined;
	for (const bucket of report.buckets) {
		if (bucket.groupId !== previousGroup) lines.push(`${bucket.groupLabel ?? "Token Plan"}:`);
		previousGroup = bucket.groupId;
		const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
		const value =
			bucket.period === "unlimited"
				? "unlimited"
				: bucket.unit === "percent" && bucket.remaining !== undefined
					? `${bucket.remaining}% remaining${reset}`
					: bucket.limit !== undefined && bucket.remaining !== undefined
						? `${bucket.remaining} of ${bucket.limit} left · ${percentRemaining(bucket)}%${reset}`
						: "unavailable";
		lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${value}`);
	}
}

function formatMiniMaxStatusline(report: UsageReport, model?: UsageModel): string | undefined {
	const prefix = report.providerId === "minimax-cn" ? "minimax cn" : "minimax";
	if (report.source === "minimax-account-balance") {
		const available = report.metrics.find((metric) => metric.id === "available-balance");
		return available ? `${prefix} ${available.currency} ${available.value}` : undefined;
	}
	const selectedGroup = selectMiniMaxGroup(report, model);
	if (!selectedGroup) return undefined;
	const selected = report.buckets.filter((bucket) => bucket.groupId === selectedGroup);
	const parts = [prefix];
	for (const bucket of selected) {
		const fallback = bucket.id.endsWith(":weekly") ? "weekly" : "5h";
		const window = formatWindowLabel(bucket.windowMinutes, fallback, true);
		if (bucket.period === "unlimited") {
			parts.push(`unlimited ${window}`);
			continue;
		}
		if (bucket.unit === "percent" && bucket.remaining !== undefined) {
			parts.push(`${bucket.remaining}% ${window}`);
			continue;
		}
		if (bucket.limit === undefined || bucket.remaining === undefined) continue;
		parts.push(`${percentRemaining(bucket)}% ${window}`);
	}
	return parts.length > 1 ? parts.join(" ") : undefined;
}

function selectMiniMaxGroup(report: UsageReport, model?: UsageModel): string | undefined {
	const groups = [
		...new Set(
			report.buckets
				.map((bucket) => bucket.groupId)
				.filter((group): group is string => group !== undefined),
		),
	];
	if (groups.length <= 1) return groups[0];
	if (model && model.provider !== report.providerId) return undefined;
	if (model) {
		const modelKeys = [model.id, model.name]
			.map(normalizeMiniMaxModelKey)
			.filter((key): key is string => key !== undefined);
		const candidates = groups.map((group) => {
			const bucket = report.buckets.find((candidate) => candidate.groupId === group);
			const patterns = [bucket?.groupLabel, ...(bucket?.modelKeys ?? []), group]
				.map(normalizeMiniMaxModelKey)
				.filter((key): key is string => key !== undefined);
			return { group, patterns };
		});
		const exact = candidates.find(({ patterns }) =>
			patterns.some((pattern) => !pattern.includes("*") && modelKeys.includes(pattern)),
		);
		if (exact) return exact.group;
		const wildcard = candidates.find(({ patterns }) =>
			patterns.some(
				(pattern) =>
					pattern.includes("*") && modelKeys.some((key) => wildcardKeyMatches(pattern, key)),
			),
		);
		if (wildcard) return wildcard.group;
	}
	// Prefer the Coding Plan catch-all over hiding the chip.
	return groups.find((group) => group === "general");
}

function normalizeMiniMaxModelKey(value: string | undefined): string | undefined {
	const key = value?.toLowerCase().replace(/[^a-z0-9*]+/gu, "");
	return key && /[a-z0-9]/u.test(key) ? key : undefined;
}

function wildcardKeyMatches(pattern: string, value: string): boolean {
	if (!pattern.includes("*")) return pattern === value;
	const segments = pattern.split("*").filter(Boolean);
	let offset = 0;
	for (const [index, segment] of segments.entries()) {
		const found = value.indexOf(segment, offset);
		if (found < 0 || (index === 0 && !pattern.startsWith("*") && found !== 0)) return false;
		offset = found + segment.length;
	}
	const last = segments.at(-1);
	return pattern.endsWith("*") || (last !== undefined && value.endsWith(last));
}

function formatZaiStatusline(report: UsageReport): string | undefined {
	const selected = [
		report.buckets.find((bucket) => bucket.id === "five-hour"),
		report.buckets.find((bucket) => bucket.id === "weekly"),
	];
	const parts = ["zai"];
	for (const bucket of selected) {
		if (!bucket?.limit || bucket.remaining === undefined) continue;
		const fallback = bucket.id === "weekly" ? "weekly" : "5h";
		parts.push(
			`${percentRemaining(bucket)}% ${formatWindowLabel(bucket.windowMinutes, fallback, true)}`,
		);
	}
	return parts.length > 1 ? parts.join(" ") : undefined;
}

function formatCurrencyMetric(metric: UsageReport["metrics"][number]): string {
	if (typeof metric.value !== "number") return String(metric.value);
	if (!metric.currency) return "unavailable";
	if (metric.currency === "USD") return `$${metric.value.toFixed(2)}`;
	if (metric.currency === "CNY") return `¥${metric.value.toFixed(2)}`;
	return `${metric.value.toFixed(2)} ${metric.currency}`;
}

function formatXaiReport(lines: string[], report: UsageReport): void {
	const included = report.buckets.find((bucket) => bucket.id === "included-allowance");
	if (included) {
		let value = "unavailable";
		if (included.unit === "percent" && included.used !== undefined) {
			value = formatPercentBar(included);
		} else if (included.used !== undefined) {
			value = `${formatUsd(included.used)} used`;
			if (included.limit !== undefined) value += ` of ${formatUsd(included.limit)}`;
		} else if (included.limit !== undefined) {
			value = `usage unavailable · ${formatUsd(included.limit)} limit`;
		}
		const period = included.period ? ` · ${included.period}` : "";
		const reset = included.resetsAt ? ` (resets ${formatReset(included.resetsAt)})` : "";
		lines.push(`${"Included allowance:".padEnd(VALUE_COLUMN)}${value}${period}${reset}`);
	}
	const onDemand = report.buckets.find((bucket) => bucket.id === "on-demand");
	if (onDemand) {
		let value =
			onDemand.used === undefined ? "usage unavailable" : `${formatUsd(onDemand.used)} used`;
		if (onDemand.limit !== undefined) value += ` of ${formatUsd(onDemand.limit)} cap`;
		lines.push(`${"On-demand usage:".padEnd(VALUE_COLUMN)}${value}`);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatZaiReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		if (bucket.unit === "percent" && bucket.used !== undefined) {
			lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
			continue;
		}
		const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
		let value = "unavailable";
		if (bucket.used !== undefined && bucket.limit !== undefined) {
			value = `${bucket.used} of ${bucket.limit} used`;
			if (bucket.remaining !== undefined) value += ` · ${bucket.remaining} left`;
		} else if (bucket.used !== undefined) {
			value = `${bucket.used} used`;
		} else if (bucket.remaining !== undefined) {
			value = `${bucket.remaining} left`;
		}
		lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${value}${reset}`);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatGenericReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		lines.push(
			`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(bucket.remaining ?? bucket.used ?? "unavailable", bucket.unit)}`,
		);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatCodexStatusline(
	report: UsageReport,
	model?: UsageModel,
	now = Date.now(),
	showResetCountdown = true,
): string | undefined {
	const group = selectCodexGroup(report, model);
	if (!group) return formatCodexCreditsStatus(report);
	const buckets = report.buckets.filter((bucket) => (bucket.groupId ?? bucket.id) === group);
	const labelBucket = buckets[0];
	const parts = [
		group === "codex" ? "codex" : `codex ${compactLimitLabel(labelBucket?.groupLabel ?? group)}`,
	];
	for (const bucket of buckets) {
		if (bucket.remaining === undefined) continue;
		const percent = `${clampPercent(bucket.remaining).toFixed(0)}%`;
		const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
		const window = formatWindowLabel(bucket.windowMinutes, fallback, true);
		if (!showResetCountdown) {
			parts.push(`${percent} ${window}`);
			continue;
		}
		const reset = formatResetCountdown(bucket.resetsAt, now);
		parts.push(`${percent} ${reset ? `↻ ${reset}` : window}`);
	}
	return parts.length > 1 ? parts.join(" ") : formatCodexCreditsStatus(report);
}

function formatCodexCreditsStatus(report: UsageReport): string {
	const credits = report.metrics.find((metric) => metric.id === "credits");
	if (!credits) return "codex usage unavailable";
	if (credits.value === "none") return "codex no credits";
	if (credits.value === "available") return "codex credits available";
	if (credits.value === "unlimited") return "codex credits unlimited";
	return `codex ${formatMetricValue(credits.value, "count")} credits`;
}

function selectCodexGroup(report: UsageReport, model?: UsageModel): string | undefined {
	const groups = [...new Set(report.buckets.map((bucket) => bucket.groupId ?? bucket.id))];
	if (model?.provider !== "openai-codex") {
		return groups.includes("codex") ? "codex" : groups[0];
	}
	const modelKeys = normalizedModelKeys(model);
	for (const group of groups) {
		const bucket = report.buckets.find(
			(candidate) => (candidate.groupId ?? candidate.id) === group,
		);
		const keys = [group, bucket?.groupLabel, ...(bucket?.modelKeys ?? [])]
			.map(normalizeKey)
			.filter((key): key is string => key !== undefined);
		if (keys.some((key) => modelKeys.has(key))) return group;
	}
	const variants = [...modelKeys]
		.map((key) => key.match(/(?:^|-)codex-(.+)$/)?.[1])
		.filter((value): value is string => Boolean(value));
	for (const variant of variants) {
		const matches = groups.filter((group) => {
			if (group === "codex") return false;
			const key = normalizeKey(group);
			return key ? normalizedKeyHasToken(key, variant) : false;
		});
		if (matches.length === 1) return matches[0];
	}
	return groups.includes("codex") ? "codex" : groups[0];
}

function normalizedModelKeys(model: UsageModel): Set<string> {
	const keys = new Set<string>();
	for (const value of [model.id, model.name]) {
		const key = normalizeKey(value);
		if (!key) continue;
		keys.add(key);
		const index = key.indexOf("codex");
		if (index >= 0) keys.add(key.slice(index));
	}
	return keys;
}

function normalizeKey(value: string | undefined): string | undefined {
	const separated = value?.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	if (!separated) return undefined;
	let start = 0;
	let end = separated.length;
	while (separated[start] === "-") start += 1;
	while (end > start && separated[end - 1] === "-") end -= 1;
	return separated.slice(start, end) || undefined;
}

function normalizedKeyHasToken(key: string, token: string): boolean {
	return (
		key === token ||
		key.startsWith(`${token}-`) ||
		key.endsWith(`-${token}`) ||
		key.includes(`-${token}-`)
	);
}

function compactLimitLabel(label: string): string {
	const normalized = label.replace(/[_-]+/g, " ").trim();
	const codex = /\bcodex\s/iu.exec(normalized);
	const suffix = codex ? normalized.slice(codex.index + codex[0].length).trim() : "";
	return (suffix || normalized).toLowerCase().replace(/\s+/g, " ");
}

function formatPercentBucket(bucket: UsageBucket): string {
	return `${formatPercentBar(bucket)}${bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : ""}`;
}

function formatPercentBar(bucket: UsageBucket): string {
	const remaining = clampPercent(bucket.remaining ?? 0);
	const filled = Math.round((remaining / 100) * BAR_SEGMENTS);
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}] ${remaining.toFixed(0)}% left`;
}

function formatWindowLabel(
	minutes: number | undefined,
	fallback: "5h" | "weekly",
	compact: boolean,
): string {
	if (!minutes || !Number.isFinite(minutes) || minutes <= 0) {
		return compact && fallback === "weekly" ? "wk" : capitalize(fallback);
	}
	if (minutes === 10_080) return compact ? "wk" : "Weekly";
	if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function formatResetCountdown(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined || !Number.isFinite(resetsAt) || !Number.isFinite(now))
		return undefined;
	const totalMinutes = Math.max(0, Math.ceil((resetsAt * 1_000 - now) / 60_000));
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) {
		return [
			`${String(days)}d`,
			hours > 0 ? `${String(hours)}h` : minutes > 0 ? `${String(minutes)}m` : "",
		]
			.filter(Boolean)
			.join("");
	}
	if (hours > 0)
		return [`${String(hours)}h`, minutes > 0 ? `${String(minutes)}m` : ""].filter(Boolean).join("");
	return `${String(minutes)}m`;
}

function formatMetricValue(value: number | string, unit: UsageBucket["unit"] | undefined): string {
	if (unit === "usd" && typeof value === "number") return formatUsd(value);
	return String(value);
}

function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

function formatReset(epochSeconds: number): string {
	const reset = new Date(epochSeconds * 1000);
	if (Number.isNaN(reset.getTime())) return "at an unknown time";
	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	const now = new Date();
	if (reset.toDateString() === now.toDateString()) return time;
	return `${time} on ${reset.getDate()} ${reset.toLocaleDateString(undefined, { month: "short" })}`;
}

function capitalize(value: string): string {
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}
