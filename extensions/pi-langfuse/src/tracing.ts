const MAX_STRING_LENGTH = 50_000;
const MAX_ARRAY_LENGTH = 200;
const MAX_DEPTH = 12;
const CONTENT_DISABLED = "[content capture disabled]";

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
		options: { asType: "span" | "generation"; parent?: Observation },
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
	systemPrompt?: unknown;
	model?: ModelDescriptor;
}

interface BeginGenerationInput {
	messages: unknown;
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
	private systemPrompt: unknown;
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

		this.systemPrompt = input.systemPrompt;
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

		this.root = this.backend.start("pi.agent", { input: traceInput, metadata }, { asType: "span" });
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
			{
				input: this.capture({
					messages: input.messages,
					...(this.systemPrompt !== undefined ? { systemPrompt: this.systemPrompt } : {}),
				}),
			},
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
			promptTokens: message.usage?.input,
			completionTokens: message.usage?.output,
			cacheReadTokens: message.usage?.cacheRead,
			cacheWriteTokens: message.usage?.cacheWrite,
			totalTokens: message.usage?.totalTokens,
		});
		const totalCost = message.usage?.cost?.total;
		const failed = message.stopReason === "error" || Boolean(message.errorMessage);
		this.generation.update({
			output: this.lastOutput,
			...(message.model ? { model: message.model } : {}),
			...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
			...(typeof totalCost === "number" ? { costDetails: { totalCost } } : {}),
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

	beginTool(toolCallId: string, toolName: string, args: unknown): void {
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
					input: this.capture(args),
					metadata: { "pi.tool.call_id": toolCallId, "pi.tool.name": toolName },
				},
				{ asType: "span", parent: this.root },
			),
		);
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
		this.systemPrompt = undefined;
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
	return sanitize(value, new WeakSet<object>(), 0);
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") {
		return value.length <= MAX_STRING_LENGTH
			? value
			: `${value.slice(0, MAX_STRING_LENGTH)}… [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		return undefined;
	}
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) return { name: value.name, message: value.message };
	if (depth >= MAX_DEPTH) return "[maximum depth reached]";
	if (seen.has(value)) return "[circular]";
	seen.add(value);

	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitize(item, seen, depth + 1));
		if (value.length > MAX_ARRAY_LENGTH) {
			items.push(`[${value.length - MAX_ARRAY_LENGTH} items omitted]`);
		}
		return items;
	}

	const record = value as Record<string, unknown>;
	const isImage = record.type === "image";
	const entries = Object.entries(record).map(([key, item]) => {
		if (isImage && key === "data") return [key, "[base64 omitted]"];
		if (
			key === "source" &&
			item &&
			typeof item === "object" &&
			(item as Record<string, unknown>).type === "base64"
		) {
			return [key, { ...(item as Record<string, unknown>), data: "[base64 omitted]" }];
		}
		return [key, sanitize(item, seen, depth + 1)];
	});
	return Object.fromEntries(entries);
}

function numericRecord(values: Record<string, number | undefined>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
	);
}

function hasItems(value: unknown): boolean {
	return Array.isArray(value) ? value.length > 0 : value !== undefined;
}
