import { isAbsolute, win32 } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderCaptureState } from "./capture-state.js";
import type { ProviderRequestDiagnostic } from "./provider-request.js";
import {
	compareRuntimeSnapshots,
	createRuntimeReport,
	type RuntimeDiagnosticReport,
	type RuntimeSnapshot,
} from "./snapshot.js";

export const DIAGNOSTIC_ACTIONS = [
	"status",
	"enable",
	"disable",
	"latest",
	"show",
	"compare",
	"clear",
	"configure",
	"bundle",
] as const;
export const DIAGNOSTIC_DETAILS = ["summary", "full"] as const;
export const DIAGNOSTIC_SECTIONS = [
	"provider",
	"cache",
	"tools",
	"extensions",
	"environment",
	"timeline",
	"privacy",
] as const;

export type DiagnosticAction = (typeof DIAGNOSTIC_ACTIONS)[number];
export type DiagnosticDetail = (typeof DIAGNOSTIC_DETAILS)[number];
export type DiagnosticSection = (typeof DIAGNOSTIC_SECTIONS)[number];

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const PROVIDER_HOOK_LIMITATIONS = [
	"before_provider_request exposes the serialized payload at this extension's position in handler load order; later extensions can still replace it.",
	"The hook does not prove that the provider accepted or executed the exposed tools.",
	"Response latency ends when response headers arrive and does not measure stream completion.",
	"The installed google-generative-ai and google-vertex adapters do not emit response-header telemetry, so those requests are marked unsupported.",
	"Provider responses are matched to requests by event order because Pi exposes no request identifier to this hook.",
	"ExtensionAPI cannot enumerate passive event-only extensions, so extension visibility is limited to public tool and command surfaces.",
	"Retention bounds the active reporting window; Pi session custom entries are append-only and are not erased from an existing session file.",
];

export interface DiagnosticFinding {
	severity: "error" | "warning" | "info";
	code: string;
	message: string;
	recommendation?: string;
}

interface DiagnosticReportOptions {
	action: DiagnosticAction;
	detail: DiagnosticDetail;
	sections: readonly DiagnosticSection[];
	limit: number;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	capture: ProviderCaptureState;
	capturedAt: number;
}

export function createDiagnosticResponse(options: DiagnosticReportOptions) {
	const runtime = createRuntimeReport(options.pi, options.ctx, options.capturedAt);
	const provider = createProviderReport(options.action, options.limit, options.capture);
	const bundleRequested = options.action === "bundle";
	const toolCatalog = bundleRequested
		? redactToolCatalogPaths(runtime.toolCatalog)
		: runtime.toolCatalog;
	const extensions = bundleRequested
		? redactExtensionSurfacePaths(runtime.extensions)
		: runtime.extensions;
	const privacy = createPrivacyAudit(options.capture.records, {
		bundleRequested,
		bundleSourceRedactionPassed:
			!bundleRequested || bundleSourcesAreRedacted(toolCatalog, extensions.surfaces),
	});
	const findings = createFindings(runtime, provider, options.capture, privacy);
	const selectedSections = selectSections(options);
	const details: Record<string, unknown> = {};
	if (selectedSections.has("provider")) details.providerRequestCapture = provider;
	if (selectedSections.has("cache")) details.cache = runtime.cache;
	if (selectedSections.has("tools")) {
		details.tools = {
			state: runtime.tools,
			catalog: toolCatalog,
			knownProviderDefinitionBytes: sumComplete(
				toolCatalog.map(({ knownProviderDefinitionBytes }) => knownProviderDefinitionBytes),
			),
			definitionSizeBasis:
				"Lower bound from name, description, and parameters. ExtensionAPI does not expose constrainedSampling; captured provider requests report actual serialized tool bytes.",
		};
	}
	if (selectedSections.has("extensions")) details.extensions = extensions;
	if (selectedSections.has("environment")) details.environment = runtime.environment;
	if (selectedSections.has("timeline")) {
		details.timeline = {
			recentRuntimeRecords: runtime.recentRuntimeRecords,
			comparison: selectRuntimeComparison(options.action, runtime.recentRuntimeRecords),
		};
	}
	if (selectedSections.has("privacy")) {
		details.privacy = privacy;
		details.limitations = PROVIDER_HOOK_LIMITATIONS;
	}

	return {
		format: "runtime-diagnostics/v2",
		action: options.action,
		generatedAt: options.capturedAt,
		export:
			options.action === "bundle"
				? {
						sanitized: privacy.passed,
						contentType: "application/json",
						description: privacy.passed
							? "Shareable privacy-filtered runtime diagnostic bundle."
							: "Diagnostic bundle failed its privacy audit and should not be shared.",
					}
				: undefined,
		summary: {
			health: findings.some(({ severity }) => severity === "error")
				? "error"
				: findings.some(({ severity }) => severity === "warning")
					? "warning"
					: "ok",
			current: runtime.current,
			cache: {
				requestCount: runtime.cache.requestCount,
				hitRatePercent: runtime.cache.hitRatePercent,
				promptTokens: runtime.cache.promptTokens,
			},
			tools: {
				configuredCount: runtime.tools.configuredCount,
				activeCount: runtime.tools.activeCount,
				inactiveCount: runtime.tools.inactiveCount,
				providerVisibleCount: provider.latest ? providerVisibleNames(provider.latest).length : null,
			},
			capture: {
				enabled: options.capture.enabled,
				retainedRecordCount: options.capture.records.length,
				prunedRecordCount: options.capture.prunedRecordCount,
				policy: options.capture.policy,
			},
			visibleExtensionCount: runtime.extensions.visibleCount,
			findingCounts: countFindings(findings),
		},
		findings,
		recommendations: [
			...new Set(
				findings
					.map(({ recommendation }) => recommendation)
					.filter((value): value is string => Boolean(value)),
			),
		],
		details,
	};
}

export function boundDiagnosticResponse(value: ReturnType<typeof createDiagnosticResponse>): {
	value: unknown;
	text: string;
} {
	const text = JSON.stringify(value, null, 2);
	if (withinOutputBounds(text)) return { value, text };

	const compact = {
		format: value.format,
		action: value.action,
		generatedAt: value.generatedAt,
		export: value.export,
		summary: value.summary,
		findings: value.findings.slice(0, 20),
		recommendations: value.recommendations.slice(0, 20),
		outputNote: "Detailed sections were omitted to keep tool output below 50 KB and 2,000 lines.",
	};
	const compactText = JSON.stringify(compact, null, 2);
	if (withinOutputBounds(compactText)) return { value: compact, text: compactText };

	const minimal = {
		format: value.format,
		action: value.action,
		generatedAt: value.generatedAt,
		summary: value.summary,
		outputNote:
			"Findings and detailed sections were omitted to keep tool output below 50 KB and 2,000 lines.",
	};
	return { value: minimal, text: JSON.stringify(minimal, null, 2) };
}

export function formatCommandSummary(
	response: ReturnType<typeof createDiagnosticResponse>,
	route: string,
): string {
	if (route === "help") {
		return [
			"/runtime-diagnostics [status|provider|cache|tools|extensions|privacy|help]",
			"Use the runtime_diagnostics tool for full JSON, comparisons, capture controls, retention configuration, and bundles.",
		].join("\n");
	}
	const { summary } = response;
	const header = [
		`Runtime diagnostics: ${summary.health}`,
		`Model: ${summary.current.provider ?? "none"}/${summary.current.model ?? "none"} (${summary.current.thinkingLevel})`,
	];
	if (route === "status") {
		return [
			...header,
			`Cache: ${summary.cache.requestCount} request(s), ${formatPercent(summary.cache.hitRatePercent)} hit rate`,
			`Tools: ${summary.tools.activeCount}/${summary.tools.configuredCount} active, ${summary.tools.providerVisibleCount ?? "no"} provider-visible`,
			`Capture: ${summary.capture.enabled ? "enabled" : "disabled"}, ${summary.capture.retainedRecordCount} retained`,
			`Findings: ${summary.findingCounts.error} error, ${summary.findingCounts.warning} warning, ${summary.findingCounts.info} info`,
		].join("\n");
	}
	const detail = response.details as Record<string, unknown>;
	if (route === "provider") {
		const provider = detail.providerRequestCapture as
			| ReturnType<typeof createProviderReport>
			| undefined;
		return [
			...header,
			`Capture: ${provider?.enabled ? "enabled" : "disabled"}`,
			`Retained: ${provider?.retainedRecordCount ?? 0}`,
			`Latest request: ${provider?.latest?.requestIndex ?? "none"}`,
			`Latest status: ${formatResponseTelemetry(provider?.latest ?? null)}`,
			`Telemetry completed/pending/unavailable/unsupported: ${provider?.performance.completedRequestCount ?? 0}/${provider?.performance.pendingRequestCount ?? 0}/${provider?.performance.unavailableRequestCount ?? 0}/${provider?.performance.unsupportedRequestCount ?? 0}`,
			`Average header latency: ${formatMilliseconds(provider?.performance.averageResponseHeaderLatencyMs ?? null)}`,
		].join("\n");
	}
	if (route === "cache") {
		const cache = detail.cache as RuntimeDiagnosticReport["cache"] | undefined;
		return [
			...header,
			`Requests: ${cache?.requestCount ?? 0}`,
			`Prompt tokens: ${cache?.promptTokens ?? 0}`,
			`Cache read/write: ${cache?.cacheRead ?? 0}/${cache?.cacheWrite ?? 0}`,
			`Hit rate: ${formatPercent(cache?.hitRatePercent ?? null)}`,
		].join("\n");
	}
	if (route === "tools") {
		const tools = detail.tools as
			| {
					state: RuntimeDiagnosticReport["tools"];
					knownProviderDefinitionBytes: number | null;
			  }
			| undefined;
		return [
			...header,
			`Configured/active/inactive: ${tools?.state.configuredCount ?? 0}/${tools?.state.activeCount ?? 0}/${tools?.state.inactiveCount ?? 0}`,
			`Known provider-definition bytes: ${tools?.knownProviderDefinitionBytes ?? "unknown"}`,
			`Active: ${formatNameList(tools?.state.active ?? [])}`,
			`Inactive: ${formatNameList(tools?.state.inactive ?? [])}`,
		].join("\n");
	}
	if (route === "extensions") {
		const extensions = detail.extensions as RuntimeDiagnosticReport["extensions"] | undefined;
		return [
			...header,
			`Visible extension surfaces: ${extensions?.visibleCount ?? 0}`,
			`Omitted: ${extensions?.omittedCount ?? 0}`,
			`Sources: ${formatNameList(extensions?.surfaces.map(({ source }) => source) ?? [])}`,
		].join("\n");
	}
	const privacy = detail.privacy as ReturnType<typeof createPrivacyAudit> | undefined;
	return [
		...header,
		`Privacy audit: ${privacy?.passed ? "passed" : "failed"}`,
		`Bundle source redaction: ${privacy?.bundleSourceRedaction ?? "unknown"}`,
		`Checked records: ${privacy?.checkedRecordCount ?? 0}`,
		`Unexpected fields: ${formatNameList(privacy?.unexpectedFields ?? [])}`,
		`Not retained: ${privacy?.notRetained.join(", ") ?? "unknown"}`,
	].join("\n");
}

function selectSections(options: DiagnosticReportOptions): Set<DiagnosticSection> {
	if (options.action === "bundle") return new Set(DIAGNOSTIC_SECTIONS);
	if (options.sections.length > 0) return new Set(options.sections);
	if (options.detail === "full") {
		return new Set(DIAGNOSTIC_SECTIONS);
	}
	if (options.action === "latest" || options.action === "show") return new Set(["provider"]);
	if (options.action === "compare") return new Set(["provider", "timeline"]);
	if (
		options.action === "enable" ||
		options.action === "disable" ||
		options.action === "clear" ||
		options.action === "configure"
	) {
		return new Set(["provider"]);
	}
	return new Set();
}

function createProviderReport(
	action: DiagnosticAction,
	limit: number,
	capture: ProviderCaptureState,
) {
	const recent = action === "show" || action === "bundle" ? capture.records.slice(-limit) : [];
	const latest = capture.records.at(-1) ?? null;
	const comparisonRecords = selectComparisonRecords(action, recent, capture.records);
	const completed = capture.records.filter(
		({ responseTelemetry }) => responseTelemetry === "received",
	);
	const pending = capture.records.filter(
		({ responseTelemetry }) => responseTelemetry === "pending",
	);
	const unavailable = capture.records.filter(
		({ responseTelemetry }) => responseTelemetry === "unavailable",
	);
	const unsupported = capture.records.filter(
		({ responseTelemetry }) => responseTelemetry === "unsupported",
	);
	return {
		enabled: capture.enabled,
		retainedRecordCount: capture.records.length,
		prunedRecordCount: capture.prunedRecordCount,
		policy: capture.policy,
		latest,
		recent,
		comparison:
			comparisonRecords.length === 2
				? compareProviderRequests(comparisonRecords[0], comparisonRecords[1])
				: null,
		performance: {
			completedRequestCount: completed.length,
			pendingRequestCount: pending.length,
			unavailableRequestCount: unavailable.length,
			unsupportedRequestCount: unsupported.length,
			averageResponseHeaderLatencyMs:
				completed.length > 0
					? completed.reduce(
							(total, record) => total + (record.response?.responseHeaderLatencyMs ?? 0),
							0,
						) / completed.length
					: null,
			statusCounts: countStatuses(completed),
			requestBytes: sumComplete(capture.records.map(({ requestBytes }) => requestBytes)),
			toolDefinitionBytes: sumComplete(
				capture.records.map(({ toolDefinitionBytes }) => toolDefinitionBytes),
			),
		},
	};
}

function createFindings(
	runtime: RuntimeDiagnosticReport,
	provider: ReturnType<typeof createProviderReport>,
	capture: ProviderCaptureState,
	privacy: ReturnType<typeof createPrivacyAudit>,
): DiagnosticFinding[] {
	const findings: DiagnosticFinding[] = runtime.issues.map((message) => ({
		severity: "warning",
		code: "runtime-state",
		message,
		recommendation: "Inspect the tools and environment sections for the conflicting source.",
	}));
	if (!privacy.passed) {
		findings.push({
			severity: "error",
			code: "privacy-audit-failed",
			message: `The diagnostic bundle privacy audit failed: ${privacy.unexpectedFields.join(", ")}.`,
			recommendation:
				"Disable capture and clear active records before sharing a diagnostic bundle.",
		});
	}
	if (!capture.enabled) {
		findings.push({
			severity: "info",
			code: "capture-disabled",
			message: "Provider-request capture is disabled.",
			recommendation: "Enable capture before reproducing a provider serialization issue.",
		});
	}
	if (
		runtime.cache.requestCount >= 3 &&
		runtime.cache.promptTokens >= 1_000 &&
		runtime.cache.cacheRead === 0
	) {
		findings.push({
			severity: "info",
			code: "cache-no-reads",
			message: `No cache reads were reported across ${runtime.cache.requestCount} requests.`,
			recommendation:
				"Compare consecutive provider requests and verify that the selected provider/model supports prompt caching before treating this as a cache regression.",
		});
	}
	const latest = provider.latest;
	if (!latest) return findings;
	if (latest.provider !== runtime.current.provider || latest.model !== runtime.current.model) {
		findings.push({
			severity: "warning",
			code: "provider-model-stale",
			message: "The latest captured provider/model does not match the current runtime selection.",
			recommendation: "Capture one request after the model selection settles, then compare again.",
		});
	}
	const visible = new Set(providerVisibleNames(latest));
	const missing = runtime.tools.active.filter((name) => !visible.has(name));
	const extra = [...visible].filter((name) => !runtime.tools.active.includes(name));
	if (missing.length > 0) {
		findings.push({
			severity: "warning",
			code: "active-tools-not-provider-visible",
			message: `Active tools absent from the latest provider request: ${missing.join(", ")}.`,
			recommendation:
				"Inspect deferred loading and later provider hooks; the captured hook position may precede a later payload replacement.",
		});
	}
	if (extra.length > 0) {
		findings.push({
			severity: "info",
			code: "provider-tools-not-active",
			message: `Provider-visible tools absent from the current active set: ${extra.join(", ")}.`,
			recommendation:
				"Check whether the active set changed after capture or whether transcript-anchored deferred tools remain visible.",
		});
	}
	if (latest.responseTelemetry === "unavailable") {
		findings.push({
			severity: "info",
			code: "response-telemetry-unavailable",
			message: "No response-header telemetry is available for the latest provider request.",
			recommendation:
				"Reproduce the request before interpreting HTTP status or response-header latency; if telemetry remains unavailable, inspect provider connectivity and cancellation.",
		});
	}
	if (latest.responseTelemetry === "unsupported") {
		findings.push({
			severity: "info",
			code: "response-telemetry-unsupported",
			message: "The selected provider adapter does not expose response-header telemetry.",
			recommendation:
				"Use request-size and provider-visible-tool diagnostics without interpreting the missing HTTP status or latency as a pending response.",
		});
	}
	if (latest.response && (latest.response.status < 200 || latest.response.status >= 400)) {
		findings.push({
			severity: "warning",
			code: "provider-http-status",
			message: `The latest provider response reported HTTP ${latest.response.status}.`,
			recommendation:
				"Inspect provider availability, authentication, entitlement, and rate limits.",
		});
	}
	return findings;
}

function createPrivacyAudit(
	records: readonly ProviderRequestDiagnostic[],
	options: { bundleRequested: boolean; bundleSourceRedactionPassed: boolean },
) {
	const allowedRequestFields = new Set([
		"version",
		"requestIndex",
		"capturedAt",
		"sessionId",
		"provider",
		"model",
		"planModeMarkerPresent",
		"requestBytes",
		"toolDefinitionBytes",
		"topLevelToolNames",
		"transcriptToolNames",
		"responseTelemetry",
		"response",
	]);
	const allowedResponseFields = new Set([
		"version",
		"requestIndex",
		"capturedAt",
		"status",
		"responseHeaderLatencyMs",
	]);
	const unexpectedFields = new Set<string>();
	if (options.bundleRequested && !options.bundleSourceRedactionPassed) {
		unexpectedFields.add("bundle.source-location");
	}
	for (const record of records) {
		for (const key of Object.keys(record)) {
			if (!allowedRequestFields.has(key)) unexpectedFields.add(`request.${key}`);
		}
		if (!record.response) continue;
		for (const key of Object.keys(record.response)) {
			if (!allowedResponseFields.has(key)) unexpectedFields.add(`response.${key}`);
		}
	}
	return {
		passed: unexpectedFields.size === 0,
		checkedRecordCount: records.length,
		unexpectedFields: [...unexpectedFields].sort(),
		bundleSourceRedaction: options.bundleRequested
			? options.bundleSourceRedactionPassed
				? "passed"
				: "failed"
			: "not-applicable",
		retainedFields: [...allowedRequestFields].sort(),
		notRetained: [
			"prompts and instructions",
			"message contents",
			"tool schemas and arguments",
			"HTTP headers and response bodies",
			"credentials, API keys, and authorization values",
		],
		notes: [
			"Request and tool-definition byte counts are retained as numbers, never as serialized content.",
			"Captured display strings are stripped of terminal controls and bounded before retention.",
			"Bundle exports redact non-virtual source paths, package source references, and other path-like source references.",
		],
	};
}

const REDACTED_SOURCE_PATH = "[redacted-local-path]";

function redactToolCatalogPaths(
	catalog: RuntimeDiagnosticReport["toolCatalog"],
): RuntimeDiagnosticReport["toolCatalog"] {
	return catalog.map((tool) => ({
		...tool,
		source: {
			...tool.source,
			path: redactSourcePath(tool.source.path),
			source: redactSourceReference(tool.source.source, tool.source.origin),
		},
	}));
}

function redactExtensionSurfacePaths(
	extensions: RuntimeDiagnosticReport["extensions"],
): RuntimeDiagnosticReport["extensions"] {
	return {
		...extensions,
		surfaces: extensions.surfaces.map((surface) => ({
			...surface,
			path: redactSourcePath(surface.path),
			source: redactSourceReference(surface.source, surface.origin),
		})),
	};
}

function bundleSourcesAreRedacted(
	catalog: RuntimeDiagnosticReport["toolCatalog"],
	surfaces: RuntimeDiagnosticReport["extensions"]["surfaces"],
): boolean {
	const pathsAreRedacted = [
		...catalog.map(({ source }) => source.path),
		...surfaces.map(({ path }) => path),
	].every((path) => path === REDACTED_SOURCE_PATH || isVirtualSourcePath(path));
	const sourcesAreRedacted = [
		...catalog.map(({ source }) => ({ source: source.source, origin: source.origin })),
		...surfaces.map(({ source, origin }) => ({ source, origin })),
	].every(
		({ source, origin }) =>
			source === REDACTED_SOURCE_PATH || (origin !== "package" && !isPathLikeSource(source)),
	);
	return pathsAreRedacted && sourcesAreRedacted;
}

function redactSourcePath(path: string): string {
	return isVirtualSourcePath(path) ? path : REDACTED_SOURCE_PATH;
}

function redactSourceReference(source: string, origin: string): string {
	return origin === "package" || isPathLikeSource(source) ? REDACTED_SOURCE_PATH : source;
}

function isPathLikeSource(source: string): boolean {
	return (
		isAbsolute(source) ||
		win32.isAbsolute(source) ||
		/^file:/iu.test(source) ||
		/^(?:\.{1,2}|~)[\\/]/u.test(source)
	);
}

function isVirtualSourcePath(path: string): boolean {
	return path.startsWith("<") && path.endsWith(">");
}

function selectComparisonRecords(
	action: DiagnosticAction,
	recent: readonly ProviderRequestDiagnostic[],
	all: readonly ProviderRequestDiagnostic[],
): readonly ProviderRequestDiagnostic[] {
	if (all.length < 2) return [];
	if (action === "compare" || action === "bundle") return [all[0], all[all.length - 1]];
	if (action === "show" && recent.length >= 2) {
		return [recent[0], recent[recent.length - 1]];
	}
	return all.slice(-2);
}

function compareProviderRequests(from: ProviderRequestDiagnostic, to: ProviderRequestDiagnostic) {
	return {
		fromRequestIndex: from.requestIndex,
		toRequestIndex: to.requestIndex,
		providerChanged: from.provider !== to.provider,
		modelChanged: from.model !== to.model,
		planModeMarkerChanged: from.planModeMarkerPresent !== to.planModeMarkerPresent,
		requestBytesDelta: nullableDelta(from.requestBytes, to.requestBytes),
		toolDefinitionBytesDelta: nullableDelta(from.toolDefinitionBytes, to.toolDefinitionBytes),
		responseStatusChanged: from.response?.status !== to.response?.status,
		responseHeaderLatencyMsDelta: nullableDelta(
			from.response?.responseHeaderLatencyMs ?? null,
			to.response?.responseHeaderLatencyMs ?? null,
		),
		topLevelTools: diffNames(from.topLevelToolNames, to.topLevelToolNames),
		transcriptTools: diffNames(from.transcriptToolNames, to.transcriptToolNames),
	};
}

function selectRuntimeComparison(action: DiagnosticAction, records: readonly RuntimeSnapshot[]) {
	if (records.length < 2) return null;
	const selected =
		action === "compare" || action === "bundle"
			? [records[0], records[records.length - 1]]
			: records.slice(-2);
	return compareRuntimeSnapshots(selected[0], selected[1]);
}

function countStatuses(records: readonly ProviderRequestDiagnostic[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const record of records) {
		const key = String(record.response?.status ?? "unknown");
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

function countFindings(findings: readonly DiagnosticFinding[]) {
	return {
		error: findings.filter(({ severity }) => severity === "error").length,
		warning: findings.filter(({ severity }) => severity === "warning").length,
		info: findings.filter(({ severity }) => severity === "info").length,
	};
}

function providerVisibleNames(record: ProviderRequestDiagnostic): string[] {
	return [...new Set([...record.topLevelToolNames, ...record.transcriptToolNames])].sort();
}

function sumComplete(values: readonly (number | null)[]): number | null {
	if (values.length === 0) return null;
	let total = 0;
	for (const value of values) {
		if (value === null) return null;
		total += value;
	}
	return total;
}

function nullableDelta(from: number | null, to: number | null): number | null {
	return from === null || to === null ? null : to - from;
}

function diffNames(from: readonly string[], to: readonly string[]) {
	const previous = new Set(from);
	const current = new Set(to);
	return {
		added: to.filter((name) => !previous.has(name)),
		removed: from.filter((name) => !current.has(name)),
	};
}

function withinOutputBounds(text: string): boolean {
	return (
		Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES &&
		text.split("\n").length <= MAX_OUTPUT_LINES
	);
}

function formatPercent(value: number | null): string {
	return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function formatResponseTelemetry(record: ProviderRequestDiagnostic | null): string {
	if (!record) return "none";
	if (record.responseTelemetry !== "received") return record.responseTelemetry;
	return String(record.response?.status ?? "unavailable");
}

function formatMilliseconds(value: number | null): string {
	return value === null ? "n/a" : `${value.toFixed(1)} ms`;
}

function formatNameList(values: readonly string[]): string {
	if (values.length === 0) return "none";
	const visible = values.slice(0, 10);
	return `${visible.join(", ")}${values.length > visible.length ? `, +${values.length - visible.length} more` : ""}`;
}
