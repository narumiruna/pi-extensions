export const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 50_000;
const MAX_COLLECTION_LENGTH = 200;
const MAX_DEPTH = 12;
const CONTENT_DISABLED = "[content capture disabled]";
const TRUNCATED = "[truncated: content budget exceeded]";

export interface ObservationAttributes {
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
	level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
	statusMessage?: string;
	model?: string;
	usageDetails?: Record<string, number>;
	costDetails?: Record<string, number>;
	name?: string;
	sessionId?: string;
	tags?: string[];
}

export interface Observation {
	update(attributes: ObservationAttributes): Observation;
	updateTrace?(attributes: ObservationAttributes): Observation;
	end(): Observation;
}

export interface TraceBackend {
	start(
		name: string,
		attributes: ObservationAttributes,
		options: { asType: "agent" | "generation" | "tool"; parent?: Observation },
	): Observation;
	forceFlush(): Promise<void>;
	shutdown(): Promise<void>;
}

interface RecorderContext {
	sessionId: string;
	cwd: string;
	mode: string;
	captureContent: boolean;
}

interface ModelDescriptor {
	provider?: string;
	id?: string;
}

interface BeginAgentInput {
	prompt: unknown;
	images?: unknown;
	model?: ModelDescriptor;
}

interface BeginGenerationInput {
	payload: unknown;
}

interface AssistantMessage {
	role: string;
	content?: unknown;
	provider?: string;
	model?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	stopReason?: string;
	errorMessage?: string;
}

interface ToolResult {
	content?: unknown;
	details?: unknown;
	isError?: boolean;
}

export class TraceRecorder {
	private root: Observation | undefined;
	private generation: Observation | undefined;
	private readonly tools = new Map<string, Observation>();
	private lastOutput: unknown;

	constructor(
		private readonly backend: TraceBackend,
		private readonly context: RecorderContext,
	) {}

	hasActiveTrace(): boolean {
		return this.root !== undefined;
	}

	beginAgent(input: BeginAgentInput): void {
		if (this.root) this.closeActiveTrace("Interrupted by a new Pi agent run.");

		this.lastOutput = undefined;
		const traceInput = this.capture({
			prompt: input.prompt,
			...(hasItems(input.images) ? { images: input.images } : {}),
		});
		const metadata: Record<string, unknown> = {
			"pi.cwd": this.context.cwd,
			"pi.mode": this.context.mode,
			...(input.model?.id ? { "pi.model": input.model.id } : {}),
			...(input.model?.provider ? { "pi.provider": input.model.provider } : {}),
			"pi.session.id": this.context.sessionId,
		};

		this.root = this.backend.start("pi.agent", { input: traceInput, metadata }, { asType: "agent" });
		this.root.updateTrace?.({
			name: "pi.agent",
			sessionId: this.context.sessionId,
			input: traceInput,
			metadata,
			tags: ["pi"],
		});
	}

	beginGeneration(input: BeginGenerationInput): void {
		if (!this.root) return;
		this.closeGeneration("Interrupted by the next provider request.");
		this.generation = this.backend.start(
			"pi.llm",
			{ input: this.capture(input.payload) },
			{ asType: "generation", parent: this.root },
		);
	}

	recordProviderResponse(status: number): void {
		if (!this.generation) return;
		this.generation.update({
			metadata: { "http.response.status_code": status },
			...(status >= 400
				? { level: "ERROR" as const, statusMessage: `Provider returned HTTP ${status}.` }
				: {}),
		});
	}

	finishAssistant(message: AssistantMessage): void {
		if (message.role !== "assistant") return;
		this.lastOutput = this.capture(message.content);
		if (!this.generation) return;

		const usageDetails = numericRecord({
			input: message.usage?.input,
			output: message.usage?.output,
			cache_read_input_tokens: message.usage?.cacheRead,
			cache_creation_input_tokens: message.usage?.cacheWrite,
			total: message.usage?.totalTokens,
		});
		const totalCost = message.usage?.cost?.total;
		const failed = message.stopReason === "error" || Boolean(message.errorMessage);
		this.generation.update({
			output: this.lastOutput,
			...(message.model ? { model: message.model } : {}),
			...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
			...(typeof totalCost === "number" && Number.isFinite(totalCost) && totalCost > 0
				? { costDetails: { total: totalCost } }
				: {}),
			metadata: {
				...(message.provider ? { "pi.provider": message.provider } : {}),
				...(message.stopReason ? { "pi.stop_reason": message.stopReason } : {}),
			},
			...(failed
				? {
						level: "ERROR" as const,
						statusMessage: message.errorMessage ?? "The model returned an error.",
					}
				: {}),
		});
		this.generation.end();
		this.generation = undefined;
	}

	beginTool(toolCallId: string, toolName: string, args?: unknown): void {
		if (!this.root) return;
		const existing = this.tools.get(toolCallId);
		if (existing) {
			existing.update({ level: "ERROR", statusMessage: "Duplicate tool execution started." });
			existing.end();
		}
		this.tools.set(
			toolCallId,
			this.backend.start(
				`pi.tool.${toolName}`,
				{
					...(args !== undefined ? { input: this.capture(args) } : {}),
					metadata: { "pi.tool.call_id": toolCallId, "pi.tool.name": toolName },
				},
				{ asType: "tool", parent: this.root },
			),
		);
	}

	updateToolInput(toolCallId: string, input: unknown): void {
		this.tools.get(toolCallId)?.update({ input: this.capture(input) });
	}

	finishTool(toolCallId: string, result: ToolResult): void {
		const tool = this.tools.get(toolCallId);
		if (!tool) return;
		tool.update({
			output: this.capture({ content: result.content, details: result.details }),
			...(result.isError
				? { level: "ERROR" as const, statusMessage: "Pi tool execution failed." }
				: {}),
		});
		tool.end();
		this.tools.delete(toolCallId);
	}

	settle(): void {
		this.closeActiveTrace();
	}

	async flush(): Promise<void> {
		await this.backend.forceFlush();
	}

	async shutdown(): Promise<void> {
		this.closeActiveTrace("Pi shut down before the active trace settled.");
		await this.backend.shutdown();
	}

	private closeActiveTrace(statusMessage?: string): void {
		this.closeGeneration(statusMessage ?? "Generation ended without an assistant message.");
		for (const tool of this.tools.values()) {
			tool.update({
				level: "WARNING",
				statusMessage: statusMessage ?? "Tool span ended when the agent settled.",
			});
			tool.end();
		}
		this.tools.clear();

		if (!this.root) return;
		this.root.update({
			...(this.lastOutput !== undefined ? { output: this.lastOutput } : {}),
			...(statusMessage ? { level: "WARNING" as const, statusMessage } : {}),
		});
		this.root.updateTrace?.({
			...(this.lastOutput !== undefined ? { output: this.lastOutput } : {}),
			...(statusMessage ? { metadata: { "pi.status": statusMessage } } : {}),
		});
		this.root.end();
		this.root = undefined;
		this.lastOutput = undefined;
	}

	private closeGeneration(statusMessage: string): void {
		if (!this.generation) return;
		this.generation.update({ level: "ERROR", statusMessage });
		this.generation.end();
		this.generation = undefined;
	}

	private capture(value: unknown): unknown {
		return this.context.captureContent ? sanitizeTraceValue(value) : CONTENT_DISABLED;
	}
}

export function sanitizeTraceValue(value: unknown): unknown {
	const budget = { remaining: MAX_CAPTURE_BYTES };
	const sanitized = sanitize(value, new WeakSet<object>(), 0, budget);
	return serializedBytes(sanitized) <= MAX_CAPTURE_BYTES ? sanitized : TRUNCATED;
}

function sanitize(
	value: unknown,
	active: WeakSet<object>,
	depth: number,
	budget: { remaining: number },
): unknown {
	if (budget.remaining <= byteLength(TRUNCATED)) return TRUNCATED;
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return consume(value, budget);
	}
	if (typeof value === "string") {
		if (/^data:image\/[^;,]+;base64,/i.test(value)) {
			return consume("[base64 image omitted]", budget);
		}
		const bounded = truncateString(value, Math.min(MAX_STRING_LENGTH, budget.remaining));
		return consume(bounded, budget);
	}
	if (typeof value === "bigint") return consume(value.toString(), budget);
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		return undefined;
	}
	if (value instanceof Date) return consume(value.toISOString(), budget);
	if (value instanceof Error) {
		return sanitize({ name: value.name, message: value.message }, active, depth, budget);
	}
	if (depth >= MAX_DEPTH) return consume("[maximum depth reached]", budget);
	if (active.has(value)) return consume("[circular]", budget);
	active.add(value);

	let result: unknown;
	if (Array.isArray(value)) {
		const items: unknown[] = [];
		for (const item of value.slice(0, MAX_COLLECTION_LENGTH)) {
			if (budget.remaining <= byteLength(TRUNCATED)) break;
			items.push(sanitize(item, active, depth + 1, budget));
		}
		if (items.length < value.length) items.push(`[${value.length - items.length} items omitted]`);
		result = items;
	} else {
		const record = value as Record<string, unknown>;
		const entries = Object.entries(record);
		const output: Record<string, unknown> = {};
		const isImage = record.type === "image";
		let processed = 0;
		for (const [key, item] of entries.slice(0, MAX_COLLECTION_LENGTH)) {
			if (budget.remaining <= byteLength(TRUNCATED)) break;
			budget.remaining -= byteLength(key) + 4;
			if (isImage && key === "data") output[key] = consume("[base64 omitted]", budget);
			else if (
				key === "source" &&
				item &&
				typeof item === "object" &&
				(item as Record<string, unknown>).type === "base64"
			) {
				output[key] = sanitize(
					{ ...(item as Record<string, unknown>), data: "[base64 omitted]" },
					active,
					depth + 1,
					budget,
				);
			} else output[key] = sanitize(item, active, depth + 1, budget);
			processed += 1;
		}
		if (processed < entries.length) {
			output["$truncated"] = `${entries.length - processed} object entries omitted`;
		}
		result = output;
	}
	active.delete(value);
	return result;
}

function consume<T>(value: T, budget: { remaining: number }): T | string {
	const size = serializedBytes(value);
	if (size > budget.remaining) {
		budget.remaining -= byteLength(TRUNCATED);
		return TRUNCATED;
	}
	budget.remaining -= size;
	return value;
}

function truncateString(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	const suffix = "… [truncated]";
	const target = Math.max(0, maxBytes - byteLength(suffix) - 2);
	let bytes = 0;
	let output = "";
	for (const character of value) {
		const size = byteLength(character);
		if (bytes + size > target) break;
		output += character;
		bytes += size;
	}
	return `${output}${suffix}`;
}

function serializedBytes(value: unknown): number {
	return byteLength(JSON.stringify(value) ?? "null");
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function numericRecord(values: Record<string, number | undefined>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
	);
}

function hasItems(value: unknown): boolean {
	return Array.isArray(value) ? value.length > 0 : value !== undefined;
}
