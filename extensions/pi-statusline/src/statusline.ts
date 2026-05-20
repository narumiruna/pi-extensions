import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { classicExtensionSeparator, renderClassicStatusline } from "../presets/classic.js";
import { renderTokyoNightStatusline, tokyoNightExtensionSeparator } from "../presets/tokyo-night.js";
import type {
	PaletteName,
	RenderSegment,
	SegmentName,
	StatuslineConfig,
	StatuslinePresetName,
	TokyoNightBlockName,
} from "../presets/types.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface RuntimeState {
	turnCount: number;
	activeTools: Map<string, number>;
	lastTool?: string;
	lastCompletedTool?: string;
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel;
	duplicateExtensions: string[];
	requestRender?: () => void;
}

interface TokenTotals {
	input: number;
	output: number;
	cost: number;
}

const STATUSLINE_KEY = "statusline";
const DEFAULT_PRESET: StatuslinePresetName = "tokyo-night";

const DEFAULT_SEGMENTS: SegmentName[] = [
	"brand",
	"model",
	"thinking",
	"cwd",
	"branch",
	"tools",
	"context",
	"tokens",
	"cost",
	"time",
];

const PALETTES: Record<PaletteName, ThemeColor[]> = {
	ocean: ["accent", "muted", "success", "warning"],
	sunset: ["warning", "accent", "success", "muted"],
	forest: ["success", "accent", "muted", "warning"],
	candy: ["accent", "warning", "success", "muted"],
	neon: ["accent", "success", "warning", "error"],
	mono: ["muted", "dim"],
};

export default function statusline(pi: ExtensionAPI) {
	const config = createDefaultConfig();
	const runtime: RuntimeState = {
		turnCount: 0,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
	};

	const refresh = () => runtime.requestRender?.();

	const installFooter = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		runtime.duplicateExtensions = findDuplicateExtensions(ctx.cwd);
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
					const lines = [renderStatusline(width, ctx, footerData, theme, config, runtime)];
					const extensionStatusLine = renderExtensionStatusline(
						width,
						footerData,
						theme,
						config,
						runtime,
					);
					if (extensionStatusLine) lines.push(extensionStatusLine);
					return lines;
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => {
		runtime.thinkingLevel = pi.getThinkingLevel();
		installFooter(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
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
		preset: readStatuslinePreset(),
		palette: "candy",
		density: "compact",
		separator: "dot",
		showLabels: false,
		segments: [...DEFAULT_SEGMENTS],
	};
}

function readStatuslinePreset(): StatuslinePresetName {
	const preset = process.env.PI_STATUSLINE_PRESET?.trim().toLowerCase();
	if (preset === "classic" || preset === "tokyo-night") return preset;
	return DEFAULT_PRESET;
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

function renderExtensionStatusline(
	width: number,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
): string | undefined {
	const status = formatExtensionStatuses(footerData.getExtensionStatuses(), theme, config, runtime);
	if (!status) return undefined;

	return truncateToWidth(status, width, "");
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
		case "model":
			return segment(name, `🤖 ${shortenModel(ctx.model?.id ?? "no-model")}`, color, "header");
		case "thinking":
			return segment(
				name,
				`🧠 ${runtime.thinkingLevel}`,
				thinkingColor(runtime.thinkingLevel),
				"header",
			);
		case "branch":
			return segment(name, `🌿 ${footerData.getGitBranch() ?? "no-git"}`, color, "git");
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

function extensionStatusSeparator(presetName: StatuslinePresetName, theme: Theme): string {
	switch (presetName) {
		case "classic":
			return classicExtensionSeparator(theme);
		case "tokyo-night":
			return tokyoNightExtensionSeparator(theme);
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

	if (runtime.isStreaming) return "💭 thinking";
	if (runtime.lastCompletedTool) return `✅ ${runtime.lastCompletedTool}`;
	return "💤 idle";
}

function formatExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
): string {
	const separator = extensionStatusSeparator(config.preset, theme);
	const visibleStatuses = [
		...formatDuplicateExtensionStatus(runtime, theme),
		...[...statuses.entries()]
			.filter(([key, value]) => key !== STATUSLINE_KEY && value.trim().length > 0)
			.map(([key, value]) => formatExtensionStatus(key, value, theme)),
	].slice(0, 5);

	return visibleStatuses.join(separator);
}

function formatExtensionStatus(key: string, value: string, theme: Theme): string {
	const status = splitExtensionStatusIcon(stripExtensionStatusPrefix(key, value));
	const text = truncateToWidth(simplifyExtensionStatusText(status.text), 22, "…");
	const color = extensionColor(key, value);
	const textColor = color === "warning" ? "warning" : "muted";
	return `${theme.fg(color, status.icon)} ${theme.fg(textColor, text)}`;
}

function formatDuplicateExtensionStatus(runtime: RuntimeState, theme: Theme): string[] {
	if (runtime.duplicateExtensions.length === 0) return [];
	const names = runtime.duplicateExtensions.slice(0, 2).join(", ");
	const suffix =
		runtime.duplicateExtensions.length > 2 ? ` +${runtime.duplicateExtensions.length - 2}` : "";
	return [`${theme.fg("warning", "⚠️")} ${theme.fg("warning", `dup ${names}${suffix}`)}`];
}

function splitExtensionStatusIcon(value: string): { icon: string; text: string } {
	const trimmed = value.trim();
	const [firstToken, ...restTokens] = trimmed.split(/\s+/);
	if (firstToken && isEmojiOnlyToken(firstToken)) {
		return { icon: firstToken, text: restTokens.join(" ") };
	}
	return { icon: "🔌", text: trimmed };
}

function isEmojiOnlyToken(value: string): boolean {
	return /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3))(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|[0-9#*]\ufe0f?\u20e3)+$/u.test(
		value,
	);
}

function extensionColor(key: string, value: string): ThemeColor {
	const normalized = `${key} ${value}`.toLowerCase();
	if (/missing|error|fail|conflict|duplicate|unavailable/.test(normalized)) return "warning";
	if (normalized.includes("codex")) return "accent";
	if (/ready|active|running|enabled|awake|ok/.test(normalized)) return "success";
	return "muted";
}

function stripExtensionStatusPrefix(key: string, value: string): string {
	return value.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*`, "iu"), "");
}

function simplifyExtensionStatusText(value: string): string {
	return value
		.trim()
		.replace(/\bready\b/giu, "✓")
		.replace(/\bmissing\b/giu, "✗")
		.replace(/,\s*/g, " ")
		.replace(/\s+\([^)]*\)\s*$/, "")
		.replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDuplicateExtensions(cwd: string): string[] {
	const settingsFiles = [
		join(process.env.HOME ?? "", ".pi", "agent", "settings.json"),
		join(cwd, ".pi", "settings.json"),
	].filter((file) => existsSync(file));
	const sourcesByPackage = new Map<string, Set<string>>();

	for (const settingsFile of settingsFiles) {
		for (const source of readPackageSources(settingsFile)) {
			const packageName = packageNameForSource(source, dirname(settingsFile));
			if (!packageName) continue;
			const sources = sourcesByPackage.get(packageName) ?? new Set<string>();
			sources.add(sourceIdentity(source, dirname(settingsFile)));
			sourcesByPackage.set(packageName, sources);
		}
	}

	return [...sourcesByPackage.entries()]
		.filter(([, sources]) => sources.size > 1)
		.map(([packageName]) => packageName.replace(/^@[^/]+\//, "").replace(/^pi-/, ""));
}

function readPackageSources(settingsFile: string): string[] {
	try {
		const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as { packages?: unknown[] };
		return (settings.packages ?? [])
			.map((entry) => {
				if (typeof entry === "string") return entry;
				if (
					entry &&
					typeof entry === "object" &&
					typeof (entry as { source?: unknown }).source === "string"
				) {
					return (entry as { source: string }).source;
				}
				return undefined;
			})
			.filter((source): source is string => source !== undefined);
	} catch {
		return [];
	}
}

function packageNameForSource(source: string, baseDirectory: string): string | undefined {
	if (source.startsWith("npm:")) return npmPackageName(source);
	const packageJson = join(resolveSourcePath(source, baseDirectory), "package.json");
	try {
		const packageData = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
		return typeof packageData.name === "string" ? packageData.name : undefined;
	} catch {
		return undefined;
	}
}

function npmPackageName(source: string): string {
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) return spec.split("@").slice(0, 2).join("@").replace(/^@/, "@");
	return spec.split("@")[0] ?? spec;
}

function sourceIdentity(source: string, baseDirectory: string): string {
	if (source.startsWith("npm:")) return `npm:${npmPackageName(source)}`;
	return resolveSourcePath(source, baseDirectory);
}

function resolveSourcePath(source: string, baseDirectory: string): string {
	return isAbsolute(source) ? source : resolve(baseDirectory, source);
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
