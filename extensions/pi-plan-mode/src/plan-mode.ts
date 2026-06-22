import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "plan-mode-state";
const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";
const PLAN_CONTEXT_MESSAGE_TYPE = "plan-mode-context";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";
const PLAN_CONTEXT_MARKER = "[CODEX-LIKE PLAN MODE ACTIVE]";
const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const TOOL_SELECTOR_PAGE_SIZE = 10;
const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const PROPOSED_PLAN_BLOCK_PATTERN = /<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>/gi;

interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

interface PlanModeState {
	enabled: boolean;
	latestPlan?: string;
	awaitingAction: boolean;
	selectedToolNames?: string[];
	selectedToolKeys?: string[];
}

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: Partial<PlanModeState>;
	message?: SessionMessage;
};

type SessionMessage = {
	role?: string;
	content?: unknown;
};

type TextBlock = {
	type?: string;
	text?: string;
};

type PlanModeQuestionOption = {
	label: string;
	description?: string;
};

type PlanModeQuestion = {
	id: string;
	header: string;
	question: string;
	options: PlanModeQuestionOption[];
};

type PlanModeQuestionParams = {
	questions: PlanModeQuestion[];
};

type PlanModeQuestionAnswer = {
	id: string;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
};

type PlanModeQuestionReason = "cancelled" | "ui_unavailable" | "plan_mode_inactive" | "invalid_input";

type PlanModeQuestionDetails = {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	questions: PlanModeQuestion[];
	answers?: PlanModeQuestionAnswer[];
};

const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "exit", label: "exit", description: "Leave Plan mode" },
	{ value: "off", label: "off", description: "Leave Plan mode" },
	{ value: "tools", label: "tools", description: "Select tools allowed in Plan mode" },
];

const PLAN_MODE_QUESTION_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["questions"],
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			description: "Questions to show the user. Prefer 1 and do not exceed 3.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "header", "question", "options"],
				properties: {
					id: {
						type: "string",
						description: "Stable identifier for mapping answers (snake_case).",
					},
					header: {
						type: "string",
						description: "Short header label shown in the UI (12 or fewer chars).",
					},
					question: {
						type: "string",
						description: "Single-sentence prompt shown to the user.",
					},
					options: {
						type: "array",
						minItems: 2,
						maxItems: 4,
						description:
							"Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["label", "description"],
							properties: {
								label: {
									type: "string",
									description: "User-facing label (1-5 words).",
								},
								description: {
									type: "string",
									description: "One short sentence explaining impact/tradeoff if selected.",
								},
							},
						},
					},
				},
			},
		},
	},
} as const;

const MUTATING_BASH_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|version)\b/i,
	/\byarn\s+(add|remove|install|publish|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish|update)\b/i,
	/\bbun\s+(add|remove|install|update|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\buv\s+(add|remove|sync|lock|pip\s+install)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_BASH_PATTERNS = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|jq|awk|rg|fd|bat|eza)\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|grep)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*(node|python|python3|npm|tsc|biome|ruff|ty)\s+--version\b/i,
];

export default function planMode(pi: ExtensionAPI) {
	let state: PlanModeState = { enabled: false, awaitingAction: false };
	let previousTools: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in Codex-like Plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
		promptSnippet: "Ask user decision questions while Plan mode is active",
		promptGuidelines: [
			"In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
		parameters: PLAN_MODE_QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return planModeQuestionCancelled(
					[],
					"plan_mode_inactive",
					"Error: plan_mode_question is only available while Plan mode is active.",
				);
			}

			const parsed = normalizePlanModeQuestionParams(params);
			if (!parsed.ok) {
				return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
			}

			if (!ctx.hasUI) {
				return planModeQuestionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Unable to ask Plan-mode questions because interactive UI is not available.",
				);
			}

			const answers = await askPlanModeQuestions(parsed.questions, ctx);
			if (!answers) {
				return planModeQuestionCancelled(
					parsed.questions,
					"cancelled",
					"User cancelled the Plan-mode question prompt.",
				);
			}

			return planModeQuestionAnswered(parsed.questions, answers);
		},
	});

	pi.registerCommand("plan", {
		description: "Enter or manage Codex-like Plan mode",
		getArgumentCompletions: completePlanArguments,
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const command = prompt.toLowerCase();
			if (command === "exit" || command === "off") {
				exitPlanMode(ctx);
				ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
				return;
			}
			if (command === "tools") {
				if (!state.enabled) enterPlanMode(ctx);
				await showToolSelector(ctx);
				return;
			}
			if (prompt) {
				enterPlanModeWithPrompt(prompt, ctx);
				return;
			}
			if (!state.enabled) {
				enterPlanMode(ctx);
				ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
				return;
			}
			await showPlanMenu(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
		if (pi.getFlag("plan") === true) state.enabled = true;
		if (state.enabled) activatePlanModeTools();
		else deactivatePlanModeQuestionTool();
		updateUi(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persistState();
		clearUi(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;
		if (isBlockedBuiltinToolName(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode blocks built-in mutating tool '${event.toolName}'. Use /plan and choose implementation when the plan is ready.`,
			};
		}
		if (event.toolName !== "bash" || !isBuiltinToolName(event.toolName)) return;

		const command = readCommand(event.input);
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode blocks mutating or non-allowlisted bash commands.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		const messagesWithoutLegacyPlanContext = event.messages.filter(
			(message: unknown) => !messageContainsLegacyPlanModeContextArtifact(message),
		);
		if (state.enabled) return { messages: messagesWithoutLegacyPlanContext };
		return {
			messages: messagesWithoutLegacyPlanContext
				.filter((message: unknown) => !messageContainsInactivePlanModeArtifact(message))
				.map(stripProposedPlanBlocksFromMessage),
		};
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.enabled) return;
		if (state.latestPlan || state.awaitingAction) {
			state = { ...state, latestPlan: undefined, awaitingAction: false };
			persistState();
			updateUi(ctx);
		}
		applyPlanModeTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled) return;

		const text = latestAssistantText(event.messages);
		const proposedPlan = extractProposedPlan(text);
		if (!proposedPlan) {
			persistState();
			updateUi(ctx);
			return;
		}

		state = { ...state, latestPlan: proposedPlan, awaitingAction: true };
		persistState();
		updateUi(ctx);

		scheduleAfterCurrentAgentRun(async () => {
			if (!state.enabled || state.latestPlan !== proposedPlan) return;
			if (ctx.hasUI) await showPlanReadyMenu(ctx);
			if (!state.enabled || state.latestPlan !== proposedPlan) return;

			pi.sendMessage(
				{
					customType: PROPOSED_PLAN_MESSAGE_TYPE,
					content: `**Proposed Plan**\n\n${proposedPlan}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		});
	});

	function enterPlanMode(ctx: ExtensionContext) {
		if (!state.enabled) previousTools = withoutPlanModeQuestionTool(safeGetActiveTools());
		state = { ...state, enabled: true, awaitingAction: false };
		activatePlanModeTools();
		persistState();
		updateUi(ctx);
	}

	function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		enterPlanMode(ctx);
		if (!wasEnabled) {
			ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
		}
		sendPlanModeUserMessage(prompt, ctx);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		state = { ...state, enabled: false, latestPlan: undefined, awaitingAction: false };
		if (wasEnabled) restoreTools();
		persistState();
		updateUi(ctx);
	}

	function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
		if (ctx.isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	function scheduleAfterCurrentAgentRun(task: () => Promise<void> | void) {
		setTimeout(() => {
			void Promise.resolve(task()).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Plan mode follow-up failed: ${message}`);
			});
		}, 0);
	}

	function startImplementation(ctx: ExtensionContext) {
		const plan = state.latestPlan?.trim();
		exitPlanMode(ctx);

		if (!plan) {
			ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
			return;
		}

		sendPlanModeUserMessage(
			`Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n${plan}`,
			ctx,
		);
	}

	async function showPlanMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(planStatusText(), "info");
			return;
		}

		const choices = state.latestPlan
			? [
					"Show latest proposed plan",
					"Implement this plan",
					"Configure Plan-mode tools",
					"Stay in Plan mode",
					"Exit Plan mode",
				]
			: ["Configure Plan-mode tools", "Stay in Plan mode", "Exit Plan mode"];
		const choice = await ctx.ui.select(planStatusText(), choices);
		if (choice === "Show latest proposed plan") {
			ctx.ui.notify(state.latestPlan ?? "No proposed plan yet.", "info");
			return;
		}
		if (choice === "Implement this plan") {
			startImplementation(ctx);
			return;
		}
		if (choice === "Configure Plan-mode tools") {
			await showToolSelector(ctx);
			return;
		}
		if (choice === "Exit Plan mode") {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
			return;
		}
		updateUi(ctx);
	}

	async function showPlanReadyMenu(ctx: ExtensionContext) {
		const choice = await ctx.ui.select("Proposed plan ready. What next?", [
			"Implement this plan",
			"Stay in Plan mode",
			"Exit Plan mode",
		]);
		if (choice === "Implement this plan") {
			startImplementation(ctx);
			return;
		}
		if (choice === "Exit Plan mode") {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
		}
	}

	async function showToolSelector(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(formatToolSummary(), "info");
			return;
		}

		let pageIndex = 0;
		while (true) {
			const tools = selectableTools();
			const pageCount = toolSelectorPageCount(tools);
			pageIndex = Math.min(pageIndex, pageCount - 1);
			const pageStart = pageIndex * TOOL_SELECTOR_PAGE_SIZE;
			const pageTools = tools.slice(pageStart, pageStart + TOOL_SELECTOR_PAGE_SIZE);
			const selectedNames = planModeSelectedNames(tools);
			const choices = pageTools.map((tool, index) =>
				formatToolChoice(tool, selectedNames.has(tool.name), pageStart + index),
			);
			const previousChoice = "Previous page";
			const nextChoice = "Next page";
			const doneChoice = "Done";
			const navigationChoices = [
				...(pageIndex > 0 ? [previousChoice] : []),
				...(pageIndex < pageCount - 1 ? [nextChoice] : []),
				doneChoice,
			];
			const choice = await ctx.ui.select(
				`Plan-mode tools (${pageIndex + 1}/${pageCount}). Non-built-in tools run at user risk.`,
				[...choices, ...navigationChoices],
			);
			if (!choice || choice === doneChoice) break;
			if (choice === previousChoice) {
				pageIndex = Math.max(0, pageIndex - 1);
				continue;
			}
			if (choice === nextChoice) {
				pageIndex = Math.min(pageCount - 1, pageIndex + 1);
				continue;
			}

			const selectedIndex = choices.indexOf(choice);
			const tool = pageTools[selectedIndex];
			if (!tool) continue;
			if (!canSelectToolInPlanMode(tool)) {
				ctx.ui.notify(`${tool.name} is blocked in Plan mode.`, "warning");
				continue;
			}

			const nextSelectedNames = planModeSelectedNames(tools);
			if (nextSelectedNames.has(tool.name)) nextSelectedNames.delete(tool.name);
			else nextSelectedNames.add(tool.name);

			state = {
				...state,
				selectedToolNames: filterAvailableSelectedNames(Array.from(nextSelectedNames), tools),
			};
			applyPlanModeTools();
			persistState();
			updateUi(ctx);
		}

		applyPlanModeTools();
		persistState();
		updateUi(ctx);
	}

	function activatePlanModeTools() {
		previousTools ??= withoutPlanModeQuestionTool(safeGetActiveTools());
		applyPlanModeTools();
	}

	function applyPlanModeTools() {
		pi.setActiveTools(planModeToolNames());
	}

	function planModeToolNames() {
		const tools = selectableTools();
		if (tools.length === 0) return ["read", "bash", PLAN_MODE_QUESTION_TOOL_NAME];

		const selectedNames = planModeSelectedNames(tools);
		return withRequiredPlanModeTools(
			tools
				.filter((tool) => selectedNames.has(tool.name) && canSelectToolInPlanMode(tool))
				.map((tool) => tool.name),
		);
	}

	function planModeSelectedNames(tools: ToolInfo[]) {
		const selectedToolNames = state.selectedToolNames ?? migrateSelectedToolKeys(tools);
		if (selectedToolNames === undefined) return new Set(defaultPlanModeToolNames(tools));

		state = {
			...state,
			selectedToolNames: filterAvailableSelectedNames(selectedToolNames, tools),
			selectedToolKeys: undefined,
		};
		return new Set(state.selectedToolNames);
	}

	function defaultPlanModeToolNames(tools: ToolInfo[]) {
		return tools
			.filter((tool) => isBuiltinTool(tool) && SAFE_BUILTIN_PLAN_TOOLS.has(tool.name))
			.map((tool) => tool.name);
	}

	function migrateSelectedToolKeys(tools: ToolInfo[]) {
		if (state.selectedToolKeys === undefined) return undefined;
		return state.selectedToolKeys
			.map((key) => toolNameFromLegacyKey(key, tools))
			.filter((name): name is string => name !== undefined);
	}

	function filterAvailableSelectedNames(names: string[], tools: ToolInfo[]) {
		const availableNames = new Set(tools.filter(canSelectToolInPlanMode).map((tool) => tool.name));
		return unique(names.filter((name) => availableNames.has(name)));
	}

	function selectableTools() {
		return safeGetAllTools()
			.filter((tool) => tool.name !== PLAN_MODE_QUESTION_TOOL_NAME)
			.sort(compareTools);
	}

	function toolSelectorPageCount(tools: ToolInfo[]) {
		return Math.max(1, Math.ceil(tools.length / TOOL_SELECTOR_PAGE_SIZE));
	}

	function safeGetAllTools() {
		try {
			return pi.getAllTools();
		} catch {
			return [];
		}
	}

	function restoreTools() {
		const restoredTools = previousTools && previousTools.length > 0 ? previousTools : DEFAULT_TOOLS;
		pi.setActiveTools(withoutPlanModeQuestionTool(restoredTools));
		previousTools = undefined;
	}

	function deactivatePlanModeQuestionTool() {
		const activeTools = safeGetActiveTools();
		const filteredTools = withoutPlanModeQuestionTool(activeTools);
		if (filteredTools.length !== activeTools.length) {
			pi.setActiveTools(filteredTools);
		}
	}

	function safeGetActiveTools() {
		try {
			return pi.getActiveTools();
		} catch {
			return DEFAULT_TOOLS;
		}
	}

	function persistState() {
		pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
	}

	function restoreState(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getEntries() as SessionEntry[];
		const entry = entries
			.filter((candidate) => candidate.type === "custom" && candidate.customType === STATE_ENTRY_TYPE)
			.pop();
		if (!entry?.data) return;
		const enabled = entry.data.enabled ?? false;
		state = {
			enabled,
			latestPlan: enabled ? entry.data.latestPlan : undefined,
			awaitingAction: enabled ? (entry.data.awaitingAction ?? false) : false,
			selectedToolNames: entry.data.selectedToolNames,
			selectedToolKeys: entry.data.selectedToolKeys,
		};
	}

	function updateUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, formatStatus());
		if (state.enabled && state.latestPlan) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, [
				"Proposed plan ready",
				"Use /plan to implement, revise, or exit Plan mode.",
			]);
		} else if (state.enabled) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, [
				"Plan mode: planning",
				formatToolSummary(),
				"Produce a <proposed_plan> block.",
			]);
		} else {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		}
	}

	function formatStatus() {
		if (!state.enabled) return undefined;
		if (state.awaitingAction || state.latestPlan) return "plan ready";
		return "plan active";
	}

	function clearUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	}

	function planStatusText() {
		if (!state.enabled) return "Plan mode is off.";
		if (state.latestPlan) return `Plan mode is active and a proposed plan is ready. ${formatToolSummary()}`;
		return `Plan mode is active. ${formatToolSummary()} Explore, ask, and produce a <proposed_plan> block.`;
	}

	function formatToolSummary() {
		const names = planModeToolNames();
		return `Tools: ${names.length > 0 ? names.join(", ") : "none"}`;
	}

	function isBlockedBuiltinToolName(toolName: string) {
		if (!BLOCKED_BUILTIN_TOOLS.has(toolName)) return false;
		const tool = toolByName(toolName);
		return tool ? isBuiltinTool(tool) : true;
	}

	function isBuiltinToolName(toolName: string) {
		const tool = toolByName(toolName);
		return tool ? isBuiltinTool(tool) : toolName === "bash";
	}

	function toolByName(toolName: string) {
		return safeGetAllTools().find((candidate) => candidate.name === toolName);
	}
}

function isBuiltinTool(tool: ToolInfo) {
	return tool.sourceInfo.source === "builtin";
}

export function completePlanArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...PLAN_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;

	const matches = PLAN_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return matches.length > 0 ? [...matches] : null;
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
	if (isBuiltinTool(tool)) return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name);
	return true;
}

function toolNameFromLegacyKey(key: string, tools: ToolInfo[]) {
	const directName = tools.find((tool) => tool.name === key)?.name;
	if (directName) return directName;
	const [name] = key.split("\u001f");
	return tools.find((tool) => tool.name === name) ? name : undefined;
}

function compareTools(left: ToolInfo, right: ToolInfo) {
	const leftBuiltin = isBuiltinTool(left);
	const rightBuiltin = isBuiltinTool(right);
	if (leftBuiltin !== rightBuiltin) return leftBuiltin ? -1 : 1;
	return left.name.localeCompare(right.name);
}

function formatToolChoice(tool: ToolInfo, selected: boolean, index: number) {
	const marker = selected ? "[x]" : "[ ]";
	return `${marker} ${index + 1}. ${tool.name} (${toolPolicyLabel(tool)})`;
}

function toolPolicyLabel(tool: ToolInfo) {
	if (isBuiltinTool(tool)) {
		if (!SAFE_BUILTIN_PLAN_TOOLS.has(tool.name)) return "built-in blocked";
		return tool.name === "bash" ? "built-in limited" : "built-in";
	}
	return `user risk: ${toolSourceLabel(tool)}`;
}

function toolSourceLabel(tool: ToolInfo) {
	const sourceInfo = tool.sourceInfo;
	const source = `${sourceInfo.scope}/${sourceInfo.source}`;
	return sourceInfo.path ? `${source} ${sourceInfo.path}` : source;
}

function unique(values: string[]) {
	return Array.from(new Set(values));
}

export function withRequiredPlanModeTools(toolNames: string[]) {
	return unique([...withoutPlanModeQuestionTool(toolNames), PLAN_MODE_QUESTION_TOOL_NAME]);
}

export function withoutPlanModeQuestionTool(toolNames: string[]) {
	return toolNames.filter((toolName) => toolName !== PLAN_MODE_QUESTION_TOOL_NAME);
}

type NormalizePlanModeQuestionParamsResult =
	| { ok: true; questions: PlanModeQuestion[] }
	| { ok: false; error: string };

export function normalizePlanModeQuestionParams(input: unknown): NormalizePlanModeQuestionParamsResult {
	if (!isRecord(input) || !Array.isArray(input.questions)) {
		return { ok: false, error: "questions must be an array" };
	}
	if (input.questions.length < 1 || input.questions.length > 3) {
		return { ok: false, error: "questions must contain 1-3 items" };
	}

	const questions: PlanModeQuestion[] = [];
	for (const [questionIndex, rawQuestion] of input.questions.entries()) {
		if (!isRecord(rawQuestion)) {
			return { ok: false, error: `question ${questionIndex + 1} must be an object` };
		}

		const id = stringField(rawQuestion.id);
		const header = stringField(rawQuestion.header);
		const question = stringField(rawQuestion.question);
		if (!id || !header || !question) {
			return {
				ok: false,
				error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
			};
		}

		if (!Array.isArray(rawQuestion.options)) {
			return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
		}
		if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
			return { ok: false, error: `question ${questionIndex + 1} options must contain 2-4 items` };
		}

		const options: PlanModeQuestionOption[] = [];
		for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
			if (!isRecord(rawOption)) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
				};
			}

			const label = stringField(rawOption.label);
			if (!label) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
				};
			}
			const description = stringField(rawOption.description);
			if (!description) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
				};
			}
			options.push({ label, description });
		}

		questions.push({ id, header, question, options });
	}

	return { ok: true, questions };
}

async function askPlanModeQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
): Promise<PlanModeQuestionAnswer[] | undefined> {
	const answers: PlanModeQuestionAnswer[] = [];
	for (const question of questions) {
		const choices = question.options.map(formatPlanModeQuestionChoice);
		const otherChoice = `${question.options.length + 1}. Other (free-form)`;
		const choice = await ctx.ui.select(`${question.header}: ${question.question}`, [...choices, otherChoice]);
		if (!choice) return undefined;

		if (choice === otherChoice) {
			const customAnswer = (await ctx.ui.editor(question.question, ""))?.trim();
			if (!customAnswer) return undefined;
			answers.push({
				id: question.id,
				header: question.header,
				question: question.question,
				answer: customAnswer,
				wasCustom: true,
			});
			continue;
		}

		const optionIndex = choices.indexOf(choice);
		const option = question.options[optionIndex];
		if (!option) return undefined;
		answers.push({
			id: question.id,
			header: question.header,
			question: question.question,
			answer: option.label,
			wasCustom: false,
			optionIndex: optionIndex + 1,
		});
	}
	return answers;
}

function formatPlanModeQuestionChoice(option: PlanModeQuestionOption, index: number) {
	return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}

function planModeQuestionAnswered(questions: PlanModeQuestion[], answers: PlanModeQuestionAnswer[]) {
	return {
		content: [{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: false, answers }) }],
		details: { cancelled: false, questions, answers } satisfies PlanModeQuestionDetails,
	};
}

function planModeQuestionCancelled(
	questions: PlanModeQuestion[],
	reason: PlanModeQuestionReason,
	message: string,
) {
	return {
		content: [{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: true, reason, message }) }],
		details: { cancelled: true, reason, questions } satisfies PlanModeQuestionDetails,
	};
}

function formatPlanModeQuestionPayload(payload: {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	message?: string;
	answers?: PlanModeQuestionAnswer[];
}) {
	return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
	return typeof value === "string" ? value.trim() : undefined;
}

function buildPlanModePrompt() {
	return `${PLAN_CONTEXT_MARKER}
# Plan Mode (Conversational)

You are in Plan Mode, a Codex-like collaboration mode for producing a decision-complete implementation plan. Chat your way to the plan before finalizing it. A final plan must leave no implementation decisions unresolved.

## Mode rules

- Stay in Plan Mode until a developer or extension explicitly exits it.
- Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not use update_plan/TODO tooling in Plan Mode; Plan Mode is conversational planning, not execution progress tracking.
- Plan Mode manages built-in tool safety only. Non-built-in tools are disabled by default and may be enabled by the user at their own risk.
- Do not perform mutating actions: no edit/write tools, no patching, no formatting that rewrites files, no dependency installation, no commits, no migrations.

## Phase 1 — Ground in the environment

- Explore first and ask second. Use non-mutating exploration to read files, search, inspect configuration, run read-only checks, and resolve discoverable facts.
- Before asking the user any question, perform at least one targeted non-mutating exploration pass unless no local environment or repository is available.
- Do not ask questions that can be answered from repository or system truth. Ask only when multiple plausible choices remain, a needed identifier/context is missing, or the ambiguity is product intent.

## Phase 2 — Intent chat

- Keep asking until you can clearly state the goal, success criteria, in/out of scope, constraints, current state, and key preferences/tradeoffs.
- Bias toward questions over guessing: if a high-impact ambiguity remains, do not produce a proposed plan yet.

## Phase 3 — Implementation chat

- Once intent is stable, keep asking until the spec is decision-complete: approach, interfaces, data flow, edge cases/failure modes, testing and acceptance criteria, and any migration or compatibility constraints.
- Use plan_mode_question for important preferences, tradeoffs, or assumption locks that cannot be discovered by non-mutating exploration. Ask 1-3 concise questions with 2-4 meaningful options. Do not include filler options.
- If plan_mode_question returns cancelled or ui_unavailable, do not jump straight to a final plan when the missing answer is high impact. Ask one concise plain-text question or proceed only with a clearly stated low-risk assumption.

## Finalization rule

Only output the final plan when it is decision-complete and leaves no decisions to the implementer. When presenting the official plan, output exactly one proposed plan block and keep the tags exactly as shown:

<proposed_plan>
# Title

## Summary
...

## Key Changes
...

## Test Plan
...

## Assumptions
...
</proposed_plan>

Keep the proposed plan concise, human and agent digestible, and free of open decisions. Do not ask "should I proceed?" in the final output; the Plan-mode ready menu handles implementation, staying in Plan mode, or exit.`;
}

function readCommand(input: unknown) {
	const command = input as { command?: unknown } | undefined;
	return typeof command?.command === "string" ? command.command : "";
}

export function isSafeCommand(command: string) {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
	return SAFE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function extractProposedPlan(text: string) {
	const match = PROPOSED_PLAN_PATTERN.exec(text);
	return match?.[1]?.trim();
}

export function latestAssistantText(messages: unknown) {
	if (!Array.isArray(messages)) return "";
	for (const entry of [...messages].reverse()) {
		const message = (entry as { message?: SessionMessage })?.message ?? (entry as SessionMessage);
		if (message?.role !== "assistant") continue;
		const text = messageText(message);
		if (text) return text;
	}
	return "";
}

function messageContainsLegacyPlanModeContextArtifact(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return candidate.customType === PLAN_CONTEXT_MESSAGE_TYPE;
}

function messageContainsInactivePlanModeArtifact(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return candidate.customType === PROPOSED_PLAN_MESSAGE_TYPE;
}

export function stripProposedPlanBlocksFromMessage<T>(message: T): T {
	const candidate = unwrapSessionMessage(message);
	if (candidate.role !== "assistant") return message;

	const content = stripProposedPlanBlocksFromContent(candidate.content);
	if (content === candidate.content) return message;

	if (isSessionMessageEntry(message)) {
		return { ...message, message: { ...candidate, content } };
	}
	return { ...candidate, content } as T;
}

function unwrapSessionMessage(message: unknown) {
	const entry = message as { message?: unknown };
	return (entry.message ?? message) as { role?: string; customType?: string; content?: unknown };
}

function isSessionMessageEntry<T>(message: T): message is T & { message: SessionMessage } {
	return typeof message === "object" && message !== null && "message" in message;
}

function stripProposedPlanBlocksFromContent(content: unknown) {
	if (typeof content === "string") return stripProposedPlanBlocks(content);
	if (!Array.isArray(content)) return content;

	let changed = false;
	const nextContent = content.map((block) => {
		const textBlock = block as TextBlock;
		if (textBlock.type !== "text" || typeof textBlock.text !== "string") return block;

		const text = stripProposedPlanBlocks(textBlock.text);
		if (text === textBlock.text) return block;

		changed = true;
		return { ...textBlock, text };
	});
	return changed ? nextContent : content;
}

export function stripProposedPlanBlocks(text: string) {
	return text.replace(PROPOSED_PLAN_BLOCK_PATTERN, "");
}

function messageText(message: SessionMessage) {
	return contentText(message.content);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const textBlock = block as TextBlock;
			return textBlock.type === "text" && typeof textBlock.text === "string" ? textBlock.text : "";
		})
		.filter(Boolean)
		.join("\n");
}
