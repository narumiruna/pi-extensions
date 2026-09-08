import { homedir, hostname, userInfo } from "node:os";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { completeStarshipArguments } from "./command-contract.js";
import type { StarshipCommandOptions } from "./commands.js";
import {
	type LoadedStarshipConfig,
	loadStarshipConfig,
	type StarshipConfig,
	settingsFilePath,
} from "./config.js";
import { gitSnapshotEqual, readGitSnapshot } from "./modules/git/runtime.js";
import {
	type GithubPrSnapshot,
	type GitSnapshot,
	inspectStatuslineModules,
	reachableModuleRequirements,
	renderStatusline,
	type StarshipRuntimeSnapshot,
	type StatuslineInspection,
	type WorkspaceSnapshot,
} from "./modules/index.js";
import { execWorkspaceCommand } from "./runtime/command.js";
import { githubPrSnapshotEqual, queryGithubPr } from "./runtime/github-pr.js";
import { AsyncRefreshController } from "./runtime/refresh-controller.js";
import {
	collectWorkspaceSnapshot,
	type WorkspaceExec,
	type WorkspaceRefreshInput,
	workspaceSnapshotEqual,
} from "./runtime/workspace.js";
import { summarizeFooterUsage } from "./usage.js";

const REFRESH_INTERVAL_MS = 30_000;
const GITHUB_PR_REFRESH_INTERVAL_MS = 60_000;
const EVENT_DEBOUNCE_MS = 250;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type StarshipCommands = typeof import("./commands.js");
let starshipCommandsPromise: Promise<StarshipCommands> | undefined;

function loadStarshipCommands(): Promise<StarshipCommands> {
	if (!starshipCommandsPromise) {
		starshipCommandsPromise = import("./commands.js").catch((error) => {
			starshipCommandsPromise = undefined;
			throw error;
		});
	}
	return starshipCommandsPromise;
}

interface RuntimeState {
	activeTools: Map<string, number>;
	isStreaming: boolean;
	uiPrompt?: NonNullable<StarshipRuntimeSnapshot["uiPrompt"]>;
	thinkingLevel: string;
	lastCompletedTool?: string;
	git?: GitSnapshot;
	githubPr?: GithubPrSnapshot;
	workspace?: WorkspaceSnapshot;
	requestRender?: () => void;
	renderPreview?: (loaded: LoadedStarshipConfig, width: number) => string[];
	inspect?: (loaded: LoadedStarshipConfig) => StatuslineInspection;
	footerWidth?: number;
}

interface RefreshTarget {
	cwd: string;
	generation: number;
	sessionManager: ExtensionContext["sessionManager"];
}

interface GitRefreshInput {
	cwd: string;
	config: StarshipConfig;
}

interface PiStarshipOptions {
	githubPrExec?: WorkspaceExec;
}

export default function piStarship(pi: ExtensionAPI, options: PiStarshipOptions = {}) {
	let loaded: LoadedStarshipConfig | undefined;
	let loadedRevision = 0;
	let previewLoaded: LoadedStarshipConfig | undefined;
	const runtime: RuntimeState = {
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
	};
	let sessionGeneration = 0;
	let menuController = new AbortController();
	let sessionOwner: ExtensionContext["sessionManager"] | undefined;
	let activeTarget: RefreshTarget | undefined;
	let eventDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let githubPrRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let githubPrExpiryTimer: ReturnType<typeof setTimeout> | undefined;
	let githubPrGeneration = 0;

	const refresh = () => runtime.requestRender?.();
	const ownsRuntime = (ctx: ExtensionContext) => sessionOwner === ctx.sessionManager;
	const githubPrExec = options.githubPrExec ?? execWorkspaceCommand;
	const gitController = new AsyncRefreshController<GitRefreshInput, GitSnapshot | undefined>({
		async read(input, signal) {
			const requirements = reachableModuleRequirements(input.config);
			const gitReachable =
				[...requirements.keys()].some((name) => name.startsWith("git_")) ||
				(requirements.has("directory") &&
					input.config.modules.directory.options.truncate_to_repo === true);
			if (!gitReachable) return undefined;
			try {
				return await readGitSnapshot(pi, input.cwd, {
					includeMetrics: requirements.has("git_metrics"),
					includeTag: requirements.get("git_commit")?.has("tag") ?? false,
					signal,
				});
			} catch {
				return undefined;
			}
		},
		equal: gitSnapshotEqual,
		publish(snapshot) {
			runtime.git = snapshot;
			refresh();
		},
	});
	const githubPrController = new AsyncRefreshController<
		Pick<RefreshTarget, "cwd">,
		GithubPrSnapshot | undefined
	>({
		read: (input, signal) => queryGithubPr(githubPrExec, input.cwd, signal),
		equal: githubPrSnapshotEqual,
		publish(snapshot) {
			runtime.githubPr = snapshot;
			scheduleGithubPrExpiry(snapshot);
			refresh();
		},
	});
	const workspaceController = new AsyncRefreshController<WorkspaceRefreshInput, WorkspaceSnapshot>({
		async read(input, signal) {
			try {
				return await collectWorkspaceSnapshot({ ...input, signal });
			} catch {
				return { modules: {} };
			}
		},
		equal: workspaceSnapshotEqual,
		publish(snapshot) {
			runtime.workspace = snapshot;
			refresh();
		},
	});

	const clearDebounce = () => {
		if (!eventDebounceTimer) return;
		clearTimeout(eventDebounceTimer);
		eventDebounceTimer = undefined;
	};
	const isActiveTarget = (target: RefreshTarget) =>
		activeTarget?.cwd === target.cwd &&
		activeTarget.generation === target.generation &&
		activeTarget.sessionManager === target.sessionManager &&
		target.generation === sessionGeneration;

	const requestRefresh = (
		target: RefreshTarget,
		reason: WorkspaceRefreshInput["reason"] = "event",
	) => {
		if (!loaded || !isActiveTarget(target)) return;
		gitController.request({ cwd: target.cwd, config: loaded.config });
		workspaceController.request(
			workspaceInput(target.cwd, loaded.config, reason, runtime.workspace),
		);
	};
	const scheduleRefresh = (ctx: ExtensionContext) => {
		const target = activeTarget;
		if (!target || target.cwd !== ctx.cwd || target.sessionManager !== ctx.sessionManager) {
			return;
		}
		clearDebounce();
		eventDebounceTimer = setTimeout(() => {
			eventDebounceTimer = undefined;
			requestRefresh(target);
		}, EVENT_DEBOUNCE_MS);
	};

	function restartLocalControllers(target: RefreshTarget) {
		if (!isActiveTarget(target)) return;
		gitController.start(target.generation);
		workspaceController.start(target.generation);
	}

	function clearGithubPrTimers() {
		if (githubPrRefreshTimer) clearInterval(githubPrRefreshTimer);
		if (githubPrExpiryTimer) clearTimeout(githubPrExpiryTimer);
		githubPrRefreshTimer = undefined;
		githubPrExpiryTimer = undefined;
	}

	function stopGithubPr() {
		clearGithubPrTimers();
		githubPrController.stop();
		runtime.githubPr = undefined;
	}

	function githubPrReachable(): boolean {
		return Boolean(loaded && reachableModuleRequirements(loaded.config).has("github_pr"));
	}

	function startGithubPr(target: RefreshTarget): boolean {
		if (!isActiveTarget(target)) return false;
		stopGithubPr();
		if (!githubPrReachable()) return false;
		githubPrController.start(++githubPrGeneration);
		githubPrRefreshTimer = setInterval(() => {
			requestGithubPr(target);
		}, GITHUB_PR_REFRESH_INTERVAL_MS);
		githubPrRefreshTimer.unref?.();
		return true;
	}

	function requestGithubPr(target: RefreshTarget) {
		if (!isActiveTarget(target) || !githubPrReachable()) return;
		githubPrController.request({ cwd: target.cwd });
	}

	function scheduleGithubPrExpiry(snapshot: GithubPrSnapshot | undefined) {
		if (githubPrExpiryTimer) clearTimeout(githubPrExpiryTimer);
		githubPrExpiryTimer = undefined;
		if (snapshot?.expiresAt === undefined) return;
		const target = activeTarget;
		if (!target) return;
		const delay = snapshot.expiresAt - Date.now();
		if (delay <= 0) {
			runtime.githubPr = undefined;
			githubPrController.clear();
			refresh();
			return;
		}
		githubPrExpiryTimer = setTimeout(
			() => {
				githubPrExpiryTimer = undefined;
				if (!isActiveTarget(target) || runtime.githubPr !== snapshot) return;
				scheduleGithubPrExpiry(snapshot);
			},
			Math.min(delay, MAX_TIMER_DELAY_MS),
		);
		githubPrExpiryTimer.unref?.();
	}

	const installFooter = (ctx: ExtensionContext) => {
		const generation = ++sessionGeneration;
		sessionOwner = ctx.sessionManager;
		previewLoaded = undefined;
		menuController.abort(new DOMException("Starship session context replaced", "AbortError"));
		menuController = new AbortController();
		const target: RefreshTarget = { cwd: ctx.cwd, generation, sessionManager: ctx.sessionManager };
		clearDebounce();
		gitController.stop();
		workspaceController.stop();
		stopGithubPr();
		runtime.git = undefined;
		runtime.workspace = undefined;
		runtime.requestRender = undefined;
		runtime.renderPreview = undefined;
		runtime.inspect = undefined;
		runtime.footerWidth = undefined;
		activeTarget = ctx.mode === "tui" ? target : undefined;
		ctx.ui.setStatus("starship", undefined);
		if (!activeTarget || !loaded) return;
		gitController.start(generation);
		workspaceController.start(generation);
		startGithubPr(target);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			runtime.requestRender = () => tui.requestRender();
			runtime.renderPreview = (preview, width) => {
				const snapshot = runtimeSnapshot(ctx, footerData, runtime);
				return wrapFormattedStatusline(
					renderStatusline(preview.config, snapshot, width, getCapabilities().trueColor).ansi,
					width,
				);
			};
			runtime.inspect = (current) =>
				inspectStatuslineModules(
					current.config,
					runtimeSnapshot(ctx, footerData, runtime),
					runtime.footerWidth ?? 80,
				);
			const unsubscribe = footerData.onBranchChange(() => {
				if (!isActiveTarget(target)) return;
				runtime.git = undefined;
				restartLocalControllers(target);
				clearDebounce();
				startGithubPr(target);
				requestRefresh(target);
				requestGithubPr(target);
				tui.requestRender();
			});
			let lastRender:
				| {
						snapshot: StarshipRuntimeSnapshot;
						lines: string[];
						config: StarshipConfig;
						width: number;
				  }
				| undefined;
			const timer = setInterval(() => {
				if (!isActiveTarget(target)) return;
				clearDebounce();
				requestRefresh(target, "periodic");
				// Collectors publish only changed snapshots. The clock is the sole value
				// that changes without publication; reuse the last render's session data.
				if (!lastRender || !reachableModuleRequirements(lastRender.config).get("time")?.has("time"))
					return;
				const now = new Date();
				const previous = lastRender.snapshot.now;
				if (now.getHours() === previous.getHours() && now.getMinutes() === previous.getMinutes())
					return;
				const lines = wrapFormattedStatusline(
					renderStatusline(
						lastRender.config,
						{ ...lastRender.snapshot, now },
						lastRender.width,
						getCapabilities().trueColor,
					).ansi,
					lastRender.width,
				);
				const previousLines = lastRender.lines;
				if (
					lines.length !== previousLines.length ||
					lines.some((line, index) => line !== previousLines[index])
				)
					tui.requestRender();
			}, REFRESH_INTERVAL_MS);
			let disposed = false;

			return {
				dispose() {
					if (disposed) return;
					disposed = true;
					unsubscribe();
					clearInterval(timer);
					if (isActiveTarget(target)) {
						activeTarget = undefined;
						clearDebounce();
						gitController.stop();
						workspaceController.stop();
						stopGithubPr();
						runtime.git = undefined;
						runtime.workspace = undefined;
						runtime.requestRender = undefined;
						runtime.renderPreview = undefined;
						runtime.inspect = undefined;
						runtime.footerWidth = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					runtime.footerWidth = width;
					const current = previewLoaded ?? loaded;
					if (!current) return [];
					const snapshot = runtimeSnapshot(ctx, footerData, runtime);
					const lines = wrapFormattedStatusline(
						renderStatusline(current.config, snapshot, width, getCapabilities().trueColor).ansi,
						width,
					);
					lastRender = { snapshot, lines, config: current.config, width };
					return lines;
				},
			};
		});
		requestRefresh(target, "initial");
		requestGithubPr(target);
	};

	const configPath = settingsFilePath(getAgentDir());
	const commandOptions: StarshipCommandOptions = {
		settingsPath: configPath,
		getLoaded: () => loaded ?? loadStarshipConfig(configPath),
		getLoadedRevision: () => loadedRevision,
		getInspection: () => {
			const current = loaded ?? loadStarshipConfig(configPath);
			return runtime.inspect?.(current);
		},
		getMenuOwner: () => {
			const generation = sessionGeneration;
			return {
				signal: menuController.signal,
				isCurrent: () => generation === sessionGeneration && !menuController.signal.aborted,
			};
		},
		apply(next, ctx) {
			if (sessionOwner !== ctx.sessionManager) {
				throw new Error("Starship session context was replaced");
			}
			previewLoaded = undefined;
			loaded = next;
			loadedRevision += 1;
			const target = activeTarget;
			if (target) {
				restartLocalControllers(target);
				startGithubPr(target);
				requestRefresh(target);
				requestGithubPr(target);
			}
			refresh();
		},
		preview(next, ctx) {
			if (sessionOwner !== ctx.sessionManager) return;
			previewLoaded = next;
			refresh();
		},
		renderPreview(preview, width) {
			return (
				runtime.renderPreview?.(preview, width) ?? [
					"Live preview is unavailable until the footer is ready.",
				]
			);
		},
	};
	pi.registerCommand("starship", {
		description: "Customize or inspect the native Starship-style footer",
		getArgumentCompletions: completeStarshipArguments,
		handler: async (args, ctx) => {
			const commands = await loadStarshipCommands();
			if (sessionOwner !== ctx.sessionManager) return;
			await commands.handleStarshipCommand(args, ctx, commandOptions);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		runtime.activeTools.clear();
		runtime.isStreaming = false;
		runtime.uiPrompt = undefined;
		runtime.lastCompletedTool = undefined;
		loaded = loadStarshipConfig(configPath);
		loadedRevision += 1;
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
		if (sessionOwner !== ctx.sessionManager) return;
		sessionOwner = undefined;
		previewLoaded = undefined;
		sessionGeneration += 1;
		menuController.abort(new DOMException("Starship session shut down", "AbortError"));
		activeTarget = undefined;
		clearDebounce();
		gitController.stop();
		workspaceController.stop();
		stopGithubPr();
		runtime.git = undefined;
		runtime.workspace = undefined;
		runtime.activeTools.clear();
		runtime.isStreaming = false;
		runtime.uiPrompt = undefined;
		runtime.lastCompletedTool = undefined;
		runtime.requestRender = undefined;
		runtime.renderPreview = undefined;
		runtime.inspect = undefined;
		runtime.footerWidth = undefined;
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
		scheduleRefresh(ctx);
		const target = activeTarget;
		if (target?.sessionManager === ctx.sessionManager) requestGithubPr(target);
		refresh();
	});
	pi.on("ui_prompt_start", (event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.uiPrompt = { kind: event.kind, title: event.title };
		refresh();
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.uiPrompt = undefined;
		refresh();
	});
	pi.on("turn_start", () => {
		runtime.isStreaming = true;
		refresh();
	});
	pi.on("turn_end", (_event, ctx) => {
		scheduleRefresh(ctx);
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
		scheduleRefresh(ctx);
		refresh();
	});
}

function workspaceInput(
	cwd: string,
	config: StarshipConfig,
	reason: WorkspaceRefreshInput["reason"],
	previous: WorkspaceSnapshot | undefined,
): WorkspaceRefreshInput {
	return {
		cwd,
		config,
		environment: allowlistedEnvironment(config),
		homeDir: homedir(),
		platform: process.platform,
		hostname: hostname(),
		username: safeUsername(),
		exec: execWorkspaceCommand,
		reason,
		previous,
	};
}

const ENVIRONMENT_ALLOWLIST = [
	"AWS_CONFIG_FILE",
	"AWS_DEFAULT_PROFILE",
	"AWS_DEFAULT_REGION",
	"AWS_PROFILE",
	"AWS_REGION",
	"AZURE_CONFIG_DIR",
	"CLOUDSDK_ACTIVE_CONFIG_NAME",
	"CLOUDSDK_CONFIG",
	"CODESPACES",
	"CONDA_DEFAULT_ENV",
	"DOCKER_CONFIG",
	"DOCKER_CONTEXT",
	"GUIX_ENVIRONMENT",
	"IN_NIX_SHELL",
	"KUBECONFIG",
	"LOGNAME",
	"NIX_SHELL_LEVEL",
	"NIX_SHELL_NAME",
	"OS_CLIENT_CONFIG_FILE",
	"OS_CLOUD",
	"OS_PROJECT_NAME",
	"PATH",
	"PIXI_ENVIRONMENT_NAME",
	"PIXI_PROJECT_NAME",
	"PYENV_VERSION",
	"REMOTE_CONTAINERS",
	"RUSTC",
	"RUSTUP_TOOLCHAIN",
	"SSH_CONNECTION",
	"SSH_TTY",
	"TF_DATA_DIR",
	"TF_WORKSPACE",
	"USER",
	"USERNAME",
	"VIRTUAL_ENV",
	"WSL_DISTRO_NAME",
] as const;

function allowlistedEnvironment(config: StarshipConfig): Record<string, string | undefined> {
	const result: Record<string, string | undefined> = {};
	const configured = config.modules.username.options.detect_env_vars;
	const names = new Set([
		...ENVIRONMENT_ALLOWLIST,
		...(Array.isArray(configured)
			? configured.filter((name): name is string => typeof name === "string")
			: []),
	]);
	for (const name of names) result[name] = process.env[name];
	return result;
}

function safeUsername(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "";
	}
}

function runtimeSnapshot(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	runtime: RuntimeState,
): StarshipRuntimeSnapshot {
	return {
		cwd: ctx.cwd,
		homeDir: homedir(),
		gitRoot: runtime.git?.root,
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
		thinkingLevel: runtime.thinkingLevel,
		turnCount: userTurnCount(ctx),
		activeTools: runtime.activeTools,
		isStreaming: runtime.isStreaming,
		uiPrompt: runtime.uiPrompt,
		lastCompletedTool: runtime.lastCompletedTool,
		contextUsage: ctx.getContextUsage() ?? undefined,
		tokenTotals: summarizeFooterUsage(ctx.sessionManager.getEntries()),
		usingSubscription: isSubscriptionBacked(ctx),
		gitBranch: runtime.git?.branch?.name ?? footerData.getGitBranch(),
		gitBranchDetails: runtime.git?.branch,
		gitCommit: runtime.git?.commit,
		gitState: runtime.git?.state,
		gitMetrics: runtime.git?.metrics,
		gitStatus: runtime.git?.status,
		gitWorktree: runtime.git?.worktree,
		githubPr: runtime.githubPr,
		workspace: runtime.workspace,
		extensionStatuses: footerData.getExtensionStatuses(),
		now: new Date(),
	};
}

function userTurnCount(ctx: ExtensionContext): number {
	return ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}

function isSubscriptionBacked(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return (
		model !== undefined &&
		(model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model))
	);
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

export {
	parseGitDiffShortstat,
	parseGitState,
	parseGitStatusPorcelain,
	parseGitStatusPorcelainV2,
	parseGitWorktree,
} from "./modules/git/runtime.js";
