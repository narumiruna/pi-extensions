import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import {
	formatImplementationHandoff,
	formatTransferredPlanPrompt,
} from "./fresh-implementation.js";
import type { ImplementationPlanRetention } from "./settings.js";
import type { ActiveImplementationPlan, PlanCompletionSource, PlanModeState } from "./state.js";

export const PLAN_MODE_BRANCH_POINT_ENTRY_TYPE = "plan-mode-branch-point";

interface BranchPointEntry {
	id?: string;
	type?: string;
	customType?: string;
}

interface BranchPointSessionManager {
	getLeafId?(): string | null;
	getEntry?(id: string): BranchPointEntry | undefined;
}

export interface PlanModeBranchPoint {
	id: string;
	tools: string[];
}

interface PendingTreeHandoff {
	branchPointId: string;
	sourceLeafId: string | null;
	session: object;
}

interface TreeImplementationOwner {
	getState(): PlanModeState;
	getCurrentSession(): object | undefined;
	getWorkflowGeneration(): number;
	getRetention(): ImplementationPlanRetention;
	restoreNormalRuntime(tools: readonly string[]): void;
	publishImplementation(
		state: PlanModeState,
		active: ActiveImplementationPlan | undefined,
		ctx: ExtensionContext,
	): void;
	publishRecovery(state: PlanModeState, ctx: ExtensionContext): void;
	sendUserMessage(message: string, ctx: ExtensionContext): boolean;
}

export function capturePlanModeBranchPoint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tools: readonly string[],
): PlanModeBranchPoint | undefined {
	const sessionManager = ctx.sessionManager as unknown as BranchPointSessionManager;
	if (!sessionManager.getLeafId || !sessionManager.getEntry) return undefined;

	pi.appendEntry(PLAN_MODE_BRANCH_POINT_ENTRY_TYPE, { version: 1 });
	const id = sessionManager.getLeafId();
	if (!id || !isPlanModeBranchPoint(sessionManager.getEntry(id), id)) return undefined;
	return { id, tools: [...tools] };
}

export function createTreeImplementationController(owner: TreeImplementationOwner) {
	let pending: PendingTreeHandoff | undefined;

	return {
		acceptsTreeEvent(event: SessionTreeEvent, ctx: ExtensionContext) {
			const accepted =
				pending?.session === ctx.sessionManager &&
				pending.sourceLeafId === event.oldLeafId &&
				pending.branchPointId === event.newLeafId;
			if (!accepted) pending = undefined;
			return accepted;
		},
		cancel() {
			pending = undefined;
		},
		async start(
			ctx: ExtensionContext,
			request: {
				plan: string;
				source: PlanCompletionSource;
				signal?: AbortSignal;
			},
		) {
			const initialState = owner.getState();
			const branchPointId = initialState.branchPointId;
			const toolsBeforePlanMode = initialState.toolsBeforePlanMode;
			if (!branchPointId || !toolsBeforePlanMode) {
				report(
					ctx,
					"This completed plan has no restorable Normal-mode tool snapshot. The plan remains ready in the current branch.",
					"warning",
				);
				return;
			}
			if (!isValidPlanModeBranchPoint(ctx, branchPointId)) {
				report(
					ctx,
					"This completed plan has no valid branch point. The plan remains ready in the current branch.",
					"warning",
				);
				return;
			}

			const sourceSession = ctx.sessionManager;
			const sourceWorkflowGeneration = owner.getWorkflowGeneration();
			const handoff: PendingTreeHandoff = {
				branchPointId,
				sourceLeafId: sourceSession.getLeafId(),
				session: sourceSession,
			};
			pending = handoff;
			const navigation = await navigateToPlanModeBranchPoint(ctx, {
				branchPointId,
				signal: request.signal,
				isCurrent: () => {
					const currentState = owner.getState();
					return (
						pending === handoff &&
						owner.getCurrentSession() === sourceSession &&
						owner.getWorkflowGeneration() === sourceWorkflowGeneration &&
						sourceSession.getLeafId() === handoff.sourceLeafId &&
						currentState.enabled &&
						currentState.latestPlan === initialState.latestPlan &&
						currentState.latestPlanSource === initialState.latestPlanSource
					);
				},
			});
			if (navigation !== "navigated") {
				if (pending === handoff) pending = undefined;
				return;
			}

			let message: string | undefined;
			try {
				if (
					pending !== handoff ||
					owner.getCurrentSession() !== sourceSession ||
					sourceSession.getLeafId() !== branchPointId
				) {
					return;
				}

				const retention = owner.getRetention();
				const activeImplementation = createActiveImplementation(request, retention);
				owner.restoreNormalRuntime(toolsBeforePlanMode);
				owner.publishImplementation(
					implementationState(owner.getState(), activeImplementation),
					activeImplementation,
					ctx,
				);
				message =
					retention === "clear-on-start"
						? formatTransferredPlanPrompt(request.plan, false)
						: formatImplementationHandoff(request.plan);
				if (!owner.sendUserMessage(message, ctx)) recover(owner, ctx, request, message);
			} catch {
				recover(owner, ctx, request, message);
			} finally {
				if (pending === handoff) pending = undefined;
			}
		},
	};
}

function createActiveImplementation(
	request: { plan: string; source: PlanCompletionSource },
	retention: ImplementationPlanRetention,
): ActiveImplementationPlan | undefined {
	return retention === "clear-on-start"
		? undefined
		: {
				id: randomUUID(),
				plan: request.plan,
				source: request.source,
				startedAt: Date.now(),
				retention,
			};
}

function implementationState(
	state: PlanModeState,
	activeImplementation: ActiveImplementationPlan | undefined,
): PlanModeState {
	return {
		...state,
		enabled: false,
		latestPlan: undefined,
		latestPlanSource: undefined,
		awaitingAction: false,
		savedPlan: undefined,
		activeImplementation,
		manualThinkingLevel: undefined,
		branchPointId: undefined,
		toolsBeforePlanMode: undefined,
	};
}

function recover(
	owner: TreeImplementationOwner,
	ctx: ExtensionContext,
	request: { plan: string; source: PlanCompletionSource },
	handoff: string | undefined,
) {
	const currentState = owner.getState();
	const currentPlanIsRecoverable =
		currentState.activeImplementation?.plan === request.plan &&
		currentState.activeImplementation.source === request.source;
	if (!currentPlanIsRecoverable) {
		try {
			owner.publishRecovery(
				{
					...implementationState(currentState, undefined),
					savedPlan: { plan: request.plan, source: request.source },
				},
				ctx,
			);
		} catch {
			// The editor recovery below still retains the exact plan when persistence is unavailable.
		}
	}

	const message = handoff ?? formatTransferredPlanPrompt(request.plan, false);
	let restoredInEditor = false;
	try {
		if (!ctx.ui.getEditorText().trim()) {
			ctx.ui.setEditorText(message);
			restoredInEditor = true;
		}
	} catch {
		// A stale context cannot own editor recovery after session replacement.
	}
	try {
		ctx.ui.notify(
			restoredInEditor
				? "The clean implementation branch is ready, but implementation did not start. The complete request is in the editor."
				: "The clean implementation branch is ready, but implementation did not start. The approved plan remains saved in this branch.",
			"error",
		);
	} catch {
		// A stale context cannot receive recovery notifications.
	}
}

function isValidPlanModeBranchPoint(ctx: ExtensionContext, id: string) {
	try {
		return isPlanModeBranchPoint(ctx.sessionManager.getEntry(id), id);
	} catch {
		return false;
	}
}

async function navigateToPlanModeBranchPoint(
	ctx: ExtensionContext,
	options: {
		branchPointId: string;
		signal?: AbortSignal;
		isCurrent(): boolean;
	},
): Promise<"navigated" | "cancelled" | "rejected" | "stale"> {
	if (ctx.mode === "print" || ctx.mode === "json") {
		throw new Error(
			"Clean-branch Plan implementation is unavailable in print/JSON mode. Resume the session in TUI or RPC.",
		);
	}
	if (!isCommandContext(ctx)) {
		report(
			ctx,
			"Clean-branch implementation requires the interactive /plan command. Reopen /plan and try again.",
			"warning",
		);
		return "rejected";
	}

	try {
		await ctx.waitForIdle();
	} catch (error: unknown) {
		report(
			ctx,
			`Unable to prepare clean-branch implementation: ${safeErrorDetail(error)}. The completed plan remains ready in the current branch.`,
			"error",
		);
		return "rejected";
	}
	if (options.signal?.aborted || !options.isCurrent()) return "stale";
	if (!isValidPlanModeBranchPoint(ctx, options.branchPointId)) {
		report(
			ctx,
			"The Plan-mode branch point is unavailable. The completed plan remains ready in the current branch.",
			"warning",
		);
		return "rejected";
	}

	try {
		const result = await ctx.navigateTree(options.branchPointId, { summarize: false });
		return result.cancelled ? "cancelled" : "navigated";
	} catch (error: unknown) {
		report(
			ctx,
			`Unable to return to the Plan-mode branch point: ${safeErrorDetail(error)}. The completed plan remains ready in the current branch.`,
			"error",
		);
		return "rejected";
	}
}

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return (
		typeof (ctx as Partial<ExtensionCommandContext>).waitForIdle === "function" &&
		typeof (ctx as Partial<ExtensionCommandContext>).navigateTree === "function"
	);
}

function isPlanModeBranchPoint(entry: BranchPointEntry | undefined, id: string) {
	return (
		entry?.id === id &&
		entry.type === "custom" &&
		entry.customType === PLAN_MODE_BRANCH_POINT_ENTRY_TYPE
	);
}

function report(ctx: ExtensionContext, message: string, level: "warning" | "error") {
	if (!ctx.hasUI) throw new Error(message);
	ctx.ui.notify(message, level);
}

function safeErrorDetail(error: unknown) {
	const detail = error instanceof Error ? error.message : String(error);
	const normalized =
		[...detail]
			.map((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
			})
			.join("")
			.replace(/\s+/gu, " ")
			.trim() || "unknown error";
	const characters = [...normalized];
	return characters.length > 500 ? `${characters.slice(0, 499).join("")}…` : normalized;
}
