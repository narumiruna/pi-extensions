import { homedir, hostname, userInfo } from "node:os";
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
	type StarshipConfig,
	settingsFilePath,
} from "./config.js";
import { readInstalledPackageInfo } from "./installed-packages.js";
import { gitSnapshotEqual, readGitSnapshot } from "./modules/git/runtime.js";
import {
	type ExtensionStatusIconAliasMap,
	type GitSnapshot,
	reachableModuleRequirements,
	renderStatusline,
	type StarshipRuntimeSnapshot,
	type WorkspaceSnapshot,
} from "./modules/index.js";
import { AsyncRefreshController } from "./runtime/refresh-controller.js";
import {
	collectWorkspaceSnapshot,
	type WorkspaceRefreshInput,
	workspaceSnapshotEqual,
} from "./runtime/workspace.js";

const REFRESH_INTERVAL_MS = 30_000;
const EVENT_DEBOUNCE_MS = 250;
const EMPTY_ALIASES: ExtensionStatusIconAliasMap = new Map();

interface RuntimeState {
	activeTools: Map<string, number>;
	isStreaming: boolean;
	thinkingLevel: string;
	lastCompletedTool?: string;
	git?: GitSnapshot;
	workspace?: WorkspaceSnapshot;
	extensionStatusIconAliases: ExtensionStatusIconAliasMap;
	requestRender?: () => void;
	renderPreview?: (loaded: LoadedStarshipConfig, width: number) => string[];
}

interface RefreshTarget {
	cwd: string;
	generation: number;
}

interface GitRefreshInput {
	cwd: string;
	config: StarshipConfig;
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
	let activeTarget: RefreshTarget | undefined;
	let eventDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	const refresh = () => runtime.requestRender?.();
	const gitController = new AsyncRefreshController<GitRefreshInput, GitSnapshot | undefined>({
		async read(input) {
			const requirements = reachableModuleRequirements(input.config);
			const gitReachable = [...requirements.keys()].some((name) => name.startsWith("git_"));
			if (!gitReachable) return undefined;
			try {
				return await readGitSnapshot(pi, input.cwd, {
					includeMetrics: requirements.has("git_metrics"),
					includeTag: requirements.get("git_commit")?.has("tag") ?? false,
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
	const workspaceController = new AsyncRefreshController<WorkspaceRefreshInput, WorkspaceSnapshot>({
		async read(input) {
			try {
				return await collectWorkspaceSnapshot(input);
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
		target.generation === sessionGeneration;

	const requestRefresh = (
		target: RefreshTarget,
		reason: WorkspaceRefreshInput["reason"] = "event",
	) => {
		if (!loaded || !isActiveTarget(target)) return;
		gitController.request({ cwd: target.cwd, config: loaded.config });
		workspaceController.request(
			workspaceInput(pi, target.cwd, loaded.config, reason, runtime.workspace),
		);
	};
	const scheduleRefresh = (ctx: ExtensionContext) => {
		const target = activeTarget;
		if (!target || target.cwd !== ctx.cwd) return;
		clearDebounce();
		eventDebounceTimer = setTimeout(() => {
			eventDebounceTimer = undefined;
			requestRefresh(target);
		}, EVENT_DEBOUNCE_MS);
	};

	const installFooter = (ctx: ExtensionContext) => {
		const generation = ++sessionGeneration;
		const target = { cwd: ctx.cwd, generation };
		clearDebounce();
		gitController.stop();
		workspaceController.stop();
		runtime.git = undefined;
		runtime.workspace = undefined;
		runtime.requestRender = undefined;
		runtime.renderPreview = undefined;
		activeTarget = ctx.mode === "tui" ? target : undefined;
		ctx.ui.setStatus("starship", undefined);
		if (!activeTarget || !loaded) return;
		gitController.start(generation);
		workspaceController.start(generation);

		const installed = readInstalledPackageInfo(getAgentDir(), target.cwd, ctx.isProjectTrusted());
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
				return wrapFormattedStatusline(
					renderStatusline(preview.config, snapshot, width).ansi,
					width,
				);
			};
			const unsubscribe = footerData.onBranchChange(() => {
				runtime.git = undefined;
				gitController.clear();
				clearDebounce();
				requestRefresh(target);
				tui.requestRender();
			});
			const timer = setInterval(() => {
				clearDebounce();
				requestRefresh(target, "periodic");
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
						runtime.git = undefined;
						runtime.workspace = undefined;
						runtime.requestRender = undefined;
						runtime.renderPreview = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					if (!loaded) return [];
					const snapshot = runtimeSnapshot(ctx, footerData, runtime);
					return wrapFormattedStatusline(
						renderStatusline(loaded.config, snapshot, width).ansi,
						width,
					);
				},
			};
		});
		requestRefresh(target, "initial");
	};

	const configPath = settingsFilePath(getAgentDir());
	registerStarshipCommand(pi, {
		settingsPath: configPath,
		getLoaded: () => loaded ?? loadStarshipConfig(configPath),
		apply(next) {
			loaded = next;
			const target = activeTarget;
			if (target) requestRefresh(target);
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
		activeTarget = undefined;
		clearDebounce();
		gitController.stop();
		workspaceController.stop();
		runtime.git = undefined;
		runtime.workspace = undefined;
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
		scheduleRefresh(ctx);
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
	pi: ExtensionAPI,
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
		exec: (command, args, options) => pi.exec(command, args, options),
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
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
		thinkingLevel: runtime.thinkingLevel,
		turnCount: userTurnCount(ctx),
		activeTools: runtime.activeTools,
		isStreaming: runtime.isStreaming,
		lastCompletedTool: runtime.lastCompletedTool,
		contextUsage: ctx.getContextUsage() ?? undefined,
		tokenTotals: tokenTotals(ctx),
		gitBranch: runtime.git?.branch?.name ?? footerData.getGitBranch(),
		gitBranchDetails: runtime.git?.branch,
		gitCommit: runtime.git?.commit,
		gitState: runtime.git?.state,
		gitMetrics: runtime.git?.metrics,
		gitStatus: runtime.git?.status,
		gitWorktree: runtime.git?.worktree,
		workspace: runtime.workspace,
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

export {
	parseGitDiffShortstat,
	parseGitState,
	parseGitStatusPorcelain,
	parseGitStatusPorcelainV2,
	parseGitWorktree,
} from "./modules/git/runtime.js";
