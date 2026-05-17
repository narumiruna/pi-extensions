import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATE_ENTRY_TYPE = "plan-mode-state";
const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";
const PLAN_CONTEXT_MARKER = "[CODEX-LIKE PLAN MODE ACTIVE]";
const READ_ONLY_TOOLS = ["read", "bash"];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const MUTATING_TOOLS = new Set(["edit", "write"]);
const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

interface PlanModeState {
	enabled: boolean;
	latestPlan?: string;
	awaitingAction: boolean;
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
			const command = args.trim().toLowerCase();
			if (command === "exit" || command === "off") {
				exitPlanMode(ctx);
				ctx.ui.notify("Plan mode disabled. Full tool access restored.", "info");
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
		if (state.enabled) activateReadOnlyTools();
		updateUi(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persistState();
		clearUi(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;
		if (MUTATING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode blocks mutating tool '${event.toolName}'. Use /plan and choose implementation when the plan is ready.`,
			};
		}
		if (event.toolName !== "bash") return;

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
			messages: event.messages.filter((message: unknown) => !messageContainsPlanModeContext(message)),
		};
	});

	pi.on("before_agent_start", () => {
		if (!state.enabled) return;
		return {
			message: {
				customType: "plan-mode-context",
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
				customType: "proposed-plan",
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
		activateReadOnlyTools();
		persistState();
		updateUi(ctx);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		state = { ...state, enabled: false, awaitingAction: false };
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
				customType: "plan-mode-implementation",
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
			? ["Show latest proposed plan", "Implement this plan", "Stay in Plan mode", "Exit Plan mode"]
			: ["Stay in Plan mode", "Exit Plan mode"];
		const choice = await ctx.ui.select(planStatusText(), choices);
		if (choice === "Show latest proposed plan") {
			ctx.ui.notify(state.latestPlan ?? "No proposed plan yet.", "info");
			return;
		}
		if (choice === "Implement this plan") {
			startImplementation(ctx);
			return;
		}
		if (choice === "Exit Plan mode") {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode disabled. Full tool access restored.", "info");
			return;
		}
		updateUi(ctx);
	}

	async function showPlanReadyMenu(ctx: ExtensionContext) {
		const choice = await ctx.ui.select("Proposed plan ready. What next?", [
			"Implement this plan",
			"Revise plan",
			"Stay in Plan mode",
		]);
		if (choice === "Implement this plan") {
			startImplementation(ctx);
			return;
		}
		if (choice === "Revise plan") {
			const refinement = await ctx.ui.editor("Revise the plan", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
		}
	}

	function activateReadOnlyTools() {
		previousTools ??= safeGetActiveTools();
		pi.setActiveTools(READ_ONLY_TOOLS);
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
		state = {
			enabled: entry.data.enabled ?? false,
			latestPlan: entry.data.latestPlan,
			awaitingAction: entry.data.awaitingAction ?? false,
		};
	}

	function updateUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, state.enabled ? "plan: active" : undefined);
		if (state.enabled && state.latestPlan) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, [
				"Proposed plan ready",
				"Use /plan to implement, revise, or exit Plan mode.",
			]);
		} else if (state.enabled) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, ["Plan mode: read-only", "Produce a <proposed_plan> block."]);
		} else {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		}
	}

	function clearUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	}

	function planStatusText() {
		if (!state.enabled) return "Plan mode is off.";
		if (state.latestPlan) return "Plan mode is active and a proposed plan is ready.";
		return "Plan mode is active. Explore, ask, and produce a <proposed_plan> block.";
	}
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

function messageContainsPlanModeContext(message: unknown) {
	const candidate = message as { customType?: string; content?: unknown };
	if (candidate.customType === "plan-mode-context") return true;
	return contentText(candidate.content).includes(PLAN_CONTEXT_MARKER);
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
