import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateObjective } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import type { GoalTransitionProvenance } from "./persistence.js";
import {
	formatError,
	type GoalRuntime,
	type GoalStateSnapshot,
	isTerminalGoalStatus,
	type StatusContext,
} from "./runtime.js";

export const GOAL_RUN_START_CHANNEL = "pi-goal:start";
export const GOAL_RUN_CANCEL_CHANNEL = "pi-goal:cancel";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_CANCEL_REASON_LENGTH = 1_000;

export type GoalRunStatus = Exclude<GoalStateSnapshot["status"], "queued">;
export type GoalRunErrorCode =
	| "RPC_DISABLED"
	| "INVALID_REQUEST"
	| "NO_ACTIVE_SESSION"
	| "RUN_ID_IN_USE"
	| "RUN_NOT_FOUND"
	| "GOAL_ALREADY_EXISTS"
	| "ACTIVATION_FAILED"
	| "SUPERSEDED";

export type GoalRunEvent =
	| {
			type: "state";
			runId: string;
			goalId: string;
			status: GoalRunStatus;
			summary?: string;
			reason?: string;
			transition?: GoalTransitionProvenance;
	  }
	| {
			type: "error";
			runId: string;
			operation: "start" | "cancel";
			error: { code: GoalRunErrorCode; message: string };
	  };

interface GoalRunStartPayload {
	runId: string;
	objective: string;
	tokenBudget?: number;
}

interface BoundSession {
	generation: number;
	ctx: StatusContext;
}

interface ManagedRun {
	runId: string;
	generation: number;
	goalId?: string;
	lastStatus?: GoalRunStatus;
	closed: boolean;
	cancelRequested: boolean;
	cancelReason?: string;
}

export function goalRunEventChannel(runId: string) {
	return `pi-goal:event:${runId}`;
}

function isPayloadRecord(data: unknown): data is object {
	if (!data || typeof data !== "object") return false;
	try {
		return !Array.isArray(data);
	} catch {
		return false;
	}
}

function readPayloadProperty(
	data: object,
	key: "runId" | "objective" | "tokenBudget" | "reason",
): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: Reflect.get(data, key) };
	} catch {
		return { ok: false };
	}
}

function parseRunId(data: unknown): string | undefined {
	if (!isPayloadRecord(data)) return undefined;
	const runId = readPayloadProperty(data, "runId");
	return runId.ok && typeof runId.value === "string" && RUN_ID_PATTERN.test(runId.value)
		? runId.value
		: undefined;
}

function currentActiveGoal(runtime: GoalRuntime) {
	return runtime.activeGoal;
}

function parseStartPayload(data: unknown): string | Omit<GoalRunStartPayload, "runId"> {
	if (!isPayloadRecord(data)) return "start payload must be an object";
	const objectiveValue = readPayloadProperty(data, "objective");
	if (!objectiveValue.ok || typeof objectiveValue.value !== "string") {
		return "objective must be a string";
	}
	const objective = objectiveValue.value.trim();
	const objectiveError = validateObjective(objective);
	if (objectiveError) return objectiveError;
	const tokenBudgetValue = readPayloadProperty(data, "tokenBudget");
	if (
		!tokenBudgetValue.ok ||
		(tokenBudgetValue.value !== undefined &&
			(typeof tokenBudgetValue.value !== "number" ||
				!Number.isFinite(tokenBudgetValue.value) ||
				!Number.isSafeInteger(tokenBudgetValue.value) ||
				tokenBudgetValue.value <= 0))
	) {
		return "tokenBudget must be a positive integer";
	}
	return { objective, tokenBudget: tokenBudgetValue.value as number | undefined };
}

function parseCancelReason(data: unknown): string | undefined | { error: string } {
	if (!isPayloadRecord(data)) return { error: "cancel payload must be an object" };
	const reasonValue = readPayloadProperty(data, "reason");
	if (
		!reasonValue.ok ||
		(reasonValue.value !== undefined && typeof reasonValue.value !== "string")
	) {
		return { error: "reason must be a string" };
	}
	if (reasonValue.value === undefined) return undefined;
	const reason = reasonValue.value.trim();
	if (reason.length > MAX_CANCEL_REASON_LENGTH) {
		return { error: `reason must be at most ${MAX_CANCEL_REASON_LENGTH} characters` };
	}
	return reason || undefined;
}

export class GoalRunController {
	private readonly runtime: GoalRuntime;
	private readonly commands: GoalCommandController;
	private generation = 0;
	private session?: BoundSession;
	private run?: ManagedRun;
	private readonly usedRunIds = new Set<string>();

	constructor(runtime: GoalRuntime, commands: GoalCommandController) {
		this.runtime = runtime;
		this.commands = commands;
		this.runtime.setGoalStateSink((snapshot) => this.handleGoalState(snapshot));
	}

	register(pi: ExtensionAPI) {
		pi.events.on(GOAL_RUN_START_CHANNEL, (data) => this.handleStart(data));
		pi.events.on(GOAL_RUN_CANCEL_CHANNEL, (data) => {
			this.handleCancel(data);
		});
	}

	bindSession(ctx: StatusContext) {
		this.generation += 1;
		this.session = { generation: this.generation, ctx };
		this.closeCurrentRun();
		this.usedRunIds.clear();
	}

	unbindSession() {
		this.generation += 1;
		this.session = undefined;
		this.closeCurrentRun();
		this.usedRunIds.clear();
	}

	private async handleStart(data: unknown) {
		const runId = parseRunId(data);
		if (!runId) return;
		const session = this.session;
		if (!session) {
			this.emitError(runId, "start", "NO_ACTIVE_SESSION", "No active pi-goal session.");
			return;
		}
		if (!this.runtime.settings.rpc.enabled) {
			this.emitError(runId, "start", "RPC_DISABLED", "Managed run RPC is disabled.");
			return;
		}
		if (this.usedRunIds.has(runId)) {
			this.emitError(runId, "start", "RUN_ID_IN_USE", "runId was already used in this session.");
			return;
		}
		const parsed = parseStartPayload(data);
		if (typeof parsed === "string") {
			this.emitError(runId, "start", "INVALID_REQUEST", parsed);
			return;
		}
		if (this.session !== session || this.generation !== session.generation) {
			this.emitError(
				runId,
				"start",
				"SUPERSEDED",
				"The pi-goal session changed while validating the request.",
			);
			return;
		}
		if (this.usedRunIds.has(runId)) {
			this.emitError(runId, "start", "RUN_ID_IN_USE", "runId was already used in this session.");
			return;
		}
		if (this.runtime.activeGoal || (this.run && !this.run.closed)) {
			this.emitError(runId, "start", "GOAL_ALREADY_EXISTS", "A Goal already exists.");
			return;
		}

		const run: ManagedRun = {
			runId,
			generation: session.generation,
			closed: false,
			cancelRequested: false,
		};
		this.run = run;
		this.usedRunIds.add(runId);

		try {
			await this.commands.startGoal(
				parsed.objective,
				parsed.tokenBudget,
				session.ctx,
				(goal) => {
					if (this.ownsRun(run, session.generation)) run.goalId = goal.id;
				},
				() => this.ownsRun(run, session.generation),
			);
		} catch (error) {
			if (this.ownsRun(run, session.generation)) {
				this.closeCurrentRun();
				this.emitError(
					runId,
					"start",
					"ACTIVATION_FAILED",
					`Goal activation failed: ${formatError(error)}`,
				);
			}
			return;
		}

		if (!this.ownsRun(run, session.generation)) return;
		if (!run.goalId) {
			this.closeCurrentRun();
			this.emitError(runId, "start", "ACTIVATION_FAILED", "Goal activation did not create a Goal.");
			return;
		}
		if (currentActiveGoal(this.runtime)?.id !== run.goalId) {
			this.closeCurrentRun();
			this.emitError(runId, "start", "SUPERSEDED", "The managed Goal was superseded.");
			return;
		}
		if (run.cancelRequested) this.cancelActiveRun(run, session, run.cancelReason);
	}

	private handleCancel(data: unknown) {
		const runId = parseRunId(data);
		if (!runId) return;
		const session = this.session;
		if (!session) {
			this.emitError(runId, "cancel", "NO_ACTIVE_SESSION", "No active pi-goal session.");
			return;
		}
		const reason = parseCancelReason(data);
		if (reason && typeof reason === "object") {
			this.emitError(runId, "cancel", "INVALID_REQUEST", reason.error);
			return;
		}
		const run = this.run;
		if (!run || run.closed || run.runId !== runId || run.generation !== session.generation) {
			this.emitError(runId, "cancel", "RUN_NOT_FOUND", "No active managed run matches runId.");
			return;
		}
		if (!run.goalId) {
			run.cancelRequested = true;
			run.cancelReason = reason;
			return;
		}
		this.cancelActiveRun(run, session, reason);
	}

	private cancelActiveRun(run: ManagedRun, session: BoundSession, reason: string | undefined) {
		if (!this.ownsRun(run, session.generation)) return;
		const goal = this.runtime.activeGoal;
		if (!goal || goal.id !== run.goalId) {
			this.closeCurrentRun();
			this.emitError(run.runId, "cancel", "SUPERSEDED", "The managed Goal was superseded.");
			return;
		}
		if (goal.status !== "active") {
			this.closeCurrentRun();
			this.emitError(run.runId, "cancel", "RUN_NOT_FOUND", "The managed run is no longer active.");
			return;
		}
		this.runtime.setTerminalReason(goal.id, reason ?? "goal cancelled by managed run");
		this.commands.pauseGoal(session.ctx, {
			source: "managed_run",
			cause: "consumer_cancel",
		});
	}

	private handleGoalState(snapshot: GoalStateSnapshot) {
		const run = this.run;
		if (!run || run.closed || !run.goalId) return;
		if (run.goalId !== snapshot.goalId) {
			if (currentActiveGoal(this.runtime)?.id !== snapshot.goalId) return;
			this.publishStateEvent(run, {
				goalId: run.goalId,
				status: "cleared",
				reason: "managed Goal superseded by another Goal",
			});
			return;
		}
		if (snapshot.status === "queued" || run.lastStatus === snapshot.status) return;
		this.publishStateEvent(run, snapshot);
	}

	private publishStateEvent(
		run: ManagedRun,
		snapshot: Pick<GoalStateSnapshot, "goalId" | "status" | "summary" | "reason" | "transition">,
	) {
		const status = snapshot.status;
		if (status === "queued") return;
		run.lastStatus = status;
		const event: GoalRunEvent = {
			type: "state",
			runId: run.runId,
			goalId: snapshot.goalId,
			status,
			...(snapshot.summary ? { summary: snapshot.summary } : {}),
			...(snapshot.reason ? { reason: snapshot.reason } : {}),
			...(snapshot.transition ? { transition: snapshot.transition } : {}),
		};
		if (!isTerminalGoalStatus(status)) {
			this.runtime.pi.events.emit(goalRunEventChannel(run.runId), event);
			return;
		}

		run.closed = true;
		this.run = undefined;
		const generation = run.generation;
		// Active stays synchronous so a listener can cancel before kickoff. Terminal
		// publication waits until the transition finishes, preventing listener work
		// from being overwritten by the old transition's remaining UI or cleanup.
		queueMicrotask(() => {
			if (this.generation !== generation) return;
			this.runtime.pi.events.emit(goalRunEventChannel(run.runId), event);
		});
	}

	private emitError(
		runId: string,
		operation: "start" | "cancel",
		code: GoalRunErrorCode,
		message: string,
	) {
		this.runtime.pi.events.emit(goalRunEventChannel(runId), {
			type: "error",
			runId,
			operation,
			error: { code, message },
		} satisfies GoalRunEvent);
	}

	private ownsRun(run: ManagedRun, generation: number) {
		return (
			this.session?.generation === generation &&
			this.generation === generation &&
			this.run === run &&
			!run.closed
		);
	}

	private closeCurrentRun() {
		if (this.run) this.run.closed = true;
		this.run = undefined;
	}
}
