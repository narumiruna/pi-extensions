/**
 * Stateful registration remains one lifecycle owner so session replacement, persistence,
 * capability revocation, workspace cleanup, and completion delivery cannot reorder.
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentScope,
	type CompletionDelivery,
	isThinkingLevel,
	type SubagentRuntimeSettings,
	type SubagentSettings,
	type SubagentTransportKind,
	THINKING_LEVELS,
} from "./agents/types.js";
import type { CompletionDeliveryBroker } from "./completion-delivery.js";
import {
	CompletionRequirementModeSchema,
	completionRequirementsFromBranch,
} from "./completion-requirement.js";
import type { ContextMode } from "./context.js";
import type { CreateStatefulTransportOptions } from "./create-stateful-transport.js";
import { DelegationContractSchema } from "./delegation-contract.js";
import type { ChildSessionFactory, ParentRuntimeSnapshot } from "./in-process-transport.js";
import {
	DEFAULT_MAX_CONTEXT_BYTES,
	MAX_SUBAGENT_TIMEOUT_MS,
	MAX_TOOL_MESSAGE_BYTES,
	truncateUtf8,
} from "./limits.js";
import type { AgentPersistence } from "./persistence.js";
import type {
	AgentRegistry,
	AgentRunInspectionDetail,
	AgentRunInspectionSummary,
	ManagedAgent,
} from "./registry.js";
import { SUBAGENT_RESULT_FORMATS, type SubagentResultFormat } from "./result-contract.js";
import { DEFAULT_DELEGATION_CWD_POLICY } from "./settings/inspection.js";
import { readSubagentSettings } from "./settings-reader.js";
import {
	assertSpawnIdempotencyKey,
	MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH,
} from "./spawn-idempotency.js";
import { summarizeStatefulAgent } from "./stateful-agent-view.js";
import { resolveCompletionDelivery, resolveStatefulTransportKind } from "./stateful-config.js";
import { createSpawnPromptGuidelines } from "./stateful-guidance.js";
import { assertCurrentSpawn, waitForOwnedSpawn } from "./stateful-lifecycle.js";
import { resolveStatefulLimits, type StatefulLimits } from "./stateful-limits.js";
import { createStatefulToolRenderer } from "./stateful-render.js";
import { confirmProjectAgent } from "./stateful-safety.js";
import {
	MailboxParamsSchema,
	ManageParamsSchema,
	validateMailboxParams,
	validateManageParams,
} from "./stateful-tool-params.js";
import { MAX_TASK_NAME_LENGTH } from "./task-path.js";
import { grammarSafeToolObject } from "./tool-schema-compatibility.js";
import { MAX_SUBAGENT_TOOL_CALLS, MAX_SUBAGENT_TURNS } from "./turn-budget.js";
import type { UsageRecordingController } from "./usage-recording.js";
import type { WorkspaceManager } from "./workspace.js";

type CwdPolicyModule = typeof import("./cwd-policy.js");
type StateLifecycleModule = typeof import("./stateful-lifecycle.js");

type StatefulSessionModules = {
	broker: typeof import("./completion-delivery.js");
	peerCommunication: typeof import("./peer-communication.js");
	context: typeof import("./context.js");
	transport: typeof import("./create-stateful-transport.js");
	cwdPolicy: CwdPolicyModule;
	persistence: typeof import("./persistence.js");
	registry: typeof import("./registry.js");
	lifecycle: StateLifecycleModule;
};

type StatefulSpawnModules = {
	agents: typeof import("./agents/discovery.js");
	capabilityGrant: typeof import("./capability-grant.js");
	context: typeof import("./context.js");
	cwdPolicy: CwdPolicyModule;
	delegationContract: typeof import("./delegation-contract.js");
	runtimePolicy: typeof import("./execution/runtime-policy.js");
	retainedSemanticState: typeof import("./retained-semantic-state.js");
	semanticSnapshot: typeof import("./semantic-snapshot.js");
	spawnIdempotency: typeof import("./spawn-idempotency.js");
};

let statefulSessionModules: Promise<StatefulSessionModules> | undefined;
let statefulSpawnModules: Promise<StatefulSpawnModules> | undefined;
let workspaceModule: Promise<typeof import("./workspace.js")> | undefined;

function loadStatefulSessionModules(): Promise<StatefulSessionModules> {
	statefulSessionModules ??= Promise.all([
		import("./completion-delivery.js"),
		import("./peer-communication.js"),
		import("./context.js"),
		import("./create-stateful-transport.js"),
		import("./cwd-policy.js"),
		import("./persistence.js"),
		import("./registry.js"),
		import("./stateful-lifecycle.js"),
	])
		.then(
			([
				broker,
				peerCommunication,
				context,
				transport,
				cwdPolicy,
				persistence,
				registry,
				lifecycle,
			]) => ({
				broker,
				peerCommunication,
				context,
				transport,
				cwdPolicy,
				persistence,
				registry,
				lifecycle,
			}),
		)
		.catch((error: unknown) => {
			statefulSessionModules = undefined;
			throw error;
		});
	return statefulSessionModules;
}

function loadStatefulSpawnModules(): Promise<StatefulSpawnModules> {
	statefulSpawnModules ??= Promise.all([
		import("./agents/discovery.js"),
		import("./capability-grant.js"),
		import("./context.js"),
		import("./cwd-policy.js"),
		import("./delegation-contract.js"),
		import("./execution/runtime-policy.js"),
		import("./retained-semantic-state.js"),
		import("./semantic-snapshot.js"),
		import("./spawn-idempotency.js"),
	])
		.then(
			([
				agents,
				capabilityGrant,
				context,
				cwdPolicy,
				delegationContract,
				runtimePolicy,
				retainedSemanticState,
				semanticSnapshot,
				spawnIdempotency,
			]) => ({
				agents,
				capabilityGrant,
				context,
				cwdPolicy,
				delegationContract,
				runtimePolicy,
				retainedSemanticState,
				semanticSnapshot,
				spawnIdempotency,
			}),
		)
		.catch((error: unknown) => {
			statefulSpawnModules = undefined;
			throw error;
		});
	return statefulSpawnModules;
}

async function loadWorkspaceModule(): Promise<typeof import("./workspace.js")> {
	workspaceModule ??= import("./workspace.js").catch((error: unknown) => {
		workspaceModule = undefined;
		throw error;
	});
	return workspaceModule;
}

const ContextModeSchema = Type.Union([
	StringEnum(["none", "all", "summary"] as const),
	Type.Number({ minimum: 1, description: "Include the most recent N user turns." }),
]);
const ScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Per-invocation custom agent scope for this spawn. Default: "user". Use "project" for project-local agents or "both" for user and project agents; the selected scope is retained for follow-ups.',
	default: "user",
});
const StatefulThinkingLevelSchema = StringEnum(THINKING_LEVELS, {
	description:
		"Optional requested Pi thinking level selected for this task difficulty; retained for every turn of the spawned agent.",
});
const StatefulTimeoutSchema = Type.Integer({
	minimum: 1,
	maximum: MAX_SUBAGENT_TIMEOUT_MS,
	description:
		"Work deadline in milliseconds selected for the task difficulty. On expiry, Pi aborts the work and makes one separately bounded summary attempt. Retained as the agent default.",
});
const DEFAULT_SUBAGENT_AWAIT_TIMEOUT_MS = 30_000;
const SubagentAwaitParams = Type.Object({
	agentId: Type.String({
		minLength: 1,
		description: "Retained agent ID or canonical task path.",
	}),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
			description:
				"Maximum time to wait in milliseconds. A wait timeout stops only this tool call and does not interrupt or close the subagent. Defaults to 30000.",
		}),
	),
});
const StatefulTurnLimitFields = {
	idleTimeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
			description:
				"Maximum milliseconds without a completed assistant turn or tool result; retained as the agent default.",
		}),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_SUBAGENT_TURNS,
			description:
				"Maximum unfinished assistant turns; retained as the agent default. Omit rather than guessing a tight bound.",
		}),
	),
	maxToolCalls: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_SUBAGENT_TOOL_CALLS,
			description:
				"Maximum tool calls; retained as the agent default. Omit rather than guessing a tight bound.",
		}),
	),
};
export interface StatefulSubagentDependencies {
	blockingEnabled?: boolean;
	createInProcessSession?: ChildSessionFactory;
	workspaceManager?: WorkspaceManager;
	settings?: SubagentRuntimeSettings;
	getSettings?: () => SubagentSettings | undefined;
	loadTransport?: CreateStatefulTransportOptions["loadTransport"];
	usageRecording?: UsageRecordingController;
}

export interface StatefulSubagentRuntimeStatus {
	enabled: boolean;
	initialized: boolean;
	transport: SubagentTransportKind;
	completionDelivery: CompletionDelivery;
	limits: StatefulLimits;
	activeAgents: number;
	retainedAgents: number;
}

export interface StatefulSubagentController {
	getCompletionDelivery(): CompletionDelivery;
	setCompletionDelivery(value: CompletionDelivery): void;
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	listAgents(includeClosed?: boolean): ManagedAgent[];
	listRunInspection(includeClosed?: boolean): AgentRunInspectionSummary[];
	getRunInspection(agentId: string): AgentRunInspectionDetail | undefined;
	clearAgents(): Promise<number>;
}

interface StatefulActionToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export function registerStatefulSubagents(
	pi: ExtensionAPI,
	dependencies: StatefulSubagentDependencies = {},
): StatefulSubagentController {
	const settings = Object.hasOwn(dependencies, "settings")
		? (dependencies.settings ?? {})
		: (readSubagentSettings()?.stateful ?? {});
	const blockingEnabled = dependencies.blockingEnabled !== false;
	const enabled = settings.enabled !== false;
	const transportKind = resolveStatefulTransportKind(settings.transport);
	let completionDelivery = resolveCompletionDelivery(settings.completionDelivery);
	let runtimeLimits = resolveStatefulLimits(settings);
	let completionBroker: CompletionDeliveryBroker | undefined;
	let peerBroker: import("./peer-communication.js").PeerCommunicationBroker | undefined;
	let registry: AgentRegistry | undefined;
	let persistence: AgentPersistence | undefined;
	let sweepTimer: NodeJS.Timeout | undefined;
	let runtimeGeneration = 0;
	let runtimeTransition: Promise<void> = Promise.resolve();
	let workspaceManager = dependencies.workspaceManager;
	const getWorkspaceManager = async () => {
		if (workspaceManager) return workspaceManager;
		const { WorkspaceManager } = await loadWorkspaceModule();
		workspaceManager = new WorkspaceManager();
		return workspaceManager;
	};
	const isolatedAgents = new Map<string, string>();
	const seenMessageIds = new Set<string>();
	type PendingIdempotentSpawn = {
		generation: number;
		requestHash: string;
		promise: Promise<ManagedAgent>;
	};
	const pendingIdempotentSpawns = new Map<string, PendingIdempotentSpawn>();
	const parentRuntime: ParentRuntimeSnapshot = { model: undefined, thinkingLevel: "off" };
	const getCurrentSettings = () =>
		dependencies.getSettings ? dependencies.getSettings() : readSubagentSettings();
	const getCurrentStatefulSettings = () =>
		dependencies.getSettings ? (dependencies.getSettings()?.stateful ?? {}) : settings;

	const clearAgents = async (): Promise<number> => {
		const generation = runtimeGeneration;
		const currentRegistry = registry;
		const currentPersistence = persistence;
		if (!currentRegistry) return 0;
		const currentWorkspaceManager = await getWorkspaceManager();
		const count = currentRegistry.list().length;
		const clear = async () => {
			await currentRegistry.closeAll();
			if (generation !== runtimeGeneration) return;
			await currentWorkspaceManager.cleanupAll();
			isolatedAgents.clear();
			seenMessageIds.clear();
			await currentPersistence?.delete();
		};
		const transition = runtimeTransition.then(clear, clear);
		runtimeTransition = transition.catch(() => undefined);
		await transition;
		return count;
	};
	const controller: StatefulSubagentController = {
		getCompletionDelivery() {
			return completionDelivery;
		},
		setCompletionDelivery(value) {
			completionDelivery = value;
			completionBroker?.setDelivery(value);
		},
		getRuntimeStatus() {
			const counts = registry?.inspectionCounts() ?? { activeAgents: 0, retainedAgents: 0 };
			return {
				enabled,
				initialized: registry !== undefined,
				transport: transportKind,
				completionDelivery,
				limits: { ...runtimeLimits },
				...counts,
			};
		},
		listAgents(includeClosed = false) {
			return registry?.list(includeClosed) ?? [];
		},
		listRunInspection(includeClosed = false) {
			return registry?.listInspection(includeClosed) ?? [];
		},
		getRunInspection(agentId) {
			return registry?.getInspection(agentId);
		},
		clearAgents,
	};
	if (!enabled) return controller;

	const requireRegistry = () => {
		if (!registry) throw new Error("Stateful subagents are not initialized for this session");
		return registry;
	};
	pi.on("session_start", async (event, ctx) => {
		const generation = ++runtimeGeneration;
		completionBroker?.close();
		completionBroker = undefined;
		const previousPeerBroker = peerBroker;
		peerBroker = undefined;
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;
		const previousRegistry = registry;
		registry = undefined;
		persistence = undefined;
		isolatedAgents.clear();
		seenMessageIds.clear();
		pendingIdempotentSpawns.clear();
		const initialize = async () => {
			await previousPeerBroker?.close();
			const currentWorkspaceManager = await getWorkspaceManager();
			const modules = await loadStatefulSessionModules();
			const cleanupErrors = await modules.lifecycle.disposeStatefulRuntime(
				previousRegistry,
				currentWorkspaceManager,
			);
			if (generation !== runtimeGeneration) return;
			if (cleanupErrors.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Previous subagent runtime cleanup reported ${cleanupErrors.length} error(s).`,
					"warning",
				);
			}
			parentRuntime.model = ctx.model;
			parentRuntime.thinkingLevel = normalizeRuntimeThinkingLevel(pi.getThinkingLevel());
			const sessionSettings = getCurrentStatefulSettings();
			const nextLimits = resolveStatefulLimits(sessionSettings);
			const owner =
				ctx.sessionManager.getSessionId?.() ??
				ctx.sessionManager.getSessionFile?.() ??
				`ephemeral:${ctx.cwd}`;
			const sessionPersistence = new modules.persistence.AgentPersistence(owner, {
				retentionDays: sessionSettings.retentionDays,
				maxStoredAgents: nextLimits.maxStoredAgents,
			});
			let nextRegistry: AgentRegistry;
			let transport: import("./transport.js").SubagentTransport;
			const sessionBroker = new modules.broker.CompletionDeliveryBroker(
				pi,
				ctx,
				completionDelivery,
				{
					onDeliveryError: (error) => {
						if (!ctx.hasUI) return;
						const reason = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Subagent completion delivery failed: ${reason}`, "warning");
					},
					onDeliveryAttempt: (completions, input) => {
						if (generation !== runtimeGeneration) return;
						for (const completion of completions) {
							dependencies.usageRecording?.recordCompletionDeliveryAttempt(completion, input);
						}
					},
					onAcknowledged: (completions, deliveredAt) => {
						if (generation !== runtimeGeneration) return;
						for (const completion of completions) {
							dependencies.usageRecording?.recordCompletionVisible(completion);
							void nextRegistry
								.markCompletionDelivered(completion.completionId, deliveredAt)
								.catch((error: unknown) => {
									if (!ctx.hasUI || generation !== runtimeGeneration) return;
									const reason = error instanceof Error ? error.message : String(error);
									ctx.ui.notify(`Subagent completion acknowledgement failed: ${reason}`, "warning");
								});
						}
					},
				},
			);
			const sessionPeerBroker = new modules.peerCommunication.PeerCommunicationBroker({
				getRegistry: () => nextRegistry,
				sendRoot: ({ message, senderPath }) => {
					pi.appendEntry("pi-subagent-peer-message", {
						messageId: message.id,
						senderId: message.senderId,
						senderPath,
						content: modules.context.redactPrivateText(message.content),
					});
					pi.sendMessage(
						{
							customType: "pi-subagent-peer-message",
							content: [
								"Message Type: SUBAGENT_PEER_MESSAGE",
								"Protocol: pi-subagents:v1",
								`Message ID: ${message.id}`,
								`Sender ID: ${message.senderId}`,
								`Sender Path: ${senderPath}`,
								"Payload:",
								message.content,
							].join("\n"),
							display: true,
							details: { ...message, senderPath },
						},
						{ deliverAs: "steer", triggerTurn: false },
					);
				},
				dispatch: (recipient, message) => transport.deliverMessage?.(recipient, message) ?? false,
			});
			transport = modules.transport.createStatefulTransport({
				kind: transportKind,
				modelRegistry: ctx.modelRegistry,
				getParentRuntime: () => ({ ...parentRuntime }),
				getSettings: getCurrentSettings,
				createInProcessSession: dependencies.createInProcessSession,
				peerRuntime: sessionPeerBroker,
				loadTransport: dependencies.loadTransport,
			});
			nextRegistry = new modules.registry.AgentRegistry(transport, {
				maxAgents: nextLimits.maxAgents,
				maxActiveTurns: nextLimits.maxActiveTurns,
				maxDepth: nextLimits.maxDepth,
				maxChildrenPerAgent: nextLimits.maxChildrenPerAgent,
				maxMailboxMessages: sessionSettings.maxMailboxMessages,
				maxMailboxMessageBytes: sessionSettings.maxMailboxMessageBytes,
				idleTtlMs: sessionSettings.idleTtlMs,
				onChange: async (agents) => {
					if (generation !== runtimeGeneration) return;
					await sessionPersistence.save(agents);
					if (generation !== runtimeGeneration) return;
					dependencies.usageRecording?.observeAgents(agents);
					for (const agent of agents) {
						for (const message of agent.mailbox) {
							if (seenMessageIds.has(message.id)) continue;
							seenMessageIds.add(message.id);
							pi.appendEntry("pi-subagent-message", {
								senderId: message.senderId,
								recipientId: message.recipientId,
								content: modules.context.redactPrivateText(message.content).slice(0, 160),
							});
							if (
								agent.state === "running" &&
								message.deduplicationKey?.startsWith("completion:")
							) {
								try {
									await transport.deliverMessage?.(agent, {
										...message,
										content: modules.context.redactPrivateText(message.content),
									});
								} catch {
									// The durable parent mailbox remains the retry path for the next turn.
								}
								if (generation !== runtimeGeneration) return;
							}
						}
					}
				},
				onTurnComplete: (completion) => {
					if (generation !== runtimeGeneration) return;
					dependencies.usageRecording?.recordChildCompletion(completion);
					if (completion.recipientId === "root") sessionBroker.enqueue(completion);
				},
			});
			const persisted = sessionPersistence.load();
			const orphanCleanupFailures = await modules.lifecycle.cleanupPersistedWorkspaces(
				persisted,
				currentWorkspaceManager,
			);
			if (generation !== runtimeGeneration) {
				sessionBroker.close();
				await sessionPeerBroker.close();
				await modules.lifecycle.disposeStatefulRuntime(nextRegistry, currentWorkspaceManager);
				return;
			}
			if (ctx.hasUI && orphanCleanupFailures > 0) {
				ctx.ui.notify("Some orphaned subagent worktrees could not be cleaned", "warning");
			}
			const restored = persisted
				.filter(
					(agent) =>
						agent.workspaceMode !== "worktree" &&
						((agent.agentScope !== "project" && agent.agentScope !== "both") ||
							ctx.isProjectTrusted()),
				)
				.flatMap((agent) => {
					try {
						const target = modules.cwdPolicy.resolveSubagentTarget({
							workspace: ctx.cwd,
							requestedCwd: agent.cwd,
							currentProjectTrusted: ctx.isProjectTrusted(),
						});
						return [
							{ ...agent, cwd: target.cwd, target: modules.cwdPolicy.targetPolicyAudit(target) },
						];
					} catch {
						return [];
					}
				});
			for (const agent of restored) {
				for (const message of agent.mailbox) seenMessageIds.add(message.id);
			}
			nextRegistry.restore(restored);
			const branchRequirements = completionRequirementsFromBranch(ctx.sessionManager.getBranch());
			const branchOwnsRequirementState =
				branchRequirements.observedState || event.reason === "fork" || event.reason === "new";
			nextRegistry.reconcileCompletionRequirements(
				branchRequirements.records,
				branchOwnsRequirementState,
			);
			if (branchOwnsRequirementState) {
				try {
					await sessionPersistence.save(nextRegistry.list(true));
				} catch (error) {
					if (generation === runtimeGeneration && ctx.hasUI) {
						const reason = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(
							`Subagent requirement reconciliation could not be persisted yet: ${reason}`,
							"warning",
						);
					}
				}
			}
			if (generation !== runtimeGeneration) {
				sessionBroker.close();
				await sessionPeerBroker.close();
				await modules.lifecycle.disposeStatefulRuntime(nextRegistry, currentWorkspaceManager);
				return;
			}
			registry = nextRegistry;
			persistence = sessionPersistence;
			completionBroker = sessionBroker;
			peerBroker = sessionPeerBroker;
			for (const completion of nextRegistry.listPendingCompletions()) {
				if (completion.recipientId === "root") sessionBroker.enqueue(completion);
			}
			runtimeLimits = nextLimits;
			const sweepEveryMs = Math.max(
				1_000,
				Math.min(sessionSettings.idleTtlMs ?? 60 * 60 * 1000, 60_000),
			);
			sweepTimer = setInterval(() => {
				void nextRegistry.sweepExpired().catch((error: unknown) => {
					if (!ctx.hasUI || generation !== runtimeGeneration) return;
					const reason = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Subagent expiry cleanup failed: ${reason}`, "warning");
				});
			}, sweepEveryMs);
			sweepTimer.unref();
		};
		const transition = runtimeTransition.then(initialize, initialize);
		runtimeTransition = transition.catch(() => undefined);
		await transition;
	});

	pi.on("agent_start", () => {
		completionBroker?.onParentTurnStart();
	});

	pi.on("context", (event) => {
		completionBroker?.onParentContext(event.messages);
	});

	pi.on("agent_settled", () => {
		completionBroker?.onParentSettled();
	});

	pi.on("model_select", (event) => {
		parentRuntime.model = event.model;
	});

	pi.on("thinking_level_select", (event) => {
		parentRuntime.thinkingLevel = normalizeRuntimeThinkingLevel(event.level);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtimeGeneration++;
		completionBroker?.close();
		completionBroker = undefined;
		const previousPeerBroker = peerBroker;
		peerBroker = undefined;
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;
		const previousRegistry = registry;
		registry = undefined;
		persistence = undefined;
		isolatedAgents.clear();
		seenMessageIds.clear();
		pendingIdempotentSpawns.clear();
		const shutdown = async () => {
			await previousPeerBroker?.close();
			const currentWorkspaceManager = await getWorkspaceManager();
			const { disposeStatefulRuntime } = await import("./stateful-lifecycle.js");
			const errors = await disposeStatefulRuntime(previousRegistry, currentWorkspaceManager);
			if (errors.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Subagent shutdown cleanup reported ${errors.length} error(s).`, "warning");
			}
		};
		const transition = runtimeTransition.then(shutdown, shutdown);
		runtimeTransition = transition.catch(() => undefined);
		await transition;
	});

	const spawnTool = defineTool({
		name: "subagent_spawn",
		label: "Spawn Subagent",
		description:
			"Start an addressable background subagent with an opaque agentId and canonical taskPath, an optional thinking level and execution budgets chosen for the task difficulty, and asynchronous completion delivery. The current bounded capacity, completion policy, working-directory policy, and available agent definitions are published in the pi-subagents session-guidance message. Working-directory policy controls launch targets and protected project resources, not filesystem access or sandboxing.",
		promptSnippet: "Start a reusable detached subagent; completion is delivered asynchronously",
		promptGuidelines: createSpawnPromptGuidelines(blockingEnabled),
		parameters: grammarSafeToolObject({
			agent: Type.String({ minLength: 1 }),
			taskName: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: MAX_TASK_NAME_LENGTH,
					pattern: "^[a-z0-9_]+$",
					description:
						"Canonical path segment for this task; use lowercase letters, digits, and underscores.",
				}),
			),
			task: Type.String({ minLength: 1, maxLength: DEFAULT_MAX_CONTEXT_BYTES }),
			thinkingLevel: Type.Optional(StatefulThinkingLevelSchema),
			timeoutMs: Type.Optional(StatefulTimeoutSchema),
			...StatefulTurnLimitFields,
			cwd: Type.Optional(Type.String()),
			agentScope: Type.Optional(ScopeSchema),
			confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
			context: Type.Optional(ContextModeSchema),
			contextEntryIds: Type.Optional(
				Type.Array(Type.String(), { description: "Optional selected session entry IDs." }),
			),
			parentId: Type.Optional(
				Type.String({ description: "Optional parent agent ID or canonical task path." }),
			),
			allowConcurrentWrites: Type.Optional(
				Type.Boolean({
					description:
						"Deprecated compatibility field; shared-workspace concurrency is allowed by default.",
				}),
			),
			workspaceMode: Type.Optional(
				StringEnum(["shared", "worktree"] as const, {
					description: "Use the shared workspace (default) or an opt-in disposable Git worktree.",
				}),
			),
			contract: Type.Optional(DelegationContractSchema),
			idempotencyKey: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH,
					description: "Reuse the same retained agent for an exact accepted spawn retry.",
				}),
			),
			resultFormat: Type.Optional(
				StringEnum(SUBAGENT_RESULT_FORMATS, {
					description:
						"Use text (default), structured-v1, or the evidence-preserving structured-v2 completion contract.",
				}),
			),
			completionRequirement: Type.Optional(CompletionRequirementModeSchema),
		}),
		...createStatefulToolRenderer("spawn"),
		async execute(_id, params, signal, _update, ctx) {
			const generation = runtimeGeneration;
			const capturedRegistry = registry;
			let modules: StatefulSpawnModules;
			try {
				modules = await loadStatefulSpawnModules();
			} catch (error) {
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				throw error;
			}
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			let currentWorkspaceManager: WorkspaceManager;
			try {
				currentWorkspaceManager = await getWorkspaceManager();
			} catch (error) {
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				throw error;
			}
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			const scope = (params.agentScope ?? "user") as AgentScope;
			const resultFormat = (params.resultFormat ?? "text") as SubagentResultFormat;
			const contract = modules.delegationContract.normalizeDelegationContract(params.contract);
			if (params.contract !== undefined && !contract) {
				throw new Error(
					"subagent_spawn contract must be a valid pi-subagents:delegation:v2 object",
				);
			}
			modules.runtimePolicy.assertSubagentDepthAllowed();
			assertSpawnIdempotencyKey(params.idempotencyKey);
			const currentSettings = getCurrentSettings();
			const target = modules.cwdPolicy.resolveSubagentTarget({
				workspace: ctx.cwd,
				requestedCwd: params.cwd,
				currentProjectTrusted: ctx.isProjectTrusted(),
			});
			modules.cwdPolicy.assertDelegationTargetAllowed(
				target,
				currentSettings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY,
			);
			const cwd = target.cwd;
			const mode = resolveSpawnContextMode(params.context, params.contextEntryIds);
			const snapshot = modules.context.buildContextSnapshot(
				ctx.sessionManager.getBranch(),
				mode,
				DEFAULT_MAX_CONTEXT_BYTES,
				params.contextEntryIds,
			);
			if ((scope === "project" || scope === "both") && !ctx.isProjectTrusted()) {
				throw new Error("Project-local subagent definitions require a trusted project");
			}
			const resolvedAgents = modules.agents.discoverAgents(cwd, scope, currentSettings).agents;
			const resolvedAgent = resolvedAgents.find((agent) => agent.name === params.agent);
			if (!resolvedAgent) {
				const available = resolvedAgents.map((agent) => agent.name).join(", ") || "none";
				throw new Error(`Unknown subagent ${params.agent}. Available agents: ${available}`);
			}
			const targetSnapshot = modules.cwdPolicy.targetPolicyAudit(target);
			const { executionPlan, semanticSnapshot } =
				await modules.retainedSemanticState.buildRetainedSemanticState({
					agent: resolvedAgent,
					contract,
					target: targetSnapshot,
					cwd,
					workspaceMode: params.workspaceMode === "worktree" ? "worktree" : "shared",
					transport: transportKind,
					resultFormat,
					thinkingLevel: params.thinkingLevel,
					timeoutMs: params.timeoutMs,
					taskGeneration: 1,
				});
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			const requestHash = modules.spawnIdempotency.hashSpawnRequest({
				agent: params.agent,
				taskName: params.taskName,
				task: params.task,
				cwd,
				agentScope: scope,
				thinkingLevel: params.thinkingLevel,
				timeoutMs: params.timeoutMs,
				idleTimeoutMs: params.idleTimeoutMs,
				maxTurns: params.maxTurns,
				maxToolCalls: params.maxToolCalls,
				parentId: params.parentId,
				context: snapshot.text || undefined,
				contextSourceIds: snapshot.sourceIds,
				workspaceMode: params.workspaceMode ?? "shared",
				allowConcurrentWrites: params.allowConcurrentWrites ?? false,
				contract,
				resultFormat,
				completionRequirement: params.completionRequirement ?? "background",
			});
			if (!capturedRegistry) {
				throw new Error("Stateful subagents are not initialized for this session");
			}
			const ownedRegistry = capturedRegistry;
			const retained = ownedRegistry.findBySpawnIdempotencyKey(params.idempotencyKey, requestHash);
			if (retained) return result(retained, `Reused ${retained.agent} as ${retained.id}.`);
			const foundPending = params.idempotencyKey
				? pendingIdempotentSpawns.get(params.idempotencyKey)
				: undefined;
			if (
				params.idempotencyKey &&
				foundPending &&
				foundPending.generation !== generation &&
				pendingIdempotentSpawns.get(params.idempotencyKey) === foundPending
			) {
				pendingIdempotentSpawns.delete(params.idempotencyKey);
			}
			const pending = foundPending?.generation === generation ? foundPending : undefined;
			if (pending) {
				if (pending.requestHash !== requestHash) {
					throw new Error("The subagent_spawn idempotencyKey is pending with different parameters");
				}
				const agent = await waitForOwnedSpawn(pending.promise, signal);
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				return result(agent, `Reused ${agent.agent} as ${agent.id}.`);
			}
			let resolvePending: ((agent: ManagedAgent) => void) | undefined;
			let rejectPending: ((error: unknown) => void) | undefined;
			let ownedPending: PendingIdempotentSpawn | undefined;
			if (params.idempotencyKey) {
				const promise = new Promise<ManagedAgent>((resolve, reject) => {
					resolvePending = resolve;
					rejectPending = reject;
				});
				void promise.catch(() => undefined);
				ownedPending = { generation, requestHash, promise };
				pendingIdempotentSpawns.set(params.idempotencyKey, ownedPending);
			}
			try {
				await confirmProjectAgent(
					params.agent,
					scope,
					params.confirmProjectAgents ?? true,
					ctx,
					cwd,
					currentSettings,
				);
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				if (params.workspaceMode === "worktree" && resolvedAgent.source === "project") {
					throw new Error("Project-local subagent definitions cannot run in a detached worktree");
				}
				const requestedCwd = cwd;
				const workspaceOwner = `pending-${randomUUID()}`;
				const workspace =
					params.workspaceMode === "worktree"
						? await currentWorkspaceManager.create(workspaceOwner, requestedCwd)
						: undefined;
				try {
					assertCurrentSpawn(signal, generation, runtimeGeneration);
				} catch (error) {
					if (workspace) await currentWorkspaceManager.cleanup(workspaceOwner);
					throw error;
				}
				let agent: ManagedAgent | undefined;
				try {
					const capabilityGrant = modules.capabilityGrant.issueCapabilityGrant(
						executionPlan,
						Date.now(),
						Math.max(1, (params.timeoutMs ?? resolvedAgent.timeoutMs ?? 600_000) + 60_000),
					);
					agent = await ownedRegistry.spawn({
						agent: params.agent,
						taskName: params.taskName,
						task: params.task,
						cwd: workspace?.path ?? requestedCwd,
						agentScope: scope,
						thinkingLevel: params.thinkingLevel,
						timeoutMs: params.timeoutMs,
						idleTimeoutMs: params.idleTimeoutMs,
						maxTurns: params.maxTurns,
						maxToolCalls: params.maxToolCalls,
						parentId: params.parentId,
						context: snapshot.text || undefined,
						contextSourceIds: snapshot.sourceIds,
						contextTruncated: snapshot.truncated,
						contextTurns: snapshot.turns,
						contextBytes: Buffer.byteLength(snapshot.text, "utf8"),
						workspaceMode: workspace ? "worktree" : undefined,
						spawnIdempotencyKey: params.idempotencyKey,
						spawnRequestHash: params.idempotencyKey ? requestHash : undefined,
						contract,
						resultFormat: resultFormat === "text" ? undefined : resultFormat,
						completionRequirement: params.completionRequirement ?? "background",
						executionPlan,
						capabilityGrant,
						semanticSnapshot,
						semanticCompatibility: { status: "compatible", changedComponents: [] },
						target: targetSnapshot,
					});
					assertCurrentSpawn(signal, generation, runtimeGeneration);
				} catch (error) {
					if (agent) await ownedRegistry.closeTree(agent.id).catch(() => undefined);
					if (workspace) await currentWorkspaceManager.cleanup(workspaceOwner);
					throw error;
				}
				if (!agent) throw new Error("Subagent spawn completed without a retained agent");
				if (workspace && agent.cwd === workspace.path) isolatedAgents.set(agent.id, workspaceOwner);
				else if (workspace) await currentWorkspaceManager.cleanup(workspaceOwner);
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				resolvePending?.(agent);
				const deliveryNote =
					completionDelivery === "auto-resume"
						? "Auto-resume steers completions into active parent work or requests synthesis when idle. Treat this response as progress, not final synthesis, until every final-answer-required completion message is visible. If local work is exhausted while required children remain active, emit at most one brief progress sentence and end the turn; do not repeat waiting updates or use the requested final format, verdict, or conclusion. Do not redo a running child's assigned work."
						: "The current response must not depend on the result because next-turn delivery will not wake an idle root.";
				const requirementNote =
					params.completionRequirement === "required"
						? "This exact run is runtime-tracked as required until its completion becomes visible or reaches an explicit terminal state. Current Pi versions still cannot prevent already-streamed premature output."
						: "This run is background work and does not block the parent final answer.";
				return result(
					agent,
					`Spawned ${agent.agent} as ${agent.taskPath ?? agent.id} (${agent.id}). ${requirementNote} Continue the identified non-overlapping local work immediately; do not merely announce the spawn or end while useful local work remains. Only an explicit user-requested specialist model, tool-profile, or isolation exception may lack concurrent local work. ${deliveryNote} Do not poll for progress.`,
				);
			} catch (error) {
				rejectPending?.(error);
				throw error;
			} finally {
				if (
					params.idempotencyKey &&
					ownedPending &&
					pendingIdempotentSpawns.get(params.idempotencyKey) === ownedPending
				) {
					pendingIdempotentSpawns.delete(params.idempotencyKey);
				}
			}
		},
	});
	pi.registerTool(spawnTool);

	pi.registerTool({
		name: "subagent_send",
		label: "Send Subagent Follow-up",
		description:
			"Send follow-up work to a reusable retained subagent and start a new turn. Semantic resource skew requires explicit revalidation. Use subagent_mailbox for queue-only messages.",
		promptSnippet: "Start a new detached follow-up turn on a retained subagent",
		parameters: Type.Object({
			agentId: Type.String({ description: "Retained agent ID or canonical task path." }),
			task: Type.String({ minLength: 1, maxLength: DEFAULT_MAX_CONTEXT_BYTES }),
			timeoutMs: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_SUBAGENT_TIMEOUT_MS,
					description:
						"Optional work deadline for this follow-up turn. On expiry, Pi aborts the work and makes one separately bounded summary attempt.",
				}),
			),
			...StatefulTurnLimitFields,
			completionRequirement: Type.Optional(CompletionRequirementModeSchema),
			revalidate: Type.Optional(
				Type.Boolean({
					description:
						"Accept the current semantic resource snapshot after a reported mismatch before starting this follow-up.",
				}),
			),
			allowConcurrentWrites: Type.Optional(
				Type.Boolean({
					description:
						"Deprecated compatibility field; shared-workspace concurrency is allowed by default.",
				}),
			),
		}),
		...createStatefulToolRenderer("send"),
		async execute(_id, params, signal, _update, ctx) {
			const generation = runtimeGeneration;
			const ownedRegistry = requireRegistry();
			let modules: StatefulSpawnModules;
			try {
				modules = await loadStatefulSpawnModules();
			} catch (error) {
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				throw error;
			}
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			const currentSettings = getCurrentSettings();
			const existing = ownedRegistry.get(params.agentId);
			if (!existing) throw new Error(`Unknown subagent: ${params.agentId}`);
			const currentAgent = modules.agents
				.discoverAgents(existing.cwd, existing.agentScope ?? "user", currentSettings)
				.agents.find((agent) => agent.name === existing.agent);
			if (!currentAgent) throw new Error(`Unknown retained subagent definition: ${existing.agent}`);
			const resolvedFollowUpTarget =
				existing.workspaceMode === "worktree"
					? undefined
					: modules.cwdPolicy.resolveSubagentTarget({
							workspace: ctx.cwd,
							requestedCwd: existing.cwd,
							currentProjectTrusted: ctx.isProjectTrusted(),
						});
			if (resolvedFollowUpTarget) {
				modules.cwdPolicy.assertDelegationTargetAllowed(
					resolvedFollowUpTarget,
					currentSettings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY,
				);
			}
			if (existing.workspaceMode === "worktree" && !existing.target) {
				throw new Error("Retained worktree is missing its trusted target snapshot");
			}
			const currentTarget =
				existing.workspaceMode === "worktree" && existing.target
					? existing.target
					: modules.cwdPolicy.targetPolicyAudit(
							resolvedFollowUpTarget as NonNullable<typeof resolvedFollowUpTarget>,
						);
			const { executionPlan: currentPlan, semanticSnapshot: currentSnapshot } =
				await modules.retainedSemanticState.buildRetainedSemanticState({
					agent: currentAgent,
					contract: existing.contract,
					target: currentTarget,
					cwd: existing.cwd,
					workspaceMode: existing.workspaceMode === "worktree" ? "worktree" : "shared",
					transport: transportKind,
					resultFormat: existing.resultFormat ?? "text",
					thinkingLevel: existing.thinkingLevel,
					timeoutMs: params.timeoutMs ?? existing.timeoutMs,
					taskGeneration: (existing.executionPlan?.taskGeneration ?? 0) + 1,
					cancellationLineage: [
						...(existing.executionPlan?.cancellationLineage ?? []),
						...(existing.state === "interrupted" && existing.executionPlan?.id
							? [existing.executionPlan.id]
							: []),
					],
				});
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			const compatibility = existing.semanticSnapshot
				? modules.semanticSnapshot.evaluateSemanticCompatibility(
						existing.semanticSnapshot,
						currentSnapshot,
					)
				: { status: "warning" as const, changedComponents: ["legacy-missing-snapshot"] };
			if (
				(compatibility.status === "needs-revalidation" || compatibility.status === "rejected") &&
				params.revalidate !== true
			) {
				throw new Error(
					`Subagent semantic resources changed; retry with revalidate: true after reviewing: ${compatibility.changedComponents.join(", ")}`,
				);
			}
			await confirmProjectAgent(
				existing.agent,
				existing.agentScope ?? "user",
				false,
				ctx,
				existing.cwd,
				currentSettings,
			);
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			const currentGrant = modules.capabilityGrant.issueCapabilityGrant(
				currentPlan,
				Date.now(),
				Math.max(1, (params.timeoutMs ?? existing.timeoutMs ?? 600_000) + 60_000),
			);
			await ownedRegistry.updateSemanticState(
				existing.id,
				currentPlan,
				currentGrant,
				currentSnapshot,
				params.revalidate === true && compatibility.status !== "compatible"
					? { status: "warning", changedComponents: compatibility.changedComponents }
					: compatibility,
			);
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			const agent = await ownedRegistry.followUp(params.agentId, params.task, {
				timeoutMs: params.timeoutMs,
				idleTimeoutMs: params.idleTimeoutMs,
				maxTurns: params.maxTurns,
				maxToolCalls: params.maxToolCalls,
				completionRequirement: params.completionRequirement ?? "background",
			});
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			return result(agent, `Started follow-up for ${agent.id}.`);
		},
	});

	if (blockingEnabled) {
		pi.registerTool({
			name: "subagent_await",
			label: "Await Subagent",
			description:
				"Wait for one retained subagent's current turn to settle and return its latest bounded output. This blocks Pi from processing queued steering until the wait finishes. A wait timeout or caller cancellation stops only the wait and never interrupts or closes the subagent; use subagent_manage for lifecycle changes. Automatic completion delivery remains active and may later repeat the same at-least-once completion.",
			promptSnippet:
				"Intentionally block until one retained subagent settles or the wait times out",
			promptGuidelines: [
				"Use subagent_await only when the retained result is required before the next action, useful overlapping main-agent work is complete, and blocking Pi is intentional.",
				"Do not repeatedly call subagent_await after a timeout; the subagent keeps running and completion delivery remains active. Use subagent_manage only when the user wants to interrupt or close it.",
			],
			parameters: SubagentAwaitParams,
			...createStatefulToolRenderer("await"),
			async execute(_id, params, signal): Promise<StatefulActionToolResult> {
				const generation = runtimeGeneration;
				const timeoutMs = params.timeoutMs ?? DEFAULT_SUBAGENT_AWAIT_TIMEOUT_MS;
				const waited = await requireRegistry().wait(params.agentId, timeoutMs, signal);
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				return awaitResult(waited.agent, waited.timedOut, timeoutMs);
			},
		});
	}

	pi.registerTool({
		name: "subagent_manage",
		label: "Manage Subagents",
		description:
			"Interrupt active work while keeping an agent reusable, or close agents and release their resources. Use subagent_inspect for every read-only list, detail, status, and diagnostic operation.",
		promptSnippet: "Interrupt or close retained detached subagents",
		parameters: ManageParamsSchema,
		...createStatefulToolRenderer("manage"),
		async execute(_id, params, signal): Promise<StatefulActionToolResult> {
			const generation = runtimeGeneration;
			const ownedRegistry = requireRegistry();
			let currentWorkspaceManager: WorkspaceManager;
			try {
				currentWorkspaceManager = await getWorkspaceManager();
			} catch (error) {
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				throw error;
			}
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			const ownedAgent = (agentId: string): ManagedAgent => {
				const value = ownedRegistry.get(agentId);
				if (!value) throw new Error(`Unknown subagent: ${agentId}`);
				return value;
			};
			const operation = validateManageParams(params);
			const agentId = operation.agentId;
			if (operation.action === "interrupt") {
				if (operation.subtree) {
					const agents = await ownedRegistry.interruptTree(agentId);
					assertCurrentSpawn(signal, generation, runtimeGeneration);
					return {
						content: [{ type: "text", text: `Interrupted ${agents.length} active agent(s).` }],
						details: {
							agent: summarizeStatefulAgent(ownedAgent(agentId)),
							agents: agents.map(summarizeStatefulAgent),
						},
					};
				}
				const agent = await ownedRegistry.interrupt(agentId);
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				return result(agent, `Interrupted ${agent.id}; it remains reusable.`);
			}
			const existing = ownedRegistry.get(agentId);
			if (existing?.state === "closed" && !operation.subtree) {
				const pendingOwner = isolatedAgents.get(existing.id);
				if (pendingOwner) await currentWorkspaceManager.cleanup(pendingOwner);
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				isolatedAgents.delete(existing.id);
				return result(existing, `Closed ${existing.id}.`);
			}
			if (operation.subtree) {
				let agents: ManagedAgent[];
				try {
					agents = await ownedRegistry.closeTree(agentId);
				} finally {
					await cleanupClosedWorkspaces(ownedRegistry, isolatedAgents, currentWorkspaceManager);
				}
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				return {
					content: [{ type: "text", text: `Closed ${agents.length} agent(s).` }],
					details: {
						agent: summarizeStatefulAgent(ownedAgent(agentId)),
						agents: agents.map(summarizeStatefulAgent),
					},
				};
			}
			let agent: ManagedAgent;
			try {
				agent = await ownedRegistry.close(agentId);
			} finally {
				await cleanupClosedWorkspaces(ownedRegistry, isolatedAgents, currentWorkspaceManager);
			}
			assertCurrentSpawn(signal, generation, runtimeGeneration);
			return result(agent, `Closed ${agent.id}.`);
		},
	});

	pi.registerTool({
		name: "subagent_mailbox",
		label: "Subagent Mailbox",
		description:
			"Queue a bounded message without starting a turn, or read unread mailbox messages. Read acknowledges returned messages by default; use subagent_inspect for metadata-only unread counts.",
		promptSnippet: "Send or read queue-only detached-subagent mailbox messages",
		parameters: MailboxParamsSchema,
		...createStatefulToolRenderer("mailbox"),
		async execute(_id, params, signal): Promise<StatefulActionToolResult> {
			const generation = runtimeGeneration;
			const ownedRegistry = requireRegistry();
			const operation = validateMailboxParams(params);
			if (operation.action === "send") {
				const message = await ownedRegistry.sendMessage(
					operation.agentId,
					operation.message,
					operation.senderId,
					operation.deduplicationKey,
				);
				assertCurrentSpawn(signal, generation, runtimeGeneration);
				return {
					content: [{ type: "text", text: `Queued ${message.id} for ${message.recipientId}.` }],
					details: { message },
				};
			}
			const messages = await ownedRegistry.readMessages(
				operation.agentId,
				operation.acknowledge,
				operation.limit,
			);
			assertCurrentSpawn(signal, generation, runtimeGeneration);
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

	return controller;
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
		details: { agent: summarizeStatefulAgent(agent) },
	};
}

function awaitResult(agent: ManagedAgent, timedOut: boolean, timeoutMs: number) {
	const latestTurn = agent.history.at(-1);
	const output = timedOut
		? ""
		: truncateUtf8(latestTurn?.output ?? "", DEFAULT_MAX_CONTEXT_BYTES).text;
	const error = timedOut ? "" : truncateUtf8(agent.error ?? "", MAX_TOOL_MESSAGE_BYTES).text;
	const text = timedOut
		? `Stopped waiting for ${agent.taskPath ?? agent.id} after ${timeoutMs}ms; it remains ${agent.state}. The wait did not interrupt or close the subagent.`
		: [`Subagent ${agent.taskPath ?? agent.id} settled as ${agent.state}.`, output || error]
				.filter(Boolean)
				.join("\n\n");
	return {
		content: [
			{
				type: "text" as const,
				text: truncateUtf8(text, DEFAULT_MAX_CONTEXT_BYTES).text,
			},
		],
		details: {
			agent: summarizeStatefulAgent(agent),
			timedOut,
			timeoutMs,
			...(output ? { output } : {}),
			...(error ? { error } : {}),
		},
	};
}

function normalizeRuntimeThinkingLevel(value: string): ParentRuntimeSnapshot["thinkingLevel"] {
	return isThinkingLevel(value) ? value : "off";
}
