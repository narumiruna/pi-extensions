import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { cachedModuleLoader, throwIfAborted } from "./cached-module-loader.js";
import type { RegisterSubagentConsultOptions } from "./consult.js";
import { renderConsultCall, renderConsultResult } from "./consult-render.js";
import { type ConsultDetails, SubagentConsultParams } from "./consult-tool.js";

interface ConsultExecutionModule {
	executeSubagentConsult: typeof import("./consult.js").executeSubagentConsult;
}

export interface ConsultRegistrationDependencies {
	loadExecution?: () => Promise<ConsultExecutionModule>;
}

export function registerSubagentConsult(
	pi: ExtensionAPI,
	options: RegisterSubagentConsultOptions,
	dependencies: ConsultRegistrationDependencies = {},
): void {
	const loadExecution = cachedModuleLoader(
		dependencies.loadExecution ?? (() => import("./consult.js")),
	);
	let generation = 0;
	const active = new Set<AbortController>();
	const activeWork = new Set<Promise<unknown>>();
	const cancelActive = (reason: string) => {
		generation++;
		for (const controller of active) {
			controller.abort(new DOMException(reason, "AbortError"));
		}
		active.clear();
	};
	const cancelAndWaitForWork = async (reason: string) => {
		cancelActive(reason);
		await Promise.allSettled([...activeWork]);
	};
	pi.on("session_start", () => cancelAndWaitForWork("Subagent consultation session replaced"));
	pi.on("session_shutdown", () => cancelAndWaitForWork("Subagent consultation session shut down"));

	const description =
		"Run one ephemeral subagent synchronously under enforced read-only tool and resource policies and return its answer. The child can use only the effective subset of Pi's built-in read, grep, find, and ls tools. Shell commands, file writes, extension tools, detached lifecycle operations, and persistent agent state are disabled. The current working-directory policy, trusted-target resource policy, and available agent definitions are published in the pi-subagents session-guidance message. Allowed targets without effective trust inherit no target or project resources. This is not a filesystem sandbox.";
	const definition: ToolDefinition<typeof SubagentConsultParams, ConsultDetails> = {
		name: "subagent_consult",
		label: "Consult Read-only Subagent",
		description,
		promptSnippet: "Consult one constrained read-only subagent and wait for its answer",
		promptGuidelines: [
			"Use subagent_consult only for bounded read-only evidence gathering when an independent perspective is worth making the main agent wait.",
			"Keep ordinary planning and review in the main agent with applicable skills and deterministic checks; use subagent_consult only when synchronous read-only isolation adds concrete value.",
			"Set subagent_consult timeoutMs to the shortest realistic work deadline for the task difficulty; split oversized consultations instead of extending the deadline merely to compensate for broad scope.",
			"Implementation-shaped subagent_consult tasks remain read-only and can return only analysis or instructions.",
		],
		parameters: SubagentConsultParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const ownerGeneration = generation;
			const ownedController = new AbortController();
			active.add(ownedController);
			const combined = combineAbortSignals(signal, ownedController.signal);
			const work = (async () => {
				throwIfAborted(combined.signal, "Subagent consultation loading was cancelled");
				let executionModule: ConsultExecutionModule;
				try {
					executionModule = await loadExecution();
				} catch (error) {
					throwIfAborted(combined.signal, "Subagent consultation loading was cancelled");
					throw error;
				}
				throwIfAborted(combined.signal, "Subagent consultation loading was cancelled");
				if (ownerGeneration !== generation) {
					throw new DOMException("Subagent consultation owner was replaced", "AbortError");
				}
				return executionModule.executeSubagentConsult(
					params,
					combined.signal,
					onUpdate,
					ctx,
					options,
					() => ownerGeneration === generation,
				);
			})();
			activeWork.add(work);
			try {
				return await work;
			} finally {
				combined.dispose();
				active.delete(ownedController);
				activeWork.delete(work);
			}
		},
		renderCall(args, theme) {
			return renderConsultCall(args, theme);
		},
		renderResult(result, renderOptions, theme, context) {
			return renderConsultResult(result, renderOptions, theme, context);
		},
	};
	pi.registerTool<typeof SubagentConsultParams, ConsultDetails>(definition);
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent_consult") return;
		if ((event.details as ConsultDetails | undefined)?.isError) return { isError: true };
	});
}

function combineAbortSignals(
	external: AbortSignal | undefined,
	owned: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
	if (!external) return { signal: owned, dispose() {} };
	const controller = new AbortController();
	const sources = [external, owned];
	const listeners = sources.map((source) => {
		const listener = () => {
			if (!controller.signal.aborted) controller.abort(source.reason);
		};
		if (source.aborted) listener();
		else source.addEventListener("abort", listener, { once: true });
		return { source, listener };
	});
	return {
		signal: controller.signal,
		dispose() {
			for (const { source, listener } of listeners) source.removeEventListener("abort", listener);
		},
	};
}
