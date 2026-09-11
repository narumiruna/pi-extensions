import type { ModuleName } from "../modules/catalog.js";
import { reachableModuleRequirements } from "../modules/render.js";
import type { WorkspaceSnapshot } from "../modules/types.js";
import { createFileSystem } from "./helpers.js";
import {
  type CollectorContext,
  type MutableModuleSnapshot,
  PRIVATE_STYLE_SELECTOR,
  type WorkspaceEntry,
  type WorkspaceRefreshInput,
} from "./types.js";

export type { WorkspaceExec, WorkspaceExecResult, WorkspaceRefreshInput } from "./types.js";

export async function collectWorkspaceSnapshot(input: WorkspaceRefreshInput): Promise<WorkspaceSnapshot> {
  const requirements = reachableModuleRequirements(input.config);
  if (input.signal?.aborted || !hasWorkspaceRequirement(requirements)) return freezeSnapshot({});
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
  if (requirements.has("package")) {
    const { collectPackage } = await import("./package.js");
    if (input.signal?.aborted) return freezeSnapshot({});
    const packageValues = await collectPackage(context);
    if (input.signal?.aborted) return freezeSnapshot({});
    if (packageValues) modules.package = packageValues;
  }
  for (const descriptor of COLLECTOR_GROUPS) {
    if (!descriptor.modules.some((name) => requirements.has(name))) continue;
    if (input.signal?.aborted) return freezeSnapshot({});
    const collector = await descriptor.load();
    if (input.signal?.aborted) return freezeSnapshot({});
    mergeModules(modules, await collector(context));
  }
  return input.signal?.aborted ? freezeSnapshot({}) : freezeSnapshot(modules);
}

export function workspaceSnapshotEqual(
  left: WorkspaceSnapshot | undefined,
  right: WorkspaceSnapshot | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasWorkspaceRequirement(requirements: ReadonlyMap<ModuleName, ReadonlySet<string>>): boolean {
  return [...requirements.keys()].some((name) => !BUILT_IN_ONLY_MODULES.has(name));
}

type WorkspaceCollector = (context: CollectorContext) => Promise<MutableModuleSnapshot>;

const COLLECTOR_GROUPS: readonly {
  modules: readonly ModuleName[];
  load(): Promise<WorkspaceCollector>;
}[] = [
  {
    modules: ["nodejs", "python", "rust", "golang", "bun", "deno"],
    load: async () => (await import("./languages.js")).collectLanguages,
  },
  {
    modules: ["mise", "direnv", "pixi", "conda", "nix_shell", "guix_shell"],
    load: async () => (await import("./development.js")).collectDevelopment,
  },
  {
    modules: ["docker_context", "kubernetes", "terraform"],
    load: async () => (await import("./deployment.js")).collectDeployment,
  },
  {
    modules: ["aws", "gcloud", "azure", "openstack"],
    load: async () => (await import("./cloud.js")).collectCloud,
  },
  {
    modules: ["container", "hostname", "os", "username"],
    load: async () => (await import("./execution.js")).collectExecution,
  },
];

const BUILT_IN_ONLY_MODULES = new Set<ModuleName>([
  "brand",
  "provider",
  "model",
  "thinking",
  "directory",
  "git_worktree",
  "git_branch",
  "github_pr",
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
  const styleSelectors: Record<string, string> = {};
  for (const [name, values] of Object.entries(modules)) {
    const selector = Object.hasOwn(values, PRIVATE_STYLE_SELECTOR) ? values[PRIVATE_STYLE_SELECTOR] : undefined;
    delete values[PRIVATE_STYLE_SELECTOR];
    if (selector !== undefined) styleSelectors[name] = selector;
    Object.freeze(values);
  }
  return Object.freeze({
    modules: Object.freeze(modules),
    ...(Object.keys(styleSelectors).length > 0 ? { styleSelectors: Object.freeze(styleSelectors) } : {}),
  });
}
