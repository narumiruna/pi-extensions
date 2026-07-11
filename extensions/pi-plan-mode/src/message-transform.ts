const PLAN_CONTEXT_MESSAGE_TYPE = "plan-mode-context";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const PROPOSED_PLAN_PATTERN = /^<proposed_plan>[\t ]*\r?\n([\s\S]*?)\r?\n<\/proposed_plan>[\t ]*$/gim;
const PROPOSED_PLAN_BLOCK_PATTERN = /^<proposed_plan>[\t ]*\r?\n[\s\S]*?\r?\n<\/proposed_plan>[\t ]*$/gim;

export type ProposedPlanParseResult =
	| { kind: "absent" }
	| { kind: "valid"; plan: string }
	| { kind: "empty" }
	| { kind: "multiple" }
	| { kind: "malformed" }
	| { kind: "unclosed" };

type SessionMessage = {
	role?: string;
	content?: unknown;
};

type TextBlock = {
	type?: string;
	text?: string;
};

export function parseProposedPlan(text: string): ProposedPlanParseResult {
	const openingCount = text.match(/<proposed_plan>/gi)?.length ?? 0;
	const closingCount = text.match(/<\/proposed_plan>/gi)?.length ?? 0;
	if (openingCount === 0 && closingCount === 0) return { kind: "absent" };
	if (openingCount > 1 || closingCount > 1) return { kind: "multiple" };
	if (openingCount === 1 && closingCount === 0) return { kind: "unclosed" };
	if (openingCount !== 1 || closingCount !== 1) return { kind: "malformed" };

	const matches = Array.from(text.matchAll(PROPOSED_PLAN_PATTERN));
	if (matches.length !== 1) return { kind: "malformed" };
	const plan = matches[0]?.[1]?.trim() ?? "";
	return plan ? { kind: "valid", plan } : { kind: "empty" };
}

export function extractProposedPlan(text: string) {
	const result = parseProposedPlan(text);
	return result.kind === "valid" ? result.plan : undefined;
}

export function latestAssistantText(messages: unknown) {
	if (!Array.isArray(messages)) return "";
	for (const entry of [...messages].reverse()) {
		const message = (entry as { message?: SessionMessage })?.message ?? (entry as SessionMessage);
		if (message?.role !== "assistant") continue;
		const text = messageText(message);
		if (text) return text;
	}
	return "";
}

export function messageContainsLegacyPlanModeContextArtifact(message: unknown) {
	return unwrapSessionMessage(message).customType === PLAN_CONTEXT_MESSAGE_TYPE;
}

export function messageContainsInactivePlanModeArtifact(message: unknown) {
	return unwrapSessionMessage(message).customType === PROPOSED_PLAN_MESSAGE_TYPE;
}

export function stripProposedPlanBlocksFromMessage<T>(message: T): T {
	const candidate = unwrapSessionMessage(message);
	if (candidate.role !== "assistant") return message;

	const content = stripProposedPlanBlocksFromContent(candidate.content);
	if (content === candidate.content) return message;

	if (isSessionMessageEntry(message)) {
		return { ...message, message: { ...candidate, content } };
	}
	return { ...candidate, content } as T;
}

function unwrapSessionMessage(message: unknown) {
	const entry = message as { message?: unknown };
	return (entry.message ?? message) as { role?: string; customType?: string; content?: unknown };
}

function isSessionMessageEntry<T>(message: T): message is T & { message: SessionMessage } {
	return typeof message === "object" && message !== null && "message" in message;
}

function stripProposedPlanBlocksFromContent(content: unknown) {
	if (typeof content === "string") return stripProposedPlanBlocks(content);
	if (!Array.isArray(content)) return content;

	let changed = false;
	const nextContent = content.map((block) => {
		const textBlock = block as TextBlock;
		if (textBlock.type !== "text" || typeof textBlock.text !== "string") return block;

		const text = stripProposedPlanBlocks(textBlock.text);
		if (text === textBlock.text) return block;

		changed = true;
		return { ...textBlock, text };
	});
	return changed ? nextContent : content;
}

export function stripProposedPlanBlocks(text: string) {
	return text.replace(PROPOSED_PLAN_BLOCK_PATTERN, "");
}

function messageText(message: SessionMessage) {
	return contentText(message.content);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const textBlock = block as TextBlock;
			return textBlock.type === "text" && typeof textBlock.text === "string" ? textBlock.text : "";
		})
		.filter(Boolean)
		.join("\n");
}
