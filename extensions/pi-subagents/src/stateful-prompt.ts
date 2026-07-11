import type { AgentConfig } from "./agents.js";
import { resolveDefaultSubagentTimeoutMs } from "./execution.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { redactPrivateText } from "./context.js";
import type { ManagedAgent } from "./registry.js";

export function buildStatefulTurnPrompt(
	record: Pick<ManagedAgent, "context" | "history" | "mailbox">,
	task: string,
	maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
): { text: string; truncated: boolean } {
	const previous = record.history
		.map((turn) => {
			const redactedTask = redactPrivateText(turn.task);
			const redactedOutput = redactPrivateText(turn.output);
			return `Task: ${redactedTask}\nOutput: ${redactedOutput}`;
		})
		.join("\n\n");
	const messages = record.mailbox
		.slice(-20)
		.map((message) => `From ${message.senderId}: ${redactPrivateText(message.content)}`)
		.join("\n");
	const context = [
		`Current task:\n${task}`,
		messages ? `Mailbox messages:\n${messages}` : "",
		previous ? `Prior subagent turns:\n${previous}` : "",
		record.context ? `Parent context:\n${redactPrivateText(record.context)}` : "",
	]
		.filter(Boolean)
		.join("\n\n---\n\n");
	return truncateUtf8(context, maxBytes);
}

export function resolveStatefulTurnTimeout(
	agent: Pick<AgentConfig, "timeoutMs"> | undefined,
): number {
	return agent?.timeoutMs ?? resolveDefaultSubagentTimeoutMs();
}
