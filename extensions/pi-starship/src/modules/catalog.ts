import { activityModule } from "./activity.js";
import { brandModule } from "./brand.js";
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
import { languageModules } from "./languages.js";
import { modelModule } from "./model.js";
import { packageModule } from "./package.js";
import { providerModule } from "./provider.js";
import { thinkingModule } from "./thinking.js";
import { timeModule } from "./time.js";
import { tokensModule } from "./tokens.js";
import { turnModule } from "./turn.js";
import type { ModuleDefinition } from "./types.js";

export const MODULE_DEFINITIONS = [
	brandModule,
	providerModule,
	modelModule,
	thinkingModule,
	directoryModule,
	gitWorktreeModule,
	gitBranchModule,
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
	costModule,
	timeModule,
	turnModule,
	fillModule,
	// Render last so earlier modules can consume extension-owned status values.
	extensionStatusModule,
] as const satisfies readonly ModuleDefinition<string>[];

export type ModuleName = (typeof MODULE_DEFINITIONS)[number]["name"];

export const MODULE_NAMES: readonly ModuleName[] = MODULE_DEFINITIONS.map(
	(definition) => definition.name,
);
