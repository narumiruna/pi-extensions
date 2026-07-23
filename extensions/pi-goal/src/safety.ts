import { createHash } from "node:crypto";

export interface ToolFreeRepeatState {
	toolFreeRepeatCount: number;
	lastToolFreeOutputFingerprint?: string;
}

export function nextToolFreeRepeatState(
	current: ToolFreeRepeatState,
	messages: readonly unknown[],
	toolAttempted: boolean,
): ToolFreeRepeatState {
	if (toolAttempted) return { toolFreeRepeatCount: 0 };
	const fingerprint = fingerprintVisibleAssistantOutput(messages);
	return {
		toolFreeRepeatCount:
			fingerprint === current.lastToolFreeOutputFingerprint
				? Math.min(Number.MAX_SAFE_INTEGER, current.toolFreeRepeatCount + 1)
				: 1,
		lastToolFreeOutputFingerprint: fingerprint,
	};
}

export function hasAssistantToolCall(messages: readonly unknown[]) {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		if (message.content.some((block) => isRecord(block) && block.type === "toolCall")) return true;
	}
	return false;
}

export function fingerprintVisibleAssistantOutput(messages: readonly unknown[]) {
	const normalized = normalizeVisibleAssistantOutput(messages);
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function normalizeVisibleAssistantOutput(messages: readonly unknown[]) {
	const text: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
			text.push(block.text);
		}
	}
	const normalized = text
		.join("\n")
		.normalize("NFKC")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.trim();
	return normalized === "" || /^[\p{P}\s]+$/u.test(normalized) ? "" : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
