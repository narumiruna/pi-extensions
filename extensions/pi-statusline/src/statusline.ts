import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";

type SegmentName =
	| "brand"
	| "model"
	| "thinking"
	| "branch"
	| "cwd"
	| "tools"
	| "status"
	| "context"
	| "tokens"
	| "cost"
	| "time"
	| "turn";

type PresetName = "minimal" | "balanced" | "powerline" | "rainbow" | "focus";
type PaletteName = "ocean" | "sunset" | "forest" | "candy" | "neon" | "mono";
type Density = "compact" | "cozy";
type SeparatorName = "dot" | "bar" | "powerline" | "round" | "none";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface StatuslineConfig {
	enabled: boolean;
	preset: PresetName;
	palette: PaletteName;
	density: Density;
	separator: SeparatorName;
	showLabels: boolean;
	segments: SegmentName[];
}

interface StatuslineEntry {
	config: StatuslineConfig;
	request: string;
	updatedAt: number;
}

interface RuntimeState {
	turnCount: number;
	activeTools: Map<string, number>;
	lastTool?: string;
	lastCompletedTool?: string;
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel;
	requestRender?: () => void;
}

interface CustomizeResult {
	config: StatuslineConfig;
	changes: string[];
}

interface TokenTotals {
	input: number;
	output: number;
	cost: number;
}

interface RenderSegment {
	name: SegmentName;
	text: string;
	color: ThemeColor;
	emphasis?: boolean;
}

const STATUSLINE_KEY = "statusline";

const DEFAULT_SEGMENTS: SegmentName[] = [
	"brand",
	"model",
	"thinking",
	"branch",
	"cwd",
	"tools",
	"status",
	"context",
	"tokens",
	"cost",
	"time",
];

const PRESET_SEGMENTS: Record<PresetName, SegmentName[]> = {
	minimal: ["brand", "model", "branch", "context"],
	balanced: DEFAULT_SEGMENTS,
	powerline: DEFAULT_SEGMENTS,
	rainbow: DEFAULT_SEGMENTS,
	focus: ["brand", "cwd", "tools", "status", "context", "time"],
};

const RIGHT_SEGMENTS = new Set<SegmentName>(["context", "tokens", "cost", "time", "turn"]);

const SEGMENT_KEYWORDS: Record<SegmentName, string[]> = {
	brand: ["brand", "logo", "pi", "π", "標誌", "品牌"],
	model: ["model", "ai", "llm", "模型"],
	thinking: ["thinking", "reasoning", "think", "推理", "思考"],
	branch: ["branch", "git", "repo", "repository", "分支", "版本"],
	cwd: ["cwd", "directory", "dir", "folder", "path", "project", "專案", "目錄", "路徑"],
	tools: ["tool", "tools", "activity", "busy", "工具", "活動"],
	status: ["extension", "extensions", "goal", "狀態", "擴充"],
	context: ["context", "usage", "percent", "window", "上下文", "使用率", "百分比"],
	tokens: ["token", "tokens", "input", "output", "tok", "權杖", "token數"],
	cost: ["cost", "price", "money", "spend", "usd", "成本", "花費", "費用"],
	time: ["time", "clock", "date", "時間", "時鐘"],
	turn: ["turns", "iteration", "輪次", "回合"],
};

const PALETTES: Record<PaletteName, ThemeColor[]> = {
	ocean: ["accent", "muted", "success", "warning"],
	sunset: ["warning", "accent", "success", "muted"],
	forest: ["success", "accent", "muted", "warning"],
	candy: ["accent", "warning", "success", "muted"],
	neon: ["accent", "success", "warning", "error"],
	mono: ["muted", "dim"],
};

const STATUSLINE_TOOL_PARAMETERS = Type.Object({
	request: Type.String({
		description:
			"Natural-language statusline request, such as 'make it minimal, hide cost, show git branch and time'.",
	}),
});

export default function statusline(pi: ExtensionAPI) {
	let config = createDefaultConfig();
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
	};

	const persistConfig = (request: string) => {
		pi.appendEntry(STATUSLINE_KEY, {
			config,
			request,
			updatedAt: Date.now(),
		} satisfies StatuslineEntry);
	};

	const refresh = () => runtime.requestRender?.();

	const installFooter = (ctx: ExtensionContext) => {
		if (!config.enabled) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus(STATUSLINE_KEY, undefined);
			runtime.requestRender = undefined;
			return;
		}

		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		ctx.ui.setFooter((tui, theme, footerData) => {
			runtime.requestRender = () => tui.requestRender();

			const branchUnsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const clock = setInterval(() => tui.requestRender(), 30_000);

			return {
				dispose() {
					branchUnsubscribe();
					clearInterval(clock);
				},
				invalidate() {},
				render(width: number): string[] {
					return [renderStatusline(width, ctx, footerData, theme, config, runtime)];
				},
			};
		});
	};

	const applyRequest = (request: string, ctx: ExtensionContext): CustomizeResult => {
		const result = applyNaturalLanguageRequest(request, config);
		config = result.config;
		persistConfig(request);
		installFooter(ctx);
		refresh();
		return result;
	};

	pi.registerTool({
		name: "statusline_customize",
		label: "Statusline Customize",
		description:
			"Customize Pi's footer/statusline from a natural-language request. Use when the user asks to change the statusline, footer, shown segments, colors, density, or style.",
		promptSnippet: "Customize the Pi footer/statusline from natural-language requests",
		promptGuidelines: [
			"Use statusline_customize when the user asks to customize the statusline/footer appearance or visible footer segments.",
			"Pass the user's natural-language request verbatim when possible so pi-statusline can parse style, palette, and segment preferences.",
		],
		parameters: STATUSLINE_TOOL_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyRequest(params.request, ctx);
			const summary = summarizeConfig(result.config, result.changes);
			if (ctx.hasUI) ctx.ui.notify(summary, "info");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					request: params.request,
					config: result.config,
					changes: result.changes,
				},
			};
		},
	});

	pi.registerCommand("statusline", {
		description: "Customize the footer/statusline. Usage: /statusline <request>",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (!request) {
				ctx.ui.notify(`Usage: /statusline <request>\n${summarizeConfig(config, [])}`, "info");
				return;
			}

			if (isStatuslineShowRequest(request)) {
				ctx.ui.notify(summarizeConfig(config, []), "info");
				return;
			}

			const result = applyRequest(request, ctx);
			ctx.ui.notify(summarizeConfig(result.config, result.changes), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		config = readPersistedConfig(ctx) ?? config;
		runtime.thinkingLevel = pi.getThinkingLevel();
		installFooter(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		config = readPersistedConfig(ctx) ?? createDefaultConfig();
		installFooter(ctx);
		refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setFooter(undefined);
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		runtime.requestRender = undefined;
	});

	pi.on("model_select", () => refresh());

	pi.on("thinking_level_select", (event) => {
		runtime.thinkingLevel = event.level;
		refresh();
	});

	pi.on("agent_start", () => {
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("agent_end", () => {
		runtime.isStreaming = false;
		refresh();
	});

	pi.on("turn_start", () => {
		runtime.turnCount += 1;
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("turn_end", () => refresh());

	pi.on("tool_execution_start", (event) => {
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		runtime.activeTools.set(event.toolName, currentCount + 1);
		runtime.lastTool = event.toolName;
		refresh();
	});

	pi.on("tool_execution_end", (event) => {
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		if (currentCount <= 1) runtime.activeTools.delete(event.toolName);
		else runtime.activeTools.set(event.toolName, currentCount - 1);

		runtime.lastCompletedTool = event.toolName;
		refresh();
	});
}

function createDefaultConfig(): StatuslineConfig {
	return {
		enabled: true,
		preset: "powerline",
		palette: "candy",
		density: "compact",
		separator: "powerline",
		showLabels: false,
		segments: [...DEFAULT_SEGMENTS],
	};
}

function readPersistedConfig(ctx: ExtensionContext): StatuslineConfig | undefined {
	let latest: StatuslineConfig | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATUSLINE_KEY) continue;

		const data = entry.data as Partial<StatuslineEntry> | undefined;
		const config = normalizeConfig(data?.config);
		if (config) latest = config;
	}

	return latest;
}

function normalizeConfig(value: unknown): StatuslineConfig | undefined {
	if (!value || typeof value !== "object") return undefined;

	const input = value as Partial<StatuslineConfig>;
	const fallback = createDefaultConfig();

	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
		preset: isPreset(input.preset) ? input.preset : fallback.preset,
		palette: isPalette(input.palette) ? input.palette : fallback.palette,
		density:
			input.density === "cozy" || input.density === "compact" ? input.density : fallback.density,
		separator: isSeparator(input.separator) ? input.separator : fallback.separator,
		showLabels: typeof input.showLabels === "boolean" ? input.showLabels : fallback.showLabels,
		segments: normalizeSegments(input.segments, fallback.segments),
	};
}

function applyNaturalLanguageRequest(
	request: string,
	currentConfig: StatuslineConfig,
): CustomizeResult {
	const text = request.trim();
	const lower = text.toLowerCase();
	let next: StatuslineConfig = {
		...currentConfig,
		segments: [...currentConfig.segments],
	};
	const changes: string[] = [];

	if (hasAny(lower, ["reset", "default", "factory", "重設", "預設", "恢復預設"])) {
		next = createDefaultConfig();
		changes.push("reset to the balanced default");
	}

	if (
		hasAny(lower, ["disable", "turn off", "restore pi footer", "關閉", "停用"]) ||
		hasStandaloneWord(lower, "off")
	) {
		next.enabled = false;
		changes.push("disabled custom statusline");
	}

	if (hasAny(lower, ["enable", "turn on", "啟用", "開啟"]) || hasStandaloneWord(lower, "on")) {
		next.enabled = true;
		changes.push("enabled custom statusline");
	}

	const preset = detectPreset(lower);
	if (preset) {
		next.preset = preset;
		next.segments = [...PRESET_SEGMENTS[preset]];
		changes.push(`preset: ${preset}`);
	}

	const palette = detectPalette(lower);
	if (palette) {
		next.palette = palette;
		changes.push(`palette: ${palette}`);
	}

	const separator = detectSeparator(lower, next.separator);
	if (separator !== next.separator) {
		next.separator = separator;
		changes.push(`separator: ${separator}`);
	}

	if (hasAny(lower, ["compact", "dense", "short", "精簡", "緊湊"])) {
		next.density = "compact";
		changes.push("density: compact");
	}

	if (hasAny(lower, ["cozy", "spacious", "roomy", "with labels", "labeled", "詳細", "寬鬆"])) {
		next.density = "cozy";
		next.showLabels = true;
		changes.push("density: cozy");
	}

	if (hasAny(lower, ["no labels", "hide labels", "without labels", "無標籤", "隱藏標籤"])) {
		next.showLabels = false;
		changes.push("labels hidden");
	} else if (hasAny(lower, ["labels", "show labels", "with labels", "顯示標籤", "標籤"])) {
		next.showLabels = true;
		changes.push("labels shown");
	}

	const mentionedSegments = getMentionedSegments(lower);
	if (hasAny(lower, ["only", "just", "僅", "只顯示", "只有"]) && mentionedSegments.length > 0) {
		next.segments = mentionedSegments.includes("brand")
			? mentionedSegments
			: ["brand", ...mentionedSegments];
		changes.push(`showing only: ${next.segments.join(", ")}`);
	} else {
		for (const segment of mentionedSegments) {
			if (hasHideIntentForSegment(lower, segment)) {
				next.segments = next.segments.filter((item) => item !== segment);
				changes.push(`hidden: ${segment}`);
				continue;
			}

			if (hasShowIntentForSegment(lower, segment) || !hasAny(lower, HIDE_WORDS)) {
				next.segments = appendUnique(next.segments, segment);
				changes.push(`shown: ${segment}`);
			}
		}
	}

	next.segments = normalizeSegments(next.segments, createDefaultConfig().segments);
	return { config: next, changes: dedupe(changes) };
}

const SHOW_WORDS = ["show", "add", "include", "with", "display", "顯示", "加入", "包含"];
const HIDE_WORDS = ["hide", "remove", "without", "no ", "omit", "隱藏", "移除", "不要", "沒有"];

function isStatuslineShowRequest(request: string): boolean {
	const lower = request.toLowerCase().trim();
	if (!lower) return false;
	if (hasAny(lower, ["config", "configuration", "current", "目前", "現在", "設定值"])) {
		return true;
	}
	return /^(show|display)(\s+(the\s+)?(statusline|status line|footer)(\s+status)?)?$/i.test(lower);
}

function detectPreset(text: string): PresetName | undefined {
	if (hasAny(text, ["minimal", "simple", "clean", "zen", "極簡", "簡潔"])) return "minimal";
	if (hasAny(text, ["focus", "focused", "work mode", "專注"])) return "focus";
	if (hasAny(text, ["rainbow", "colorful", "colourful", "彩虹", "多彩"])) return "rainbow";
	if (
		hasAny(text, ["powerline", "fancy", "beautiful", "pretty", "gorgeous", "漂亮", "美化", "華麗"])
	) {
		return "powerline";
	}
	if (hasAny(text, ["balanced", "classic", "normal", "完整", "平衡"])) return "balanced";
	return undefined;
}

function detectPalette(text: string): PaletteName | undefined {
	if (hasAny(text, ["mono", "monochrome", "gray", "grey", "no color", "plain", "黑白", "單色"])) {
		return "mono";
	}
	if (hasAny(text, ["ocean", "blue", "cyan", "sea", "藍", "海洋"])) return "ocean";
	if (hasAny(text, ["sunset", "orange", "amber", "warm", "夕陽", "橘", "暖色"])) return "sunset";
	if (hasAny(text, ["forest", "green", "nature", "綠", "森林"])) return "forest";
	if (hasAny(text, ["neon", "cyber", "terminal", "matrix", "霓虹", "賽博"])) return "neon";
	if (hasAny(text, ["candy", "pink", "purple", "magenta", "粉", "紫", "糖果"])) return "candy";
	return undefined;
}

function detectSeparator(text: string, fallback: SeparatorName): SeparatorName {
	if (hasAny(text, ["powerline", "nerd font", "nerdfont"])) return "powerline";
	if (hasAny(text, ["dot", "dots", "bullet", "圓點"])) return "dot";
	if (hasAny(text, ["bar", "pipe", "vertical", "直線", "分隔線"])) return "bar";
	if (hasAny(text, ["round", "rounded", "soft", "圓角"])) return "round";
	if (hasAny(text, ["none", "no separator", "plain", "不要分隔"])) return "none";
	return fallback;
}

function getMentionedSegments(text: string): SegmentName[] {
	const segments: SegmentName[] = [];
	for (const [segment, keywords] of Object.entries(SEGMENT_KEYWORDS) as [SegmentName, string[]][]) {
		if (hasAny(text, keywords)) segments.push(segment);
	}
	return segments;
}

function hasShowIntentForSegment(text: string, segment: SegmentName): boolean {
	return hasIntentForSegment(text, SHOW_WORDS, SEGMENT_KEYWORDS[segment]);
}

function hasHideIntentForSegment(text: string, segment: SegmentName): boolean {
	return hasIntentForSegment(text, HIDE_WORDS, SEGMENT_KEYWORDS[segment]);
}

function hasIntentForSegment(text: string, intents: string[], keywords: string[]): boolean {
	for (const intent of intents) {
		for (const keyword of keywords) {
			if (!text.includes(intent) || !text.includes(keyword)) continue;
			if (intent.length === 1 || keyword.length === 1) return true;

			const intentBefore = new RegExp(
				`${escapeRegExp(intent)}(?:\\W+\\w+){0,5}\\W+${escapeRegExp(keyword)}`,
				"iu",
			);
			const keywordBefore = new RegExp(
				`${escapeRegExp(keyword)}(?:\\W+\\w+){0,5}\\W+${escapeRegExp(intent)}`,
				"iu",
			);
			if (intentBefore.test(text) || keywordBefore.test(text)) return true;
		}
	}

	return false;
}

function renderStatusline(
	width: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
): string {
	if (width <= 0) return "";

	const segments = config.segments
		.map((segment, index) => buildSegment(segment, index, ctx, footerData, theme, config, runtime))
		.filter(
			(segment): segment is RenderSegment => segment !== undefined && segment.text.length > 0,
		);

	const left = joinSegments(
		segments.filter((segment) => !RIGHT_SEGMENTS.has(segment.name)),
		theme,
		config,
	);
	const right = joinSegments(
		segments.filter((segment) => RIGHT_SEGMENTS.has(segment.name)),
		theme,
		config,
	);

	if (!left && !right) return truncateToWidth(theme.fg("dim", "pi-statusline"), width);
	if (!right) return truncateToWidth(left, width);
	if (!left) return truncateToWidth(right, width);

	const rightWidth = visibleWidth(right);
	if (rightWidth + 1 >= width) return truncateToWidth(right, width);

	const leftWidth = Math.max(0, width - rightWidth - 1);
	const trimmedLeft = truncateToWidth(left, leftWidth, "…");
	const padding = " ".repeat(Math.max(1, width - visibleWidth(trimmedLeft) - rightWidth));

	return truncateToWidth(`${trimmedLeft}${padding}${right}`, width, "");
}

function buildSegment(
	name: SegmentName,
	index: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
): RenderSegment | undefined {
	const color = pickColor(config, index);

	switch (name) {
		case "brand":
			return { name, text: "π", color: "accent", emphasis: true };
		case "model":
			return labeled(name, shortenModel(ctx.model?.id ?? "no-model"), color, config);
		case "thinking":
			return labeled(name, runtime.thinkingLevel, thinkingColor(runtime.thinkingLevel), config);
		case "branch":
			return labeled(name, footerData.getGitBranch() ?? "no-git", color, config);
		case "cwd":
			return labeled(name, basename(ctx.cwd) || ctx.cwd, color, config);
		case "tools":
			return labeled(name, formatToolActivity(runtime), color, config);
		case "status": {
			const status = formatExtensionStatuses(footerData.getExtensionStatuses(), theme);
			return status ? labeled(name, status, color, config) : undefined;
		}
		case "context": {
			const usage = ctx.getContextUsage();
			const value =
				usage?.percent === null || usage?.percent === undefined
					? "ctx ?"
					: `ctx ${usage.percent.toFixed(0)}%`;
			return labeled(name, value, contextColor(usage?.percent), config);
		}
		case "tokens": {
			const totals = getTokenTotals(ctx);
			if (totals.input === 0 && totals.output === 0) return labeled(name, "tok 0", color, config);
			return labeled(
				name,
				`↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`,
				color,
				config,
			);
		}
		case "cost": {
			const totals = getTokenTotals(ctx);
			return labeled(name, `$${totals.cost.toFixed(totals.cost >= 1 ? 2 : 3)}`, color, config);
		}
		case "time":
			return labeled(name, formatTime(), color, config);
		case "turn":
			return labeled(name, `#${runtime.turnCount}`, color, config);
	}
}

function labeled(
	name: SegmentName,
	value: string,
	color: ThemeColor,
	config: StatuslineConfig,
): RenderSegment {
	if (!config.showLabels || name === "brand") return { name, text: value, color };
	return { name, text: `${name} ${value}`, color };
}

function joinSegments(segments: RenderSegment[], theme: Theme, config: StatuslineConfig): string {
	const separator = separatorText(config.separator);
	return segments
		.map((segment, index) => styleSegment(segment, index, theme, config))
		.join(theme.fg("dim", separator));
}

function styleSegment(
	segment: RenderSegment,
	index: number,
	theme: Theme,
	config: StatuslineConfig,
): string {
	const padding = config.density === "cozy" ? " " : "";
	const text = `${padding}${segment.text}${padding}`;
	const styledText = segment.emphasis ? theme.bold(text) : text;

	if (config.palette === "mono") {
		return index === 0 ? theme.fg("muted", styledText) : theme.fg("dim", styledText);
	}

	return theme.fg(segment.color, styledText);
}

function separatorText(separator: SeparatorName): string {
	switch (separator) {
		case "powerline":
			return "  ";
		case "bar":
			return " │ ";
		case "round":
			return " ❯ ";
		case "none":
			return " ";
		case "dot":
			return " • ";
	}
}

function pickColor(config: StatuslineConfig, index: number): ThemeColor {
	const palette = PALETTES[config.palette];
	return palette[index % palette.length] ?? "muted";
}

function thinkingColor(level: ThinkingLevel): ThemeColor {
	switch (level) {
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
	}
}

function contextColor(percent: number | null | undefined): ThemeColor {
	if (percent === null || percent === undefined) return "dim";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function formatToolActivity(runtime: RuntimeState): string {
	const active = [...runtime.activeTools.entries()];
	if (active.length > 0) {
		const [name, count] = active[0] ?? ["tool", 1];
		const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
		return `⚙ ${name}${suffix}`;
	}

	if (runtime.isStreaming) return "thinking";
	if (runtime.lastCompletedTool) return `✓ ${runtime.lastCompletedTool}`;
	return "idle";
}

function formatExtensionStatuses(statuses: ReadonlyMap<string, string>, theme: Theme): string {
	const visibleStatuses = [...statuses.entries()]
		.filter(([key, value]) => key !== STATUSLINE_KEY && value.trim().length > 0)
		.slice(0, 2)
		.map(([key, value]) => {
			if (visibleWidth(value) <= 28) return value;
			return `${theme.fg("dim", `${key}:`)} ${truncateToWidth(value, 24)}`;
		});

	return visibleStatuses.join(" ");
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

function formatCount(value: number): string {
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

function shortenModel(model: string): string {
	return model
		.replace(/^claude-/, "")
		.replace(/^gpt-/, "gpt ")
		.replace(/-20\d{6}$/, "")
		.replace(/-latest$/, "");
}

function summarizeConfig(config: StatuslineConfig, changes: string[]): string {
	const state = config.enabled ? "enabled" : "disabled";
	const prefix = changes.length > 0 ? `${changes.join("; ")}. ` : "";
	return `${prefix}pi-statusline ${state}: ${config.preset}/${config.palette}, ${config.density}, segments: ${config.segments.join(", ")}`;
}

function normalizeSegments(input: unknown, fallback: SegmentName[]): SegmentName[] {
	if (!Array.isArray(input)) return [...fallback];

	const segments = input.filter(isSegmentName);
	return segments.length > 0 ? dedupe(segments) : [...fallback];
}

function appendUnique<T>(items: T[], item: T): T[] {
	return items.includes(item) ? items : [...items, item];
}

function dedupe<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function hasAny(text: string, needles: string[]): boolean {
	return needles.some((needle) => text.includes(needle));
}

function hasStandaloneWord(text: string, word: string): boolean {
	return new RegExp(`(^|\\W)${escapeRegExp(word)}(\\W|$)`, "iu").test(text);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSegmentName(value: unknown): value is SegmentName {
	return typeof value === "string" && Object.hasOwn(SEGMENT_KEYWORDS, value);
}

function isPreset(value: unknown): value is PresetName {
	return (
		value === "minimal" ||
		value === "balanced" ||
		value === "powerline" ||
		value === "rainbow" ||
		value === "focus"
	);
}

function isPalette(value: unknown): value is PaletteName {
	return (
		value === "ocean" ||
		value === "sunset" ||
		value === "forest" ||
		value === "candy" ||
		value === "neon" ||
		value === "mono"
	);
}

function isSeparator(value: unknown): value is SeparatorName {
	return (
		value === "dot" ||
		value === "bar" ||
		value === "powerline" ||
		value === "round" ||
		value === "none"
	);
}
