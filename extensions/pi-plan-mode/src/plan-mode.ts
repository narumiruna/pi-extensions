import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";

const STATE_ENTRY_TYPE = "plan-mode-state";
const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";
const PLAN_CONTEXT_MESSAGE_TYPE = "plan-mode-context";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const PLAN_IMPLEMENTATION_MESSAGE_TYPE = "plan-mode-implementation";
const PLAN_CONTEXT_MARKER = "[CODEX-LIKE PLAN MODE ACTIVE]";
const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const TOOL_SELECTOR_PAGE_SIZE = 10;
const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const PROPOSED_PLAN_BLOCK_PATTERN = /<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>/gi;

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

	pi.registerCommand("plan", {
		description: "Enter or manage Codex-like Plan mode",
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
		if (state.enabled) return;
		return {
			messages: event.messages
				.filter((message: unknown) => !messageContainsInactivePlanModeArtifact(message))
				.map(stripProposedPlanBlocksFromMessage),
		};
	});

	pi.on("before_agent_start", () => {
		if (!state.enabled) return;
		applyPlanModeTools();
		return {
			message: {
				customType: PLAN_CONTEXT_MESSAGE_TYPE,
				content: buildPlanModePrompt(),
				display: false,
			},
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
		pi.sendMessage(
			{
				customType: PROPOSED_PLAN_MESSAGE_TYPE,
				content: `**Proposed Plan**\n\n${proposedPlan}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		if (ctx.hasUI) await showPlanReadyMenu(ctx);
	});

	function enterPlanMode(ctx: ExtensionContext) {
		if (!state.enabled) previousTools = safeGetActiveTools();
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
		if (ctx.isIdle()) pi.sendUserMessage(prompt);
		else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	function exitPlanMode(ctx: ExtensionContext) {
		state = { ...state, enabled: false, latestPlan: undefined, awaitingAction: false };
		restoreTools();
		persistState();
		updateUi(ctx);
	}

	function startImplementation(ctx: ExtensionContext) {
		const plan = state.latestPlan?.trim();
		exitPlanMode(ctx);

		if (!plan) {
			ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
			return;
		}

		pi.sendMessage(
			{
				customType: PLAN_IMPLEMENTATION_MESSAGE_TYPE,
				content: `Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n${plan}`,
				display: true,
			},
			{ triggerTurn: true },
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
			"Revise plan",
			"Configure Plan-mode tools",
			"Stay in Plan mode",
			"Exit Plan mode",
		]);
		if (choice === "Implement this plan") {
			startImplementation(ctx);
			return;
		}
		if (choice === "Configure Plan-mode tools") {
			await showToolSelector(ctx);
			return;
		}
		if (choice === "Revise plan") {
			const refinement = await ctx.ui.editor("Revise the plan", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
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
		previousTools ??= safeGetActiveTools();
		applyPlanModeTools();
	}

	function applyPlanModeTools() {
		pi.setActiveTools(planModeToolNames());
	}

	function planModeToolNames() {
		const tools = selectableTools();
		if (tools.length === 0) return ["read", "bash"];

		const selectedNames = planModeSelectedNames(tools);
		return tools
			.filter((tool) => selectedNames.has(tool.name) && canSelectToolInPlanMode(tool))
			.map((tool) => tool.name);
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
		return safeGetAllTools().sort(compareTools);
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
		pi.setActiveTools(previousTools && previousTools.length > 0 ? previousTools : DEFAULT_TOOLS);
		previousTools = undefined;
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
		if (state.awaitingAction || state.latestPlan) return "📝 plan ready";
		return "📝 plan active";
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

function canSelectToolInPlanMode(tool: ToolInfo) {
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

function buildPlanModePrompt() {
	return `${PLAN_CONTEXT_MARKER}
You are in Plan Mode, a Codex-like collaboration mode for producing a decision-complete implementation plan.

Mode rules:
- Stay in Plan Mode until a developer or extension explicitly exits it.
- Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Use non-mutating exploration first: read files, search, inspect configuration, run read-only checks, and resolve discoverable facts before asking the user.
- Ask the user only for preferences or tradeoffs that cannot be discovered from the repository.
- Do not use update_plan/TODO tooling in Plan Mode; Plan Mode is conversational planning, not execution progress tracking.
- Plan Mode manages built-in tool safety only. Non-built-in tools are disabled by default and may be enabled by the user at their own risk.
- Do not perform mutating actions: no edit/write tools, no patching, no formatting that rewrites files, no dependency installation, no commits, no migrations.
- When the plan is decision-complete, output exactly one proposed plan block using:
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
- Keep the proposed plan concise, implementation-ready, and free of open decisions.`;
}

function readCommand(input: unknown) {
	const command = input as { command?: unknown } | undefined;
	return typeof command?.command === "string" ? command.command : "";
}

function isSafeCommand(command: string) {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
	return SAFE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function extractProposedPlan(text: string) {
	const match = PROPOSED_PLAN_PATTERN.exec(text);
	return match?.[1]?.trim();
}

function latestAssistantText(messages: unknown) {
	if (!Array.isArray(messages)) return "";
	for (const entry of [...messages].reverse()) {
		const message = (entry as { message?: SessionMessage })?.message ?? (entry as SessionMessage);
		if (message?.role !== "assistant") continue;
		const text = messageText(message);
		if (text) return text;
	}
	return "";
}

function messageContainsInactivePlanModeArtifact(message: unknown) {
	const candidate = message as { customType?: string; content?: unknown };
	return (
		candidate.customType === PLAN_CONTEXT_MESSAGE_TYPE ||
		candidate.customType === PROPOSED_PLAN_MESSAGE_TYPE ||
		contentText(candidate.content).includes(PLAN_CONTEXT_MARKER)
	);
}

function stripProposedPlanBlocksFromMessage<T>(message: T): T {
	const candidate = message as { role?: string; content?: unknown };
	if (candidate.role !== "assistant") return message;

	const content = stripProposedPlanBlocksFromContent(candidate.content);
	if (content === candidate.content) return message;
	return { ...candidate, content } as T;
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

function stripProposedPlanBlocks(text: string) {
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
