import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { registerStarshipCommand } from "./commands.js";
import {
	type LoadedStarshipConfig,
	loadOrCreateStarshipConfig,
	loadStarshipConfig,
	settingsFilePath,
} from "./config.js";
import { readInstalledPackageInfo } from "./installed-packages.js";
import { gitStatusEqual, readGitStatus, readGitWorktree } from "./modules/git/runtime.js";
import {
	type ExtensionStatusIconAliasMap,
	type GitStatusSnapshot,
	type GitWorktreeSnapshot,
	renderStatusline,
	type StarshipRuntimeSnapshot,
} from "./modules/index.js";

const GIT_REFRESH_INTERVAL_MS = 30_000;
const GIT_EVENT_DEBOUNCE_MS = 250;
const EMPTY_ALIASES: ExtensionStatusIconAliasMap = new Map();

interface RuntimeState {
	activeTools: Map<string, number>;
	isStreaming: boolean;
	thinkingLevel: string;
	lastCompletedTool?: string;
	gitStatus?: GitStatusSnapshot;
	gitWorktree?: GitWorktreeSnapshot;
	extensionStatusIconAliases: ExtensionStatusIconAliasMap;
	requestRender?: () => void;
	renderPreview?: (loaded: LoadedStarshipConfig, width: number) => string[];
}

export default function piStarship(pi: ExtensionAPI) {
	let loaded: LoadedStarshipConfig | undefined;
	const runtime: RuntimeState = {
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		extensionStatusIconAliases: EMPTY_ALIASES,
	};
	let conflictWarningShown = false;
	let sessionGeneration = 0;
	let gitRequestId = 0;
	let activeGitTarget: { cwd: string; generation: number } | undefined;
	let gitRefreshInFlight = false;
	let gitDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingGitRefresh: { cwd: string; generation: number; requestId: number } | undefined;

	const refresh = () => runtime.requestRender?.();
	const clearDebounce = () => {
		if (!gitDebounceTimer) return;
		clearTimeout(gitDebounceTimer);
		gitDebounceTimer = undefined;
	};
	const isActiveTarget = (cwd: string, generation: number) =>
		activeGitTarget?.cwd === cwd &&
		activeGitTarget.generation === generation &&
		generation === sessionGeneration;
	const isCurrentRequest = (cwd: string, generation: number, requestId: number) =>
		isActiveTarget(cwd, generation) && requestId === gitRequestId;

	const setGitStatus = (status: GitStatusSnapshot | undefined) => {
		if (gitStatusEqual(runtime.gitStatus, status)) return;
		runtime.gitStatus = status;
		refresh();
	};

	const refreshGitWorktree = (cwd: string, generation: number) => {
		void (async () => {
			let worktree: GitWorktreeSnapshot | undefined;
			try {
				worktree = await readGitWorktree(pi, cwd);
			} catch {
				worktree = undefined;
			}
			if (!isActiveTarget(cwd, generation)) return;
			if (
				runtime.gitWorktree?.name === worktree?.name &&
				runtime.gitWorktree?.path === worktree?.path
			) {
				return;
			}
			runtime.gitWorktree = worktree;
			refresh();
		})();
	};

	const runGitRefresh = (cwd: string, generation: number, requestId: number) => {
		if (!isCurrentRequest(cwd, generation, requestId)) return;
		if (gitRefreshInFlight) {
			pendingGitRefresh = { cwd, generation, requestId };
			return;
		}
		gitRefreshInFlight = true;
		void (async () => {
			try {
				const status = await readGitStatus(pi, cwd);
				if (isCurrentRequest(cwd, generation, requestId)) setGitStatus(status);
			} catch {
				if (isCurrentRequest(cwd, generation, requestId)) setGitStatus(undefined);
			} finally {
				gitRefreshInFlight = false;
				const pending = pendingGitRefresh;
				pendingGitRefresh = undefined;
				if (pending) runGitRefresh(pending.cwd, pending.generation, pending.requestId);
			}
		})();
	};

	const refreshGit = (cwd: string, generation = sessionGeneration) => {
		if (!isActiveTarget(cwd, generation)) return;
		runGitRefresh(cwd, generation, ++gitRequestId);
	};
	const scheduleGit = (ctx: ExtensionContext) => {
		if (!activeGitTarget || activeGitTarget.cwd !== ctx.cwd) return;
		const { cwd, generation } = activeGitTarget;
		const requestId = ++gitRequestId;
		clearDebounce();
		gitDebounceTimer = setTimeout(() => {
			gitDebounceTimer = undefined;
			runGitRefresh(cwd, generation, requestId);
		}, GIT_EVENT_DEBOUNCE_MS);
	};

	const installFooter = (ctx: ExtensionContext) => {
		const generation = ++sessionGeneration;
		const cwd = ctx.cwd;
		clearDebounce();
		pendingGitRefresh = undefined;
		runtime.gitStatus = undefined;
		runtime.gitWorktree = undefined;
		runtime.requestRender = undefined;
		runtime.renderPreview = undefined;
		activeGitTarget = ctx.mode === "tui" ? { cwd, generation } : undefined;
		ctx.ui.setStatus("starship", undefined);
		if (!activeGitTarget || !loaded) return;

		const installed = readInstalledPackageInfo(getAgentDir(), cwd, ctx.isProjectTrusted());
		runtime.extensionStatusIconAliases = installed.aliases;
		if (installed.hasStatuslineConflict && !conflictWarningShown) {
			conflictWarningShown = true;
			ctx.ui.notify(
				"pi-starship and pi-statusline both replace Pi's footer; disable one to avoid a footer conflict.",
				"warning",
			);
		}

		ctx.ui.setFooter((tui, _theme, footerData) => {
			runtime.requestRender = () => tui.requestRender();
			runtime.renderPreview = (preview, width) => {
				const snapshot = runtimeSnapshot(ctx, footerData, runtime);
				return wrapFormattedStatusline(renderStatusline(preview.config, snapshot).ansi, width);
			};
			const unsubscribe = footerData.onBranchChange(() => {
				runtime.gitStatus = undefined;
				clearDebounce();
				refreshGit(cwd, generation);
				tui.requestRender();
			});
			const timer = setInterval(() => {
				clearDebounce();
				refreshGit(cwd, generation);
				tui.requestRender();
			}, GIT_REFRESH_INTERVAL_MS);
			let disposed = false;

			return {
				dispose() {
					if (disposed) return;
					disposed = true;
					unsubscribe();
					clearInterval(timer);
					if (isActiveTarget(cwd, generation)) {
						activeGitTarget = undefined;
						clearDebounce();
						pendingGitRefresh = undefined;
						runtime.gitStatus = undefined;
						runtime.gitWorktree = undefined;
						runtime.requestRender = undefined;
						runtime.renderPreview = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					if (!loaded) return [];
					const snapshot = runtimeSnapshot(ctx, footerData, runtime);
					return wrapFormattedStatusline(renderStatusline(loaded.config, snapshot).ansi, width);
				},
			};
		});
		refreshGit(cwd, generation);
		refreshGitWorktree(cwd, generation);
	};

	const configPath = settingsFilePath(getAgentDir());
	registerStarshipCommand(pi, {
		settingsPath: configPath,
		getLoaded: () => loaded ?? loadStarshipConfig(configPath),
		apply(next) {
			loaded = next;
			refresh();
		},
		renderPreview(preview, width) {
			return (
				runtime.renderPreview?.(preview, width) ?? [
					"Live preview is unavailable until the footer is ready.",
				]
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		loaded = loadOrCreateStarshipConfig(configPath);
		if (loaded.diagnostics.length > 0 && (ctx.mode === "tui" || ctx.hasUI)) {
			ctx.ui.notify(formatDiagnostics(loaded), "warning");
		}
		runtime.thinkingLevel = pi.getThinkingLevel();
		installFooter(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		installFooter(ctx);
		refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionGeneration += 1;
		activeGitTarget = undefined;
		clearDebounce();
		pendingGitRefresh = undefined;
		runtime.gitStatus = undefined;
		runtime.gitWorktree = undefined;
		runtime.extensionStatusIconAliases = EMPTY_ALIASES;
		runtime.requestRender = undefined;
		runtime.renderPreview = undefined;
		ctx.ui.setFooter(undefined);
		ctx.ui.setStatus("starship", undefined);
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
		scheduleGit(ctx);
		refresh();
	});
	pi.on("turn_start", () => {
		runtime.isStreaming = true;
		refresh();
	});
	pi.on("turn_end", (_event, ctx) => {
		scheduleGit(ctx);
		refresh();
	});
	pi.on("tool_execution_start", (event) => {
		runtime.activeTools.set(event.toolName, (runtime.activeTools.get(event.toolName) ?? 0) + 1);
		refresh();
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const count = runtime.activeTools.get(event.toolName) ?? 0;
		if (count <= 1) runtime.activeTools.delete(event.toolName);
		else runtime.activeTools.set(event.toolName, count - 1);
		runtime.lastCompletedTool = event.toolName;
		scheduleGit(ctx);
		refresh();
	});
}

function runtimeSnapshot(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	runtime: RuntimeState,
): StarshipRuntimeSnapshot {
	return {
		cwd: ctx.cwd,
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
		thinkingLevel: runtime.thinkingLevel,
		turnCount: userTurnCount(ctx),
		activeTools: runtime.activeTools,
		isStreaming: runtime.isStreaming,
		lastCompletedTool: runtime.lastCompletedTool,
		contextUsage: ctx.getContextUsage() ?? undefined,
		tokenTotals: tokenTotals(ctx),
		gitBranch: footerData.getGitBranch(),
		gitStatus: runtime.gitStatus,
		gitWorktree: runtime.gitWorktree,
		extensionStatuses: footerData.getExtensionStatuses(),
		extensionStatusIconAliases: runtime.extensionStatusIconAliases,
		now: new Date(),
	};
}

function userTurnCount(ctx: ExtensionContext): number {
	return ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}

function tokenTotals(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	const totals = { input: 0, output: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	}
	return totals;
}

function formatDiagnostics(loaded: LoadedStarshipConfig): string {
	const details = loaded.diagnostics.slice(0, 5).map((item) => item.message);
	const remaining = loaded.diagnostics.length - details.length;
	return [
		`pi-starship settings: ${details.join("; ")}`,
		...(remaining > 0 ? [`+${remaining} more`] : []),
	].join(" ");
}

export function wrapFormattedStatusline(format: string, width: number): string[] {
	if (width <= 0) return [];
	return wrapTextWithAnsi(format, width);
}

export { parseGitStatusPorcelain, parseGitWorktree } from "./modules/git/runtime.js";
