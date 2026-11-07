import { createHash } from "node:crypto";
import { GOAL_TOOL_NAMES } from "./tool-policy.js";

const WINDOW = 6;
const MAX_SAMPLES_PER_TURN = 32;
export const TOOL_LOOP_WARNING =
	"Repeated identical tool calls and results in at least 3 of the last 6 turns. This may be intentional; inspect the evidence or try a different approach. Warning only; automatic work is not paused.";

export interface ToolLoopState {
	samples: string[][];
	warning?: string;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record(value)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function normalizeToolLoopState(value: unknown): ToolLoopState | undefined {
	const samples = record(value).samples;
	if (
		!Array.isArray(samples) ||
		samples.length > WINDOW ||
		!samples.every(
			(sample) =>
				Array.isArray(sample) &&
				sample.length <= MAX_SAMPLES_PER_TURN &&
				sample.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)),
		)
	)
		return undefined;
	return {
		samples: samples.map((sample: string[]) => [...sample]),
		warning: record(value).warning === TOOL_LOOP_WARNING ? TOOL_LOOP_WARNING : undefined,
	};
}

/** Compare finalized top-level calls, once per turn, not completion-order execution events.
 * Includes failed/blocked/invalid calls and truncated-output failures when Pi emits a result.
 * Missing results and non-tool turns age the window; Goal bookkeeping is excluded.
 * Only hashes are retained: never raw commands, results, image bytes, or tool details.
 */
export function nextToolLoopState(
	current: ToolLoopState | undefined,
	event: { message?: unknown; toolResults?: readonly unknown[] },
): ToolLoopState {
	const message = record(event.message);
	const content = Array.isArray(message.content) ? message.content : [];
	const results = new Map(
		(event.toolResults ?? []).map((value) => [record(value).toolCallId, record(value)]),
	);
	const signatures = new Set<string>();
	for (const raw of content) {
		const call = record(raw);
		if (
			message.role !== "assistant" ||
			call.type !== "toolCall" ||
			typeof call.name !== "string" ||
			(GOAL_TOOL_NAMES as readonly string[]).includes(call.name)
		)
			continue;
		const result = results.get(call.id);
		if (!result) continue;
		const hash = createHash("sha256")
			.update(stableJson([call.name, call.arguments, result.isError === true, result.content]))
			.digest("hex");
		signatures.add(hash);
		if (signatures.size >= MAX_SAMPLES_PER_TURN) break;
	}
	const samples = [...(current?.samples ?? []), [...signatures]].slice(-WINDOW);
	const repeatedNow = [...signatures].some(
		(hash) => samples.filter((sample) => sample.includes(hash)).length >= 3,
	);
	return { samples, warning: repeatedNow ? TOOL_LOOP_WARNING : undefined };
}
