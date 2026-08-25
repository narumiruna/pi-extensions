import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import {
	formatStatus,
	GOAL_BLOCKED_TOOL,
	GOAL_COMPLETE_TOOL,
	GOAL_WAIT_TOOL,
	type GoalRuntime,
	goalIdRejectionReason,
	isContradictoryCompletionSummary,
	MAX_GOAL_ID_LENGTH,
	STATUS_KEY,
	transitionGoal,
	truncateNotification,
} from "./runtime.js";
import {
	createGoalWait,
	MAX_GOAL_WAIT_DELAY_MS,
	MAX_GOAL_WAIT_REASON_LENGTH,
	MIN_GOAL_WAIT_DELAY_MS,
	resolveGoalWaitDelay,
} from "./wait.js";

interface GoalCompleteDetails {
	goal: string;
	goal_id: string;
	summary: string;
}

interface GoalBlockedDetails {
	goal: string;
	goal_id: string;
	reason: string;
	evidence: string;
	repeated_turns: number;
}

interface GoalWaitDetails {
	goal: string;
	goal_id: string;
	reason: string;
	requested_resume_after_ms?: number;
	resume_after_ms?: number;
	resume_at?: number;
}

const MAX_GOAL_TEXT_LENGTH = 4_000;
const MAX_COMPLETION_SUMMARY_LENGTH = 4_000;
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime) {
	const goalCompleteTool = defineTool({
		name: GOAL_COMPLETE_TOOL,
		label: "Goal Complete",
		description:
			"Mark an active /goal complete only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and every requirement is verified. Tool visibility alone does not activate Goal mode. Never call for ordinary work, partial progress, blockers, failures, or unverified work.",
		parameters: Type.Object({
			goal_id: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_ID_LENGTH,
				description:
					"The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
			}),
			summary: Type.String({
				minLength: 1,
				maxLength: MAX_COMPLETION_SUMMARY_LENGTH,
				description:
					"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const completedGoal = runtime.activeGoal;
			const goal = completedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const summary = typeof params.summary === "string" ? params.summary.trim() : "";

			if (!completedGoal) {
				const rejection = "Goal completion rejected: no active goal.";
				notifyTerminal(ctx.ui, rejection, "warning");

				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
				};
			}
			const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
			if (completedGoal.status === "active" && !runtime.ownsWorkflow(completedGoal)) {
				const rejection = "Goal completion rejected: active Goal no longer owns its workflow.";
				notifyTerminal(ctx.ui, rejection, "warning");
				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
				};
			}
			if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
				const rejection = "Goal completion rejected: current run does not own the active goal.";
				notifyTerminal(ctx.ui, rejection, "warning");
				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
				};
			}
			const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
			if (staleGoalRejection) {
				const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
				notifyTerminal(ctx.ui, rejection, "warning");
				if (completingDuringBudgetWrapUp) {
					runtime.recordGoalUsage(completedGoal, ctx);
					runtime.persistGoal(completedGoal);
					runtime.updateStatus(ctx, completedGoal);
					runtime.clearBudgetWrapUp();
				}

				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}
			if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
				const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
				notifyTerminal(ctx.ui, rejection, "warning");

				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
				};
			}

			const rejectionReason = !summary
				? "summary is empty"
				: summary.length > MAX_COMPLETION_SUMMARY_LENGTH
					? "summary is too long"
					: isContradictoryCompletionSummary(summary)
						? "summary says the goal is not complete"
						: undefined;
			if (rejectionReason) {
				runtime.recordGoalUsage(completedGoal, ctx);
				runtime.persistGoal(completedGoal);
				runtime.updateStatus(ctx, completedGoal);
				const rejection = `Goal completion rejected: ${rejectionReason}.`;
				notifyTerminal(ctx.ui, rejection, "warning");
				if (completingDuringBudgetWrapUp) runtime.clearBudgetWrapUp();

				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}

			runtime.clearGoalWaitTimer();
			runtime.activeGoal = transitionGoal(completedGoal, "complete");
			runtime.setCompletionSummary(runtime.activeGoal.id, summary);
			runtime.recordGoalUsage(runtime.activeGoal, ctx);
			runtime.persistGoal(runtime.activeGoal);

			ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
			// deferred to turn_end
			// runtime.clearActiveGoal(ctx);
			runtime.showCompletionStatus(ctx);
			notifyTerminal(ctx.ui, `Goal complete: ${goal}`, "info");

			return {
				content: toolContent(`Goal complete: ${summary}`),
				details: completionDetails(goal, requestedGoalId, summary),
				terminate: true,
			};
		},
	});

	const goalBlockedTool = defineTool({
		name: GOAL_BLOCKED_TOOL,
		label: "Goal Blocked",
		description:
			"Stop an active /goal only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and the same evidenced external blocker recurred for at least three consecutive Goal turns. Tool visibility alone does not activate Goal mode. Never call for ordinary clarification, uncertainty, incomplete work, or recoverable failures.",
		parameters: Type.Object({
			goal_id: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_ID_LENGTH,
				description: "The exact goal_id shown in the current active /goal prompt.",
			}),
			reason: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_REASON_LENGTH,
				description: "The specific user or external action required to unblock the goal.",
			}),
			evidence: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
				description: "Concrete evidence from the repeated attempts that proves the impasse.",
			}),
			repeated_turns: Type.Integer({
				minimum: 3,
				description: "Number of separate turns spent trying to resolve this same blocker.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const blockedGoal = runtime.activeGoal;
			const goal = blockedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
			const repeatedTurns =
				typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
			const reject = (rejectionReason: string, terminate = false) => {
				const rejection = `goal_blocked rejected: ${rejectionReason}.`;
				notifyTerminal(ctx.ui, rejection, "warning");
				return {
					content: toolContent(rejection),
					details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
					...(terminate ? { terminate: true as const } : {}),
				};
			};

			if (!blockedGoal) return reject("no active goal");
			if (!runtime.canRecordGoalUsage()) {
				return reject("current run does not own the active goal");
			}
			const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
			if (staleGoalRejection) return reject(staleGoalRejection);
			if (blockedGoal.status !== "active") {
				return reject(`goal is ${blockedGoal.status}, not active`);
			}
			if (!runtime.ownsWorkflow(blockedGoal))
				return reject("active Goal no longer owns its workflow");
			if (!reason) return reject("reason is empty");
			if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
			if (!evidence) return reject("evidence is empty");
			if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
			if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
			if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

			const stoppedGoal = runtime.stopActiveGoal(ctx, {
				kind: "blocker_report",
				expectedGoalId: blockedGoal.id,
				reason,
			});
			if (!stoppedGoal) return reject("active goal changed before blocker transition");
			notifyTerminal(ctx.ui, `Goal blocked: ${truncateNotification(reason)}`, "warning");

			return {
				content: toolContent(`Goal blocked: ${reason}`),
				details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
				terminate: true,
			};
		},
	});

	const goalWaitTool = defineTool({
		name: GOAL_WAIT_TOOL,
		label: "Goal Wait",
		description: `Keep an active /goal quiet only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and progress depends on an arranged external wake event or one safety deadline. Tool visibility alone does not activate Goal mode. Call goal_wait alone. Requests below ${MIN_GOAL_WAIT_DELAY_MS}ms are clamped to ${MIN_GOAL_WAIT_DELAY_MS}ms. Never call for ordinary unfinished work.`,
		parameters: Type.Object({
			goal_id: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_ID_LENGTH,
				description: "The exact goal_id shown in the current active /goal prompt.",
			}),
			reason: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_WAIT_REASON_LENGTH,
				description: "Why the goal is waiting and which external event should wake it.",
			}),
			resume_after_ms: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_GOAL_WAIT_DELAY_MS,
					description: `Optional safety deadline in milliseconds that requests one continuation if no wake message arrives. Values below ${MIN_GOAL_WAIT_DELAY_MS} are accepted but clamped to ${MIN_GOAL_WAIT_DELAY_MS}.`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const activeGoal = runtime.activeGoal;
			const goal = activeGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const resumeAfterMs =
				typeof params.resume_after_ms === "number" ? params.resume_after_ms : undefined;
			const reject = (rejectionReason: string) => {
				const rejection = `goal_wait rejected: ${rejectionReason}.`;
				notifyTerminal(ctx.ui, rejection, "warning");
				return {
					content: toolContent(rejection),
					details: waitDetails(goal, requestedGoalId, reason, resumeAfterMs),
				};
			};

			if (!activeGoal) return reject("no active goal");
			if (!runtime.canRecordGoalUsage()) {
				return reject("current run does not own the active goal");
			}
			const staleGoalRejection = goalIdRejectionReason(activeGoal, requestedGoalId);
			if (staleGoalRejection) return reject(staleGoalRejection);
			if (activeGoal.status !== "active") {
				return reject(`goal is ${activeGoal.status}, not active`);
			}
			if (!runtime.ownsWorkflow(activeGoal))
				return reject("active Goal no longer owns its workflow");
			if (activeGoal.waiting) return reject("goal is already waiting");
			if (!reason) return reject("reason is empty");
			if (reason.length > MAX_GOAL_WAIT_REASON_LENGTH) return reject("reason is too long");
			if (
				resumeAfterMs !== undefined &&
				(!Number.isInteger(resumeAfterMs) ||
					resumeAfterMs < 1 ||
					resumeAfterMs > MAX_GOAL_WAIT_DELAY_MS)
			) {
				return reject(`resume_after_ms must be a whole number from 1 to ${MAX_GOAL_WAIT_DELAY_MS}`);
			}

			const { requestedMs, effectiveMs } = resolveGoalWaitDelay(resumeAfterMs);
			const waiting = createGoalWait(reason, resumeAfterMs);
			const waitingGoal = runtime.enterGoalWait(ctx, activeGoal.id, waiting);
			if (!waitingGoal) return reject("active goal changed before waiting transition");
			const clamped = requestedMs !== undefined && effectiveMs !== requestedMs;
			notifyTerminal(ctx.ui, `Goal waiting: ${truncateNotification(reason)}`, "info");
			return {
				content: toolContent(
					clamped
						? `Goal waiting: ${reason}\nRequested resume_after_ms ${requestedMs} was clamped to ${effectiveMs}.`
						: `Goal waiting: ${reason}`,
				),
				details: waitDetails(
					goal,
					requestedGoalId,
					reason,
					effectiveMs,
					waiting.resumeAt,
					clamped ? requestedMs : undefined,
				),
				terminate: true,
			};
		},
	});

	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalBlockedTool);
	pi.registerTool(goalWaitTool);
}

function toolContent(text: string) {
	return [
		{
			type: "text" as const,
			text: truncateHead(safeTerminalText(text), {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			}).content,
		},
	];
}

function completionDetails(goal: string, goalId: string, summary: string): GoalCompleteDetails {
	return {
		goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
		goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
		summary: summary.slice(0, MAX_COMPLETION_SUMMARY_LENGTH),
	};
}

function blockerDetails(
	goal: string,
	goalId: string,
	reason: string,
	evidence: string,
	repeatedTurns: number,
): GoalBlockedDetails {
	return {
		goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
		goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
		reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
		evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
		repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
	};
}

function waitDetails(
	goal: string,
	goalId: string,
	reason: string,
	resumeAfterMs: number | undefined,
	resumeAt?: number,
	requestedResumeAfterMs?: number,
): GoalWaitDetails {
	return {
		goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
		goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
		reason: reason.slice(0, MAX_GOAL_WAIT_REASON_LENGTH),
		...(requestedResumeAfterMs === undefined
			? {}
			: { requested_resume_after_ms: requestedResumeAfterMs }),
		...(resumeAfterMs === undefined ? {} : { resume_after_ms: resumeAfterMs }),
		...(resumeAt === undefined ? {} : { resume_at: resumeAt }),
	};
}
