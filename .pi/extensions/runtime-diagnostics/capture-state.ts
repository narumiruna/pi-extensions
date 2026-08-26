import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	attachProviderResponse,
	isProviderResponseDiagnostic,
	type ProviderRequestDiagnostic,
	restoreProviderRequestDiagnostic,
} from "./provider-request.js";

export const PROVIDER_REQUEST_ENTRY_TYPE = "pi-debug:provider-request";
export const PROVIDER_RESPONSE_ENTRY_TYPE = "pi-debug:provider-response";
export const CONTROL_ENTRY_TYPE = "pi-debug:control";
export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
	maxRecords: 100,
	maxAgeMinutes: 24 * 60,
};
export const MAX_CAPTURE_RECORDS = 500;
export const MAX_CAPTURE_AGE_MINUTES = 7 * 24 * 60;

export interface CapturePolicy {
	maxRecords: number;
	maxAgeMinutes: number;
}

export interface ProviderCaptureState {
	enabled: boolean;
	records: ProviderRequestDiagnostic[];
	pendingRequestIndexes: number[];
	nextRequestIndex: number;
	policy: CapturePolicy;
	prunedRecordCount: number;
}

export type CaptureControlAction = "enable" | "disable" | "clear" | "configure";

interface LegacyControlEntry {
	version: 1;
	capturedAt: number;
	action: "enable" | "disable" | "clear";
}

export interface ControlEntry {
	version: 2;
	capturedAt: number;
	action: CaptureControlAction;
	policy: CapturePolicy;
}

export function createCaptureState(): ProviderCaptureState {
	return {
		enabled: true,
		records: [],
		pendingRequestIndexes: [],
		nextRequestIndex: 1,
		policy: { ...DEFAULT_CAPTURE_POLICY },
		prunedRecordCount: 0,
	};
}

export function restoreCaptureState(
	entries: readonly SessionEntry[],
	capturedAt: number,
): ProviderCaptureState {
	const state = createCaptureState();
	const requestsByIndex = new Map<number, ProviderRequestDiagnostic>();
	let maximumRequestIndex = 0;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === PROVIDER_REQUEST_ENTRY_TYPE) {
			const record = restoreProviderRequestDiagnostic(entry.data);
			if (!record) continue;
			maximumRequestIndex = Math.max(maximumRequestIndex, record.requestIndex);
			state.records.push(record);
			requestsByIndex.set(record.requestIndex, record);
			pruneRestoredCaptureState(state, record.capturedAt, requestsByIndex);
			continue;
		}
		if (entry.customType === PROVIDER_RESPONSE_ENTRY_TYPE) {
			const response = entry.data;
			if (!isProviderResponseDiagnostic(response)) continue;
			const request = requestsByIndex.get(response.requestIndex);
			if (request) attachProviderResponse(request, response);
			continue;
		}
		if (entry.customType !== CONTROL_ENTRY_TYPE) continue;
		const control = normalizeControlEntry(entry.data);
		if (!control) continue;
		const policy = "policy" in control ? control.policy : state.policy;
		applyControlToState(state, control.action, policy);
		pruneRestoredCaptureState(state, control.capturedAt, requestsByIndex);
	}
	state.nextRequestIndex = maximumRequestIndex + 1;
	pruneCaptureState(state, capturedAt);
	return state;
}

export function finalizePendingRequests(state: ProviderCaptureState): void {
	const pendingIndexes = new Set(state.pendingRequestIndexes);
	for (const record of state.records) {
		if (pendingIndexes.has(record.requestIndex) && record.responseTelemetry === "pending") {
			record.responseTelemetry = "unavailable";
			record.response = null;
		}
	}
	state.pendingRequestIndexes = [];
}

export function createControlEntry(
	state: ProviderCaptureState,
	action: CaptureControlAction,
	capturedAt: number,
	policyPatch: Partial<CapturePolicy> = {},
): ControlEntry {
	const policy = normalizePolicy({
		maxRecords: policyPatch.maxRecords ?? state.policy.maxRecords,
		maxAgeMinutes: policyPatch.maxAgeMinutes ?? state.policy.maxAgeMinutes,
	});
	applyControlToState(state, action, policy);
	pruneCaptureState(state, capturedAt);
	return { version: 2, capturedAt, action, policy: { ...state.policy } };
}

export function pruneCaptureState(state: ProviderCaptureState, capturedAt: number): void {
	const previousLength = state.records.length;
	const oldestAllowed = capturedAt - state.policy.maxAgeMinutes * 60_000;
	state.records = state.records
		.filter((record) => record.capturedAt >= oldestAllowed)
		.slice(-state.policy.maxRecords);
	const retainedIndexes = new Set(state.records.map(({ requestIndex }) => requestIndex));
	state.pendingRequestIndexes = state.pendingRequestIndexes.filter((requestIndex) =>
		retainedIndexes.has(requestIndex),
	);
	state.prunedRecordCount += previousLength - state.records.length;
}

function pruneRestoredCaptureState(
	state: ProviderCaptureState,
	capturedAt: number,
	requestsByIndex: Map<number, ProviderRequestDiagnostic>,
): void {
	pruneCaptureState(state, capturedAt);
	const retainedRecords = new Set(state.records);
	for (const [requestIndex, record] of requestsByIndex) {
		if (!retainedRecords.has(record)) requestsByIndex.delete(requestIndex);
	}
}

function applyControlToState(
	state: ProviderCaptureState,
	action: CaptureControlAction,
	policy: CapturePolicy,
): void {
	state.policy = { ...policy };
	if (action === "enable") state.enabled = true;
	if (action === "disable") state.enabled = false;
	if (action === "clear") {
		state.records = [];
		state.pendingRequestIndexes = [];
	}
}

function normalizeControlEntry(value: unknown): ControlEntry | LegacyControlEntry | undefined {
	if (!isRecord(value) || !Number.isFinite(value.capturedAt)) return undefined;
	if (
		value.version === 1 &&
		(value.action === "enable" || value.action === "disable" || value.action === "clear")
	) {
		return value as unknown as LegacyControlEntry;
	}
	if (
		value.version !== 2 ||
		(value.action !== "enable" &&
			value.action !== "disable" &&
			value.action !== "clear" &&
			value.action !== "configure") ||
		!isCapturePolicy(value.policy)
	) {
		return undefined;
	}
	return {
		version: 2,
		capturedAt: value.capturedAt as number,
		action: value.action,
		policy: normalizePolicy(value.policy),
	};
}

function normalizePolicy(policy: Partial<CapturePolicy>): CapturePolicy {
	return {
		maxRecords: clampInteger(
			policy.maxRecords,
			DEFAULT_CAPTURE_POLICY.maxRecords,
			1,
			MAX_CAPTURE_RECORDS,
		),
		maxAgeMinutes: clampInteger(
			policy.maxAgeMinutes,
			DEFAULT_CAPTURE_POLICY.maxAgeMinutes,
			1,
			MAX_CAPTURE_AGE_MINUTES,
		),
	};
}

function isCapturePolicy(value: unknown): value is CapturePolicy {
	if (!isRecord(value)) return false;
	return (
		typeof value.maxRecords === "number" &&
		Number.isInteger(value.maxRecords) &&
		typeof value.maxAgeMinutes === "number" &&
		Number.isInteger(value.maxAgeMinutes)
	);
}

function clampInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
