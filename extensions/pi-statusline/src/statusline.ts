import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildExtensionStatusIconAliases,
	type ExtensionStatusIconAliasMap,
	findDuplicateExtensions,
	readInstalledExtensionPackages,
} from "./extension-status.js";
import {
	gitStatusSummaryEqual,
	readGitStatus,
	type GitStatusSummary,
} from "./git-status.js";
import {
	renderExtensionStatusline,
	renderStatusline,
	type RuntimeState,
} from "./render.js";
import { consumeStatuslineSettingsNotice, createDefaultConfig } from "./settings.js";

const STATUSLINE_KEY = "statusline";
const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const GIT_STATUS_EVENT_DEBOUNCE_MS = 250;
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();

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
					const mainLine = renderStatusline(width, ctx, footerData, theme, config, runtime);
					const lines = [mainLine];
					lines.push(
						...renderExtensionStatusline(width, footerData, theme, config, runtime, mainLine),
					);
					return lines;
				},
			};
		});
		refreshGitStatus(cwd, generation);
	};

	pi.on("session_start", (_event, ctx) => {
		const settingsNotice = consumeStatuslineSettingsNotice();
		if (settingsNotice) ctx.ui.notify(settingsNotice, "warning");
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
	formatGitStatusSummary,
	parseGitStatusPorcelain,
	type GitStatusSummary,
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
