#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBuilds } from "./run-builds.mjs";
import { selectStagedTypechecks, stagedFiles } from "./select-staged-typechecks.mjs";
import { readWorkspaces } from "./workspace-graph.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagedOnly = process.argv.slice(2).includes("--staged");

if (!stagedOnly) {
  runFullTypechecks();
  process.exit(0);
}

let selection;
try {
  selection = selectStagedTypechecks(root, stagedFiles(root));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Could not select staged typechecks (${message}); falling back to all workspaces.`);
  runFullTypechecks();
  process.exit(0);
}

if (selection.mode === "skip") {
  console.log(`Skipping workspace typechecks: ${selection.reason}.`);
  process.exit(0);
}
if (selection.mode === "full") {
  console.log(`Running full workspace typechecks: ${selection.reason}.`);
  runFullTypechecks();
  process.exit(0);
}

console.log(
  `Running affected workspace typechecks for ${selection.workspaceDirectories.join(", ")}: ${selection.reason}.`,
);
if (process.env.PI_EXTENSIONS_BUILD_READY !== "1" && selection.buildWorkspaceNames.length > 0) {
  const status = runBuilds({ root, workspaceNames: selection.buildWorkspaceNames });
  if (status !== 0) process.exit(status);
}
runWorkspaceTypechecks(selection.workspaceNames);

function runFullTypechecks() {
  if (process.env.PI_EXTENSIONS_BUILD_READY !== "1") {
    runNpm(["run", "build"]);
    process.env.PI_EXTENSIONS_BUILD_READY = "1";
  }
  runWorkspaceTypechecks();
}

function runWorkspaceTypechecks(workspaceNames) {
  const workspaces = readWorkspaces(root);
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const selected = workspaceNames
    ? workspaceNames.map((name) => {
        const workspace = workspaceByName.get(name);
        if (!workspace) throw new Error(`Unknown typecheck workspace: ${name}`);
        return workspace;
      })
    : workspaces;
  if (selected.length === 0) throw new Error("No typecheck workspaces found.");

  // Use Node directly: npm exec turns the Windows executable path into unquoted shell text.
  const compiler = path.join(root, "node_modules", "tsc-rs", "bin", "tsc-rs");
  for (const { directoryName, name } of selected) {
    console.log(`Typechecking ${name} with tsc-rs.`);
    runCommand(process.execPath, [compiler, "--noEmit"], path.join(root, "packages", directoryName));
  }
}

function runNpm(args) {
  const command = process.env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
  runCommand(command, commandArgs);
}

function runCommand(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
