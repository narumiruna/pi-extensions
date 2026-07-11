import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverAgents, type AgentScope } from "./agents.js";
import { buildContextSnapshot, type ContextMode } from "./context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { AgentPersistence } from "./persistence.js";
import { AgentRegistry, type ManagedAgent } from "./registry.js";
import { getResultFinalOutput, runSingleAgent, type SubagentDetails } from "./runner.js";
import { readSubagentSettings, resolveSubagentThinkingLevel } from "./settings.js";

const ContextModeSchema = Type.Union([
	StringEnum(["none", "all"] as const),
	Type.Number({ minimum: 1, description: "Include the most recent N user turns." }),
]);
const ScopeSchema = StringEnum(["user", "project", "both"] as const);

export function registerStatefulSubagents(pi: ExtensionAPI): void {
	const settings = readSubagentSettings()?.stateful;
	if (!settings?.enabled) return;

	let registry: AgentRegistry | undefined;
	let persistence: AgentPersistence | undefined;
	let sweepTimer: NodeJS.Timeout | undefined;

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
		registry = new AgentRegistry(createTurnRunner(ctx), {
			maxAgents: settings.maxAgents,
			maxActiveTurns: settings.maxActiveTurns,
			idleTtlMs: settings.idleTtlMs,
			onChange: async (agents) => {
				await persistence?.save(agents);
			},
		});
		const restored = persistence
			.load()
			.filter((agent) => agent.agentScope !== "project" && agent.agentScope !== "both" || ctx.isProjectTrusted());
		registry.restore(restored);
		const sweepEveryMs = Math.max(1_000, Math.min(settings.idleTtlMs ?? 60 * 60 * 1000, 60_000));
		sweepTimer = setInterval(() => void registry?.sweepExpired(), sweepEveryMs);
		sweepTimer.unref();
	});

	pi.on("session_shutdown", async () => {
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;
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
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const scope = (params.agentScope ?? "user") as AgentScope;
			await confirmProjectAgent(params.agent, scope, params.confirmProjectAgents ?? true, ctx);
			const mode = normalizeContextMode(params.context);
			const snapshot = buildContextSnapshot(ctx.sessionManager.getBranch(), mode, DEFAULT_MAX_CONTEXT_BYTES);
			const agent = await requireRegistry().spawn({
				agent: params.agent,
				task: params.task,
				cwd: params.cwd ?? ctx.cwd,
				agentScope: scope,
				context: snapshot.text || undefined,
				contextTruncated: snapshot.truncated,
			});
			return result(agent, `Spawned ${agent.agent} as ${agent.id}.`);
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Send Subagent Follow-up",
		description: "Send a follow-up task to an idle, completed, interrupted, or failed subagent.",
		parameters: Type.Object({ agentId: Type.String(), task: Type.String() }),
		async execute(_id, params) {
			const agent = await requireRegistry().followUp(params.agentId, params.task);
			return result(agent, `Started follow-up for ${agent.id}.`);
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
		parameters: Type.Object({ agentId: Type.String() }),
		async execute(_id, params) {
			const agent = await requireRegistry().interrupt(params.agentId);
			return result(agent, `Interrupted ${agent.id}; it remains reusable.`);
		},
	});

	pi.registerTool({
		name: "subagent_close",
		label: "Close Subagent",
		description: "Close a stateful subagent and remove it from retained persistence.",
		parameters: Type.Object({ agentId: Type.String() }),
		async execute(_id, params) {
			const agent = await requireRegistry().close(params.agentId);
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

function createTurnRunner(ctx: ExtensionContext) {
	return async (record: ManagedAgent, task: string, signal: AbortSignal) => {
		const settings = readSubagentSettings();
		const discovery = discoverAgents(record.cwd, record.agentScope ?? "user", settings);
		const agent = discovery.agents.find((candidate) => candidate.name === record.agent);
		const previous = record.history
			.map((turn) => `Task: ${turn.task}\nOutput: ${turn.output}`)
			.join("\n\n");
		const context = [
			`Current task:\n${task}`,
			previous ? `Prior subagent turns:\n${previous}` : "",
			record.context ? `Parent context:\n${record.context}` : "",
		]
			.filter(Boolean)
			.join("\n\n---\n\n");
		const boundedTask = truncateUtf8(context, DEFAULT_MAX_CONTEXT_BYTES);
		const makeDetails = (results: SubagentDetails["results"]): SubagentDetails => ({
			mode: "single",
			agentScope: record.agentScope ?? "user",
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		});
		const single = await runSingleAgent(
			record.cwd,
			discovery.agents,
			record.agent,
			boundedTask.text,
			undefined,
			undefined,
			signal,
			resolveSubagentThinkingLevel(discovery.agents, record.agent),
			agent?.timeoutMs ?? 10 * 60 * 1000,
			undefined,
			makeDetails,
		);
		return {
			output: getResultFinalOutput(single),
			exitCode: single.exitCode,
			aborted: single.aborted,
			truncated: single.truncated || boundedTask.truncated,
			error: single.errorMessage || single.stderr || undefined,
			policy: single.policy,
		};
	};
}

async function confirmProjectAgent(
	name: string,
	scope: AgentScope,
	confirm: boolean,
	ctx: ExtensionContext,
): Promise<void> {
	if (scope !== "project" && scope !== "both") return;
	const discovery = discoverAgents(ctx.cwd, scope, readSubagentSettings());
	const agent = discovery.agents.find((candidate) => candidate.name === name);
	if (agent?.source !== "project") return;
	if (!ctx.isProjectTrusted()) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
	if (confirm && ctx.hasUI) {
		const approved = await ctx.ui.confirm("Run project-local agent?", `Agent: ${name}\nSource: ${agent.filePath}`);
		if (!approved) throw new Error("Project-local subagent was not approved");
	}
}

function normalizeContextMode(value: "none" | "all" | number | undefined): ContextMode {
	if (value === undefined) return "none";
	if (value === "none" || value === "all") return value;
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
	return `${agent.id} ${agent.agent} ${agent.state} ${elapsedSeconds}s [${actions}]${task}`;
}

function formatFinal(agent: ManagedAgent): string {
	const last = agent.history.at(-1);
	return last?.output || agent.error || `${agent.id} is ${agent.state}.`;
}

function result(agent: ManagedAgent, text: string) {
	return { content: [{ type: "text" as const, text }], details: { agent } };
}
