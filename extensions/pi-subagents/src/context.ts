import { createHash } from "node:crypto";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";

export type ContextMode = "none" | "all" | "summary" | number;

export interface ContextSnapshot {
	text: string;
	turns: number;
	truncated: boolean;
	sourceIds: string[];
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(
				part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			),
		)
		.map((part) => part.text)
		.join("\n");
}

export function redactPrivateText(text: string): string {
	return text
		.replace(/<private>[\s\S]*?<\/private>/gi, "[private content omitted]")
		.split("\n")
		.filter((line) => !line.includes("[subagent-private]"))
		.join("\n");
}

export function buildContextSnapshot(
	entries: readonly unknown[],
	mode: ContextMode,
	maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
	selectedSourceIds?: readonly string[],
): ContextSnapshot {
	if (mode === "none") return { text: "", turns: 0, truncated: false, sourceIds: [] };
	const messages: Array<{ role: "user" | "assistant"; text: string; sourceId: string }> = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as {
			id?: string;
			type?: string;
			role?: string;
			content?: unknown;
			message?: { role?: string; content?: unknown };
		};
		const message: { role?: string; content?: unknown } | undefined =
			candidate.type === "message" ? candidate.message : candidate;
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		const text = redactPrivateText(textParts(message.content));
		if (text.trim()) {
			const sourceId =
				candidate.id ??
				createHash("sha256").update(`${message.role}\0${text}`).digest("hex").slice(0, 16);
			messages.push({ role: message.role, text, sourceId });
		}
	}
	const selectedSet = selectedSourceIds ? new Set(selectedSourceIds) : undefined;
	const eligible = selectedSet
		? messages.filter((message) => selectedSet.has(message.sourceId))
		: messages;
	const turnLimit =
		typeof mode === "number" ? Math.max(1, Math.floor(mode)) : Number.POSITIVE_INFINITY;
	let userTurns = 0;
	let start = eligible.length;
	for (let index = eligible.length - 1; index >= 0; index--) {
		if (eligible[index].role === "user") userTurns++;
		if (userTurns > turnLimit) break;
		start = index;
	}
	const selected = eligible.slice(start);
	const raw =
		mode === "summary" && selected.length > 4
			? [
					`## Earlier context checkpoint\n${truncateUtf8(
						selected
							.slice(0, -4)
							.map((message) => `${message.role}: ${message.text}`)
							.join("\n"),
						Math.floor(maxBytes / 3),
					).text}`,
					...selected
						.slice(-4)
						.map((message) => `## ${message.role}\n${message.text}`),
				].join("\n\n")
			: selected.map((message) => `## ${message.role}\n${message.text}`).join("\n\n");
	const bounded = truncateUtf8(raw, maxBytes);
	return {
		text: bounded.text,
		turns: selected.filter((message) => message.role === "user").length,
		truncated: bounded.truncated,
		sourceIds: selected.map((message) => message.sourceId),
	};
}
