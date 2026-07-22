import { sanitizeTraceValue } from "./sanitizer.js";

export { MAX_CAPTURE_BYTES, sanitizeTraceValue } from "./sanitizer.js";

export const TRACE_SCHEMA_VERSION = "2";
const MAX_HEADER_VALUE_LENGTH = 1_024;
const CONTENT_DISABLED = "[content capture disabled]";
const ALLOWED_RESPONSE_HEADERS = new Set([
	"anthropic-ratelimit-requests-limit",
	"anthropic-ratelimit-requests-remaining",
	"anthropic-ratelimit-requests-reset",
	"anthropic-ratelimit-tokens-limit",
	"anthropic-ratelimit-tokens-remaining",
	"anthropic-ratelimit-tokens-reset",
	"cf-ray",
	"openai-request-id",
	"request-id",
	"retry-after",
	"x-amzn-requestid",
	"x-request-id",
	"x-ratelimit-limit-requests",
	"x-ratelimit-limit-tokens",
	"x-ratelimit-remaining-requests",
	"x-ratelimit-remaining-tokens",
	"x-ratelimit-reset-requests",
	"x-ratelimit-reset-tokens",
]);

export interface ObservationAttributes {
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
	level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
	statusMessage?: string;
	completionStartTime?: Date;
	model?: string;
	modelParameters?: Record<string, string | number>;
	usageDetails?: Record<string, number>;
	costDetails?: Record<string, number>;
	version?: string;
	name?: string;
	sessionId?: string;
	tags?: string[];
}

export interface Observation {
	update(attributes: ObservationAttributes): Observation;
	updateTrace?(attributes: ObservationAttributes): Observation;
	end(endTime?: number): Observation;
}

export type ObservationType = "agent" | "generation" | "span" | "tool";

export interface TraceBackend {
	start(
		name: string,
		attributes: ObservationAttributes,
		options: { asType: ObservationType; parent?: Observation },
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
	api?: string;
}

export interface GitMetadata {
	branch?: string;
	commit?: string;
	detached: boolean;
}

export interface ContextSnapshot {
	leafId?: string | null;
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
}

interface BeginAgentInput {
	prompt: unknown;
	images?: unknown;
	model?: ModelDescriptor;
	git?: GitMetadata;
	snapshot?: ContextSnapshot;
}

interface AttemptInput {
	reason?: string;
}

interface GenerationInput {
	payload?: unknown;
	payloadStage?: "before_provider_request";
	model?: ModelDescriptor;
	thinkingLevel?: string;
}

interface AssistantMessage {
	role: string;
	content?: unknown;
	provider?: string;
	api?: string;
	model?: string;
	responseModel?: string;
	responseId?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cacheWrite1h?: number;
		reasoning?: number;
		totalTokens?: number;
		cost?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total?: number;
		};
	};
	stopReason?: string;
	errorMessage?: string;
}

interface ToolResult {
	content?: unknown;
	details?: unknown;
	isError?: boolean;
}

interface TurnResult {
	message: { role: string; stopReason?: string; errorMessage?: string };
	toolResultCount: number;
}

interface CompactionStart {
	reason: string;
	willRetry: boolean;
	tokensBefore?: number;
	messagesToSummarize: number;
	turnPrefixMessages: number;
	branchEntries: number;
	isSplitTurn: boolean;
}

interface CompactionFinish {
	reason: string;
	willRetry: boolean;
	fromExtension: boolean;
	tokensBefore?: number;
	details?: unknown;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total?: number;
		};
	};
}

type Outcome = "success" | "error" | "aborted" | "length" | "interrupted";

interface GenerationState {
	observation: Observation;
	endTime?: number;
	completionStartTime?: number;
	requestMetadata: Record<string, unknown>;
	statuses: number[];
	headers: Record<string, string>;
}

interface ToolState {
	observation: Observation;
	startedAt: number;
	progressUpdates: number;
	firstProgressAt?: number;
}

interface CompactionState {
	observation: Observation;
}

interface Counters {
	attempts: number;
	turns: number;
	generations: number;
	tools: number;
	toolErrors: number;
	compactions: number;
	recoveredErrors: number;
	failedAttempts: number;
}

export class TraceRecorder {
	private root: Observation | undefined;
	private agent: Observation | undefined;
	private attempt: Observation | undefined;
	private attemptIndex: number | undefined;
	private turn: Observation | undefined;
	private turnIndex: number | undefined;
	private generation: GenerationState | undefined;
	private readonly tools = new Map<string, ToolState>();
	private readonly duplicateToolIds = new Set<string>();
	private compaction: CompactionState | undefined;
	private lastOutput: unknown;
	private lastAssistant: AssistantMessage | undefined;
	private lastAttemptOutcome: Outcome | undefined;
	private unresolvedToolErrors = 0;
	private startSnapshot: ContextSnapshot | undefined;
	private counters: Counters = emptyCounters();

	constructor(
		private readonly backend: TraceBackend,
		private readonly context: RecorderContext,
	) {}

	hasActiveTrace(): boolean {
		return this.root !== undefined;
	}

	hasActiveAttempt(): boolean {
		return this.attempt !== undefined;
	}

	beginAgent(input: BeginAgentInput): void {
		if (this.root)
			this.closeActiveTrace("Interrupted by a new Pi conversation.", undefined, "interrupted");

		this.lastOutput = undefined;
		this.lastAssistant = undefined;
		this.lastAttemptOutcome = undefined;
		this.unresolvedToolErrors = 0;
		this.duplicateToolIds.clear();
		this.startSnapshot = input.snapshot;
		this.counters = emptyCounters();
		const traceInput = this.capture({
			prompt: input.prompt,
			...(hasItems(input.images) ? { images: input.images } : {}),
		});
		const metadata: Record<string, unknown> = {
			"pi.cwd": this.context.cwd,
			...(input.git?.branch ? { "pi.git.branch": input.git.branch } : {}),
			...(input.git?.commit ? { "pi.git.commit": input.git.commit } : {}),
			...(input.git ? { "pi.git.detached": input.git.detached } : {}),
			"pi.mode": this.context.mode,
			...(input.model?.id ? { "pi.model": input.model.id } : {}),
			...(input.model?.provider ? { "pi.provider": input.model.provider } : {}),
			"pi.session.id": this.context.sessionId,
			"pi.trace.schema_version": Number(TRACE_SCHEMA_VERSION),
			...snapshotMetadata("start", input.snapshot),
		};
		const attributes = { input: traceInput, metadata, version: TRACE_SCHEMA_VERSION };
		const gitTag = input.git?.branch
			? `branch:${input.git.branch}`
			: input.git?.detached
				? "git:detached"
				: undefined;

		this.root = this.backend.start("pi.conversation", attributes, { asType: "span" });
		this.root.updateTrace?.({
			name: "pi.trace",
			sessionId: this.context.sessionId,
			version: TRACE_SCHEMA_VERSION,
			input: traceInput,
			metadata,
			tags: ["pi", ...(gitTag ? [gitTag] : [])],
		});
		this.agent = this.backend.start("pi.agent", attributes, {
			asType: "agent",
			parent: this.root,
		});
	}

	beginAttempt(input: AttemptInput = {}): void {
		if (!this.root) return;
		if (this.attempt) {
			this.closeAttempt(undefined, "Interrupted by the next Pi attempt.", "interrupted");
		}
		const index = this.counters.attempts;
		this.counters.attempts += 1;
		this.lastAssistant = undefined;
		this.unresolvedToolErrors = 0;
		this.attemptIndex = index;
		this.attempt = this.backend.start(
			"pi.attempt",
			{
				metadata: {
					"pi.attempt.index": index,
					...(input.reason ? { "pi.attempt.reason": input.reason } : {}),
				},
				version: TRACE_SCHEMA_VERSION,
			},
			{ asType: "span", parent: this.agent ?? this.root },
		);
	}

	finishAttempt(message?: AssistantMessage): void {
		if (message?.role === "assistant") this.finishAssistant(message);
		if (!this.attempt) return;
		const outcome = this.unresolvedToolErrors > 0 ? "error" : classifyOutcome(message);
		this.closeAttempt(
			message,
			this.unresolvedToolErrors > 0 ? "Pi attempt ended after a tool failure." : undefined,
			outcome,
		);
	}

	beginTurn(turnIndex: number): void {
		if (!this.root) return;
		if (this.turn) this.closeTurn("Interrupted by the next Pi turn.", "ERROR");
		this.counters.turns += 1;
		this.turnIndex = turnIndex;
		this.turn = this.backend.start(
			"pi.turn",
			{ metadata: { "pi.turn.index": turnIndex }, version: TRACE_SCHEMA_VERSION },
			{ asType: "span", parent: this.attempt ?? this.agent ?? this.root },
		);
	}

	finishTurn(turnIndex: number, result: TurnResult): void {
		if (!this.turn) return;
		this.closeGeneration("Turn ended without a finalized assistant message.");
		this.closeTools("Tool span ended when the Pi turn finished.");

		const mismatched = this.turnIndex !== turnIndex;
		const outcome = classifyOutcome(result.message);
		this.turn.update({
			metadata: {
				"pi.turn.index": this.turnIndex ?? turnIndex,
				"pi.turn.tool_result_count": result.toolResultCount,
				...(result.message.stopReason ? { "pi.turn.stop_reason": result.message.stopReason } : {}),
			},
			...(mismatched && outcome === "success"
				? {
						level: "WARNING" as const,
						statusMessage: `Turn ${turnIndex} ended while turn ${this.turnIndex} was active.`,
					}
				: severityForOutcome(outcome, result.message.errorMessage)),
		});
		this.turn.end();
		this.turn = undefined;
		this.turnIndex = undefined;
	}

	beginGeneration(input: GenerationInput = {}): void {
		if (!this.root) return;
		this.closeGeneration("Interrupted by the next provider request.");
		if (this.unresolvedToolErrors > 0) {
			this.counters.recoveredErrors += this.unresolvedToolErrors;
			this.unresolvedToolErrors = 0;
		}
		this.counters.generations += 1;
		const requestMetadata: Record<string, unknown> = {
			...(input.payloadStage ? { "pi.request.payload_stage": input.payloadStage } : {}),
			...(input.model?.provider ? { "pi.request.provider": input.model.provider } : {}),
			...(input.model?.id ? { "pi.request.model": input.model.id } : {}),
			...(input.model?.api ? { "pi.request.api": input.model.api } : {}),
			...(input.thinkingLevel ? { "pi.request.thinking_level": input.thinkingLevel } : {}),
		};
		const observation = this.backend.start(
			"pi.llm",
			{
				...(input.payload !== undefined ? { input: this.capture(input.payload) } : {}),
				...(input.model?.id ? { model: input.model.id } : {}),
				...(input.thinkingLevel
					? { modelParameters: { thinking_level: input.thinkingLevel } }
					: {}),
				...(Object.keys(requestMetadata).length > 0 ? { metadata: requestMetadata } : {}),
				version: TRACE_SCHEMA_VERSION,
			},
			{ asType: "generation", parent: this.turn ?? this.attempt ?? this.agent ?? this.root },
		);
		this.generation = {
			observation,
			requestMetadata,
			statuses: [],
			headers: {},
		};
	}

	recordProviderResponse(status: number, headers: Record<string, string> = {}): void {
		if (!this.generation) return;
		this.generation.statuses.push(status);
		Object.assign(this.generation.headers, allowlistedResponseHeaders(headers));
	}

	markGenerationFirstOutput(timestamp = Date.now()): void {
		if (this.generation && this.generation.completionStartTime === undefined) {
			this.generation.completionStartTime = timestamp;
		}
	}

	markGenerationEnd(endTime = Date.now()): void {
		if (this.generation && this.generation.endTime === undefined) {
			this.generation.endTime = endTime;
		}
	}

	finishAssistant(message: AssistantMessage): void {
		if (message.role !== "assistant") return;
		this.lastAssistant = message;
		this.lastOutput = this.capture(message.content);
		if (!this.generation) return;

		const state = this.generation;
		const usageDetails = numericRecord({
			input: message.usage?.input,
			output: message.usage?.output,
			cache_read_input_tokens: message.usage?.cacheRead,
			cache_creation_input_tokens: message.usage?.cacheWrite,
			total: message.usage?.totalTokens,
		});
		const costDetails = positiveNumericRecord({
			input: message.usage?.cost?.input,
			output: message.usage?.cost?.output,
			cache_read: message.usage?.cost?.cacheRead,
			cache_write: message.usage?.cost?.cacheWrite,
			total: message.usage?.cost?.total,
		});
		const outcome = classifyOutcome(message);
		const responseModel = message.responseModel ?? message.model;
		const httpMetadata = generationHttpMetadata(state);
		const recoveredStatuses = state.statuses.filter((status) => status >= 400).length;
		if (outcome === "success" && recoveredStatuses > 0) {
			this.counters.recoveredErrors += recoveredStatuses;
		}
		state.observation.update({
			output: this.lastOutput,
			...(state.completionStartTime !== undefined
				? { completionStartTime: new Date(state.completionStartTime) }
				: {}),
			...(responseModel ? { model: responseModel } : {}),
			...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
			...(Object.keys(costDetails).length > 0 ? { costDetails } : {}),
			metadata: {
				...state.requestMetadata,
				...httpMetadata,
				...(message.provider
					? { "pi.provider": message.provider, "pi.response.provider": message.provider }
					: {}),
				...(message.api ? { "pi.response.api": message.api } : {}),
				...(responseModel ? { "pi.response.model": responseModel } : {}),
				...(message.responseId ? { "pi.response.id": message.responseId } : {}),
				...(message.responseModel && message.model && message.responseModel !== message.model
					? { "pi.requested_model": message.model }
					: {}),
				...(message.stopReason ? { "pi.stop_reason": message.stopReason } : {}),
				...(finiteNumber(message.usage?.reasoning)
					? { "pi.usage.reasoning_tokens": message.usage.reasoning }
					: {}),
				...(finiteNumber(message.usage?.cacheWrite1h)
					? { "pi.usage.cache_write_1h_tokens": message.usage.cacheWrite1h }
					: {}),
			},
			...severityForOutcome(outcome, message.errorMessage),
		});
		state.observation.end(state.endTime);
		this.generation = undefined;
	}

	beginTool(toolCallId: string, toolName: string, args?: unknown, startedAt = Date.now()): void {
		if (!this.root) return;
		this.counters.tools += 1;
		if (this.duplicateToolIds.has(toolCallId)) {
			this.counters.toolErrors += 1;
			const duplicate = this.startToolObservation(toolCallId, toolName, args);
			duplicate.update({
				level: "ERROR",
				statusMessage: "Duplicate tool call ID cannot be correlated safely.",
			});
			duplicate.end();
			return;
		}

		const existing = this.tools.get(toolCallId);
		if (existing) {
			existing.observation.update({
				level: "ERROR",
				statusMessage: "Duplicate tool execution started.",
			});
			existing.observation.end();
			this.tools.delete(toolCallId);
			this.counters.toolErrors += 2;
			const duplicate = this.startToolObservation(toolCallId, toolName, args);
			duplicate.update({
				level: "ERROR",
				statusMessage: "Duplicate tool call ID cannot be correlated safely.",
			});
			duplicate.end();
			this.duplicateToolIds.add(toolCallId);
			return;
		}

		this.tools.set(toolCallId, {
			observation: this.startToolObservation(toolCallId, toolName, args),
			startedAt,
			progressUpdates: 0,
		});
	}

	recordToolInput(toolCallId: string, input: unknown): void {
		if (input === undefined || this.duplicateToolIds.has(toolCallId)) return;
		this.tools.get(toolCallId)?.observation.update({ input: this.capture(input) });
	}

	recordToolProgress(toolCallId: string, timestamp = Date.now()): void {
		const tool = this.tools.get(toolCallId);
		if (!tool) return;
		tool.progressUpdates += 1;
		tool.firstProgressAt ??= timestamp;
	}

	finishTool(toolCallId: string, result: ToolResult): void {
		if (this.duplicateToolIds.has(toolCallId)) return;
		const tool = this.tools.get(toolCallId);
		if (!tool) return;
		if (result.isError) {
			this.counters.toolErrors += 1;
			this.unresolvedToolErrors += 1;
		}
		tool.observation.update({
			output: this.capture({ content: result.content, details: result.details }),
			metadata: {
				"pi.tool.progress_update_count": tool.progressUpdates,
				...(tool.firstProgressAt !== undefined
					? {
							"pi.tool.time_to_first_progress_ms": Math.max(
								0,
								tool.firstProgressAt - tool.startedAt,
							),
						}
					: {}),
			},
			...(result.isError
				? { level: "ERROR" as const, statusMessage: "Pi tool execution failed." }
				: {}),
		});
		tool.observation.end();
		this.tools.delete(toolCallId);
	}

	beginCompaction(input: CompactionStart): void {
		if (!this.root) return;
		this.closeCompaction("Interrupted by another Pi compaction.");
		this.counters.compactions += 1;
		this.compaction = {
			observation: this.backend.start(
				"pi.compaction",
				{
					metadata: {
						"pi.compaction.reason": input.reason,
						"pi.compaction.will_retry": input.willRetry,
						...(finiteNumber(input.tokensBefore)
							? { "pi.compaction.tokens_before": input.tokensBefore }
							: {}),
						"pi.compaction.messages_to_summarize": input.messagesToSummarize,
						"pi.compaction.turn_prefix_messages": input.turnPrefixMessages,
						"pi.compaction.branch_entries": input.branchEntries,
						"pi.compaction.is_split_turn": input.isSplitTurn,
					},
					version: TRACE_SCHEMA_VERSION,
				},
				{ asType: "span", parent: this.agent ?? this.root },
			),
		};
	}

	finishCompaction(input: CompactionFinish): void {
		if (!this.compaction) return;
		const details = structuralCompactionDetails(input.details);
		const usage = numericRecord({
			input: input.usage?.input,
			output: input.usage?.output,
			cache_read: input.usage?.cacheRead,
			cache_write: input.usage?.cacheWrite,
			total: input.usage?.totalTokens,
		});
		const cost = positiveNumericRecord({
			input: input.usage?.cost?.input,
			output: input.usage?.cost?.output,
			cache_read: input.usage?.cost?.cacheRead,
			cache_write: input.usage?.cost?.cacheWrite,
			total: input.usage?.cost?.total,
		});
		this.compaction.observation.update({
			metadata: {
				"pi.compaction.reason": input.reason,
				"pi.compaction.will_retry": input.willRetry,
				"pi.compaction.from_extension": input.fromExtension,
				...(finiteNumber(input.tokensBefore)
					? { "pi.compaction.tokens_before": input.tokensBefore }
					: {}),
				...details,
				...prefixRecord("pi.compaction.usage", usage),
				...prefixRecord("pi.compaction.cost", cost),
			},
		});
		this.compaction.observation.end();
		this.compaction = undefined;
	}

	settle(snapshot?: ContextSnapshot): void {
		this.closeActiveTrace(undefined, snapshot);
	}

	interrupt(statusMessage: string, snapshot?: ContextSnapshot): void {
		this.closeActiveTrace(statusMessage, snapshot, "interrupted");
	}

	async flush(): Promise<void> {
		await this.backend.forceFlush();
	}

	async shutdown(snapshot?: ContextSnapshot): Promise<void> {
		this.closeActiveTrace("Pi shut down before the active trace settled.", snapshot, "interrupted");
		await this.backend.shutdown();
	}

	private closeActiveTrace(
		statusMessage?: string,
		snapshot?: ContextSnapshot,
		forcedOutcome?: Outcome,
	): void {
		this.closeTurn(statusMessage ?? "Pi turn ended when the conversation settled.");
		this.closeAttempt(undefined, statusMessage, forcedOutcome ?? "interrupted");
		this.closeCompaction(statusMessage ?? "Pi compaction ended when the conversation settled.");

		if (!this.root) return;
		const baseOutcome =
			forcedOutcome ?? this.lastAttemptOutcome ?? classifyOutcome(this.lastAssistant);
		const recoveredErrorCount =
			this.counters.recoveredErrors +
			(baseOutcome === "success" ? this.counters.failedAttempts : 0);
		const traceOutcome =
			baseOutcome === "success" && recoveredErrorCount > 0 ? "recovered_success" : baseOutcome;
		const finalMetadata: Record<string, unknown> = {
			"pi.trace.schema_version": Number(TRACE_SCHEMA_VERSION),
			"pi.trace.outcome": traceOutcome,
			...(this.lastAssistant?.stopReason
				? { "pi.trace.stop_reason": this.lastAssistant.stopReason }
				: {}),
			"pi.trace.attempt_count": this.counters.attempts,
			"pi.trace.turn_count": this.counters.turns,
			"pi.trace.generation_count": this.counters.generations,
			"pi.trace.tool_count": this.counters.tools,
			"pi.trace.tool_error_count": this.counters.toolErrors,
			"pi.trace.compaction_count": this.counters.compactions,
			"pi.trace.recovered_error_count": recoveredErrorCount,
			...snapshotMetadata("start", this.startSnapshot),
			...snapshotMetadata("end", snapshot),
		};
		const finalAttributes: ObservationAttributes = {
			...(this.lastOutput !== undefined ? { output: this.lastOutput } : {}),
			metadata: finalMetadata,
			...severityForOutcome(baseOutcome, statusMessage ?? this.lastAssistant?.errorMessage),
		};
		if (this.agent) {
			this.agent.update(finalAttributes);
			this.agent.end();
			this.agent = undefined;
		}
		this.root.update(finalAttributes);
		this.root.updateTrace?.({
			...(this.lastOutput !== undefined ? { output: this.lastOutput } : {}),
			metadata: finalMetadata,
			version: TRACE_SCHEMA_VERSION,
		});
		this.root.end();
		this.root = undefined;
		this.lastOutput = undefined;
		this.lastAssistant = undefined;
		this.lastAttemptOutcome = undefined;
		this.unresolvedToolErrors = 0;
		this.duplicateToolIds.clear();
		this.startSnapshot = undefined;
	}

	private closeAttempt(
		message?: AssistantMessage,
		statusMessage?: string,
		forcedOutcome?: Outcome,
	): void {
		if (!this.attempt) return;
		this.closeTurn(statusMessage ?? "Pi turn ended when the attempt finished.");
		const outcome = forcedOutcome ?? classifyOutcome(message);
		if (outcome === "error") this.counters.failedAttempts += 1;
		this.lastAttemptOutcome = outcome;
		this.attempt.update({
			...(message?.content !== undefined ? { output: this.capture(message.content) } : {}),
			metadata: {
				"pi.attempt.index": this.attemptIndex ?? Math.max(0, this.counters.attempts - 1),
				"pi.attempt.outcome": outcome,
				...(message?.stopReason ? { "pi.attempt.stop_reason": message.stopReason } : {}),
			},
			...severityForOutcome(outcome, statusMessage ?? message?.errorMessage),
		});
		this.attempt.end();
		this.attempt = undefined;
		this.attemptIndex = undefined;
		this.unresolvedToolErrors = 0;
	}

	private startToolObservation(toolCallId: string, toolName: string, args?: unknown): Observation {
		return this.backend.start(
			`pi.tool.${toolName}`,
			{
				...(args !== undefined ? { input: this.capture(args) } : {}),
				metadata: { "pi.tool.call_id": toolCallId, "pi.tool.name": toolName },
				version: TRACE_SCHEMA_VERSION,
			},
			{ asType: "tool", parent: this.turn ?? this.attempt ?? this.agent ?? this.root },
		);
	}

	private closeTurn(statusMessage: string, generationLevel: "ERROR" | "WARNING" = "WARNING"): void {
		this.closeGeneration(statusMessage, generationLevel);
		this.closeTools(statusMessage);
		if (!this.turn) return;
		this.turn.update({ level: "WARNING", statusMessage });
		this.turn.end();
		this.turn = undefined;
		this.turnIndex = undefined;
	}

	private closeTools(statusMessage: string): void {
		for (const tool of this.tools.values()) {
			tool.observation.update({
				level: "WARNING",
				statusMessage,
				metadata: {
					"pi.tool.progress_update_count": tool.progressUpdates,
					...(tool.firstProgressAt !== undefined
						? {
								"pi.tool.time_to_first_progress_ms": Math.max(
									0,
									tool.firstProgressAt - tool.startedAt,
								),
							}
						: {}),
				},
			});
			tool.observation.end();
		}
		this.tools.clear();
	}

	private closeGeneration(statusMessage: string, level: "ERROR" | "WARNING" = "ERROR"): void {
		if (!this.generation) return;
		this.generation.observation.update({
			level,
			statusMessage,
			metadata: {
				...this.generation.requestMetadata,
				...generationHttpMetadata(this.generation),
			},
		});
		this.generation.observation.end(this.generation.endTime);
		this.generation = undefined;
	}

	private closeCompaction(statusMessage: string): void {
		if (!this.compaction) return;
		this.compaction.observation.update({ level: "WARNING", statusMessage });
		this.compaction.observation.end();
		this.compaction = undefined;
	}

	private capture(value: unknown): unknown {
		return this.context.captureContent ? sanitizeTraceValue(value) : CONTENT_DISABLED;
	}
}

function generationHttpMetadata(state: GenerationState): Record<string, unknown> {
	const finalStatus = state.statuses.at(-1);
	return {
		...(state.statuses.length > 0
			? {
					"http.response.status_codes": [...state.statuses],
					"http.response.status_code": finalStatus,
					"http.response.attempt_count": state.statuses.length,
					"http.response.retry_count": Math.max(0, state.statuses.length - 1),
				}
			: {}),
		...(Object.keys(state.headers).length > 0
			? { "http.response.headers": { ...state.headers } }
			: {}),
	};
}

function allowlistedResponseHeaders(headers: Record<string, string>): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		if (!ALLOWED_RESPONSE_HEADERS.has(name) || typeof rawValue !== "string") continue;
		output[name] = truncateString(rawValue, MAX_HEADER_VALUE_LENGTH);
	}
	return output;
}

function structuralCompactionDetails(details: unknown): Record<string, unknown> {
	if (!details || typeof details !== "object" || Array.isArray(details)) return {};
	const record = details as Record<string, unknown>;
	return {
		...(Array.isArray(record.readFiles)
			? { "pi.compaction.read_file_count": record.readFiles.length }
			: {}),
		...(Array.isArray(record.modifiedFiles)
			? { "pi.compaction.modified_file_count": record.modifiedFiles.length }
			: {}),
	};
}

function snapshotMetadata(prefix: string, snapshot?: ContextSnapshot): Record<string, unknown> {
	if (!snapshot) return {};
	return {
		...(snapshot.leafId ? { [`pi.trace.${prefix}_leaf_id`]: snapshot.leafId } : {}),
		...(snapshot.contextUsage
			? {
					...(finiteNumber(snapshot.contextUsage.tokens)
						? { [`pi.trace.${prefix}_context_tokens`]: snapshot.contextUsage.tokens }
						: {}),
					[`pi.trace.${prefix}_context_window`]: snapshot.contextUsage.contextWindow,
					...(finiteNumber(snapshot.contextUsage.percent)
						? { [`pi.trace.${prefix}_context_percent`]: snapshot.contextUsage.percent }
						: {}),
				}
			: {}),
	};
}

function classifyOutcome(message?: {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}): Outcome {
	if (message?.role !== "assistant") return "interrupted";
	if (message.stopReason === "error" || message.errorMessage) return "error";
	if (message.stopReason === "aborted") return "aborted";
	if (message.stopReason === "length") return "length";
	return "success";
}

function severityForOutcome(
	outcome: Outcome,
	statusMessage?: string,
): Pick<ObservationAttributes, "level" | "statusMessage"> {
	if (outcome === "success") return {};
	if (outcome === "error") {
		return {
			level: "ERROR",
			statusMessage: statusMessage ?? "The Pi operation failed.",
		};
	}
	return {
		level: "WARNING",
		statusMessage:
			statusMessage ??
			(outcome === "aborted"
				? "The Pi operation was aborted."
				: outcome === "length"
					? "The model reached its output limit."
					: "The Pi operation was interrupted."),
	};
}

function prefixRecord(prefix: string, values: Record<string, number>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => [`${prefix}.${key}`, value]),
	);
}

function truncateString(value: string, maxBytes: number): string {
	const boundedPrefix = value.slice(0, maxBytes);
	if (boundedPrefix.length === value.length && byteLength(boundedPrefix) <= maxBytes) {
		return boundedPrefix;
	}
	const suffix = "… [truncated]";
	const target = Math.max(0, maxBytes - byteLength(suffix) - 2);
	let bytes = 0;
	let output = "";
	for (const character of boundedPrefix) {
		const size = byteLength(character);
		if (bytes + size > target) break;
		output += character;
		bytes += size;
	}
	return `${output}${suffix}`;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function numericRecord(values: Record<string, number | undefined>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, number] => finiteNumber(entry[1])),
	);
}

function positiveNumericRecord(values: Record<string, number | undefined>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(values).filter(
			(entry): entry is [string, number] => finiteNumber(entry[1]) && entry[1] > 0,
		),
	);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasItems(value: unknown): boolean {
	return Array.isArray(value) ? value.length > 0 : value !== undefined;
}

function emptyCounters(): Counters {
	return {
		attempts: 0,
		turns: 0,
		generations: 0,
		tools: 0,
		toolErrors: 0,
		compactions: 0,
		recoveredErrors: 0,
		failedAttempts: 0,
	};
}
