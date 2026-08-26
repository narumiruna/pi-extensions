/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports blocking single, parallel, chain, workflow, and panel modes.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { discoverAgentCatalog, formatAgentCatalog } from "./agents/catalog.js";
import type {
	ConsultationCwdPolicy,
	ConsultResourcePolicy,
	DelegationCwdPolicy,
	SubagentSettings,
} from "./agents/types.js";
import { cachedModuleLoader, throwIfAborted } from "./cached-module-loader.js";
import { renderCompletionMessage, SUBAGENT_COMPLETION_MESSAGE_TYPE } from "./completion-render.js";
import {
	type ConfigRegistrationDependencies,
	registerSubagentConfigCommand,
	registerSubagentConfigLifecycle,
} from "./config-registration.js";
import {
	type ConsultRegistrationDependencies,
	registerSubagentConsult,
} from "./consult-registration.js";
import {
	type InspectRegistrationDependencies,
	registerSubagentInspect,
} from "./inspect-registration.js";
import { MAX_BLOCKING_PARALLEL_CONCURRENCY } from "./limits.js";
import { SubagentParams } from "./params.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import {
	registerSubagentSessionGuidance,
	type SubagentSessionGuidanceSnapshot,
} from "./session-guidance-contract.js";
import {
	consumeSubagentSettingsNotice,
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
	DEFAULT_DELEGATION_CWD_POLICY,
	inspectSubagentSettings,
	readSubagentSettings,
	resolveBlockingMaxParallelTasks,
} from "./settings-reader.js";
import { registerStatefulSubagents } from "./stateful-registration.js";
import type { SubagentDetails } from "./subagent-details.js";
import type { SubagentTransport } from "./transport.js";
import {
	registerUsageRecording,
	type UsageRecordingDependencies,
	type UsageSurfaceArm,
} from "./usage-recording.js";
import { resolveUsageRecordingEnabled } from "./usage-recording-config.js";

type BlockingExecutionModule = Pick<typeof import("./execution.js"), "executeSubagent">;

export interface SubagentsDependencies {
	loadBlockingExecution?: () => Promise<BlockingExecutionModule>;
	loadStatefulTransport?: () => Promise<SubagentTransport>;
	config?: ConfigRegistrationDependencies;
	consult?: ConsultRegistrationDependencies;
	inspect?: InspectRegistrationDependencies;
	usageRecording?: Partial<UsageRecordingDependencies>;
}

export default function (pi: ExtensionAPI, dependencies: SubagentsDependencies = {}) {
	pi.registerMessageRenderer(SUBAGENT_COMPLETION_MESSAGE_TYPE, renderCompletionMessage);
	const loadBlockingExecution = cachedModuleLoader(
		dependencies.loadBlockingExecution ?? (() => import("./execution.js")),
	);
	const configOwner = registerSubagentConfigLifecycle(pi);
	const usageRecording = registerUsageRecording(pi, dependencies.usageRecording);
	const settings = readSubagentSettings();
	let currentSettings: SubagentSettings | undefined = settings;
	let currentCatalog = "";
	const blockingEnabled = settings?.blocking?.enabled !== false;
	const statefulEnabled = settings?.stateful?.enabled !== false;
	if (blockingEnabled) {
		registerBlockingSubagent(pi, () => currentSettings, statefulEnabled, loadBlockingExecution);
	}

	pi.on("session_start", async (event, ctx) => {
		// Preserve a one-shot migration notice from extension load while refreshing
		// validation against settings that may have changed before this session.
		const loadNotice = consumeSubagentSettingsNotice();
		const refreshedSettings = readSubagentSettings();
		const refreshedNotice = consumeSubagentSettingsNotice();
		if (!inspectSubagentSettings().error) currentSettings = refreshedSettings;
		const notice = [
			...new Set([loadNotice, refreshedNotice].filter((value) => value !== undefined)),
		].join("\n");
		if (notice) ctx.ui.notify(notice, "warning");

		currentCatalog = formatAgentCatalog(
			discoverAgentCatalog(ctx.cwd, ctx.isProjectTrusted(), refreshedSettings),
		).text;
		await usageRecording.startSession({
			enabled: resolveUsageRecordingEnabled(currentSettings?.usageRecording),
			surfaceArm: usageSurfaceArm(blockingEnabled, statefulRuntime.getRuntimeStatus().enabled),
			reason: event.reason,
			onWarning: (message) => {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
			},
		});
	});

	const statefulRuntime = registerStatefulSubagents(pi, {
		blockingEnabled,
		settings: settings?.stateful,
		getSettings: () => currentSettings,
		loadTransport: dependencies.loadStatefulTransport,
		usageRecording,
	});
	const getBlockingEnabled = () => blockingEnabled;
	const getMaxParallelTasks = () => resolveBlockingMaxParallelTasks(currentSettings);
	const getConsultResourcePolicy = () =>
		currentSettings?.consult?.resources ?? DEFAULT_CONSULT_RESOURCE_POLICY;
	const getConsultationCwdPolicy = () =>
		currentSettings?.cwdPolicy?.consultation ?? DEFAULT_CONSULTATION_CWD_POLICY;
	const getDelegationCwdPolicy = () =>
		currentSettings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY;
	registerSubagentInspect(
		pi,
		{
			...statefulRuntime,
			getBlockingEnabled,
			getMaxParallelTasks,
			getConsultResourcePolicy,
			getConsultationCwdPolicy,
			getDelegationCwdPolicy,
			getUsageRecordingStatus: () => usageRecording.getStatus(),
		},
		dependencies.inspect,
	);
	if (blockingEnabled) {
		registerSubagentConsult(pi, { getSettings: () => currentSettings }, dependencies.consult);
	}
	const sessionGuidance = registerSubagentSessionGuidance(
		pi,
		(): SubagentSessionGuidanceSnapshot => {
			const runtimeStatus = statefulRuntime.getRuntimeStatus();
			return {
				blockingEnabled,
				statefulEnabled: runtimeStatus.enabled,
				completionDelivery: runtimeStatus.completionDelivery,
				blockingMaxParallelTasks: resolveBlockingMaxParallelTasks(currentSettings),
				statefulLimits: runtimeStatus.limits,
				consultationCwdPolicy: getConsultationCwdPolicy(),
				delegationCwdPolicy: getDelegationCwdPolicy(),
				consultResourcePolicy: getConsultResourcePolicy(),
				agentCatalog: currentCatalog,
			};
		},
		() => statefulRuntime.listAgents(),
	);
	registerSubagentConfigCommand(
		pi,
		{
			...statefulRuntime,
			setCompletionDelivery(value) {
				statefulRuntime.setCompletionDelivery(value);
				sessionGuidance.publish();
			},
			getBlockingEnabled,
			getMaxParallelTasks,
			getConsultResourcePolicy,
			getConsultationCwdPolicy,
			getDelegationCwdPolicy,
			getUsageRecordingEnabled: () => usageRecording.getStatus().enabled,
			getUsageRecordingStatus: () => usageRecording.getStatus(),
			setUsageRecordingEnabled: async (value: boolean) => {
				await usageRecording.setEnabled(value);
				currentSettings = {
					...(currentSettings ?? {}),
					usageRecording: { ...(currentSettings?.usageRecording ?? {}), enabled: value },
				};
			},
			setMaxParallelTasks(value: number) {
				currentSettings = {
					...(currentSettings ?? {}),
					blocking: { ...(currentSettings?.blocking ?? {}), maxParallelTasks: value },
				};
				sessionGuidance.publish();
			},
			setConsultResourcePolicy(value: ConsultResourcePolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					consult: { ...(currentSettings?.consult ?? {}), resources: value },
				};
				sessionGuidance.publish();
			},
			setConsultationCwdPolicy(value: ConsultationCwdPolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					cwdPolicy: { ...(currentSettings?.cwdPolicy ?? {}), consultation: value },
				};
				sessionGuidance.publish();
			},
			setDelegationCwdPolicy(value: DelegationCwdPolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					cwdPolicy: { ...(currentSettings?.cwdPolicy ?? {}), delegation: value },
				};
				sessionGuidance.publish();
			},
		},
		configOwner,
		dependencies.config,
	);
	pi.on("session_shutdown", (event) => usageRecording.shutdown(event.reason));
}

function usageSurfaceArm(blockingEnabled: boolean, statefulEnabled: boolean): UsageSurfaceArm {
	if (blockingEnabled && statefulEnabled) return "all";
	if (statefulEnabled) return "async-only";
	if (blockingEnabled) return "blocking-only";
	return "disabled";
}

function registerBlockingSubagent(
	pi: ExtensionAPI,
	getSettings: () => SubagentSettings | undefined,
	statefulEnabled: boolean,
	loadExecution: () => Promise<BlockingExecutionModule>,
): void {
	let deprecationWarningShown = false;
	const activeControllers = new Set<AbortController>();
	const activeWork = new Set<Promise<unknown>>();
	const cancelAndWaitForWork = async (reason: string) => {
		for (const controller of activeControllers) {
			controller.abort(new DOMException(reason, "AbortError"));
		}
		await Promise.allSettled([...activeWork]);
	};
	pi.on("session_start", () => {
		deprecationWarningShown = false;
		return cancelAndWaitForWork("Blocking subagent session replaced");
	});
	pi.on("session_shutdown", () => cancelAndWaitForWork("Blocking subagent session shut down"));
	const deprecationAlternatives = () =>
		statefulEnabled
			? "Prefer the main agent for tightly coupled work, subagent_spawn for detached work, subagent_await for an intentional retained-agent join, or subagent_consult for bounded synchronous read-only evidence."
			: "Prefer the main agent for tightly coupled work or subagent_consult for bounded synchronous read-only evidence; enable the background workflow before using detached alternatives.";
	const baseDescription = [
		"Deprecated compatibility tool: do not choose subagent for new work.",
		deprecationAlternatives(),
		"Run specialized subagents as a blocking operation with isolated contexts.",
		"The call blocks the main agent until every worker and optional aggregator finishes, so queued steering waits.",
		"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), workflow (named dependency tasks with optional capability routing), or panel (independent reviewers plus evidence-preserving synthesis).",
		"Parallel mode may include an aggregator fan-in step; workflow mode validates dependencies, authority, artifacts, scope conflicts, retries, and hedging before scheduling. Use subagent_consult instead for one synchronous child that must be executor-constrained to read-only tools.",
		'Default agent scope is "user" (from ~/.pi/agent/agents).',
		`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, pass agentScope: "both" (or "project") as a top-level argument for that call.`,
		`Configured parallel limits never exceed ${MAX_BLOCKING_PARALLEL_CONCURRENCY} concurrently started workers. The current call limit, working-directory policy, and available agent definitions are published in the pi-subagents session-guidance message.`,
		"Working-directory policy controls launch targets and protected project resources, not filesystem access or sandboxing.",
	].join(" ");
	const promptGuidelines = [
		statefulEnabled
			? "The subagent tool is deprecated for new work; prefer the main agent, subagent_spawn with supported completion delivery, subagent_await for an intentional retained-agent join, or subagent_consult for bounded synchronous read-only evidence."
			: "The subagent tool is deprecated for new work; prefer the main agent or subagent_consult for bounded synchronous read-only evidence, and enable the background workflow before using detached alternatives.",
		"Use deprecated subagent only for an existing caller or an explicit user request whose blocking chain, fan-in, panel, or workflow semantics do not yet have a detached replacement.",
		"When compatibility requires subagent, decide how many subagents to spawn from task shape instead of waiting for the user to specify a count.",
		"The main agent retains overall planning, immediate critical-path work, integration, final verification, and the final answer.",
		"Use no subagent for simple answers, quick targeted edits, latency-sensitive one-step work, tasks requiring frequent user back-and-forth, or critical-path work the main agent can perform directly.",
		"One ordinary implementation worker should not replace work the main agent can perform directly; use a blocking single only when intentional synchronous isolation or a user-requested specialist justifies waiting.",
		"Keep ordinary planning in the main agent, or use explicit workflow mode when a genuine dependency graph requires caller-authored orchestration.",
		"Keep ordinary review in the main agent with a review skill and deterministic checks; reserve panel mode or custom verifier agents for consequential independent verification.",
		"A compatibility subagent call blocks the main agent from processing queued steering until it returns; use it only when the explicit legacy workflow justifies making Pi unavailable.",
		"If a blocking parallel subagent call is genuinely required, keep tasks independent, stay within the configured maximum from the current pi-subagents session-guidance message, and avoid write-heavy implementation touching the same files or shared state.",
		"For parallel subagent calls, omit the aggregator key entirely unless a fan-in step is required; do not send null, empty strings, or an empty object for unused optional fields.",
		"Use workflow mode for explicit dependencies or capability routing; declare read/write or ownership scopes, require structured-v2 artifacts when downstream tasks consume them, and use retry or hedging only with the required side-effect contract.",
		"Use panel mode only for consequential review or research that benefits from at least two independent reviewers and one bounded synthesis; agreement is not proof, dissent and blocking objections remain visible, and simple or latency-sensitive work should not use a panel.",
		'Do not use subagent with project-local agents unless the user explicitly wants project agents or sets agentScope to "project" or "both"; keep confirmation enabled for untrusted repositories.',
		"When using subagent, write self-contained tasks with file paths, context, expected output, and whether the subagent may edit files.",
		"Set subagent timeoutMs to the shortest realistic work deadline for the task difficulty, just as thinkingLevel should match reasoning difficulty; split oversized tasks instead of extending the deadline merely to compensate for broad scope. Use totalTimeoutMs to cap an entire blocking workflow, idleTimeoutMs for stalled work, and maxTurns or maxToolCalls to stop repeated work without progress. Every budget stop preserves a bounded checkpoint and may make one separately bounded summary attempt.",
	];
	const definition: ToolDefinition<typeof SubagentParams, SubagentDetails> = {
		name: "subagent",
		label: "Blocking Subagent · Deprecated",
		description: baseDescription,
		promptSnippet:
			"Deprecated blocking subagent compatibility tool; prefer detached or read-only alternatives.",
		promptGuidelines,
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const lifecycleController = new AbortController();
			activeControllers.add(lifecycleController);
			const effectiveSignal = signal
				? AbortSignal.any([signal, lifecycleController.signal])
				: lifecycleController.signal;
			const work = (async () => {
				throwIfAborted(effectiveSignal, "Blocking subagent execution was cancelled");
				if (!deprecationWarningShown && ctx.hasUI) {
					deprecationWarningShown = true;
					ctx.ui.notify(
						statefulEnabled
							? "subagent is deprecated for new work. Prefer the main agent, subagent_spawn with completion delivery, subagent_await for an intentional join, or subagent_consult for synchronous read-only evidence."
							: "subagent is deprecated for new work. Prefer the main agent or subagent_consult; enable the background workflow before using detached alternatives.",
						"warning",
					);
				}
				let executionModule: BlockingExecutionModule;
				try {
					executionModule = await loadExecution();
				} catch (error) {
					throwIfAborted(
						effectiveSignal,
						"Blocking subagent execution was cancelled while loading",
					);
					throw error;
				}
				throwIfAborted(effectiveSignal, "Blocking subagent execution was cancelled while loading");
				return executionModule.executeSubagent(
					toolCallId,
					params,
					effectiveSignal,
					onUpdate,
					ctx,
					getSettings(),
				);
			})();
			activeWork.add(work);
			try {
				return await work;
			} finally {
				activeControllers.delete(lifecycleController);
				activeWork.delete(work);
			}
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},
	};
	pi.registerTool<typeof SubagentParams, SubagentDetails>(definition);
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		if ((event.details as (SubagentDetails & { isError?: boolean }) | undefined)?.isError)
			return { isError: true };
	});
}
