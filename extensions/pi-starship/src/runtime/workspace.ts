import type { ModuleName } from "../modules/catalog.js";
import { reachableModuleRequirements } from "../modules/render.js";
import type { WorkspaceSnapshot } from "../modules/types.js";
import { collectCloud } from "./cloud.js";
import { collectDeployment } from "./deployment.js";
import { collectDevelopment } from "./development.js";
import { collectExecution } from "./execution.js";
import { createFileSystem } from "./helpers.js";
import { collectLanguages } from "./languages.js";
import { collectPackage } from "./package.js";
import type {
	CollectorContext,
	MutableModuleSnapshot,
	WorkspaceEntry,
	WorkspaceRefreshInput,
} from "./types.js";

export { parseTerraformVersion } from "./deployment.js";
export { parseDirenvStatus, parseMiseHealth } from "./development.js";
export { parseRuntimeVersion } from "./languages.js";
export type { WorkspaceExec, WorkspaceRefreshInput } from "./types.js";

export async function collectWorkspaceSnapshot(
	input: WorkspaceRefreshInput,
): Promise<WorkspaceSnapshot> {
	const requirements = reachableModuleRequirements(input.config);
	if (!hasWorkspaceRequirement(requirements)) return freezeSnapshot({});
	const fs = createFileSystem(input);
	let listing: Promise<readonly WorkspaceEntry[]> | undefined;
	const context: CollectorContext = {
		input,
		fs,
		requirements,
		entries() {
			listing ??= fs.readDirectory(input.cwd);
			return listing;
		},
		options(name) {
			return input.config.modules[name].options;
		},
		needs(name, variable) {
			const variables = requirements.get(name);
			return Boolean(variables && (variable === undefined || variables.has(variable)));
		},
	};
	const modules: MutableModuleSnapshot = {};
	const packageValues = await collectPackage(context);
	if (packageValues) modules.package = packageValues;
	for (const collector of [
		collectLanguages,
		collectDevelopment,
		collectDeployment,
		collectCloud,
		collectExecution,
	]) {
		mergeModules(modules, await collector(context));
	}
	return freezeSnapshot(modules);
}

export function workspaceSnapshotEqual(
	left: WorkspaceSnapshot | undefined,
	right: WorkspaceSnapshot | undefined,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function hasWorkspaceRequirement(
	requirements: ReadonlyMap<ModuleName, ReadonlySet<string>>,
): boolean {
	return [...requirements.keys()].some((name) => !BUILT_IN_ONLY_MODULES.has(name));
}

const BUILT_IN_ONLY_MODULES = new Set<ModuleName>([
	"brand",
	"provider",
	"model",
	"thinking",
	"directory",
	"git_worktree",
	"git_branch",
	"git_commit",
	"git_state",
	"git_metrics",
	"git_status",
	"activity",
	"context",
	"tokens",
	"cost",
	"time",
	"turn",
	"fill",
	"extension_status",
]);

function mergeModules(target: MutableModuleSnapshot, source: MutableModuleSnapshot): void {
	for (const [name, values] of Object.entries(source)) {
		Object.defineProperty(target, name, {
			value: values,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
}

function freezeSnapshot(modules: MutableModuleSnapshot): WorkspaceSnapshot {
	for (const values of Object.values(modules)) Object.freeze(values);
	return Object.freeze({ modules: Object.freeze(modules) });
}
