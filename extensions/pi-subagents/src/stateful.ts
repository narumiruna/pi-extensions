import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverAgents, type AgentScope } from "./agents.js";
import { buildContextSnapshot, type ContextMode } from "./context.js";
import { assertSubagentDepthAllowed } from "./execution.js";
import { DEFAULT_MAX_CONTEXT_BYTES } from "./limits.js";
import { AgentPersistence } from "./persistence.js";
import { AgentRegistry, type ManagedAgent } from "./registry.js";
import { readSubagentSettings } from "./settings.js";
import { SubprocessTransport } from "./subprocess-transport.js";
import { WorkspaceManager } from "./workspace.js";

const ContextModeSchema = Type.Union([
	StringEnum(["none", "all", "summary"] as const),
	Type.Number({ minimum: 1, description: "Include the most recent N user turns." }),
]);
const ScopeSchema = StringEnum(["user", "project", "both"] as const);

export function registerStatefulSubagents(pi: ExtensionAPI): void {
	const settings = readSubagentSettings()?.stateful;
	if (!settings?.enabled) return;

	let registry: AgentRegistry | undefined;
	let persistence: AgentPersistence | undefined;
	let sweepTimer: NodeJS.Timeout | undefined;
	const workspaceManager = new WorkspaceManager();
	const isolatedAgents = new Map<string, string>();
	const seenMessageIds = new Set<string>();

	const requireRegistry = () => {
		if (!registry) throw new Error("Stateful subagents are not initialized for this session");
		return registry;
	};

	pi.on("session_start", async (_event, ctx) => {
		const owner = ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.() ?? `ephemeral:${ctx.cwd}`;
		persistence = new AgentPersistence(owner, {
			retentionDays: settings.retentionDays,
			maxStoredAgents: settings.maxStoredAgents,
		});
		registry = new AgentRegistry(new SubprocessTransport(ctx), {
			maxAgents: settings.maxAgents,
			maxActiveTurns: settings.maxActiveTurns,
			maxDepth: settings.maxDepth,
			maxChildrenPerAgent: settings.maxChildrenPerAgent,
			maxMailboxMessages: settings.maxMailboxMessages,
			idleTtlMs: settings.idleTtlMs,
			onChange: async (agents) => {
				await persistence?.save(agents);
				for (const agent of agents) {
					for (const message of agent.mailbox) {
						if (seenMessageIds.has(message.id)) continue;
						seenMessageIds.add(message.id);
						pi.appendEntry("pi-subagent-message", {
							senderId: message.senderId,
							recipientId: message.recipientId,
							content: message.content.slice(0, 160),
						});
					}
				}
			},
		});
		const restored = persistence
			.load()
			.filter(
				(agent) =>
					(agent.agentScope !== "project" && agent.agentScope !== "both") ||
					ctx.isProjectTrusted(),
			);
		for (const agent of restored) {
			for (const message of agent.mailbox) seenMessageIds.add(message.id);
		}
		registry.restore(restored);
		const sweepEveryMs = Math.max(1_000, Math.min(settings.idleTtlMs ?? 60 * 60 * 1000, 60_000));
		sweepTimer = setInterval(() => void registry?.sweepExpired(), sweepEveryMs);
		sweepTimer.unref();
	});

	pi.on("session_shutdown", async () => {
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;
		for (const agentId of isolatedAgents.keys()) {
			await registry?.closeTree(agentId).catch(() => undefined);
		}
		isolatedAgents.clear();
		seenMessageIds.clear();
		await workspaceManager.cleanupAll();
		await registry?.shutdown();
		registry = undefined;
		persistence = undefined;
	});

	pi.registerTool({
		name: "subagent_spawn",
		label: "Spawn Subagent",
		description: "Start an addressable logical subagent. Returns immediately with an agentId.",
		promptSnippet: "Start a reusable subagent and receive an agentId for lifecycle operations",
		parameters: Type.Object({
			agent: Type.String(),
			task: Type.String(),
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
			await confirmProjectAgent(
				params.agent,
				scope,
				params.confirmProjectAgents ?? true,
				ctx,
				cwd,
			);
			const resolvedAgent = discoverAgents(cwd, scope, readSubagentSettings()).agents.find(
				(agent) => agent.name === params.agent,
			);
			if (params.workspaceMode === "worktree" && resolvedAgent?.source === "project") {
				throw new Error("Project-local subagent definitions cannot run in a detached worktree");
			}
			const mode = normalizeContextMode(params.context);
			const snapshot = buildContextSnapshot(
				ctx.sessionManager.getBranch(),
				mode,
				DEFAULT_MAX_CONTEXT_BYTES,
				params.contextEntryIds,
			);
			const requestedCwd = cwd;
			if ((params.workspaceMode ?? "shared") === "shared" && !params.allowConcurrentWrites) {
				assertNoSharedWriteConflict(
					requireRegistry(),
					params.agent,
					requestedCwd,
					scope,
				);
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
			return result(agent, `Spawned ${agent.agent} as ${agent.id}.`);
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Send Subagent Follow-up",
		description: "Send a follow-up task to an idle, completed, interrupted, or failed subagent.",
		parameters: Type.Object({ agentId: Type.String(), task: Type.String() }),
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
			message: Type.String(),
			senderId: Type.Optional(Type.String()),
			deduplicationKey: Type.Optional(Type.String()),
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
		}),
		async execute(_id, params) {
			const messages = await requireRegistry().readMessages(
				params.agentId,
				params.acknowledge,
			);
			return {
				content: [
					{
						type: "text",
						text: messages.length
							? messages
									.map(
										(message) =>
											`${message.id} from ${message.senderId}: ${message.content}`,
									)
									.join("\n")
							: "No unread messages.",
					},
				],
				details: { messages },
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for Subagent",
		description: "Wait for a stateful subagent turn without terminating it when the wait times out.",
		parameters: Type.Object({
			agentId: Type.String(),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 3_600_000, default: 30_000 })),
		}),
		async execute(_id, params) {
			const waited = await requireRegistry().wait(params.agentId, params.timeoutMs);
			return result(
				waited.agent,
				waited.timedOut
					? `Wait timed out; ${waited.agent.id} is ${waited.agent.state}.`
					: formatFinal(waited.agent),
			);
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
						text: agents.length
							? agents.map(formatLine).join("\n")
							: "No stateful subagents.",
					},
				],
				details: { agents },
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
					details: { agent: requireRegistry().get(params.agentId)!, agents },
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
			if (params.subtree) {
				const agents = await requireRegistry().closeTree(params.agentId);
				for (const closed of agents) {
					const owner = isolatedAgents.get(closed.id);
					if (owner) await workspaceManager.cleanup(owner);
					isolatedAgents.delete(closed.id);
				}
				return {
					content: [{ type: "text", text: `Closed ${agents.length} agent(s).` }],
					details: { agent: requireRegistry().get(params.agentId)!, agents },
				};
			}
			const agent = await requireRegistry().close(params.agentId);
			const owner = isolatedAgents.get(agent.id);
			if (owner) await workspaceManager.cleanup(owner);
			isolatedAgents.delete(agent.id);
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
				await requireRegistry().closeAll();
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
		if (active.cwd !== cwd || (active.state !== "running" && active.state !== "starting")) continue;
		const activeConfig = agents.find((agent) => agent.name === active.agent);
		if (isWriteCapable(activeConfig?.tools)) {
			throw new Error(
				`Write-capable subagent ${active.id} is already active in shared workspace ${cwd}`,
			);
		}
	}
}

export function isWriteCapable(tools: string[] | undefined): boolean {
	if (!tools) return true;
	return tools.some((tool) => ["bash", "write", "edit"].includes(tool));
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
		const approved = await ctx.ui.confirm("Run project-local agent?", `Agent: ${name}\nSource: ${agent.filePath}`);
		if (!approved) throw new Error("Project-local subagent was not approved");
	}
}

function isSameCwd(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function normalizeContextMode(
	value: "none" | "all" | "summary" | number | undefined,
): ContextMode {
	if (value === undefined) return "none";
	if (value === "none" || value === "all" || value === "summary") return value;
	return Math.max(1, Math.floor(value));
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

function result(agent: ManagedAgent, text: string) {
	return { content: [{ type: "text" as const, text }], details: { agent } };
}

export {
	buildStatefulTurnPrompt,
	resolveStatefulTurnTimeout,
} from "./stateful-prompt.js";
