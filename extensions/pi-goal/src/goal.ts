import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

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
	sessionManager?: unknown;
}

const STATUS_KEY = "goal";
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const MAX_OBJECTIVE_LENGTH = 4_000;
const STATE_FILE = join(
	process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"),
	"pi-goal-state.json",
);

let activeGoal: ActiveGoal | undefined;
let completionStatusTimer: NodeJS.Timeout | undefined;
let extensionApi: ExtensionAPI | undefined;

const goalCompleteTool = defineTool({
	name: "goal_complete",
	label: "Goal Complete",
	description:
		"Mark the active /goal as complete. Only call this after the requested goal is fully done and verified.",
	promptSnippet: "Mark the active /goal as complete after fully finishing and verifying it",
	promptGuidelines: [
		"When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
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
					resumeGoal(ctx);
					return;
				case "clear":
					clearGoal(ctx);
					return;
				case "edit":
					editGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
				case "start":
					await startGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		activeGoal = loadGoalFromSession(ctx);
		if (activeGoal) updateStatus(ctx, activeGoal);
		else ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (activeGoal) persistGoal(activeGoal);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (completionStatusTimer) clearTimeout(completionStatusTimer);
	});

	pi.on("before_agent_start", (event) => {
		if (!activeGoal || activeGoal.status !== "active") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(activeGoal)}`,
		};
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!activeGoal || activeGoal.status !== "active") return;

		const goalId = activeGoal.id;
		activeGoal = incrementGoal(activeGoal);
		updateGoalUsage(activeGoal, ctx);

		if (activeGoal.tokenBudget !== undefined && activeGoal.tokensUsed >= activeGoal.tokenBudget) {
			activeGoal = transitionGoal(activeGoal, "budget_limited");
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			ctx.ui.notify(`Goal token budget reached: ${formatBudget(activeGoal)}`, "warning");
			return;
		}

		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);

		const currentGoal = activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		pi.sendUserMessage(buildContinuePrompt(currentGoal), { deliverAs: "followUp" });
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

	activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`, "info");
	sendGoalPrompt(pi, ctx, activeGoal);
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
	activeGoal = transitionGoal(activeGoal, "paused");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(`Goal paused: ${activeGoal.text}`, "info");
}

function resumeGoal(ctx: StatusContext) {
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
	ctx.ui.notify(`Goal resumed: ${activeGoal.text}`, "info");
}

function clearGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		clearPersistedGoal(ctx.cwd);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const stoppedGoal = activeGoal.text;
	clearActiveGoal(ctx);
	ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
}

function editGoal(
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
	if (activeGoal.status === "active") sendObjectiveUpdatedPrompt(pi, ctx, activeGoal);
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

function updateGoalUsage(goal: ActiveGoal, ctx: StatusContext) {
	goal.tokensUsed = Math.max(0, currentTokenTotal(ctx) - goal.baselineTokens);
	goal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - goal.startedAt) / 1000));
	goal.updatedAt = Date.now();
}

function parseCommand(args: string): CommandResult | string {
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

function parseTokenBudget(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return Math.floor(amount * multiplier);
}

function validateObjective(objective: string): string | undefined {
	const trimmed = objective.trim();
	if (!trimmed) return "Usage: /goal <goal_to_complete>";
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		return `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
	}
	return undefined;
}

function sendGoalPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	const prompt = buildGoalPrompt(goal);
	if (ctx.isIdle?.()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function sendObjectiveUpdatedPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	const prompt = buildObjectiveUpdatedPrompt(goal);
	if (ctx.isIdle?.()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function updateStatus(ctx: StatusContext, goal: ActiveGoal) {
	ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
}

function formatStatus(goal: ActiveGoal | undefined) {
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

function formatDuration(seconds: number) {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function formatTokenCount(value: number) {
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
	return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

function buildGoalPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatTokenCount(goal.tokenBudget)}.`;
	return `Goal mode is active. Complete this goal fully:\n\n${goal.text}${budgetLine}\n\nKeep working until the goal is done. Do not stop after planning or partial progress. When the goal is fully complete and verified, call the goal_complete tool with a concise completion summary.`;
}

function buildObjectiveUpdatedPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The active /goal objective was updated. Continue working toward this goal:\n\n${goal.text}${budgetLine}\n\nKeep working until the updated goal is fully complete and verified, then call the goal_complete tool.`;
}

function buildGoalSystemPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\n- Respect the goal token budget (${formatBudget(goal)} used).`;
	return `Active /goal: ${goal.text}\n\nGoal-mode rules:\n- Continue making concrete progress until the active goal is fully complete.\n- Do not end your response with only a plan, TODO list, or partial progress.\n- Verify the result when possible using appropriate checks.\n- If the goal is not complete at the end of a turn, expect an automatic follow-up and continue from where you left off.\n- Only call the goal_complete tool after the goal is fully complete and verified.${budgetLine}`;
}

function buildContinuePrompt(goal: ActiveGoal) {
	return `Continue the active /goal until it is complete:\n\n${goal.text}\n\nThis is automatic continuation #${goal.iteration}. If the goal is not complete yet, keep working and verify progress. If it is fully complete and verified, call the goal_complete tool.`;
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
	activeGoal = undefined;
	clearPersistedGoal(ctx.cwd);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function showCompletionStatus(ctx: StatusContext) {
	if (completionStatusTimer) clearTimeout(completionStatusTimer);
	ctx.ui.setStatus(STATUS_KEY, "🎯 complete");
	completionStatusTimer = setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 8_000);
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
