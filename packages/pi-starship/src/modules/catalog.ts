import { activityModule } from "./activity.js";
import { brandModule } from "./brand.js";
import { cacheModule } from "./cache.js";
import { cloudModules } from "./cloud.js";
import { contextModule } from "./context.js";
import { costModule } from "./cost.js";
import { deploymentModules } from "./deployment.js";
import { developmentModules } from "./development.js";
import { directoryModule } from "./directory.js";
import { executionModules } from "./execution.js";
import { extensionStatusModule } from "./extension-status.js";
import { fillModule } from "./fill.js";
import { gitBranchModule } from "./git/branch.js";
import { gitCommitModule } from "./git/commit.js";
import { gitMetricsModule } from "./git/metrics.js";
import { gitStateModule } from "./git/state.js";
import { gitStatusModule } from "./git/status.js";
import { gitWorktreeModule } from "./git/worktree.js";
import { githubPrModule } from "./github-pr.js";
import { languageModules } from "./languages.js";
import { modelModule } from "./model.js";
import { packageModule } from "./package.js";
import { providerModule } from "./provider.js";
import { thinkingModule } from "./thinking.js";
import { timeModule } from "./time.js";
import { tokensModule } from "./tokens.js";
import { turnModule } from "./turn.js";
import type { ModuleDefinition } from "./types.js";

const MODULE_IMPLEMENTATIONS = [
	brandModule,
	providerModule,
	modelModule,
	thinkingModule,
	directoryModule,
	gitWorktreeModule,
	gitBranchModule,
	githubPrModule,
	gitCommitModule,
	gitStateModule,
	gitMetricsModule,
	gitStatusModule,
	packageModule,
	...languageModules,
	...developmentModules,
	...deploymentModules,
	...cloudModules,
	...executionModules,
	activityModule,
	contextModule,
	tokensModule,
	cacheModule,
	costModule,
	timeModule,
	turnModule,
	fillModule,
	// Keep arbitrary third-party statuses after the native modules.
	extensionStatusModule,
] as const satisfies readonly ModuleDefinition<string>[];

export type ModuleName = (typeof MODULE_IMPLEMENTATIONS)[number]["name"];

const MODULE_DESCRIPTIONS = {
	activity: "Current Pi activity, extension UI wait, or most recently completed tool.",
	aws: "Active AWS profile and region.",
	azure: "Active Azure subscription and optional username.",
	brand: "pi-starship brand mark.",
	bun: "Bun version detected in the current workspace.",
	cache: "Prompt-cache usage and latest cache hit rate.",
	conda: "Active Conda environment.",
	container: "Current container or remote development environment.",
	context: "Current model context-window usage.",
	cost: "Reported estimated session cost or subscription state.",
	deno: "Deno version detected in the current workspace.",
	directory: "Current working directory.",
	direnv: "Current direnv loading and permission state.",
	docker_context: "Active Docker context.",
	extension_status: "Statuses published through Pi's extension-neutral status map.",
	fill: "Flexible spacing that aligns content within the footer width.",
	gcloud: "Active Google Cloud project, account, and region.",
	git_branch: "Current Git branch and upstream identity.",
	git_commit: "Current Git commit hash or tag.",
	git_metrics: "Added and deleted lines in the current Git worktree.",
	git_state: "Current Git operation such as merge, rebase, or cherry-pick.",
	git_status: "Current Git worktree and index status summary.",
	git_worktree: "Current linked Git worktree identity.",
	github_pr: "Current branch's GitHub pull request state, checks, and review.",
	golang: "Go version detected in the current workspace.",
	guix_shell: "Current Guix shell state.",
	hostname: "Current host name, normally shown for remote sessions.",
	kubernetes: "Active Kubernetes context, namespace, cluster, and user.",
	mise: "Current mise configuration health.",
	model: "Current Pi model.",
	nix_shell: "Current Nix shell state, name, and nesting level.",
	nodejs: "Node.js version detected in the current workspace.",
	openstack: "Active OpenStack cloud and project.",
	os: "Current operating system identity.",
	package: "Current workspace package version and manifest source.",
	pixi: "Active Pixi environment and project.",
	provider: "Current Pi model provider.",
	python: "Python version, virtual environment, and pyenv state.",
	rust: "Rust toolchain detected in the current workspace.",
	terraform: "Active Terraform workspace and version.",
	thinking: "Current Pi thinking level or streaming state.",
	time: "Current local time.",
	tokens: "Session input and output token totals.",
	turn: "Current user-turn count.",
	username: "Current user identity when configured to display.",
} as const satisfies Record<ModuleName, string>;

export type CatalogModuleDefinition<Name extends string = ModuleName> = ModuleDefinition<Name> & {
	readonly description: string;
};

export const MODULE_DEFINITIONS: readonly CatalogModuleDefinition[] = MODULE_IMPLEMENTATIONS.map(
	(definition) => ({
		...definition,
		description: MODULE_DESCRIPTIONS[definition.name],
	}),
);

export const MODULE_NAMES: readonly ModuleName[] = MODULE_IMPLEMENTATIONS.map(
	(definition) => definition.name,
);
