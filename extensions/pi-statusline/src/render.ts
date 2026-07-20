import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderClassicStatusline } from "../presets/classic.js";
import { renderTokyoNightStatusline } from "../presets/tokyo-night.js";
import type {
	PaletteName,
	RenderSegment,
	SegmentName,
	StatuslineConfig,
	TokyoNightBlockName,
} from "../presets/types.js";
import {
	type ExtensionStatusRuntime,
	formatExtensionStatuses,
	wrapExtensionStatusline,
} from "./extension-status.js";
import { formatGitBranchText, type GitStatusSummary } from "./git-status.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export interface RuntimeState extends ExtensionStatusRuntime {
	turnCount: number;
	activeTools: Map<string, number>;
	lastTool?: string;
	lastCompletedTool?: string;
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel;
	gitStatus?: GitStatusSummary;
	requestRender?: () => void;
}
interface TokenTotals {
	input: number;
	output: number;
	cost: number;
}
const GITHUB_PR_KEY = "github-pr";
const GITHUB_PR_STATUS_KEYS = new Set([GITHUB_PR_KEY]);
const PALETTES: Record<PaletteName, ThemeColor[]> = {
	ocean: ["accent", "muted", "success", "warning"],
	sunset: ["warning", "accent", "success", "muted"],
	forest: ["success", "accent", "muted", "warning"],
	candy: ["accent", "warning", "success", "muted"],
	neon: ["accent", "success", "warning", "error"],
	mono: ["muted", "dim"],
};

export function renderStatusline(
	width: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
): string {
	if (width <= 0) return "";

	const segments = config.segments
		.map((segment, index) => buildSegment(segment, index, ctx, footerData, config, runtime))
		.filter(
			(segment): segment is RenderSegment => segment !== undefined && segment.text.length > 0,
		);

	if (segments.length === 0) return truncateToWidth(theme.fg("dim", "pi-statusline"), width);

	switch (config.preset) {
		case "classic":
			return renderClassicStatusline(width, segments, theme, config);
		case "tokyo-night":
			return renderTokyoNightStatusline(width, segments);
	}
}

export function renderExtensionStatusline(
	width: number,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
	mainLine: string,
): string[] {
	const statuses = footerData.getExtensionStatuses();
	const prContext = prContextFromStatuses(statuses);
	const rendersPrInline = prContext !== undefined && mainLine.includes(prContext);
	const status = formatExtensionStatuses(
		statuses,
		theme,
		config,
		runtime,
		rendersPrInline ? GITHUB_PR_STATUS_KEYS : undefined,
	);
	return wrapExtensionStatusline(status, width);
}

function buildSegment(
	name: SegmentName,
	index: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	config: StatuslineConfig,
	runtime: RuntimeState,
): RenderSegment | undefined {
	const color = pickColor(config, index);

	switch (name) {
		case "brand":
			return segment(name, "π", "accent", "header", true);
		case "provider":
			return segment(name, `🔌 ${ctx.model?.provider ?? "no-provider"}`, color, "header");
		case "model":
			return segment(name, `🤖 ${shortenModel(ctx.model?.id ?? "no-model")}`, color, "header");
		case "thinking":
			return segment(
				name,
				`🧠 ${runtime.thinkingLevel}`,
				thinkingColor(runtime.thinkingLevel),
				"header",
			);
		case "branch": {
			const branch = footerData.getGitBranch();
			const pr = branch ? prContextFromStatuses(footerData.getExtensionStatuses()) : undefined;
			return segment(name, formatGitBranchText(branch, runtime.gitStatus, pr), color, "git");
		}
		case "cwd":
			return segment(name, `📁 ${basename(ctx.cwd) || ctx.cwd}`, color, "directory");
		case "tools":
			return segment(name, formatToolActivity(runtime), color, "runtime");
		case "context": {
			const usage = ctx.getContextUsage();
			const value =
				usage?.percent === null || usage?.percent === undefined
					? "🪟 ctx ?"
					: `🪟 ctx ${usage.percent.toFixed(0)}%`;
			return segment(name, value, contextColor(usage?.percent), "runtime");
		}
		case "tokens": {
			const totals = getTokenTotals(ctx);
			if (totals.input === 0 && totals.output === 0)
				return segment(name, "🔢 tok 0", color, "runtime");
			return segment(
				name,
				`🔢 ↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`,
				color,
				"runtime",
			);
		}
		case "cost": {
			const totals = getTokenTotals(ctx);
			return segment(name, `💸 $${totals.cost.toFixed(totals.cost >= 1 ? 2 : 3)}`, color, "meter");
		}
		case "time":
			return segment(name, `🕒 ${formatTime()}`, color, "meter");
		case "turn":
			return segment(name, `🔁 #${runtime.turnCount}`, color, "meter");
	}
}

function segment(
	name: SegmentName,
	text: string,
	color: ThemeColor,
	block: TokyoNightBlockName,
	emphasis = false,
): RenderSegment {
	return { name, text, color, block, emphasis };
}

function pickColor(config: StatuslineConfig, index: number): ThemeColor {
	const palette = PALETTES[config.palette];
	return palette[index % palette.length] ?? "muted";
}

function thinkingColor(level: ThinkingLevel): ThemeColor {
	switch (level as string) {
		case "off":
			return "dim";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax" as ThemeColor;
		default:
			return "dim";
	}
}

export function contextColor(percent: number | null | undefined): ThemeColor {
	if (percent === null || percent === undefined) return "dim";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

export function formatToolActivity(runtime: RuntimeState): string {
	const active = [...runtime.activeTools.entries()];
	if (active.length > 0) {
		const [name, count] = active[0] ?? ["tool", 1];
		const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
		return `⚙ ${name}${suffix}`;
	}

	if (runtime.isStreaming) return "💭 thinking";
	if (runtime.lastCompletedTool) return `✅ ${runtime.lastCompletedTool}`;
	return "💤 idle";
}

export function prLinkFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
	const value = statuses.get(GITHUB_PR_KEY);
	if (!value) return undefined;
	// Extract the OSC 8 hyperlink span (the clickable "#123"); skip non-PR states
	// like "PR gh missing" that carry no link. github-pr emits exactly one link, so the
	// first OSC 8 span is the PR number.
	const open = value.indexOf("\x1b]8;;");
	if (open === -1) return undefined;
	const closeMarker = "\x1b]8;;\x07";
	const close = value.indexOf(closeMarker, open + 1);
	return close === -1 ? undefined : value.slice(open, close + closeMarker.length);
}

export function prContextFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
	const value = statuses.get(GITHUB_PR_KEY);
	const link = prLinkFromStatuses(statuses);
	if (!value || !link) return undefined;

	const state = compactPrState(value.replace(link, ""));
	return state ? `${link} · ${state}` : undefined;
}

function compactPrState(value: string): string | undefined {
	if (/:\s*merged\s*$/.test(value)) return "merged";
	if (/:\s*closed\s*$/.test(value)) return "closed";
	if (/\bdraft\b/.test(value)) return "draft";

	const failing = /\bchecks failing \((\d+)\)/.exec(value);
	if (failing) return `${failing[1]} failing`;
	if (/\bchanges requested\b/.test(value)) return "changes requested";

	const pending = /\bchecks pending \((\d+)\)/.exec(value);
	if (pending) return `${pending[1]} pending`;
	if (/\bapproved\b/.test(value)) return "approved";
	if (/\breview required\b/.test(value)) return "review required";
	if (/\bchecks passing\b/.test(value)) return "checks passing";
	if (/\bno checks\b/.test(value)) return "no checks";
	return undefined;
}

function getTokenTotals(ctx: ExtensionContext): TokenTotals {
	const totals: TokenTotals = { input: 0, output: 0, cost: 0 };

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const usage = entry.message.usage as
			| {
					input?: number;
					output?: number;
					cost?: { total?: number };
			  }
			| undefined;

		totals.input += usage?.input ?? 0;
		totals.output += usage?.output ?? 0;
		totals.cost += usage?.cost?.total ?? 0;
	}

	return totals;
}

export function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatTime(): string {
	const now = new Date();
	const hours = now.getHours().toString().padStart(2, "0");
	const minutes = now.getMinutes().toString().padStart(2, "0");
	return `${hours}:${minutes}`;
}

export function shortenModel(model: string): string {
	return model
		.replace(/^claude-/, "")
		.replace(/^gpt-/, "gpt ")
		.replace(/-20\d{6}$/, "")
		.replace(/-latest$/, "");
}
