import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverAgents, type AgentScope, isThinkingLevel } from "./agents.js";
import { buildContextSnapshot, type ContextMode, redactPrivateText } from "./context.js";
import { assertSubagentDepthAllowed } from "./execution.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { AgentPersistence } from "./persistence.js";
import { AgentRegistry, type AgentTurnCompletion, type ManagedAgent } from "./registry.js";
import { readSubagentSettings } from "./settings.js";
import { SubprocessTransport } from "./subprocess-transport.js";
import {
	type ChildSessionFactory,
	InProcessTransport,
	type ParentRuntimeSnapshot,
} from "./in-process-transport.js";
import { WorkspaceManager } from "./workspace.js";

const ContextModeSchema = Type.Union([
	StringEnum(["none", "all", "summary"] as const),
	Type.Number({ minimum: 1, description: "Include the most recent N user turns." }),
]);
const ScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Per-invocation custom agent scope for this spawn. Default: "user". Use "project" for project-local agents or "both" for user and project agents; the selected scope is retained for follow-ups.',
	default: "user",
});
const MAX_TOOL_MESSAGE_BYTES = 2 * 1024;
const MAX_COMPLETION_ERROR_BYTES = 512;

export interface StatefulSubagentDependencies {
	createInProcessSession?: ChildSessionFactory;
}

export function registerStatefulSubagents(
	pi: ExtensionAPI,
	dependencies: StatefulSubagentDependencies = {},
): void {
	const settings = readSubagentSettings()?.stateful ?? {};
	if (settings.enabled === false) return;

	let registry: AgentRegistry | undefined;
	let persistence: AgentPersistence | undefined;
	let sweepTimer: NodeJS.Timeout | undefined;
	let runtimeGeneration = 0;
	const workspaceManager = new WorkspaceManager();
	const isolatedAgents = new Map<string, string>();
	const seenMessageIds = new Set<string>();
	const parentRuntime: ParentRuntimeSnapshot = { model: undefined, thinkingLevel: "off" };
	const completionWaiters = new Map<string, number>();

	const requireRegistry = () => {
		if (!registry) throw new Error("Stateful subagents are not initialized for this session");
		return registry;
	};

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++runtimeGeneration;
		parentRuntime.model = ctx.model;
		parentRuntime.thinkingLevel = normalizeRuntimeThinkingLevel(pi.getThinkingLevel());
		const owner =
			ctx.sessionManager.getSessionId?.() ??
			ctx.sessionManager.getSessionFile?.() ??
			`ephemeral:${ctx.cwd}`;
		const sessionPersistence = new AgentPersistence(owner, {
			retentionDays: settings.retentionDays,
			maxStoredAgents: settings.maxStoredAgents,
		});
		persistence = sessionPersistence;
		const transport =
			resolveStatefulTransportKind(settings.transport) === "in-process"
				? new InProcessTransport({
						modelRegistry: ctx.modelRegistry,
						getParentRuntime: () => ({ ...parentRuntime }),
						createSession: dependencies.createInProcessSession,
					})
				: new SubprocessTransport(ctx);
		registry = new AgentRegistry(transport, {
			maxAgents: settings.maxAgents,
			maxActiveTurns: settings.maxActiveTurns,
			maxDepth: settings.maxDepth,
			maxChildrenPerAgent: settings.maxChildrenPerAgent,
			maxMailboxMessages: settings.maxMailboxMessages,
			maxMailboxMessageBytes: settings.maxMailboxMessageBytes,
			idleTtlMs: settings.idleTtlMs,
			onChange: async (agents) => {
				await sessionPersistence.save(agents);
				if (generation !== runtimeGeneration) return;
				for (const agent of agents) {
					for (const message of agent.mailbox) {
						if (seenMessageIds.has(message.id)) continue;
						seenMessageIds.add(message.id);
						pi.appendEntry("pi-subagent-message", {
							senderId: message.senderId,
							recipientId: message.recipientId,
							content: redactPrivateText(message.content).slice(0, 160),
						});
					}
				}
			},
			onTurnComplete: (completion) => {
				if (generation !== runtimeGeneration) return;
				if (!completionWaiters.has(completion.agent.id)) {
					sendDetachedCompletion(pi, completion);
				}
			},
		});
		const restored = sessionPersistence
			.load()
			.filter(
				(agent) =>
					(agent.agentScope !== "project" && agent.agentScope !== "both") || ctx.isProjectTrusted(),
			);
		for (const agent of restored) {
			for (const message of agent.mailbox) seenMessageIds.add(message.id);
		}
		registry.restore(restored);
		const sweepEveryMs = Math.max(1_000, Math.min(settings.idleTtlMs ?? 60 * 60 * 1000, 60_000));
		sweepTimer = setInterval(() => {
			void registry?.sweepExpired().catch((error: unknown) => {
				if (!ctx.hasUI) return;
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Subagent expiry cleanup failed: ${reason}`, "warning");
			});
		}, sweepEveryMs);
		sweepTimer.unref();
	});

	pi.on("model_select", (event) => {
		parentRuntime.model = event.model;
	});

	pi.on("thinking_level_select", (event) => {
		parentRuntime.thinkingLevel = normalizeRuntimeThinkingLevel(event.level);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtimeGeneration++;
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;
		for (const agentId of isolatedAgents.keys()) {
			await registry?.closeTree(agentId).catch(() => undefined);
		}
		isolatedAgents.clear();
		seenMessageIds.clear();
		completionWaiters.clear();
		let cleanupError: unknown;
		try {
			await workspaceManager.cleanupAll();
		} catch (error) {
			cleanupError = error;
		}
		await registry?.shutdown();
		registry = undefined;
		persistence = undefined;
		if (cleanupError && ctx.hasUI) {
			const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
			ctx.ui.notify(`Some isolated subagent workspaces could not be removed: ${reason}`, "warning");
		}
	});

	pi.registerTool({
		name: "subagent_spawn",
		label: "Spawn Subagent",
		description:
			"Start an addressable background subagent, return immediately with an agentId, and receive its completion asynchronously.",
		promptSnippet: "Start a reusable detached subagent; completion is delivered asynchronously",
		promptGuidelines: [
			"Do not delegate simple or critical-path work that the main agent can perform directly.",
			"A single detached subagent is appropriate only for a concrete bounded subtask that can run independently alongside useful main-agent work and has an isolation or specialization benefit such as independent review, bounded context/output, a distinct model/tool profile, or workspace isolation.",
			"Use one blocking subagent parallel call for multiple independent one-shot tasks; do not use repeated detached spawns when no reuse or overlap is needed.",
			"After spawning, do useful non-overlapping local work immediately. Call subagent_wait sparingly, only when the immediate next critical-path step requires the result and is blocked until it arrives; do not wait repeatedly by reflex.",
			"Consume and synthesize available completion messages; interrupt or close agents that are no longer needed.",
			"Detached completion is delivered automatically. Do not poll, wait forever, or spawn additional agents without a distinct need.",
		],
		parameters: Type.Object({
			agent: Type.String({ minLength: 1 }),
			task: Type.String({ minLength: 1, maxLength: DEFAULT_MAX_CONTEXT_BYTES }),
			cwd: Type.Optional(Type.String()),
			agentScope: Type.Optional(ScopeSchema),
			confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
			context: Type.Optional(ContextModeSchema),
			contextEntryIds: Type.Optional(
				Type.Array(Type.String(), { description: "Optional selected session entry IDs." }),
			),
			parentId: Type.Optional(Type.String({ description: "Optional parent agent ID." })),
			allowConcurrentWrites: Type.Optional(
				Type.Boolean({ description: "Override the shared-workspace write conflict guard." }),
			),
			workspaceMode: Type.Optional(
				StringEnum(["shared", "worktree"] as const, {
					description: "Use the shared workspace or an opt-in disposable Git worktree.",
				}),
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const scope = (params.agentScope ?? "user") as AgentScope;
			assertSubagentDepthAllowed();
			const cwd = params.cwd ?? ctx.cwd;
			await confirmProjectAgent(params.agent, scope, params.confirmProjectAgents ?? true, ctx, cwd);
			const resolvedAgent = discoverAgents(cwd, scope, readSubagentSettings()).agents.find(
				(agent) => agent.name === params.agent,
			);
			if (params.workspaceMode === "worktree" && resolvedAgent?.source === "project") {
				throw new Error("Project-local subagent definitions cannot run in a detached worktree");
			}
			const mode = resolveSpawnContextMode(params.context, params.contextEntryIds);
			const snapshot = buildContextSnapshot(
				ctx.sessionManager.getBranch(),
				mode,
				DEFAULT_MAX_CONTEXT_BYTES,
				params.contextEntryIds,
			);
			const requestedCwd = cwd;
			if ((params.workspaceMode ?? "shared") === "shared" && !params.allowConcurrentWrites) {
				assertNoSharedWriteConflict(requireRegistry(), params.agent, requestedCwd, scope);
			}
			const workspaceOwner = `pending-${randomUUID()}`;
			const workspace =
				params.workspaceMode === "worktree"
					? await workspaceManager.create(workspaceOwner, requestedCwd)
					: undefined;
			let agent: ManagedAgent;
			try {
				agent = await requireRegistry().spawn({
					agent: params.agent,
					task: params.task,
					cwd: workspace?.path ?? requestedCwd,
					agentScope: scope,
					parentId: params.parentId,
					context: snapshot.text || undefined,
					contextSourceIds: snapshot.sourceIds,
					contextTruncated: snapshot.truncated,
				});
			} catch (error) {
				if (workspace) await workspaceManager.cleanup(workspaceOwner);
				throw error;
			}
			if (workspace) isolatedAgents.set(agent.id, workspaceOwner);
			return result(
				agent,
				`Spawned ${agent.agent} as ${agent.id}. Do useful non-overlapping work immediately. Completion will arrive asynchronously; call subagent_wait only if the immediate next critical-path step is blocked on this result.`,
			);
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Send Subagent Follow-up",
		description: "Send a follow-up task to an idle, completed, interrupted, or failed subagent.",
		parameters: Type.Object({
			agentId: Type.String(),
			task: Type.String({ minLength: 1, maxLength: DEFAULT_MAX_CONTEXT_BYTES }),
			allowConcurrentWrites: Type.Optional(
				Type.Boolean({ description: "Override the shared-workspace write conflict guard." }),
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const existing = requireRegistry().get(params.agentId);
			if (!existing) throw new Error(`Unknown subagent: ${params.agentId}`);
			await confirmProjectAgent(
				existing.agent,
				existing.agentScope ?? "user",
				false,
				ctx,
				existing.cwd,
			);
			assertFollowUpWriteAllowed(
				requireRegistry(),
				existing,
				params.allowConcurrentWrites ?? false,
				isolatedAgents.has(existing.id),
			);
			const agent = await requireRegistry().followUp(params.agentId, params.task);
			return result(agent, `Started follow-up for ${agent.id}.`);
		},
	});

	pi.registerTool({
		name: "subagent_message",
		label: "Message Subagent",
		description: "Queue a bounded mailbox message without starting a turn.",
		parameters: Type.Object({
			agentId: Type.String(),
			message: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
			senderId: Type.Optional(Type.String()),
			deduplicationKey: Type.Optional(Type.String({ maxLength: 256 })),
		}),
		async execute(_id, params) {
			const message = await requireRegistry().sendMessage(
				params.agentId,
				params.message,
				params.senderId,
				params.deduplicationKey,
			);
			return {
				content: [{ type: "text", text: `Queued ${message.id} for ${message.recipientId}.` }],
				details: { message },
			};
		},
	});

	pi.registerTool({
		name: "subagent_messages",
		label: "Read Subagent Messages",
		description: "Read unread mailbox messages and optionally acknowledge them.",
		parameters: Type.Object({
			agentId: Type.String(),
			acknowledge: Type.Optional(Type.Boolean({ default: true })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 20 })),
		}),
		async execute(_id, params) {
			const messages = await requireRegistry().readMessages(
				params.agentId,
				params.acknowledge,
				params.limit,
			);
			const summaries = messages.map((message) => ({
				...message,
				content: truncateUtf8(message.content, MAX_TOOL_MESSAGE_BYTES).text,
			}));
			const text = summaries.length
				? summaries
						.map((message) => `${message.id} from ${message.senderId}: ${message.content}`)
						.join("\n")
				: "No unread messages.";
			return {
				content: [{ type: "text", text: truncateUtf8(text, DEFAULT_MAX_CONTEXT_BYTES).text }],
				details: { messages: summaries },
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for Subagent",
		description:
			"Wait for a stateful subagent turn without terminating it when the wait times out. Use sparingly, only when the immediate next critical-path step is blocked on this result.",
		parameters: Type.Object({
			agentId: Type.String(),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 3_600_000, default: 30_000 })),
		}),
		async execute(_id, params, signal) {
			const existing = requireRegistry().get(params.agentId);
			const registered = existing?.state === "starting" || existing?.state === "running";
			if (registered) {
				completionWaiters.set(params.agentId, (completionWaiters.get(params.agentId) ?? 0) + 1);
			}
			try {
				const waited = await requireRegistry().wait(params.agentId, params.timeoutMs, signal);
				return result(
					waited.agent,
					waited.timedOut
						? `Wait timed out; ${waited.agent.id} is ${waited.agent.state}.`
						: formatFinal(waited.agent),
				);
			} finally {
				if (registered) decrementWaiter(completionWaiters, params.agentId);
			}
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "List Subagents",
		description: "List stateful subagents and lifecycle states.",
		parameters: Type.Object({ includeClosed: Type.Optional(Type.Boolean({ default: false })) }),
		async execute(_id, params) {
			const agents = requireRegistry().list(params.includeClosed);
			return {
				content: [
					{
						type: "text",
						text: agents.length ? agents.map(formatLine).join("\n") : "No stateful subagents.",
					},
				],
				details: { agents: agents.map(summarizeAgent) },
			};
		},
	});

	pi.registerTool({
		name: "subagent_interrupt",
		label: "Interrupt Subagent",
		description: "Interrupt the current turn while retaining the subagent for follow-up work.",
		parameters: Type.Object({
			agentId: Type.String(),
			subtree: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_id, params) {
			if (params.subtree) {
				const agents = await requireRegistry().interruptTree(params.agentId);
				return {
					content: [{ type: "text", text: `Interrupted ${agents.length} active agent(s).` }],
					details: {
						agent: summarizeAgent(requireRegistry().get(params.agentId)!),
						agents: agents.map(summarizeAgent),
					},
				};
			}
			const agent = await requireRegistry().interrupt(params.agentId);
			return result(agent, `Interrupted ${agent.id}; it remains reusable.`);
		},
	});

	pi.registerTool({
		name: "subagent_close",
		label: "Close Subagent",
		description: "Close a stateful subagent and remove it from retained persistence.",
		parameters: Type.Object({
			agentId: Type.String(),
			subtree: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_id, params) {
			const existing = requireRegistry().get(params.agentId);
			if (existing?.state === "closed" && !params.subtree) {
				const pendingOwner = isolatedAgents.get(existing.id);
				if (pendingOwner) await workspaceManager.cleanup(pendingOwner);
				isolatedAgents.delete(existing.id);
				return result(existing, `Closed ${existing.id}.`);
			}
			if (params.subtree) {
				let agents: ManagedAgent[];
				try {
					agents = await requireRegistry().closeTree(params.agentId);
				} finally {
					await cleanupClosedWorkspaces(requireRegistry(), isolatedAgents, workspaceManager);
				}
				return {
					content: [{ type: "text", text: `Closed ${agents.length} agent(s).` }],
					details: {
						agent: summarizeAgent(requireRegistry().get(params.agentId)!),
						agents: agents.map(summarizeAgent),
					},
				};
			}
			let agent: ManagedAgent;
			try {
				agent = await requireRegistry().close(params.agentId);
			} finally {
				await cleanupClosedWorkspaces(requireRegistry(), isolatedAgents, workspaceManager);
			}
			return result(agent, `Closed ${agent.id}.`);
		},
	});

	pi.registerCommand("subagents:agents", {
		description: "Inspect or clear stateful subagents",
		getArgumentCompletions(prefix: string) {
			return ["list", "clear"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},
		async handler(args, ctx) {
			if (args.trim() === "clear") {
				try {
					await requireRegistry().closeAll();
				} finally {
					await workspaceManager.cleanupAll();
					isolatedAgents.clear();
				}
				seenMessageIds.clear();
				await persistence?.delete();
				ctx.ui.notify("Cleared stateful subagents.", "info");
				return;
			}
			const agents = requireRegistry().list(true);
			ctx.ui.notify(
				agents.length ? agents.map(formatLine).join("\n") : "No stateful subagents.",
				"info",
			);
		},
	});
}

export function assertNoSharedWriteConflict(
	registry: AgentRegistry,
	agentName: string,
	cwd: string,
	scope: AgentScope,
): void {
	const agents = discoverAgents(cwd, scope, readSubagentSettings()).agents;
	const requested = agents.find((agent) => agent.name === agentName);
	if (!isWriteCapable(requested?.tools)) return;
	for (const active of registry.list()) {
		if (
			!isSameCwd(active.cwd, cwd) ||
			(active.state !== "running" && active.state !== "starting")
		) {
			continue;
		}
		const activeConfig = agents.find((agent) => agent.name === active.agent);
		if (isWriteCapable(activeConfig?.tools)) {
			throw new Error(
				`Write-capable subagent ${active.id} is already active in shared workspace ${cwd}. ` +
					"For independent one-shot work, use subagent parallel mode. Otherwise wait or close the active agent; set allowConcurrentWrites only when overlapping writes are knowingly safe, or use workspaceMode worktree when repository isolation is needed.",
			);
		}
	}
}

export function assertFollowUpWriteAllowed(
	registry: AgentRegistry,
	agent: ManagedAgent,
	allowConcurrentWrites: boolean,
	isolatedWorkspace: boolean,
): void {
	if (allowConcurrentWrites || isolatedWorkspace) return;
	assertNoSharedWriteConflict(registry, agent.agent, agent.cwd, agent.agentScope ?? "user");
}

export function isWriteCapable(tools: string[] | undefined): boolean {
	if (!tools) return true;
	return tools.some((tool) => ["bash", "write", "edit"].includes(tool));
}

function decrementWaiter(waiters: Map<string, number>, agentId: string): void {
	const count = waiters.get(agentId);
	if (count === undefined || count <= 1) waiters.delete(agentId);
	else waiters.set(agentId, count - 1);
}

async function confirmProjectAgent(
	name: string,
	scope: AgentScope,
	confirm: boolean,
	ctx: ExtensionContext,
	cwd: string,
): Promise<void> {
	if (scope !== "project" && scope !== "both") return;
	const discovery = discoverAgents(cwd, scope, readSubagentSettings());
	const agent = discovery.agents.find((candidate) => candidate.name === name);
	if (agent?.source !== "project") return;
	if (!isSameCwd(cwd, ctx.cwd)) {
		throw new Error("Project-local subagent definitions cannot run with an overridden cwd");
	}
	if (!ctx.isProjectTrusted()) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
	if (confirm && ctx.hasUI) {
		const approved = await ctx.ui.confirm(
			"Run project-local agent?",
			`Agent: ${name}\nSource: ${agent.filePath}`,
		);
		if (!approved) throw new Error("Project-local subagent was not approved");
	}
}

function isSameCwd(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function normalizeContextMode(value: "none" | "all" | "summary" | number | undefined): ContextMode {
	if (value === undefined) return "none";
	if (value === "none" || value === "all" || value === "summary") return value;
	return Math.max(1, Math.floor(value));
}

export function resolveSpawnContextMode(
	value: "none" | "all" | "summary" | number | undefined,
	contextEntryIds: readonly string[] | undefined,
): ContextMode {
	if (value === undefined && contextEntryIds !== undefined) return "all";
	return normalizeContextMode(value);
}

function formatLine(agent: ManagedAgent): string {
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - agent.updatedAt) / 1000));
	const actions =
		agent.state === "running" || agent.state === "starting"
			? "wait, interrupt, close"
			: agent.state === "closed"
				? "inspect"
				: "send, close";
	const task = agent.currentTask ? ` — ${agent.currentTask.slice(0, 80)}` : "";
	const unread = agent.mailbox.filter((message) => !message.readAt).length;
	const indent = "  ".repeat(agent.depth);
	return `${indent}${agent.id} ${agent.agent} ${agent.state} ${elapsedSeconds}s unread:${unread} [${actions}]${task}`;
}

function formatFinal(agent: ManagedAgent): string {
	const last = agent.history.at(-1);
	return last?.output || agent.error || `${agent.id} is ${agent.state}.`;
}

function summarizeAgent(agent: ManagedAgent) {
	return {
		id: agent.id,
		agent: agent.agent,
		parentId: agent.parentId,
		rootId: agent.rootId,
		depth: agent.depth,
		children: [...agent.children],
		state: agent.state,
		createdAt: agent.createdAt,
		updatedAt: agent.updatedAt,
		cwd: agent.cwd,
		currentTask: agent.currentTask
			? truncateUtf8(agent.currentTask, MAX_TOOL_MESSAGE_BYTES).text
			: undefined,
		historyCount: agent.history.length,
		unreadMessages: agent.mailbox.filter((message) => !message.readAt).length,
		error: agent.error ? truncateUtf8(agent.error, MAX_TOOL_MESSAGE_BYTES).text : undefined,
		policy: agent.policy,
	};
}

function sendDetachedCompletion(pi: ExtensionAPI, completion: AgentTurnCompletion): void {
	const content = buildDetachedCompletionMessage(completion);
	pi.sendMessage(
		{
			customType: "pi-subagent-completion",
			content,
			display: true,
			details: {
				agentId: completion.agent.id,
				agent: completion.agent.agent,
				state: completion.agent.state,
			},
		},
		{ deliverAs: "steer", triggerTurn: false },
	);
}

export function buildDetachedCompletionMessage(completion: AgentTurnCompletion): string {
	const task = sanitizeCompletionLine(completion.task, 256) || "(unknown task)";
	const agentName = sanitizeCompletionLine(completion.agent.agent, 128) || "(unknown agent)";
	const output = redactPrivateText(completion.output);
	const error = completion.error
		? truncateUtf8(redactPrivateText(completion.error), MAX_COMPLETION_ERROR_BYTES).text
		: "";
	return truncateUtf8(
		[
			"Message Type: SUBAGENT_COMPLETION",
			`Agent ID: ${completion.agent.id}`,
			`Agent: ${agentName}`,
			`Task: ${task}`,
			`State: ${completion.agent.state}`,
			...(error.trim() ? ["Error:", error] : []),
			"Payload:",
			output.trim() ? output : "(no output)",
		].join("\n"),
		MAX_TOOL_MESSAGE_BYTES,
	).text;
}

function sanitizeCompletionLine(value: string, maxBytes: number): string {
	return truncateUtf8(redactPrivateText(value), maxBytes)
		.text.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

async function cleanupClosedWorkspaces(
	registry: AgentRegistry,
	isolatedAgents: Map<string, string>,
	workspaceManager: WorkspaceManager,
): Promise<void> {
	for (const [agentId, owner] of [...isolatedAgents]) {
		if (registry.get(agentId)?.state !== "closed") continue;
		await workspaceManager.cleanup(owner);
		isolatedAgents.delete(agentId);
	}
}

function result(agent: ManagedAgent, text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { agent: summarizeAgent(agent) },
	};
}

export function resolveStatefulTransportKind(
	value: "subprocess" | "in-process" | undefined,
): "subprocess" | "in-process" {
	return value ?? "subprocess";
}

function normalizeRuntimeThinkingLevel(value: string): ParentRuntimeSnapshot["thinkingLevel"] {
	return isThinkingLevel(value) ? value : "off";
}

export {
	buildStatefulTurnPrompt,
	resolveStatefulTurnTimeout,
} from "./stateful-prompt.js";
