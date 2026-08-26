import { sanitizeDiagnosticText } from "./text.js";

const PLAN_MODE_MARKER = "[CODEX-LIKE PLAN MODE ACTIVE]";
const MAX_TOOL_NAMES = 200;
const MAX_TOOL_NAME_LENGTH = 128;

export type ResponseTelemetryState = "pending" | "received" | "unavailable" | "unsupported";

export interface ProviderRequestDiagnostic {
	version: 3;
	requestIndex: number;
	capturedAt: number;
	sessionId: string;
	provider: string | null;
	model: string | null;
	planModeMarkerPresent: boolean;
	requestBytes: number | null;
	toolDefinitionBytes: number | null;
	topLevelToolNames: string[];
	transcriptToolNames: string[];
	responseTelemetry: ResponseTelemetryState;
	response: ProviderResponseDiagnostic | null;
}

export interface ProviderResponseDiagnostic {
	version: 1;
	requestIndex: number;
	capturedAt: number;
	status: number;
	responseHeaderLatencyMs: number;
}

export interface ProviderRequestIdentity {
	requestIndex: number;
	capturedAt: number;
	sessionId: string;
	provider?: string;
	model?: string;
	api?: string;
}

export function extractProviderRequestDiagnostic(
	payload: unknown,
	identity: ProviderRequestIdentity,
): ProviderRequestDiagnostic {
	const root = asRecord(payload);
	const config = asRecord(root?.config);
	const context = asRecord(root?.context);
	return {
		version: 3,
		requestIndex: identity.requestIndex,
		capturedAt: identity.capturedAt,
		sessionId: sanitizeDiagnosticText(identity.sessionId, 128),
		provider: identity.provider ? sanitizeDiagnosticText(identity.provider, 128) : null,
		model: identity.model ? sanitizeDiagnosticText(identity.model, 256) : null,
		planModeMarkerPresent:
			containsMarker(root?.instructions) ||
			containsMarker(config?.systemInstruction) ||
			containsMarker(context?.systemPrompt) ||
			containsMarker(root?.system),
		requestBytes: jsonByteLength(payload),
		toolDefinitionBytes: providerToolDefinitionByteLength(root),
		topLevelToolNames: extractProviderToolNames(root),
		transcriptToolNames: extractTranscriptToolNames(root?.input, root?.messages),
		responseTelemetry: responseTelemetryState(identity.api),
		response: null,
	};
}

export function createProviderResponseDiagnostic(
	request: ProviderRequestDiagnostic,
	status: number,
	capturedAt: number,
): ProviderResponseDiagnostic {
	return {
		version: 1,
		requestIndex: request.requestIndex,
		capturedAt,
		status: Number.isInteger(status) ? status : 0,
		responseHeaderLatencyMs: Math.max(0, capturedAt - request.capturedAt),
	};
}

export function restoreProviderRequestDiagnostic(
	value: unknown,
): ProviderRequestDiagnostic | undefined {
	const record = asRecord(value);
	if (!isProviderRequestBase(record)) return undefined;
	if (record.version === 1 || record.version === 2) {
		const response =
			record.version === 2 && isProviderResponseDiagnostic(record.response)
				? record.response
				: null;
		return {
			version: 3,
			requestIndex: record.requestIndex as number,
			capturedAt: record.capturedAt as number,
			sessionId: sanitizeDiagnosticText(record.sessionId as string, 128),
			provider:
				typeof record.provider === "string" ? sanitizeDiagnosticText(record.provider, 128) : null,
			model: typeof record.model === "string" ? sanitizeDiagnosticText(record.model, 256) : null,
			planModeMarkerPresent: record.planModeMarkerPresent as boolean,
			requestBytes:
				record.version === 2 && isNullableFiniteNumber(record.requestBytes)
					? record.requestBytes
					: null,
			toolDefinitionBytes:
				record.version === 2 && isNullableFiniteNumber(record.toolDefinitionBytes)
					? record.toolDefinitionBytes
					: null,
			topLevelToolNames: normalizeNames(record.topLevelToolNames as string[]),
			transcriptToolNames: normalizeNames(record.transcriptToolNames as string[]),
			responseTelemetry: response ? "received" : "unavailable",
			response,
		};
	}
	if (
		record.version !== 3 ||
		!isNullableFiniteNumber(record.requestBytes) ||
		!isNullableFiniteNumber(record.toolDefinitionBytes) ||
		!isResponseTelemetryState(record.responseTelemetry) ||
		!(record.response === null || isProviderResponseDiagnostic(record.response)) ||
		(record.responseTelemetry === "received") !== isProviderResponseDiagnostic(record.response)
	) {
		return undefined;
	}
	return {
		version: 3,
		requestIndex: record.requestIndex as number,
		capturedAt: record.capturedAt as number,
		sessionId: sanitizeDiagnosticText(record.sessionId as string, 128),
		provider:
			typeof record.provider === "string" ? sanitizeDiagnosticText(record.provider, 128) : null,
		model: typeof record.model === "string" ? sanitizeDiagnosticText(record.model, 256) : null,
		planModeMarkerPresent: record.planModeMarkerPresent as boolean,
		requestBytes: record.requestBytes,
		toolDefinitionBytes: record.toolDefinitionBytes,
		topLevelToolNames: normalizeNames(record.topLevelToolNames as string[]),
		transcriptToolNames: normalizeNames(record.transcriptToolNames as string[]),
		responseTelemetry:
			record.responseTelemetry === "pending" ? "unavailable" : record.responseTelemetry,
		response: record.response as ProviderResponseDiagnostic | null,
	};
}

export function isProviderResponseDiagnostic(value: unknown): value is ProviderResponseDiagnostic {
	const record = asRecord(value);
	return (
		record?.version === 1 &&
		isNonNegativeInteger(record.requestIndex) &&
		isFiniteNumber(record.capturedAt) &&
		isNonNegativeInteger(record.status) &&
		isFiniteNumber(record.responseHeaderLatencyMs) &&
		record.responseHeaderLatencyMs >= 0
	);
}

export function attachProviderResponse(
	request: ProviderRequestDiagnostic,
	response: ProviderResponseDiagnostic,
): void {
	if (request.requestIndex !== response.requestIndex) return;
	request.responseTelemetry = "received";
	request.response = response;
}

function isProviderRequestBase(
	record: Record<string, unknown> | undefined,
): record is Record<string, unknown> {
	return (
		(record?.version === 1 || record?.version === 2 || record?.version === 3) &&
		isNonNegativeInteger(record.requestIndex) &&
		isFiniteNumber(record.capturedAt) &&
		typeof record.sessionId === "string" &&
		(record.provider === null || typeof record.provider === "string") &&
		(record.model === null || typeof record.model === "string") &&
		typeof record.planModeMarkerPresent === "boolean" &&
		isStringArray(record.topLevelToolNames) &&
		isStringArray(record.transcriptToolNames)
	);
}

function extractProviderToolDefinitionContainers(
	root: Record<string, unknown> | undefined,
): unknown[] {
	const config = asRecord(root?.config);
	const toolConfig = asRecord(root?.toolConfig);
	const context = asRecord(root?.context);
	const containers = [root?.tools, config?.tools, toolConfig?.tools, context?.tools].filter(
		(value) => value !== undefined,
	);
	if (!Array.isArray(root?.messages)) return containers;
	for (const message of root.messages) {
		const tools = asRecord(message)?.tools;
		if (tools !== undefined) containers.push(tools);
	}
	return containers;
}

function providerToolDefinitionByteLength(
	root: Record<string, unknown> | undefined,
): number | null {
	const containers = extractProviderToolDefinitionContainers(root);
	let total = 0;
	for (const container of containers) {
		const bytes = jsonByteLength(container);
		if (bytes === null) return null;
		total += bytes;
	}
	return total;
}

function extractProviderToolNames(root: Record<string, unknown> | undefined): string[] {
	const config = asRecord(root?.config);
	const toolConfig = asRecord(root?.toolConfig);
	const context = asRecord(root?.context);
	return normalizeNames([
		...extractToolNames(root?.tools),
		...extractGoogleToolNames(config?.tools),
		...extractBedrockToolNames(toolConfig?.tools),
		...extractToolNames(context?.tools),
	]);
}

function extractGoogleToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((group) => extractToolNames(asRecord(group)?.functionDeclarations));
}

function extractBedrockToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		const name = firstName(asRecord(asRecord(candidate)?.toolSpec)?.name);
		return name ? [name] : [];
	});
}

function extractTranscriptToolNames(input: unknown, messages: unknown): string[] {
	const names: string[] = [];
	if (Array.isArray(input)) {
		for (const item of input) {
			const record = asRecord(item);
			if (record?.type !== "additional_tools" && record?.type !== "tool_search_output") {
				continue;
			}
			names.push(...extractToolNames(record.tools));
			if (record.type === "tool_search_output") {
				const output = asRecord(record.output);
				names.push(
					...extractToolNames(Array.isArray(record.output) ? record.output : output?.tools),
				);
			}
		}
	}
	if (Array.isArray(messages)) {
		for (const message of messages) {
			names.push(...extractToolNames(asRecord(message)?.tools));
		}
	}
	return normalizeNames(names);
}

function extractToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const candidate of value) {
		const record = asRecord(candidate);
		if (!record) continue;
		const functionDefinition = asRecord(record.function);
		const customDefinition = asRecord(record.custom);
		const name = firstName(record.name, functionDefinition?.name, customDefinition?.name);
		if (name) names.push(name);
	}
	return normalizeNames(names);
}

function containsMarker(value: unknown): boolean {
	if (typeof value === "string") return value.includes(PLAN_MODE_MARKER);
	if (Array.isArray(value)) return value.some(containsMarker);
	const record = asRecord(value);
	if (!record) return false;
	return containsMarker(record.text) || containsMarker(record.content);
}

function firstName(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const normalized = sanitizeDiagnosticText(value, MAX_TOOL_NAME_LENGTH);
		if (normalized) return normalized;
	}
	return undefined;
}

function normalizeNames(names: readonly string[]): string[] {
	return [...new Set(names.map((name) => sanitizeDiagnosticText(name, MAX_TOOL_NAME_LENGTH)))]
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right))
		.slice(0, MAX_TOOL_NAMES);
}

function responseTelemetryState(api: string | undefined): ResponseTelemetryState {
	return api === "google-generative-ai" || api === "google-vertex" ? "unsupported" : "pending";
}

function jsonByteLength(value: unknown): number | null {
	if (value === undefined) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return null;
	}
}

function isResponseTelemetryState(value: unknown): value is ResponseTelemetryState {
	return (
		value === "pending" ||
		value === "received" ||
		value === "unavailable" ||
		value === "unsupported"
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
	return value === null || isFiniteNumber(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
