import { activityModule } from "./activity.js";
import { brandModule } from "./brand.js";
import { contextModule } from "./context.js";
import { costModule } from "./cost.js";
import { directoryModule } from "./directory.js";
import { extensionStatusModule } from "./extension-status.js";
import { gitBranchModule } from "./git/branch.js";
import { gitStatusModule } from "./git/status.js";
import { gitWorktreeModule } from "./git/worktree.js";
import { modelModule } from "./model.js";
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
	gitStatusModule,
	activityModule,
	contextModule,
	tokensModule,
	costModule,
	timeModule,
	turnModule,
	// Render last so earlier modules can consume extension-owned status values.
	extensionStatusModule,
] as const satisfies readonly ModuleDefinition<string>[];

export type ModuleName = (typeof MODULE_DEFINITIONS)[number]["name"];

export const MODULE_NAMES: readonly ModuleName[] = MODULE_DEFINITIONS.map(
	(definition) => definition.name,
);
