import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
export type ExtensionStatusIconAliasMap = ReadonlyMap<string, readonly string[]>;

interface RuntimeState {
	turnCount: number;
	activeTools: Map<string, number>;
	lastTool?: string;
	lastCompletedTool?: string;
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel;
	duplicateExtensions: string[];
	extensionStatusIconAliases: ExtensionStatusIconAliasMap;
	gitStatus?: GitStatusSummary;
	requestRender?: () => void;
}

export interface GitStatusSummary {
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
}

interface TokenTotals {
	input: number;
	output: number;
	cost: number;
}

const STATUSLINE_KEY = "statusline";
const GITHUB_PR_KEY = "github-pr";
const SETTINGS_FILE = "pi-statusline-settings.json";
const DEFAULT_PRESET: StatuslinePresetName = "tokyo-night";
const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const GIT_STATUS_EVENT_DEBOUNCE_MS = 250;
const GIT_STATUS_TIMEOUT_MS = 3_000;

const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();

const DEFAULT_EXTENSION_STATUS_ICONS: Record<string, string> = {
	"chrome-devtools": "🌐",
	"codex-usage": "📊",
	caffeinate: "💊",
	firecrawl: "🔥",
	"github-pr": "🔎",
	goal: "🎯",
	lsp: "🧰",
	"plan-mode": "📝",
	pisync: "🔄",
	subagents: "🧑‍🤝‍🧑",
	"unknown-error-retry": "🔁",
};

interface StatuslineSettings {
	extensionStatusIcons: Record<string, string>;
}

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
		extensionStatusIconAliases: EMPTY_EXTENSION_STATUS_ICON_ALIASES,
	};

	let sessionGeneration = 0;
	let gitStatusRequestId = 0;
	let activeGitStatusTarget: { cwd: string; generation: number } | undefined;
	let gitStatusRefreshInFlight = false;
	let gitStatusDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingGitStatusRefresh:
		| { cwd: string; generation: number; requestId: number }
		| undefined;

	const refresh = () => runtime.requestRender?.();

	const setGitStatus = (summary: GitStatusSummary | undefined) => {
		if (gitStatusSummaryEqual(runtime.gitStatus, summary)) return;
		runtime.gitStatus = summary;
		refresh();
	};

	const clearGitStatusDebounce = () => {
		if (!gitStatusDebounceTimer) return;
		clearTimeout(gitStatusDebounceTimer);
		gitStatusDebounceTimer = undefined;
	};

	const isActiveGitStatusTarget = (cwd: string, generation: number) =>
		activeGitStatusTarget?.cwd === cwd &&
		activeGitStatusTarget.generation === generation &&
		generation === sessionGeneration;

	const isCurrentGitStatusRequest = (cwd: string, generation: number, requestId: number) =>
		isActiveGitStatusTarget(cwd, generation) && requestId === gitStatusRequestId;

	const runGitStatusRefresh = (cwd: string, generation: number, requestId: number) => {
		if (!isCurrentGitStatusRequest(cwd, generation, requestId)) return;
		if (gitStatusRefreshInFlight) {
			pendingGitStatusRefresh = { cwd, generation, requestId };
			return;
		}

		gitStatusRefreshInFlight = true;
		void (async () => {
			try {
				const summary = await readGitStatus(pi, cwd);
				if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(summary);
			} catch {
				if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(undefined);
			} finally {
				gitStatusRefreshInFlight = false;
				const pending = pendingGitStatusRefresh;
				pendingGitStatusRefresh = undefined;
				if (pending) runGitStatusRefresh(pending.cwd, pending.generation, pending.requestId);
			}
		})();
	};

	const refreshGitStatus = (cwd: string, generation = sessionGeneration) => {
		if (!isActiveGitStatusTarget(cwd, generation)) return;
		runGitStatusRefresh(cwd, generation, ++gitStatusRequestId);
	};

	const scheduleGitStatusRefresh = (cwd: string, generation = sessionGeneration) => {
		if (!isActiveGitStatusTarget(cwd, generation)) return;
		const requestId = ++gitStatusRequestId;
		clearGitStatusDebounce();
		gitStatusDebounceTimer = setTimeout(() => {
			gitStatusDebounceTimer = undefined;
			runGitStatusRefresh(cwd, generation, requestId);
		}, GIT_STATUS_EVENT_DEBOUNCE_MS);
	};

	const scheduleGitStatusRefreshForContext = (ctx: ExtensionContext) => {
		if (!activeGitStatusTarget || activeGitStatusTarget.cwd !== ctx.cwd) return;
		scheduleGitStatusRefresh(activeGitStatusTarget.cwd, activeGitStatusTarget.generation);
	};

	const installFooter = (ctx: ExtensionContext) => {
		const generation = ++sessionGeneration;
		const cwd = ctx.cwd;
		clearGitStatusDebounce();
		activeGitStatusTarget = ctx.mode === "tui" ? { cwd, generation } : undefined;
		runtime.gitStatus = undefined;
		runtime.duplicateExtensions = [];
		runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		if (!activeGitStatusTarget) return;
		const installedPackages = readInstalledExtensionPackages(cwd);
		runtime.duplicateExtensions = findDuplicateExtensions(installedPackages);
		runtime.extensionStatusIconAliases = buildExtensionStatusIconAliases(installedPackages);
		ctx.ui.setFooter((tui, theme, footerData) => {
			runtime.requestRender = () => tui.requestRender();

			const refreshFooterGitStatus = () => refreshGitStatus(cwd, generation);
			const branchUnsubscribe = footerData.onBranchChange(() => {
				runtime.gitStatus = undefined;
				clearGitStatusDebounce();
				refreshFooterGitStatus();
				tui.requestRender();
			});
			const clock = setInterval(() => {
				clearGitStatusDebounce();
				refreshFooterGitStatus();
				tui.requestRender();
			}, GIT_STATUS_REFRESH_INTERVAL_MS);

			return {
				dispose() {
					branchUnsubscribe();
					clearInterval(clock);
					if (isActiveGitStatusTarget(cwd, generation)) {
						activeGitStatusTarget = undefined;
						clearGitStatusDebounce();
						pendingGitStatusRefresh = undefined;
						runtime.gitStatus = undefined;
						runtime.duplicateExtensions = [];
						runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
						runtime.requestRender = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const lines = [renderStatusline(width, ctx, footerData, theme, config, runtime)];
					lines.push(...renderExtensionStatusline(width, footerData, theme, config, runtime));
					return lines;
				},
			};
		});
		refreshGitStatus(cwd, generation);
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
		sessionGeneration += 1;
		activeGitStatusTarget = undefined;
		clearGitStatusDebounce();
		pendingGitStatusRefresh = undefined;
		runtime.gitStatus = undefined;
		runtime.duplicateExtensions = [];
		runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
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

	pi.on("agent_end", (_event, ctx) => {
		runtime.isStreaming = false;
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});

	pi.on("turn_start", () => {
		runtime.turnCount += 1;
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("turn_end", (_event, ctx) => {
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});

	pi.on("tool_execution_start", (event) => {
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		runtime.activeTools.set(event.toolName, currentCount + 1);
		runtime.lastTool = event.toolName;
		refresh();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		if (currentCount <= 1) runtime.activeTools.delete(event.toolName);
		else runtime.activeTools.set(event.toolName, currentCount - 1);

		runtime.lastCompletedTool = event.toolName;
		scheduleGitStatusRefreshForContext(ctx);
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
		extensionStatusIcons: readStatuslineSettings().extensionStatusIcons,
	};
}

export function readStatuslineSettings(settingsPath = join(getAgentDir(), SETTINGS_FILE)): StatuslineSettings {
	try {
		return normalizeStatuslineSettings(JSON.parse(readFileSync(settingsPath, "utf8")));
	} catch {
		return { extensionStatusIcons: {} };
	}
}

export function normalizeStatuslineSettings(value: unknown): StatuslineSettings {
	if (!value || typeof value !== "object") return { extensionStatusIcons: {} };
	const icons = (value as { extensionStatusIcons?: unknown }).extensionStatusIcons;
	if (!icons || typeof icons !== "object" || Array.isArray(icons)) {
		return { extensionStatusIcons: {} };
	}
	return {
		extensionStatusIcons: Object.fromEntries(
			Object.entries(icons).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		),
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
): string[] {
	const status = formatExtensionStatuses(footerData.getExtensionStatuses(), theme, config, runtime);
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
			const pr = branch ? prLinkFromStatuses(footerData.getExtensionStatuses()) : undefined;
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

async function readGitStatus(
	pi: ExtensionAPI,
	cwd: string,
): Promise<GitStatusSummary | undefined> {
	const result = await pi.exec(
		"git",
		["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
		{
			cwd,
			timeout: GIT_STATUS_TIMEOUT_MS,
		},
	);
	if (result.code !== 0 || result.killed) return undefined;
	return parseGitStatusPorcelain(result.stdout);
}

export function parseGitStatusPorcelain(output: string): GitStatusSummary {
	const summary: GitStatusSummary = {
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicts: 0,
	};

	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			const ahead = line.match(/\bahead (\d+)/u);
			const behind = line.match(/\bbehind (\d+)/u);
			summary.ahead = ahead ? Number(ahead[1]) : 0;
			summary.behind = behind ? Number(behind[1]) : 0;
			continue;
		}

		const indexStatus = line[0] ?? " ";
		const worktreeStatus = line[1] ?? " ";
		if (indexStatus === "?" && worktreeStatus === "?") {
			summary.untracked += 1;
			continue;
		}
		if (isConflictStatus(indexStatus, worktreeStatus)) {
			summary.conflicts += 1;
			continue;
		}
		if (isChangedStatus(indexStatus)) summary.staged += 1;
		if (isChangedStatus(worktreeStatus)) summary.modified += 1;
	}

	return summary;
}

function isConflictStatus(indexStatus: string, worktreeStatus: string): boolean {
	return (
		(indexStatus === "D" && worktreeStatus === "D") ||
		(indexStatus === "A" && worktreeStatus === "A") ||
		indexStatus === "U" ||
		worktreeStatus === "U"
	);
}

function isChangedStatus(status: string): boolean {
	return status !== " " && status !== "?" && status !== "!";
}

export function formatGitStatusSummary(summary: GitStatusSummary | undefined): string {
	if (!summary) return "";
	const tokens = [
		["⇡", summary.ahead],
		["⇣", summary.behind],
		["+", summary.staged],
		["~", summary.modified],
		["?", summary.untracked],
		["!", summary.conflicts],
	] as const;
	return tokens
		.filter(([, count]) => count > 0)
		.map(([prefix, count]) => `${prefix}${formatCount(count)}`)
		.join(" ");
}

export function formatGitBranchText(
	branch: string | null,
	status: GitStatusSummary | undefined,
	pr?: string,
): string {
	if (!branch) return "🌿 no-git";
	const suffixes = [formatGitStatusSummary(status), pr ? `(${pr})` : ""].filter(Boolean);
	return suffixes.length > 0 ? `🌿 ${branch} ${suffixes.join(" ")}` : `🌿 ${branch}`;
}

function gitStatusSummaryEqual(
	left: GitStatusSummary | undefined,
	right: GitStatusSummary | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.ahead === right.ahead &&
		left.behind === right.behind &&
		left.staged === right.staged &&
		left.modified === right.modified &&
		left.untracked === right.untracked &&
		left.conflicts === right.conflicts
	);
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
			// github-pr is rendered inline in the branch segment, so skip it here to avoid duplication.
			.filter(
				([key, value]) =>
					key !== STATUSLINE_KEY && key !== GITHUB_PR_KEY && value.trim().length > 0,
			)
			.map(([key, value]) =>
				formatExtensionStatus(key, value, theme, config, runtime.extensionStatusIconAliases),
			),
	].slice(0, 5);

	return visibleStatuses.join(separator);
}

export function formatExtensionStatus(
	key: string,
	value: string,
	theme: Theme,
	config: Pick<StatuslineConfig, "extensionStatusIcons">,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap = EMPTY_EXTENSION_STATUS_ICON_ALIASES,
): string {
	const status = splitExtensionStatusIcon(stripExtensionStatusPrefix(key, value));
	const text = simplifyExtensionStatusText(status.text);
	const color = extensionColor(key, value);
	const textColor = color === "warning" ? "warning" : "muted";
	const icon = extensionStatusIcon(key, status.icon, config.extensionStatusIcons, extensionStatusIconAliases);
	const renderedText = theme.fg(textColor, text);
	return icon ? `${theme.fg(color, icon)} ${renderedText}` : renderedText;
}

function extensionStatusIcon(
	key: string,
	leadingIcon: string | undefined,
	configuredIcons: Record<string, string>,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap,
) {
	if (Object.hasOwn(configuredIcons, key)) return configuredIcons[key];
	for (const alias of extensionStatusAliasesForKey(key, extensionStatusIconAliases)) {
		if (Object.hasOwn(configuredIcons, alias)) return configuredIcons[alias];
	}
	return leadingIcon ?? DEFAULT_EXTENSION_STATUS_ICONS[key] ?? "🔌";
}

function extensionStatusAliasesForKey(
	key: string,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap,
): readonly string[] {
	for (const [statusBase, aliases] of extensionStatusIconAliases) {
		if (statusKeyMatchesStatusBase(key, statusBase)) return aliases;
	}
	return [];
}

function statusKeyMatchesStatusBase(key: string, statusBase: string): boolean {
	return key === statusBase || key.startsWith(`${statusBase}:`) || key.startsWith(`${statusBase}/`);
}

export function wrapExtensionStatusline(status: string, width: number): string[] {
	if (!status || width <= 0) return [];
	return wrapTextWithAnsi(status, width);
}

function formatDuplicateExtensionStatus(runtime: RuntimeState, theme: Theme): string[] {
	if (runtime.duplicateExtensions.length === 0) return [];
	const names = runtime.duplicateExtensions.slice(0, 2).join(", ");
	const suffix =
		runtime.duplicateExtensions.length > 2 ? ` +${runtime.duplicateExtensions.length - 2}` : "";
	return [`${theme.fg("warning", "⚠️")} ${theme.fg("warning", `dup ${names}${suffix}`)}`];
}

export function splitExtensionStatusIcon(value: string): { icon?: string; text: string } {
	const trimmed = value.trim();
	const [firstToken, ...restTokens] = trimmed.split(/\s+/);
	if (firstToken && isEmojiOnlyToken(firstToken)) {
		return { icon: firstToken, text: restTokens.join(" ") };
	}
	return { text: trimmed };
}

function isEmojiOnlyToken(value: string): boolean {
	return /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3))(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|[0-9#*]\ufe0f?\u20e3)+$/u.test(
		value,
	);
}

export function extensionColor(key: string, value: string): ThemeColor {
	const normalized = `${key} ${value}`.toLowerCase();
	if (/missing|error|fail|conflict|duplicate|unavailable/.test(normalized)) return "warning";
	if (normalized.includes("codex")) return "accent";
	if (/ready|active|running|enabled|awake|ok/.test(normalized)) return "success";
	return "muted";
}

export function stripExtensionStatusPrefix(key: string, value: string): string {
	return value.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*`, "iu"), "");
}

export function simplifyExtensionStatusText(value: string): string {
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

interface InstalledExtensionPackage {
	packageName: string;
	source: string;
	identity: string;
}

function readInstalledExtensionPackages(cwd: string): InstalledExtensionPackage[] {
	const packages: InstalledExtensionPackage[] = [];
	const settingsFiles = extensionSettingsFiles(cwd);

	for (const settingsFile of settingsFiles) {
		const baseDirectory = dirname(settingsFile);
		for (const rawSource of readPackageSources(settingsFile)) {
			const source = rawSource.trim();
			if (!source) continue;
			const packageName = packageNameForSource(source, baseDirectory);
			if (!packageName) continue;
			packages.push({ packageName, source, identity: sourceIdentity(source, baseDirectory) });
		}
	}

	return packages;
}

function extensionSettingsFiles(cwd: string): string[] {
	return [
		join(process.env.HOME ?? "", ".pi", "agent", "settings.json"),
		join(cwd, ".pi", "settings.json"),
	].filter((file) => existsSync(file));
}

function findDuplicateExtensions(installedPackages: readonly InstalledExtensionPackage[]): string[] {
	const sourcesByPackage = new Map<string, Set<string>>();

	for (const extensionPackage of installedPackages) {
		const sources = sourcesByPackage.get(extensionPackage.packageName) ?? new Set<string>();
		sources.add(extensionPackage.identity);
		sourcesByPackage.set(extensionPackage.packageName, sources);
	}

	return [...sourcesByPackage.entries()]
		.filter(([, sources]) => sources.size > 1)
		.map(([packageName]) => packageName.replace(/^@[^/]+\//, "").replace(/^pi-/, ""));
}

export function buildExtensionStatusIconAliases(
	installedPackages: readonly { packageName: string; source?: string }[],
): Map<string, string[]> {
	const packageAliasesByStatusBase = new Map<string, Map<string, string[]>>();

	for (const extensionPackage of installedPackages) {
		const candidate = extensionStatusIconAliasCandidate(extensionPackage.packageName, extensionPackage.source);
		if (!candidate) continue;
		const aliasesByPackage = packageAliasesByStatusBase.get(candidate.statusBase) ?? new Map<string, string[]>();
		const existingAliases = aliasesByPackage.get(extensionPackage.packageName) ?? [];
		aliasesByPackage.set(extensionPackage.packageName, uniqueStrings([...existingAliases, ...candidate.aliases]));
		packageAliasesByStatusBase.set(candidate.statusBase, aliasesByPackage);
	}

	const aliases = new Map<string, string[]>();
	for (const [statusBase, aliasesByPackage] of packageAliasesByStatusBase) {
		if (aliasesByPackage.size === 1) aliases.set(statusBase, [...aliasesByPackage.values()][0] ?? []);
	}
	return aliases;
}

function extensionStatusIconAliasCandidate(
	packageName: string,
	source?: string,
): { statusBase: string; aliases: string[] } | undefined {
	const packageBase = packageBaseName(packageName);
	const statusBase = statusBaseFromPackageBase(packageBase);
	if (!statusBase) return undefined;

	const sourceAliases = source?.startsWith("npm:") ? [source, `npm:${npmPackageName(source)}`] : [];
	return {
		statusBase,
		aliases: uniqueStrings([...sourceAliases, packageName, packageBase, statusBase]),
	};
}

function packageBaseName(packageName: string): string {
	const slashIndex = packageName.lastIndexOf("/");
	return slashIndex === -1 ? packageName : packageName.slice(slashIndex + 1);
}

function statusBaseFromPackageBase(packageBase: string): string {
	return packageBase.startsWith("pi-") && packageBase.length > "pi-".length
		? packageBase.slice("pi-".length)
		: packageBase;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
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

export function npmPackageName(source: string): string {
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
