#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandDependencies, orderDependenciesFirst, readWorkspaces } from "./workspace-graph.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// All root workflows share this planner; package manifests own prerequisite edges.
export function runBuilds({ root = repositoryRoot, workspaceNames, env = process.env, execute = spawnSync } = {}) {
  const workspaces = readWorkspaces(root);
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const requested = workspaceNames ?? workspaces.map(({ name }) => name);
  for (const name of requested) {
    if (!workspaceByName.has(name)) throw new Error(`Unknown build workspace: ${name}`);
  }
  const selected = expandDependencies(workspaces, requested);
  // Order the full graph before filtering: a package with no build can still carry dependencies.
  const ordered = orderDependenciesFirst(workspaces, selected).filter(
    (name) => workspaceByName.get(name).hasBuildScript,
  );
  const command = env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const prefix = env.npm_execpath ? [env.npm_execpath] : [];
  for (const name of ordered) {
    const result = execute(command, [...prefix, "--workspace", name, "run", "build"], {
      cwd: root,
      stdio: "inherit",
      env,
    });
    if (result.error) {
      console.error(result.error.message);
      return 1;
    }
    // npm's multi-workspace runner continues after errors; consumers must not run after a failed prerequisite.
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = runBuilds();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
