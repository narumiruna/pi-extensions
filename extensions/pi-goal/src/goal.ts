import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GoalStatus = "active" | "paused" | "budget_limited" | "complete";
type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

interface ActiveGoal {
	id: string;
	text: string;
	status: GoalStatus;
	startedAt: number;
	updatedAt: number;
	iteration: number;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	baselineTokens: number;
}

interface GoalCompleteDetails {
	goal: string;
	summary: string;
}

interface ContinuationPending {
	goalId: string;
	iteration: number;
	marker: string;
	prompt: string;
}

interface AssistantMessageLike {
	role: "assistant";
	stopReason?: AgentStopReason;
	errorMessage?: string;
}

interface GoalStateEntryData {
	goal?: ActiveGoal | null;
}

interface CommandResult {
	kind: "show" | "start" | "pause" | "resume" | "clear" | "edit";
	objective?: string;
	tokenBudget?: number;
}

interface StatusContext {
	cwd: string;
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	sessionManager?: unknown;
}

const STATUS_KEY = "goal";
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const MAX_OBJECTIVE_LENGTH = 4_000;
const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
const CONTINUATION_MARKER_PREFIX = "pi-goal-continuation:";
const STATE_FILE = join(
	process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"),
	"pi-goal-state.json",
);

let activeGoal: ActiveGoal | undefined;
let completionStatusTimer: NodeJS.Timeout | undefined;
let extensionApi: ExtensionAPI | undefined;
let continuationPending: ContinuationPending | undefined;
const cancelledContinuationMarkers = new Set<string>();

const goalCompleteTool = defineTool({
	name: "goal_complete",
	label: "Goal Complete",
	description:
		"Mark the active /goal as complete. Only call this after the requested goal is fully done and verified.",
	promptSnippet: "Mark the active /goal as complete after fully finishing and verifying it",
	promptGuidelines: [
		"When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
		"Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
		"Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains.",
	],
	parameters: Type.Object({
		summary: Type.String({
			description: "Concise summary of what was completed and how it was verified.",
		}),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const completedGoal = activeGoal;
		if (completedGoal) {
			activeGoal = transitionGoal(completedGoal, "complete");
			updateGoalUsage(activeGoal, ctx);
			persistGoal(activeGoal);
		}

		const goal = completedGoal?.text ?? "unknown goal";
		const summary = params.summary.trim();

		ctx.ui.setStatus(STATUS_KEY, completedGoal ? formatStatus(activeGoal) : undefined);
		clearActiveGoal(ctx);
		showCompletionStatus(ctx);
		ctx.ui.notify(`Goal complete: ${goal}`, "info");

		return {
			content: [{ type: "text", text: `Goal complete: ${summary}` }],
			details: { goal, summary } satisfies GoalCompleteDetails,
			terminate: true,
		};
	},
});

export default function goal(pi: ExtensionAPI) {
	extensionApi = pi;
	pi.registerTool(goalCompleteTool);

	pi.registerCommand("goal", {
		description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
		handler: async (args, ctx) => {
			const result = parseCommand(args);
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
				return;
			}

			switch (result.kind) {
				case "show":
					showGoal(ctx);
					return;
				case "pause":
					pauseGoal(ctx);
					return;
				case "resume":
					await resumeGoal(pi, ctx);
					return;
				case "clear":
					clearGoal(ctx);
					return;
				case "edit":
					await editGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
				case "start":
					await startGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearCompletionStatusTimer();
		clearContinuationTracking();
		activeGoal = loadGoalFromSession(ctx);
		if (activeGoal) updateStatus(ctx, activeGoal);
		else ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (activeGoal) persistGoal(activeGoal);
		clearContinuationTracking();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearCompletionStatusTimer();
	});

	pi.on("input", (event) => {
		if (event.source !== "extension") return;
		if (consumeCancelledContinuationPrompt(event.text)) return { action: "handled" as const };
	});

	pi.on("before_agent_start", (event) => {
		markContinuationDelivered(event.prompt);
		if (!activeGoal || activeGoal.status !== "active") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(activeGoal)}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!activeGoal || activeGoal.status !== "active") return;

		const goalId = activeGoal.id;
		const hadPendingContinuation = continuationPending?.goalId === goalId;
		const finalAssistant = findFinalAssistantMessage(event.messages);

		if (!hadPendingContinuation) activeGoal = incrementGoal(activeGoal);
		updateGoalUsage(activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted" || finalAssistant?.stopReason === "error") {
			pauseGoalAfterAgentEnd(ctx, activeGoal, finalAssistant);
			return;
		}

		if (activeGoal.tokenBudget !== undefined && activeGoal.tokensUsed >= activeGoal.tokenBudget) {
			cancelContinuationPending();
			activeGoal = transitionGoal(activeGoal, "budget_limited");
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			ctx.ui.notify(`Goal token budget reached: ${formatBudget(activeGoal)}`, "warning");
			return;
		}

		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);

		if (hadPendingContinuation) {
			if (hasPendingMessages(ctx)) return;
			if (continuationPending?.goalId === goalId) continuationPending = undefined;
		}

		const currentGoal = activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (hasPendingMessages(ctx)) return;
		await sendContinuationPrompt(pi, ctx, currentGoal);
	});
}

async function startGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError, "warning");
		return;
	}

	const existingGoal = activeGoal?.status !== "complete" ? activeGoal : undefined;
	if (existingGoal) {
		const shouldReplace = await ctx.ui.confirm(
			"Replace goal?",
			`Current goal: ${existingGoal.text}\n\nNew goal: ${objective}`,
		);
		if (!shouldReplace) {
			ctx.ui.notify(`Goal kept: ${existingGoal.text}`, "info");
			return;
		}
	}

	cancelContinuationPending();
	activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`, "info");
	await sendGoalPrompt(pi, ctx, activeGoal);
}

function pauseGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	if (activeGoal.status !== "active") {
		ctx.ui.notify(`Goal is ${activeGoal.status}; only active goals can be paused.`, "warning");
		return;
	}
	cancelContinuationPending();
	activeGoal = transitionGoal(activeGoal, "paused");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(`Goal paused: ${activeGoal.text}`, "info");
}

async function resumeGoal(pi: ExtensionAPI, ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	if (activeGoal.status !== "paused" && activeGoal.status !== "budget_limited") {
		ctx.ui.notify(`Goal is ${activeGoal.status}; only paused or budget-limited goals can be resumed.`, "warning");
		return;
	}
	activeGoal = transitionGoal(activeGoal, "active");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	if (activeGoal.status !== "active") {
		ctx.ui.notify(`Goal token budget is still reached: ${formatBudget(activeGoal)}`, "warning");
		return;
	}
	ctx.ui.notify(`Goal resumed: ${activeGoal.text}`, "info");
	await sendResumePrompt(pi, ctx, activeGoal);
}

function clearGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		cancelContinuationPending();
		clearPersistedGoal(ctx.cwd);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const stoppedGoal = activeGoal.text;
	clearActiveGoal(ctx);
	ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
}

async function editGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError, "warning");
		return;
	}
	if (!activeGoal) {
		ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
		return;
	}

	updateGoalUsage(activeGoal, ctx);
	cancelContinuationPending();
	activeGoal = normalizeGoalForBudget({
		...activeGoal,
		text: objective,
		status: editedGoalStatus(activeGoal.status),
		tokenBudget: tokenBudget ?? activeGoal.tokenBudget,
		updatedAt: Date.now(),
	});
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(`Goal updated: ${objective}`, "info");
	if (activeGoal.status === "active") await sendObjectiveUpdatedPrompt(pi, ctx, activeGoal);
}

function showGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("Usage: /goal <objective>\nNo goal is currently set.", "info");
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	updateGoalUsage(activeGoal, ctx);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(goalSummary(activeGoal), "info");
}

function createGoal(text: string, tokenBudget: number | undefined, baselineTokens: number): ActiveGoal {
	const now = Date.now();
	return {
		id: randomUUID(),
		text,
		status: "active",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens,
	};
}

function transitionGoal(goal: ActiveGoal, status: GoalStatus): ActiveGoal {
	return normalizeGoalForBudget({ ...goal, status, updatedAt: Date.now() });
}

function editedGoalStatus(status: GoalStatus): GoalStatus {
	return status === "paused" ? "paused" : "active";
}

function normalizeGoalForBudget(goal: ActiveGoal): ActiveGoal {
	if (
		goal.status === "active" &&
		goal.tokenBudget !== undefined &&
		goal.tokensUsed >= goal.tokenBudget
	) {
		return { ...goal, status: "budget_limited" };
	}
	return goal;
}

function incrementGoal(goal: ActiveGoal): ActiveGoal {
	return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

function pauseGoalAfterAgentEnd(
	ctx: StatusContext,
	goal: ActiveGoal,
	assistant: AssistantMessageLike,
) {
	cancelContinuationPending();
	activeGoal = transitionGoal(goal, "paused");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);

	const reason = assistant.stopReason === "aborted" ? "interruption" : "agent error";
	const details = assistant.errorMessage ? ` (${truncateNotification(assistant.errorMessage)})` : "";
	ctx.ui.notify(`Goal paused after ${reason}${details}. Run /goal resume to continue.`, "warning");
}

function updateGoalUsage(goal: ActiveGoal, ctx: StatusContext) {
	goal.tokensUsed = Math.max(0, currentTokenTotal(ctx) - goal.baselineTokens);
	goal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - goal.startedAt) / 1000));
	goal.updatedAt = Date.now();
}

export function parseCommand(args: string): CommandResult | string {
	const tokens = tokenize(args.trim());
	if (tokens.length === 0) return { kind: "show" };

	const [first, ...rest] = tokens;
	if (first === "pause") return rest.length === 0 ? { kind: "pause" } : "Usage: /goal pause";
	if (first === "resume") return rest.length === 0 ? { kind: "resume" } : "Usage: /goal resume";
	if (first === "clear" || first === "stop") return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";
	if (first === "status") return rest.length === 0 ? { kind: "show" } : "Usage: /goal status";
	if (first === "edit") return parseObjective("edit", rest);
	return parseObjective("start", tokens);
}

function parseObjective(kind: "start" | "edit", tokens: string[]): CommandResult | string {
	let tokenBudget: number | undefined;
	const objectiveTokens = [...tokens];

	if (objectiveTokens[0] === "--tokens") {
		const rawBudget = objectiveTokens[1];
		if (!rawBudget) return "Usage: /goal --tokens 100k <goal_to_complete>";
		const parsedBudget = parseTokenBudget(rawBudget);
		if (parsedBudget === undefined) return `Invalid token budget: ${rawBudget}`;
		tokenBudget = parsedBudget;
		objectiveTokens.splice(0, 2);
	}

	if (objectiveTokens.length === 0) {
		return kind === "edit" ? "Usage: /goal edit <goal_to_complete>" : "Usage: /goal <goal_to_complete>";
	}

	return { kind, objective: objectiveTokens.join(" "), tokenBudget };
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;

	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function parseTokenBudget(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return Math.floor(amount * multiplier);
}

export function validateObjective(objective: string): string | undefined {
	const trimmed = objective.trim();
	if (!trimmed) return "Usage: /goal <goal_to_complete>";
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		return `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
	}
	return undefined;
}

async function sendGoalPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildGoalPrompt(goal));
}

async function sendObjectiveUpdatedPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildObjectiveUpdatedPrompt(goal));
}

async function sendResumePrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildResumePrompt(goal));
}

async function sendContinuationPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	if (continuationPending?.goalId === goal.id) return false;
	if (hasPendingMessages(ctx)) return false;

	const marker = continuationMarker(goal);
	const prompt = buildContinuePrompt(goal, marker);
	continuationPending = { goalId: goal.id, iteration: goal.iteration, marker, prompt };
	const sent = await sendPrompt(pi, ctx, prompt);
	if (!sent && continuationPending?.marker === marker) continuationPending = undefined;
	return sent;
}

async function sendPrompt(pi: ExtensionAPI, ctx: StatusContext, prompt: string) {
	try {
		const sent = ctx.isIdle?.()
			? (pi.sendUserMessage(prompt) as void | Promise<void>)
			: (pi.sendUserMessage(prompt, { deliverAs: "followUp" }) as void | Promise<void>);
		await sent;
		return true;
	} catch (error) {
		ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
		return false;
	}
}

function updateStatus(ctx: StatusContext, goal: ActiveGoal) {
	clearCompletionStatusTimer();
	ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
}

export function formatStatus(goal: ActiveGoal | undefined) {
	if (!goal) return undefined;
	if (goal.status === "complete") return "🎯 complete";
	if (goal.status === "paused") return "🎯 paused";
	if (goal.status === "budget_limited") return `🎯 budget ${formatBudget(goal)}`;
	if (goal.tokenBudget !== undefined) return `🎯 active ${formatBudget(goal)}`;
	return `🎯 active ${formatDuration(goal.timeUsedSeconds)}`;
}

function formatBudget(goal: ActiveGoal) {
	return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}

function goalSummary(goal: ActiveGoal) {
	return [
		`Goal: ${goal.text}`,
		`Status: ${goal.status}`,
		`Iteration: ${goal.iteration}`,
		`Elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
		`Commands: ${goalCommandHint(goal.status)}`,
	].join("\n");
}

function goalCommandHint(status: GoalStatus) {
	if (status === "active") return "/goal edit <objective>, /goal pause, /goal clear";
	if (status === "paused") return "/goal edit <objective>, /goal resume, /goal clear";
	return "/goal edit <objective>, /goal clear";
}

export function formatDuration(seconds: number) {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatTokenCount(value: number) {
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
	return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

function buildGoalPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatTokenCount(goal.tokenBudget)}.`;
	return `Goal mode is active. Complete this goal fully:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

function buildObjectiveUpdatedPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The active /goal objective was updated. Continue working toward this goal:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("the updated goal")}`;
}

function buildResumePrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The user explicitly resumed the paused /goal. Continue working toward this goal:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

export function buildGoalSystemPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\n- Respect the goal token budget (${formatBudget(goal)} used).`;
	return `Active /goal:\n${goalObjectiveBlock(goal)}\n\nGoal-mode rules:\n- Keep going until the active goal is completely resolved end-to-end.\n- Treat the current worktree, command output, tests, and external state as authoritative.\n- Do not redefine the goal into a smaller task; audit every requirement before completion.\n- Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps.\n- Autonomously perform implementation and verification with the available tools when they are needed to complete the goal.\n- Persevere through recoverable tool failures by trying reasonable alternatives instead of yielding early.\n- If the goal is not complete at the end of a turn, expect an automatic continuation and keep working from where you left off.\n- Only call the goal_complete tool after the goal is fully complete and verified.${budgetLine}`;
}

function buildContinuePrompt(goal: ActiveGoal, marker: string) {
	return `Continue the active /goal until it is complete:\n\n${goalObjectiveBlock(goal)}\n\nThis is automatic continuation #${goal.iteration}. Current files, command output, tests, and external state are authoritative; re-check them as needed. ${goalPersistenceRules("this goal")}\n\n${continuationMarkerComment(marker)}`;
}

function goalObjectiveBlock(goal: ActiveGoal) {
	return `<goal_objective>\n${escapeXmlText(goal.text)}\n</goal_objective>`;
}

function goalPersistenceRules(goalLabel: string) {
	return `Keep going until ${goalLabel} is completely resolved end-to-end. Do not redefine ${goalLabel} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit ${goalLabel} requirement by requirement against the verified current state. Only call the goal_complete tool after ${goalLabel} is fully complete and verified.`;
}

function hasPendingMessages(ctx: StatusContext) {
	return ctx.hasPendingMessages?.() ?? false;
}

function clearContinuationTracking() {
	continuationPending = undefined;
	cancelledContinuationMarkers.clear();
}

function cancelContinuationPending() {
	if (continuationPending) rememberCancelledContinuationMarker(continuationPending.marker);
	continuationPending = undefined;
}

function rememberCancelledContinuationMarker(marker: string) {
	cancelledContinuationMarkers.add(marker);
	if (cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
	const oldest = cancelledContinuationMarkers.values().next().value;
	if (oldest) cancelledContinuationMarkers.delete(oldest);
}

function consumeCancelledContinuationPrompt(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	return marker ? cancelledContinuationMarkers.delete(marker) : false;
}

function markContinuationDelivered(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	if (marker && continuationPending?.marker === marker) continuationPending = undefined;
}

function continuationMarker(goal: ActiveGoal) {
	return `${goal.id}:${goal.iteration}`;
}

function continuationMarkerComment(marker: string) {
	return `<!-- ${CONTINUATION_MARKER_PREFIX}${marker} -->`;
}

function escapeRegExpText(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CONTINUATION_MARKER_PATTERN = new RegExp(
	`<!--\\s*${escapeRegExpText(CONTINUATION_MARKER_PREFIX)}([^\\s>]+)\\s*-->`,
);

function extractContinuationMarker(prompt: string) {
	return CONTINUATION_MARKER_PATTERN.exec(prompt)?.[1];
}

export function findFinalAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const candidate = message as Record<string, unknown>;
		if (candidate.role !== "assistant") continue;
		return {
			role: "assistant",
			stopReason: isAgentStopReason(candidate.stopReason) ? candidate.stopReason : undefined,
			errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
		};
	}
	return undefined;
}

function isAgentStopReason(value: unknown): value is AgentStopReason {
	return ["stop", "length", "toolUse", "error", "aborted"].includes(String(value));
}

function escapeXmlText(value: string) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatError(error: unknown) {
	return truncateNotification(error instanceof Error ? error.message : String(error));
}

function truncateNotification(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function currentTokenTotal(ctx: StatusContext): number {
	const sessionManager = ctx.sessionManager as
		| { getBranch?: () => Array<{ type?: string; message?: { role?: string; usage?: unknown } }> }
		| undefined;
	const branch = sessionManager?.getBranch?.() ?? [];
	let total = 0;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage as { input?: number; output?: number } | undefined;
		total += usage?.input ?? 0;
		total += usage?.output ?? 0;
	}
	return total;
}

function persistGoal(goal: ActiveGoal) {
	extensionApi?.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY_TYPE, { goal });
}

function clearPersistedGoal(cwd: string) {
	extensionApi?.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY_TYPE, { goal: null });
	clearLegacyPersistedGoal(cwd);
}

function loadGoalFromSession(ctx: StatusContext): ActiveGoal | undefined {
	const sessionManager = ctx.sessionManager as
		| {
				getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
				getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
			}
		| undefined;
	const entries = sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];
	const entry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE)
		.pop();
	const data = entry?.data as GoalStateEntryData | undefined;
	return isGoal(data?.goal) && data.goal.status !== "complete" ? data.goal : undefined;
}

function clearActiveGoal(ctx: StatusContext) {
	cancelContinuationPending();
	activeGoal = undefined;
	clearPersistedGoal(ctx.cwd);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function showCompletionStatus(ctx: StatusContext) {
	clearCompletionStatusTimer();
	ctx.ui.setStatus(STATUS_KEY, "🎯 complete");
	completionStatusTimer = setTimeout(() => {
		completionStatusTimer = undefined;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// The completion status is best-effort; the captured ctx may be stale after
			// session replacement or reload before this timer fires.
		}
	}, 8_000);
}

function clearCompletionStatusTimer() {
	if (!completionStatusTimer) return;
	clearTimeout(completionStatusTimer);
	completionStatusTimer = undefined;
}

function readState(): Record<string, unknown> {
	if (!existsSync(STATE_FILE)) return {};
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function clearLegacyPersistedGoal(cwd: string) {
	if (!existsSync(STATE_FILE)) return;
	const goals = readState();
	delete goals[cwd];
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(goals, null, 2)}\n`);
}


function isGoal(value: unknown): value is ActiveGoal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<ActiveGoal>;
	return (
		typeof goal.id === "string" &&
		typeof goal.text === "string" &&
		["active", "paused", "budget_limited", "complete"].includes(String(goal.status)) &&
		typeof goal.startedAt === "number" &&
		typeof goal.updatedAt === "number" &&
		typeof goal.iteration === "number" &&
		typeof goal.tokensUsed === "number" &&
		typeof goal.timeUsedSeconds === "number" &&
		typeof goal.baselineTokens === "number"
	);
}
