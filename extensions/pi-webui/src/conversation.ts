const MAX_TEXT_BYTES = 50_000;
const MAX_TRANSCRIPT_RECORDS = 500;
const DEFAULT_REPLAY_LIMIT = 256;

export interface SessionDescriptor {
	id: string;
	cwd: string;
	projectName: string;
	name?: string;
}

export type PublicContent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "image"; mimeType?: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown };

export interface PublicMessage {
	id: string;
	role: string;
	timestamp?: number;
	final: boolean;
	content: PublicContent[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
}

export interface PublicTool {
	id: string;
	name: string;
	phase: "start" | "update" | "end";
	args?: unknown;
	result?: unknown;
	isError?: boolean;
}

export type ActivityState = "idle" | "running" | "ended";

export interface ConversationSnapshot {
	sequence: number;
	session: SessionDescriptor;
	messages: PublicMessage[];
	tools: PublicTool[];
	activity: ActivityState;
	closed: boolean;
}

export interface ConversationEvent {
	sequence: number;
	type: "message" | "tool" | "activity" | "session-ended" | "snapshot";
	payload: unknown;
}

type Listener = (event: ConversationEvent) => void;

export class ConversationProjection {
	private sequence = 0;
	private readonly messages = new Map<string, PublicMessage>();
	private readonly tools = new Map<string, PublicTool>();
	private readonly replay: ConversationEvent[] = [];
	private readonly listeners = new Set<Listener>();
	private activity: ActivityState = "idle";
	private closed = false;

	constructor(
		private readonly session: SessionDescriptor,
		initialMessages: PublicMessage[] = [],
		private readonly replayLimit = DEFAULT_REPLAY_LIMIT,
	) {
		for (const message of initialMessages.slice(-MAX_TRANSCRIPT_RECORDS)) {
			this.messages.set(message.id, clone(message));
		}
	}

	snapshot(): ConversationSnapshot {
		return {
			sequence: this.sequence,
			session: { ...this.session },
			messages: [...this.messages.values()].map(clone),
			tools: [...this.tools.values()].map(clone),
			activity: this.activity,
			closed: this.closed,
		};
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	eventsAfter(sequence: number): ConversationEvent[] | undefined {
		if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.sequence)
			return undefined;
		if (sequence === this.sequence) return [];
		const first = this.replay[0]?.sequence;
		if (first === undefined || sequence < first - 1) return undefined;
		return this.replay.filter((event) => event.sequence > sequence).map(clone);
	}

	replaceBranch(messages: PublicMessage[]): void {
		this.messages.clear();
		this.tools.clear();
		for (const message of messages.slice(-MAX_TRANSCRIPT_RECORDS)) {
			this.messages.set(message.id, clone(message));
		}
		this.publishSnapshot();
	}

	updateSession(patch: Pick<SessionDescriptor, "name">): void {
		if (this.session.name === patch.name) return;
		if (patch.name === undefined) delete this.session.name;
		else this.session.name = patch.name;
		this.publishSnapshot();
	}

	recordMessage(message: unknown, final = true, entryId?: string): void {
		const projected = projectMessage(message, entryId, final);
		const previous = this.messages.get(projected.id);
		if (previous && JSON.stringify(previous) === JSON.stringify(projected)) return;
		this.messages.set(projected.id, projected);
		trimOldest(this.messages, MAX_TRANSCRIPT_RECORDS);
		this.emit("message", projected);
	}

	recordTool(
		phase: PublicTool["phase"],
		id: string,
		name: string,
		args?: unknown,
		result?: unknown,
		isError?: boolean,
	): void {
		const previous = this.tools.get(id);
		const tool: PublicTool = {
			id,
			name,
			phase,
			...(args === undefined ? {} : { args: boundedJson(args) }),
			...(result === undefined ? {} : { result: boundedJson(result) }),
			...(isError === undefined ? {} : { isError }),
		};
		if (previous && JSON.stringify(previous) === JSON.stringify(tool)) return;
		this.tools.set(id, tool);
		trimOldest(this.tools, MAX_TRANSCRIPT_RECORDS);
		this.emit("tool", tool);
	}

	setActivity(activity: ActivityState): void {
		if (this.activity === activity || this.closed) return;
		this.activity = activity;
		this.emit("activity", { activity });
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.activity = "ended";
		this.emit("session-ended", { activity: this.activity });
	}

	private emit(type: ConversationEvent["type"], payload: unknown): void {
		this.rememberAndPublish({ sequence: ++this.sequence, type, payload: clone(payload) });
	}

	private publishSnapshot(): void {
		const sequence = ++this.sequence;
		this.rememberAndPublish({ sequence, type: "snapshot", payload: this.snapshot() });
	}

	private rememberAndPublish(event: ConversationEvent): void {
		this.replay.push(event);
		while (this.replay.length > Math.max(1, this.replayLimit)) this.replay.shift();
		for (const listener of this.listeners) listener(clone(event));
	}
}

export function projectBranchMessages(branch: unknown): PublicMessage[] {
	if (!Array.isArray(branch)) return [];
	const messages: PublicMessage[] = [];
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message" || !("message" in entry)) continue;
		try {
			messages.push(
				projectMessage(entry.message, typeof entry.id === "string" ? entry.id : undefined),
			);
		} catch {
			// Unknown extension entries must not prevent the supported transcript from loading.
		}
	}
	return messages;
}

export function projectMessage(message: unknown, entryId?: string, final = true): PublicMessage {
	if (!isRecord(message) || typeof message.role !== "string") {
		throw new Error("Invalid Pi message");
	}
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
	const content = projectContent(message.content);
	const id = entryId ?? messageId(message, timestamp, content);
	return {
		id,
		role: message.role,
		...(timestamp === undefined ? {} : { timestamp }),
		final,
		content,
		...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
		...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
		...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
		...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
		...(typeof message.errorMessage === "string"
			? { errorMessage: truncateText(message.errorMessage) }
			: {}),
	};
}

function projectContent(content: unknown): PublicContent[] {
	if (typeof content === "string") return [{ type: "text", text: truncateText(content) }];
	if (!Array.isArray(content)) return [];
	const projected: PublicContent[] = [];
	for (const block of content) {
		if (!isRecord(block) || typeof block.type !== "string") continue;
		if (block.type === "text" && typeof block.text === "string") {
			projected.push({ type: "text", text: truncateText(block.text) });
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			projected.push({ type: "thinking", text: truncateText(block.thinking) });
		} else if (block.type === "image") {
			projected.push({
				type: "image",
				...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
			});
		} else if (
			block.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string"
		) {
			projected.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: boundedJson(block.arguments),
			});
		}
	}
	return projected;
}

function messageId(
	message: Record<string, unknown>,
	timestamp: number | undefined,
	content: unknown,
): string {
	if (timestamp !== undefined) return `${message.role}:${timestamp}`;
	if (typeof message.toolCallId === "string") return `tool-result:${message.toolCallId}`;
	const toolCall = Array.isArray(message.content)
		? message.content.find(
				(block) => isRecord(block) && block.type === "toolCall" && typeof block.id === "string",
			)
		: undefined;
	if (isRecord(toolCall) && typeof toolCall.id === "string") return `assistant:${toolCall.id}`;
	return `${message.role}:live:${hash(JSON.stringify(content))}`;
}

function boundedJson(value: unknown): unknown {
	return sanitizeJson(value, { remaining: MAX_TEXT_BYTES, nodes: 1_000 }, new WeakSet(), 0);
}

function sanitizeJson(
	value: unknown,
	budget: { remaining: number; nodes: number },
	seen: WeakSet<object>,
	depth: number,
): unknown {
	if (budget.remaining <= 0 || budget.nodes <= 0) return "[Truncated]";
	budget.nodes -= 1;
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		const text = truncateToBudget(value, budget.remaining);
		budget.remaining -= Buffer.byteLength(text);
		return text;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return String(value ?? "");
	if (seen.has(value)) return "[Circular]";
	if (depth >= 8) return "[Depth limit]";
	seen.add(value);
	if (Array.isArray(value)) {
		const result = value.slice(0, 100).map((item) => sanitizeJson(item, budget, seen, depth + 1));
		if (value.length > 100) result.push(`[${value.length - 100} more items]`);
		return result;
	}
	const result: Record<string, unknown> = {};
	const keys = Object.keys(value).slice(0, 100);
	for (const rawKey of keys) {
		if (budget.remaining <= 0 || budget.nodes <= 0) break;
		const key = truncateToBudget(rawKey, Math.min(500, budget.remaining));
		budget.remaining -= Buffer.byteLength(key);
		try {
			result[key] = sanitizeJson(
				(value as Record<string, unknown>)[rawKey],
				budget,
				seen,
				depth + 1,
			);
		} catch {
			result[key] = "[Unreadable]";
		}
	}
	if (Object.keys(value).length > keys.length) result["…"] = "More properties omitted";
	return result;
}

function truncateToBudget(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end)) > Math.max(0, maxBytes - 16)) end -= 1;
	return `${text.slice(0, end)}… truncated`;
}

function truncateText(text: string): string {
	if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text;
	let end = Math.min(text.length, MAX_TEXT_BYTES);
	while (end > 0 && Buffer.byteLength(text.slice(0, end)) > MAX_TEXT_BYTES) end -= 1;
	return `${text.slice(0, end)}\n… output truncated`;
}

function hash(value: string): string {
	let result = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16777619);
	}
	return (result >>> 0).toString(36);
}

function trimOldest<T>(values: Map<string, T>, limit: number): void {
	while (values.size > limit) {
		const oldest = values.keys().next().value;
		if (typeof oldest !== "string") return;
		values.delete(oldest);
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
