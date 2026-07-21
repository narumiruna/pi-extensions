import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateObjective } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import type { GoalStatus } from "./prompts.js";
import { formatError, type GoalRuntime, type StatusContext } from "./runtime.js";

// Cross-extension RPC contract over Pi's session-local events bus. pi-subagents
// (or any sibling extension) starts or pauses a goal through RPC; pi-goal replies
// to starts and broadcasts `pi-goal:state` from the runtime persistence boundary.
const RPC_START_CHANNEL = "pi-goal:rpc:start";
const RPC_PAUSE_CHANNEL = "pi-goal:rpc:pause";

interface GoalRpcStartPayload {
	requestId: string;
	objective: string;
	tokenBudget?: number;
}

interface GoalRpcPausePayload {
	requestId?: string;
	goalId?: string;
	reason?: string;
}

type GoalRpcReply =
	| { success: true; data: { goalId: string; status: GoalStatus } }
	| { success: false; error: string };

interface GoalRpcOwnership {
	requestId: string;
	goalId: string;
}

function rpcReplyChannel(requestId: string) {
	return `pi-goal:rpc:start:reply:${requestId}`;
}

function parseRpcStartPayload(
	payload: Partial<GoalRpcStartPayload> | null,
): string | { objective: string; tokenBudget?: number } {
	if (!payload || typeof payload !== "object") return "rpc:start payload is missing";
	if (typeof payload.objective !== "string") return "objective must be a string";
	const objective = payload.objective.trim();
	const objectiveError = validateObjective(objective);
	if (objectiveError) return objectiveError;
	let tokenBudget: number | undefined;
	if (payload.tokenBudget !== undefined) {
		if (
			typeof payload.tokenBudget !== "number" ||
			!Number.isFinite(payload.tokenBudget) ||
			!Number.isSafeInteger(payload.tokenBudget) ||
			payload.tokenBudget <= 0
		) {
			return "tokenBudget must be a positive integer";
		}
		tokenBudget = payload.tokenBudget;
	}
	return { objective, tokenBudget };
}

export class GoalRpcController {
	private readonly runtime: GoalRuntime;
	private readonly commands: GoalCommandController;
	private sessionContext?: StatusContext;
	private ownership?: GoalRpcOwnership;

	constructor(runtime: GoalRuntime, commands: GoalCommandController) {
		this.runtime = runtime;
		this.commands = commands;
	}

	register(pi: ExtensionAPI) {
		pi.events.on(RPC_START_CHANNEL, (data) => {
			void this.handleStart(data);
		});
		pi.events.on(RPC_PAUSE_CHANNEL, (data) => {
			this.handlePause(data);
		});
	}

	bindSession(ctx: StatusContext) {
		this.sessionContext = ctx;
		this.ownership = undefined;
	}

	unbindSession() {
		this.sessionContext = undefined;
		this.ownership = undefined;
	}

	private async handleStart(data: unknown) {
		const payload = data as Partial<GoalRpcStartPayload> | null;
		const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
		// Without a usable requestId there is no reply channel to address safely.
		if (!requestId) return;
		const reply = (envelope: GoalRpcReply) =>
			this.runtime.pi.events.emit(rpcReplyChannel(requestId), envelope);

		const sessionContext = this.sessionContext;
		if (!sessionContext) {
			reply({ success: false, error: "no active pi-goal session context" });
			return;
		}
		const parsed = parseRpcStartPayload(payload);
		if (typeof parsed === "string") {
			reply({ success: false, error: parsed });
			return;
		}
		// RPC starts run in a fresh child: any pre-existing goal must fail rather
		// than trigger interactive replacement confirmation or reuse stale state.
		const existingGoal = this.runtime.activeGoal;
		if (existingGoal) {
			reply({
				success: false,
				error: "a goal already exists; clear it before starting another via RPC",
			});
			return;
		}

		let activatedGoalId: string | undefined;
		try {
			await this.commands.startGoal(
				parsed.objective,
				parsed.tokenBudget,
				sessionContext,
				(goal) => {
					activatedGoalId = goal.id;
					this.ownership = { requestId, goalId: goal.id };
				},
			);
		} catch (error) {
			this.clearOwnership(requestId, activatedGoalId);
			reply({ success: false, error: `goal start failed: ${formatError(error)}` });
			return;
		}

		// Read only the goal activated by this request. A replacement or clear that
		// wins while kickoff delivery is pending must not be reported as this start.
		const goal = this.runtime.activeGoal;
		if (!goal || !activatedGoalId || goal.id !== activatedGoalId) {
			this.clearOwnership(requestId, activatedGoalId);
			reply({
				success: false,
				error:
					"goal start failed; the objective could not be activated (goal tools unavailable, kickoff delivery failed, or the goal was superseded)",
			});
			return;
		}
		reply({ success: true, data: { goalId: goal.id, status: goal.status } });
	}

	private handlePause(data: unknown) {
		const sessionContext = this.sessionContext;
		const goal = this.runtime.activeGoal;
		const ownership = this.ownership;
		if (
			!sessionContext ||
			goal?.status !== "active" ||
			!ownership ||
			ownership.goalId !== goal.id
		) {
			return;
		}

		const payload = data as GoalRpcPausePayload | null;
		const goalId = typeof payload?.goalId === "string" ? payload.goalId : undefined;
		if (goalId !== undefined) {
			if (goalId !== goal.id) return;
		} else {
			const requestId =
				typeof payload?.requestId === "string" ? payload.requestId.trim() : undefined;
			if (!requestId || requestId !== ownership.requestId) return;
		}

		const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
		this.runtime.setTerminalReason(goal.id, reason || "goal paused by RPC");
		this.commands.pauseGoal(sessionContext);
	}

	private clearOwnership(requestId: string, goalId: string | undefined) {
		if (
			this.ownership?.requestId === requestId &&
			(goalId === undefined || this.ownership.goalId === goalId)
		) {
			this.ownership = undefined;
		}
	}
}
