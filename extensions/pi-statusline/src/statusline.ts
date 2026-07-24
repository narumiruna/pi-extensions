import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { registerStatuslineCommand } from "./commands.js";
import {
	buildExtensionStatusIconAliases,
	type ExtensionStatusIconAliasMap,
	findDuplicateExtensions,
	readInstalledExtensionPackages,
} from "./extension-status.js";
import { type GitStatusSummary, gitStatusSummaryEqual, readGitStatus } from "./git-status.js";
import { type RuntimeState, renderExtensionStatusline, renderStatusline } from "./render.js";
import {
	consumeStatuslineSettingsNotice,
	type LoadedStatuslineSettings,
	loadOrCreateStatuslineSettings,
	loadStatuslineSettings,
	settingsFilePath,
} from "./settings.js";
import type { PalettePreset } from "./types.js";

const STATUSLINE_KEY = "statusline";
const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const GIT_STATUS_EVENT_DEBOUNCE_MS = 250;
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();

export default function statusline(pi: ExtensionAPI) {
	let loaded: LoadedStatuslineSettings | undefined;
	let previewPalettePreset: PalettePreset | undefined;
	let activeSessionManager: ExtensionContext["sessionManager"] | undefined;
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
	let pendingGitStatusRefresh: { cwd: string; generation: number; requestId: number } | undefined;

	const refresh = () => runtime.requestRender?.();
	const ownsRuntime = (ctx: ExtensionContext) => ctx.sessionManager === activeSessionManager;

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
		activeSessionManager = ctx.sessionManager;
		previewPalettePreset = undefined;
		clearGitStatusDebounce();
		activeGitStatusTarget = ctx.mode === "tui" ? { cwd, generation } : undefined;
		runtime.gitStatus = undefined;
		runtime.duplicateExtensions = [];
		runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		if (!activeGitStatusTarget || !loaded) return;
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
					if (!loaded) return [];
					const config = previewPalettePreset
						? { ...loaded.config, palettePreset: previewPalettePreset }
						: loaded.config;
					const mainLine = renderStatusline(width, ctx, footerData, theme, config, runtime);
					const lines = mainLine ? mainLine.split("\n") : [];
					lines.push(
						...renderExtensionStatusline(width, footerData, theme, config, runtime, mainLine),
					);
					return lines;
				},
			};
		});
		refreshGitStatus(cwd, generation);
	};

	const agentDir = getAgentDir();
	const configPath = settingsFilePath(agentDir);
	registerStatuslineCommand(pi, {
		settingsPath: configPath,
		getLoaded: () => loaded ?? loadStatuslineSettings(configPath),
		apply(next, ctx) {
			if (ctx.sessionManager !== activeSessionManager) return;
			previewPalettePreset = undefined;
			loaded = next;
			refresh();
		},
		preview(palettePreset, ctx) {
			if (ctx.sessionManager !== activeSessionManager) return;
			previewPalettePreset = palettePreset;
			refresh();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		runtime.turnCount = 0;
		runtime.activeTools.clear();
		runtime.isStreaming = false;
		loaded = loadOrCreateStatuslineSettings(agentDir);
		const settingsNotice = consumeStatuslineSettingsNotice();
		if (settingsNotice) ctx.ui.notify(settingsNotice, "warning");
		if (loaded.diagnostics.length > 0) {
			ctx.ui.notify(formatSettingsDiagnostics(loaded), "warning");
		}
		runtime.thinkingLevel = pi.getThinkingLevel();
		installFooter(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		installFooter(ctx);
		refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		sessionGeneration += 1;
		activeSessionManager = undefined;
		previewPalettePreset = undefined;
		activeGitStatusTarget = undefined;
		clearGitStatusDebounce();
		pendingGitStatusRefresh = undefined;
		runtime.gitStatus = undefined;
		runtime.activeTools.clear();
		runtime.isStreaming = false;
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

	pi.on("agent_start", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.activeTools.clear();
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.isStreaming = false;
		runtime.activeTools.clear();
		refresh();
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.turnCount += 1;
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		runtime.activeTools.set(event.toolName, currentCount + 1);
		refresh();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		if (currentCount <= 1) runtime.activeTools.delete(event.toolName);
		else runtime.activeTools.set(event.toolName, currentCount - 1);

		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});
}

function formatSettingsDiagnostics(loaded: LoadedStatuslineSettings): string {
	const details = loaded.diagnostics.slice(0, 5).map((item) => item.message);
	const remaining = loaded.diagnostics.length - details.length;
	return [
		`pi-statusline settings: ${details.join("; ")}`,
		...(remaining > 0 ? [`+${remaining} more`] : []),
	].join(" ");
}

export {
	buildExtensionStatusIconAliases,
	type ExtensionStatusIconAliasMap,
	extensionColor,
	formatExtensionStatus,
	npmPackageName,
	simplifyExtensionStatusText,
	splitExtensionStatusIcon,
	stripExtensionStatusPrefix,
	wrapExtensionStatusline,
} from "./extension-status.js";
export {
	formatGitBranchText,
	formatGitBranchValue,
	formatGitStatusSummary,
	type GitStatusSummary,
	parseGitStatusPorcelain,
} from "./git-status.js";
export {
	contextColor,
	formatCount,
	formatToolActivity,
	prContextFromStatuses,
	prLinkFromStatuses,
	shortenModel,
} from "./render.js";
export { normalizeStatuslineSettings, readStatuslineSettings } from "./settings.js";
