import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	CompactionEntry,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	buildContextEntries,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { fingerprintMessage } from "./checkpoint.js";

export const CONTEXT_STATE_ENTRY_TYPE = "pi-codex-context-state";
export const CONTEXT_CONTRACT_MESSAGE_TYPE = "pi-codex-context-contract";
export const CONTEXT_DEACTIVATION_MESSAGE_TYPE = "pi-codex-context-deactivation";
export const CONTEXT_DETAILS_KIND = "pi-codex-context-window";
export const CONTEXT_VERSION = 1;
const MAX_DETAILS_BYTES = 8 * 1024 * 1024;
const MAX_FINGERPRINTS = 100_000;

export interface ContextLineage {
	firstWindowId: string;
	previousWindowId?: string;
	currentWindowId: string;
}

export interface ContextStateEntryData extends ContextLineage {
	kind: typeof CONTEXT_DETAILS_KIND;
	version: typeof CONTEXT_VERSION;
}

export interface ExperimentalContextDetails extends ContextLineage {
	kind: typeof CONTEXT_DETAILS_KIND;
	version: typeof CONTEXT_VERSION;
	reason: SessionBeforeCompactEvent["reason"];
	requestId?: string;
	keptMessageFingerprints: string[];
	createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function parseLineage(value: Record<string, unknown>): ContextLineage | undefined {
	if (!isIdentifier(value.firstWindowId) || !isIdentifier(value.currentWindowId)) return undefined;
	if (value.previousWindowId !== undefined && !isIdentifier(value.previousWindowId))
		return undefined;
	return {
		firstWindowId: value.firstWindowId,
		...(typeof value.previousWindowId === "string"
			? { previousWindowId: value.previousWindowId }
			: {}),
		currentWindowId: value.currentWindowId,
	};
}

export function parseContextState(value: unknown): ContextStateEntryData | undefined {
	if (!isRecord(value)) return undefined;
	const lineage = parseLineage(value);
	if (
		!lineage ||
		value.kind !== CONTEXT_DETAILS_KIND ||
		value.version !== CONTEXT_VERSION ||
		value.previousWindowId !== undefined ||
		lineage.firstWindowId !== lineage.currentWindowId
	) {
		return undefined;
	}
	return { kind: CONTEXT_DETAILS_KIND, version: CONTEXT_VERSION, ...lineage };
}

export function parseExperimentalContextDetails(
	value: unknown,
): ExperimentalContextDetails | undefined {
	if (!isRecord(value)) return undefined;
	try {
		if (serializedBytes(value) > MAX_DETAILS_BYTES) return undefined;
	} catch {
		return undefined;
	}
	const lineage = parseLineage(value);
	if (
		!lineage?.previousWindowId ||
		lineage.currentWindowId === lineage.previousWindowId ||
		value.kind !== CONTEXT_DETAILS_KIND ||
		value.version !== CONTEXT_VERSION ||
		(value.reason !== "manual" && value.reason !== "threshold" && value.reason !== "overflow") ||
		(value.requestId !== undefined && !isIdentifier(value.requestId)) ||
		!Array.isArray(value.keptMessageFingerprints) ||
		value.keptMessageFingerprints.length > MAX_FINGERPRINTS ||
		!value.keptMessageFingerprints.every(
			(fingerprint) => typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
		) ||
		typeof value.createdAt !== "string" ||
		value.createdAt.length > 64
	) {
		return undefined;
	}
	return {
		kind: CONTEXT_DETAILS_KIND,
		version: CONTEXT_VERSION,
		...lineage,
		reason: value.reason,
		...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
		keptMessageFingerprints: [...value.keptMessageFingerprints],
		createdAt: value.createdAt,
	};
}

export function parseExperimentalCompaction(
	entry: Pick<CompactionEntry, "summary" | "details">,
): ExperimentalContextDetails | undefined {
	const details = parseExperimentalContextDetails(entry.details);
	return details && entry.summary === contextContract(details) ? details : undefined;
}

export function createInitialContextState(windowId = randomUUID()): ContextStateEntryData {
	return {
		kind: CONTEXT_DETAILS_KIND,
		version: CONTEXT_VERSION,
		firstWindowId: windowId,
		currentWindowId: windowId,
	};
}

export function loadContextLineage(entries: readonly SessionEntry[]): ContextLineage | undefined {
	let lineage: ContextLineage | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE) {
			lineage = parseContextState(entry.data) ?? lineage;
			continue;
		}
		if (entry.type !== "compaction") continue;
		lineage = parseExperimentalCompaction(entry) ?? lineage;
	}
	return lineage;
}

export function activeExperimentalCompaction(entries: readonly SessionEntry[]):
	| {
			entry: CompactionEntry<ExperimentalContextDetails>;
			details: ExperimentalContextDetails;
	  }
	| undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "compaction") continue;
		const details = parseExperimentalCompaction(entry);
		return details
			? { entry: entry as CompactionEntry<ExperimentalContextDetails>, details }
			: undefined;
	}
	return undefined;
}

export function contextContract(lineage: ContextLineage): string {
	return [
		`[PI_CODEX_CONTEXT_WINDOW:${lineage.currentWindowId}]`,
		"Experimental Pi-native context management is active.",
		lineage.previousWindowId
			? `The previous context window was ${lineage.previousWindowId}.`
			: "This is the first context window in this session.",
		"Use codex_compact_get_context_remaining to inspect capacity, codex_compact_recall_context to retrieve older history or notes, and codex_compact_update_notes to preserve durable working memory.",
		"Call codex_compact_start_new_context when a fresh context is needed. Important information is not summarized automatically.",
	].join("\n");
}

export function contextDeactivation(): string {
	return [
		"Experimental Pi-native context management is no longer active.",
		"Its context tools are unavailable. Continue with Pi's active compaction strategy and do not call codex_compact_start_new_context, codex_compact_get_context_remaining, codex_compact_recall_context, or codex_compact_update_notes.",
	].join("\n");
}

export function latestContextMode(
	entries: readonly SessionEntry[],
): "active" | "inactive" | undefined {
	let mode: "active" | "inactive" | undefined;
	const leafId = entries.at(-1)?.id ?? null;
	for (const entry of buildContextEntries([...entries], leafId)) {
		if (entry.type === "compaction" && parseExperimentalCompaction(entry)) mode = "active";
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role !== "custom") continue;
			if (message.customType === CONTEXT_CONTRACT_MESSAGE_TYPE) mode = "active";
			if (
				message.customType === CONTEXT_DEACTIVATION_MESSAGE_TYPE &&
				message.content === contextDeactivation()
			) {
				mode = "inactive";
			}
		}
	}
	return mode;
}

export function createContextContractMessage(lineage: ContextLineage): AgentMessage {
	return {
		role: "custom",
		customType: CONTEXT_CONTRACT_MESSAGE_TYPE,
		content: contextContract(lineage),
		display: false,
		details: {
			kind: CONTEXT_DETAILS_KIND,
			version: CONTEXT_VERSION,
			currentWindowId: lineage.currentWindowId,
		},
		timestamp: 0,
	};
}

export function hasContextContract(
	messages: readonly AgentMessage[],
	lineage: ContextLineage,
): boolean {
	const expected = contextContract(lineage);
	return messages.some(
		(message) =>
			(message.role === "custom" &&
				message.customType === CONTEXT_CONTRACT_MESSAGE_TYPE &&
				message.content === expected) ||
			(message.role === "compactionSummary" && message.summary === expected),
	);
}

export function reconcileContextContract(
	messages: readonly AgentMessage[],
	lineage: ContextLineage,
): AgentMessage[] {
	if (hasContextContract(messages, lineage)) return [...messages];
	return [...messages, createContextContractMessage(lineage)];
}

export function compactionKeptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
	const leafId = event.branchEntries.at(-1)?.id ?? null;
	const contextEntries = buildContextEntries(event.branchEntries, leafId);
	const keptIndex = contextEntries.findIndex(
		(entry) => entry.id === event.preparation.firstKeptEntryId,
	);
	if (keptIndex < 0) {
		throw new Error("Pi compaction cut point is not present in the active context");
	}
	const keptMessages = contextEntries.slice(keptIndex).flatMap(sessionEntryToContextMessages);
	const lastMessage = keptMessages.at(-1);
	if (
		event.willRetry &&
		lastMessage?.role === "assistant" &&
		(lastMessage.stopReason === "error" || lastMessage.stopReason === "length")
	) {
		return keptMessages.slice(0, -1);
	}
	return keptMessages;
}

export function createExperimentalContextDetails(input: {
	lineage: ContextLineage;
	keptMessages: readonly AgentMessage[];
	reason: SessionBeforeCompactEvent["reason"];
	requestId?: string;
	windowId?: string;
	createdAt?: string;
}): ExperimentalContextDetails {
	const currentWindowId = input.windowId ?? randomUUID();
	const details: ExperimentalContextDetails = {
		kind: CONTEXT_DETAILS_KIND,
		version: CONTEXT_VERSION,
		firstWindowId: input.lineage.firstWindowId,
		previousWindowId: input.lineage.currentWindowId,
		currentWindowId,
		reason: input.reason,
		...(input.requestId ? { requestId: input.requestId } : {}),
		keptMessageFingerprints: input.keptMessages.map(fingerprintMessage),
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
	const parsed = parseExperimentalContextDetails(details);
	if (!parsed) throw new Error("Created invalid experimental context details");
	return parsed;
}

function isOlderCompactionSummary(message: AgentMessage, timestamp: number): boolean {
	return (
		message.role === "compactionSummary" &&
		Number.isFinite(message.timestamp) &&
		Number.isFinite(timestamp) &&
		message.timestamp < timestamp
	);
}

export function projectExperimentalContext(
	messages: readonly AgentMessage[],
	entry: CompactionEntry<ExperimentalContextDetails>,
	details: ExperimentalContextDetails,
): AgentMessage[] | undefined {
	const expectedSummary = contextContract(details);
	if (entry.summary !== expectedSummary) return undefined;
	const summaryIndex = messages.findIndex(
		(message) => message.role === "compactionSummary" && message.summary === expectedSummary,
	);
	if (summaryIndex < 0) return undefined;
	const timestamp = messages[summaryIndex].timestamp;
	let messageIndex = summaryIndex + 1;
	let fingerprintIndex = 0;
	while (fingerprintIndex < details.keptMessageFingerprints.length) {
		if (messageIndex >= messages.length) return undefined;
		const message = messages[messageIndex];
		if (fingerprintMessage(message) === details.keptMessageFingerprints[fingerprintIndex]) {
			messageIndex += 1;
			fingerprintIndex += 1;
			continue;
		}
		if (isOlderCompactionSummary(message, timestamp)) {
			messageIndex += 1;
			continue;
		}
		return undefined;
	}
	while (
		messageIndex < messages.length &&
		isOlderCompactionSummary(messages[messageIndex], timestamp)
	) {
		messageIndex += 1;
	}
	return [...messages.slice(0, summaryIndex + 1), ...messages.slice(messageIndex)];
}
