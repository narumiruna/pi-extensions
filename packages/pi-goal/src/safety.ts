import { createHash } from "node:crypto";
import type { ActiveGoal } from "./persistence.js";

export interface ToolFreeRepeatState {
	toolFreeRepeatCount: number;
	lastToolFreeOutputFingerprint?: string;
}

export function queueGoalSafetyReset(goal: ActiveGoal): ActiveGoal {
	return { ...goal, safetyResetPending: true };
}

export function resetGoalSafetyEpoch(goal: ActiveGoal): ActiveGoal {
	return {
		...goal,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
		lastToolFreeOutputFingerprint: undefined,
		safetyPauseCause: undefined,
		safetyResetPending: undefined,
	};
}

/** Built-in tools that inspect or change the workspace. Not a product denylist. */
export const WORKSPACE_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"subagent",
]);

export interface ToolProgressOptions {
	progressTools?: readonly string[];
	chromeTools?: readonly string[];
}

export type AssistantToolClass = "none" | "chrome" | "progress";

function stringArg(input: unknown, key: string): string {
	if (!isRecord(input)) return "";
	const value = input[key];
	return typeof value === "string" ? value.trim() : "";
}

function nameSet(names: readonly string[] | undefined): Set<string> {
	return new Set((names ?? []).map((name) => name.trim()).filter(Boolean));
}

/** True when this call is workspace (or user-listed progress) work, not session chrome. */
export function isWorkspaceToolCall(
	name: string,
	input: unknown,
	opts: ToolProgressOptions = {},
): boolean {
	const toolName = (name ?? "").trim();
	if (!toolName) return false;
	if (nameSet(opts.chromeTools).has(toolName)) return false;
	if (nameSet(opts.progressTools).has(toolName)) return true;
	if (WORKSPACE_TOOL_NAMES.has(toolName)) return true;
	return Boolean(stringArg(input, "path") || stringArg(input, "command"));
}

export function classifyAssistantTools(
	messages: readonly unknown[],
	opts: ToolProgressOptions = {},
): AssistantToolClass {
	let sawTool = false;
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "toolCall") continue;
			sawTool = true;
			const name = typeof block.name === "string" ? block.name : "";
			const input = block.arguments ?? block.input;
			if (isWorkspaceToolCall(name, input, opts)) return "progress";
		}
	}
	return sawTool ? "chrome" : "none";
}

export function nextToolFreeRepeatState(
	current: ToolFreeRepeatState,
	messages: readonly unknown[],
	toolAttempted: boolean,
	opts: ToolProgressOptions = {},
): ToolFreeRepeatState {
	const kind = classifyAssistantTools(messages, opts);
	if (toolAttempted || kind === "progress") return { toolFreeRepeatCount: 0 };
	const fingerprint = fingerprintVisibleAssistantOutput(messages);
	if (kind === "chrome") {
		return {
			toolFreeRepeatCount: Math.min(Number.MAX_SAFE_INTEGER, current.toolFreeRepeatCount + 1),
			lastToolFreeOutputFingerprint: fingerprint,
		};
	}
	return {
		toolFreeRepeatCount:
			fingerprint === current.lastToolFreeOutputFingerprint
				? Math.min(Number.MAX_SAFE_INTEGER, current.toolFreeRepeatCount + 1)
				: 1,
		lastToolFreeOutputFingerprint: fingerprint,
	};
}

export function hasAssistantToolCall(messages: readonly unknown[]) {
	return classifyAssistantTools(messages) !== "none";
}

export function hasWorkspaceToolCall(messages: readonly unknown[], opts: ToolProgressOptions = {}) {
	return classifyAssistantTools(messages, opts) === "progress";
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
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	return normalized === "" || /^[\p{P}\s]+$/u.test(normalized) ? "" : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
