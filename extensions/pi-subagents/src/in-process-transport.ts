import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgents, type SubagentThinkingLevel } from "./agents.js";
import { redactPrivateText } from "./context.js";
import { resolveDefaultSubagentTimeoutMs } from "./execution.js";
import { DEFAULT_MAX_CONTEXT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, truncateUtf8 } from "./limits.js";
import type { AgentTurn, ManagedAgent, TurnOutcome } from "./registry.js";
import { readSubagentSettings } from "./settings.js";
import type { SubagentTransport } from "./transport.js";

const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const DEFAULT_ABORT_GRACE_MS = 5_000;

export interface ParentRuntimeSnapshot {
	model: Model<Api> | undefined;
	thinkingLevel: SubagentThinkingLevel;
}

export interface ChildSession {
	readonly sessionId: string;
	readonly messages: readonly unknown[];
	prompt(text: string): Promise<void>;
	subscribe(listener: (event: unknown) => void): () => void;
	abort(): Promise<void>;
	dispose(): void;
	getActiveToolNames(): string[];
}

export interface ChildSessionCreateOptions {
	agent: ManagedAgent;
	agentConfig: AgentConfig;
	context?: string;
	history: AgentTurn[];
	modelRegistry: ModelRegistry;
	parentRuntime: ParentRuntimeSnapshot;
	tools?: string[];
}

export type ChildSessionFactory = (options: ChildSessionCreateOptions) => Promise<ChildSession>;

export interface InProcessTransportOptions {
	modelRegistry: ModelRegistry;
	getParentRuntime: () => ParentRuntimeSnapshot;
	createSession?: ChildSessionFactory;
	discoverAgent?: (agent: ManagedAgent) => AgentConfig | undefined;
	defaultTimeoutMs?: number;
	abortGraceMs?: number;
}

interface ChildSessionRecord {
	session: ChildSession;
	unsubscribe: () => void;
	lastOutput: string;
	disposed: boolean;
}

type PromptSettlement =
	| { kind: "completed" }
	| { kind: "failed"; error: unknown }
	| { kind: "timeout" }
	| { kind: "aborted" };

export class InProcessTransport implements SubagentTransport {
	readonly kind = "in-process" as const;
	private readonly sessions = new Map<string, ChildSessionRecord>();
	private readonly createSession: ChildSessionFactory;
	private readonly discoverAgent: (agent: ManagedAgent) => AgentConfig | undefined;
	private readonly defaultTimeoutMs: number;
	private readonly abortGraceMs: number;

	constructor(private readonly options: InProcessTransportOptions) {
		this.createSession = options.createSession ?? createSdkChildSession;
		this.discoverAgent =
			options.discoverAgent ??
			((agent) =>
				discoverAgents(agent.cwd, agent.agentScope ?? "user", readSubagentSettings()).agents.find(
					(candidate) => candidate.name === agent.agent,
				));
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? resolveDefaultSubagentTimeoutMs();
		this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
	}

	async runTurn(agent: ManagedAgent, task: string, signal: AbortSignal): Promise<TurnOutcome> {
		if (signal.aborted) return interruptedOutcome("");
		const agentConfig = this.discoverAgent(agent);
		if (!agentConfig) {
			return { output: "", exitCode: 1, error: `Unknown subagent: ${agent.agent}` };
		}
		let tools: string[] | undefined;
		try {
			tools = validateInProcessTools(agentConfig.tools);
		} catch (error) {
			return { output: "", exitCode: 1, error: errorMessage(error) };
		}
		let record: ChildSessionRecord;
		try {
			record = await this.getOrCreate(agent, agentConfig, tools);
		} catch (error) {
			return { output: "", exitCode: 1, error: errorMessage(error) };
		}
		if (signal.aborted) return interruptedOutcome("");
		const prompt = buildCurrentTurnPrompt(agent, task);
		const timeoutMs = agentConfig.timeoutMs ?? this.defaultTimeoutMs;
		const startingMessageCount = record.session.messages.length;
		record.lastOutput = "";
		const settlement = await this.runPrompt(record, prompt, signal, timeoutMs);
		const final = latestAssistant(record.session.messages.slice(startingMessageCount));
		const output = truncateUtf8(final.output || record.lastOutput, DEFAULT_MAX_OUTPUT_BYTES);
		const truncated = output.truncated || agent.contextTruncated;

		switch (settlement.kind) {
			case "completed":
				if (final.stopReason === "error") {
					return {
						output: output.text,
						exitCode: 1,
						truncated,
						error: final.error || "In-process subagent returned an error",
						policy: inProcessPolicy(agentConfig),
					};
				}
				if (final.stopReason === "aborted") {
					return {
						...interruptedOutcome(output.text),
						truncated,
						policy: inProcessPolicy(agentConfig),
					};
				}
				return {
					output: output.text,
					exitCode: 0,
					truncated,
					policy: inProcessPolicy(agentConfig),
				};
			case "failed":
				return {
					output: output.text,
					exitCode: 1,
					truncated,
					error: errorMessage(settlement.error),
					policy: inProcessPolicy(agentConfig),
				};
			case "timeout":
				return {
					output: output.text,
					exitCode: 124,
					truncated,
					error: `In-process subagent timed out after ${timeoutMs}ms`,
					policy: inProcessPolicy(agentConfig),
				};
			case "aborted":
				return {
					...interruptedOutcome(output.text),
					truncated,
					policy: inProcessPolicy(agentConfig),
				};
		}
	}

	async release(agent: ManagedAgent): Promise<void> {
		await this.releaseById(agent.id);
	}

	async shutdown(): Promise<void> {
		const agentIds = [...this.sessions.keys()];
		const results = await Promise.allSettled(agentIds.map((agentId) => this.releaseById(agentId)));
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Failed to dispose ${failures.length} in-process subagent session(s)`,
			);
		}
	}

	private async releaseById(agentId: string): Promise<void> {
		const record = this.sessions.get(agentId);
		if (!record) return;
		this.sessions.delete(agentId);
		if (record.disposed) return;
		record.disposed = true;
		const failures: unknown[] = [];
		try {
			record.unsubscribe();
		} catch (error) {
			failures.push(error);
		}
		if (record.session.messages.length > 0) {
			await settleWithin(record.session.abort(), this.abortGraceMs);
		}
		try {
			record.session.dispose();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Failed to release in-process subagent ${agentId}: ${failures.map(errorMessage).join("; ")}`,
			);
		}
	}

	private async getOrCreate(
		agent: ManagedAgent,
		agentConfig: AgentConfig,
		tools: string[] | undefined,
	): Promise<ChildSessionRecord> {
		const existing = this.sessions.get(agent.id);
		if (existing) return existing;
		const session = await this.createSession({
			agent,
			agentConfig,
			context: agent.context,
			history: agent.history.map((turn) => ({ ...turn })),
			modelRegistry: this.options.modelRegistry,
			parentRuntime: this.options.getParentRuntime(),
			tools,
		});
		const record: ChildSessionRecord = {
			session,
			lastOutput: "",
			disposed: false,
			unsubscribe: () => undefined,
		};
		try {
			record.unsubscribe = session.subscribe((event) => {
				const message = eventMessage(event);
				if (!message) return;
				const output = assistantText(message);
				if (output) record.lastOutput = truncateUtf8(output, DEFAULT_MAX_OUTPUT_BYTES).text;
			});
		} catch (error) {
			record.disposed = true;
			try {
				session.dispose();
			} catch {
				// Preserve the subscription failure, which explains why creation was rejected.
			}
			throw error;
		}
		this.sessions.set(agent.id, record);
		return record;
	}

	private async runPrompt(
		record: ChildSessionRecord,
		prompt: string,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<PromptSettlement> {
		let timeout: NodeJS.Timeout | undefined;
		let abortHandler: (() => void) | undefined;
		const promptSettlement: Promise<PromptSettlement> = record.session
			.prompt(prompt)
			.then(() => ({ kind: "completed" as const }))
			.catch((error: unknown) => ({ kind: "failed" as const, error }));
		const timeoutSettlement = new Promise<PromptSettlement>((resolve) => {
			timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
		});
		const abortSettlement = new Promise<PromptSettlement>((resolve) => {
			abortHandler = () => resolve({ kind: "aborted" });
			signal.addEventListener("abort", abortHandler, { once: true });
		});
		const settlement = await Promise.race([promptSettlement, timeoutSettlement, abortSettlement]);
		if (timeout) clearTimeout(timeout);
		if (abortHandler) signal.removeEventListener("abort", abortHandler);
		if (settlement.kind === "timeout" || settlement.kind === "aborted") {
			await settleWithin(record.session.abort(), this.abortGraceMs);
			const settledAfterAbort = await completesWithin(promptSettlement, this.abortGraceMs);
			if (!settledAfterAbort) this.discardRecord(record);
		}
		return settlement;
	}

	private discardRecord(record: ChildSessionRecord): void {
		for (const [agentId, candidate] of this.sessions) {
			if (candidate === record) this.sessions.delete(agentId);
		}
		if (record.disposed) return;
		record.disposed = true;
		record.unsubscribe();
		record.session.dispose();
	}
}

export function validateInProcessTools(tools: string[] | undefined): string[] | undefined {
	if (tools === undefined) return undefined;
	const unique = [...new Set(tools)];
	const unsupported = unique.filter((tool) => !BUILT_IN_TOOL_NAMES.has(tool));
	if (unsupported.length > 0) {
		throw new Error(
			`In-process subagents cannot load extension/custom tools: ${unsupported.join(", ")}. Use stateful.transport "subprocess" for this agent.`,
		);
	}
	return unique;
}

export async function createSdkChildSession(
	options: ChildSessionCreateOptions,
): Promise<ChildSession> {
	const agentDir = getAgentDir();
	const { loader: resourceLoader, settingsManager } = await createInProcessResourceLoader(
		options.agent.cwd,
		agentDir,
		options.agentConfig.systemPrompt,
		options.agent.agentScope === "project" || options.agent.agentScope === "both",
	);
	const resolved = await resolveChildModel(options);
	const sessionManager = SessionManager.inMemory(options.agent.cwd);
	seedChildSessionManager(sessionManager, options, resolved.model);
	const created = await createAgentSession({
		cwd: options.agent.cwd,
		agentDir,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel,
		modelRegistry: options.modelRegistry,
		resourceLoader,
		settingsManager,
		sessionManager,
		tools: options.tools,
		noTools: options.tools?.length === 0 ? "all" : undefined,
	});
	const session = created.session;
	if (options.tools !== undefined) {
		const active = session.getActiveToolNames();
		const expected = [...options.tools].sort();
		if (
			active.length !== expected.length ||
			[...active].sort().some((name, index) => name !== expected[index])
		) {
			session.dispose();
			throw new Error(
				`In-process child activated an unexpected tool set (${active.join(", ") || "none"}); use stateful.transport "subprocess".`,
			);
		}
	}
	return {
		get sessionId() {
			return session.sessionId;
		},
		get messages() {
			return session.messages;
		},
		prompt: (text) => session.prompt(text),
		subscribe: (listener) => session.subscribe((event) => listener(event)),
		abort: () => session.abort(),
		dispose: () => session.dispose(),
		getActiveToolNames: () => session.getActiveToolNames(),
	};
}

export async function resolveChildModel(options: ChildSessionCreateOptions): Promise<{
	model: Model<Api>;
	thinkingLevel: SubagentThinkingLevel;
}> {
	let model = options.parentRuntime.model;
	let modelThinkingLevel: SubagentThinkingLevel | undefined;
	if (options.agentConfig.model) {
		const parsed = parseModelRequest(options.agentConfig.model);
		model = resolveConfiguredModel(parsed.model, options.modelRegistry);
		modelThinkingLevel = parsed.thinkingLevel;
	}
	if (!model) model = options.modelRegistry.getAvailable()[0];
	if (!model)
		throw new Error("No model with configured authentication is available for in-process subagent");
	return {
		model,
		thinkingLevel:
			options.agentConfig.thinkingLevel ??
			modelThinkingLevel ??
			options.parentRuntime.thinkingLevel,
	};
}

function parseModelRequest(value: string): {
	model: string;
	thinkingLevel?: SubagentThinkingLevel;
} {
	const requested = value.trim();
	const separator = requested.lastIndexOf(":");
	if (separator > 0) {
		const suffix = requested.slice(separator + 1);
		if (
			suffix === "off" ||
			suffix === "minimal" ||
			suffix === "low" ||
			suffix === "medium" ||
			suffix === "high" ||
			suffix === "xhigh"
		) {
			return { model: requested.slice(0, separator), thinkingLevel: suffix };
		}
	}
	return { model: requested };
}

function resolveConfiguredModel(value: string, modelRegistry: ModelRegistry): Model<Api> {
	const requested = value.trim();
	if (!requested) throw new Error("In-process subagent model cannot be empty");
	const slash = requested.indexOf("/");
	if (slash > 0) {
		const exact = modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1));
		if (exact) return exact;
	}
	const lowered = requested.toLowerCase();
	const exactMatches = modelRegistry
		.getAll()
		.filter((model) => model.id.toLowerCase() === lowered || model.name.toLowerCase() === lowered);
	if (exactMatches.length === 1) return exactMatches[0];
	const partialMatches = modelRegistry
		.getAll()
		.filter(
			(model) =>
				model.id.toLowerCase().includes(lowered) || model.name.toLowerCase().includes(lowered),
		);
	if (partialMatches.length === 1) return partialMatches[0];
	const displayedMatches = partialMatches
		.slice(0, 8)
		.map((model) => `${model.provider}/${model.id}`);
	const remaining = partialMatches.length - displayedMatches.length;
	const suffix =
		displayedMatches.length > 0
			? `; matches: ${displayedMatches.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`
			: "";
	throw new Error(`Unable to resolve in-process subagent model ${requested}${suffix}`);
}

export async function createInProcessResourceLoader(
	cwd: string,
	agentDir: string,
	agentSystemPrompt: string,
	projectTrusted = false,
): Promise<{ loader: DefaultResourceLoader; settingsManager: SettingsManager }> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	settingsManager.setProjectTrusted(projectTrusted);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		appendSystemPrompt: agentSystemPrompt.trim() ? [agentSystemPrompt] : [],
	});
	await loader.reload();
	return { loader, settingsManager };
}

export function seedChildSessionManager(
	sessionManager: SessionManager,
	options: ChildSessionCreateOptions,
	model: Model<Api>,
): void {
	let timestamp = Date.now() - (options.history.length * 2 + 1);
	if (options.context?.trim()) {
		sessionManager.appendMessage({
			role: "user",
			content: `Parent context:\n${redactPrivateText(options.context)}`,
			timestamp: timestamp++,
		});
	}
	for (const turn of options.history) {
		sessionManager.appendMessage({
			role: "user",
			content: redactPrivateText(turn.task),
			timestamp: timestamp++,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: redactPrivateText(turn.output) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: turn.exitCode === 0 ? "stop" : "error",
			timestamp: timestamp++,
		});
	}
}

function buildCurrentTurnPrompt(agent: ManagedAgent, task: string): string {
	const ids = new Set(agent.currentMailboxMessageIds ?? []);
	const messages = agent.mailbox
		.filter((message) => ids.has(message.id))
		.slice(-20)
		.map((message) => `From ${message.senderId}: ${redactPrivateText(message.content)}`)
		.join("\n");
	return truncateUtf8(
		messages
			? `${redactPrivateText(task)}\n\nMailbox messages:\n${messages}`
			: redactPrivateText(task),
		DEFAULT_MAX_CONTEXT_BYTES,
	).text;
}

function latestAssistant(messages: readonly unknown[]): {
	output: string;
	stopReason?: string;
	error?: string;
} {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const candidate = message as { role?: string; stopReason?: string; errorMessage?: string };
		if (candidate.role !== "assistant") continue;
		return {
			output: assistantText(message),
			stopReason: candidate.stopReason,
			error: candidate.errorMessage,
		};
	}
	return { output: "" };
}

function eventMessage(event: unknown): unknown {
	if (!event || typeof event !== "object") return undefined;
	const candidate = event as { type?: string; message?: unknown };
	return candidate.type === "message_update" || candidate.type === "message_end"
		? candidate.message
		: undefined;
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
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

function interruptedOutcome(output: string): TurnOutcome {
	return { output, exitCode: 130, aborted: true, error: "In-process subagent was aborted" };
}

function inProcessPolicy(agent: AgentConfig): NonNullable<TurnOutcome["policy"]> {
	return {
		inherited: ["modelRegistry", "authentication", "cwdResources"],
		overridden: [
			...(agent.model ? ["model"] : []),
			...(agent.thinkingLevel ? ["thinkingLevel"] : []),
			...(agent.tools ? ["tools"] : []),
		],
		unsupported: ["approvalPolicy", "sandboxProfile", "providerHeaders", "extensionState"],
	};
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
	await completesWithin(
		promise.catch(() => undefined),
		timeoutMs,
	);
}

async function completesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function errorMessage(error: unknown): string {
	return truncateUtf8(
		error instanceof Error ? error.message : String(error),
		DEFAULT_MAX_OUTPUT_BYTES,
	).text;
}
