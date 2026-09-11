#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFilesSince, selectAffectedTests } from "./select-affected-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".cache", "pi-extensions-test");
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");

const missingTests = activeExtensionDirectories(path.join(root, "packages"))
  .filter((extensionDir) => !hasTestFile(path.join(extensionDir, "test")))
  .map((extensionDir) => path.relative(root, extensionDir));
if (missingTests.length > 0) {
  console.error(`Missing test files for active extension(s): ${missingTests.join(", ")}`);
  process.exit(1);
}

const selection = testSelection();
if (selection.mode === "skip") {
  console.log(`Skipping tests: ${selection.reason}.`);
  process.exit(0);
}
console.log(
  selection.mode === "full"
    ? `Running the full test suite: ${selection.reason}.`
    : `Running affected tests for ${selection.workspaceDirectories.join(", ") || "root only"}: ${selection.reason}.`,
);

if (process.env.PI_EXTENSIONS_BUILD_READY !== "1") runNpm(["run", "build"]);
fs.rmSync(outDir, { recursive: true, force: true });
run(tsc, ["-p", "tsconfig.test.json"]);

const sourceTestFiles = [
  ...findFiles(path.join(root, "test"), ".test.ts"),
  ...findFiles(path.join(root, "packages"), ".test.ts"),
];
const testFiles = sourceTestFiles.filter((testFile) => selectedTestFile(testFile, selection));
if (testFiles.length === 0) {
  console.error("No selected test files found.");
  process.exit(1);
}

const canonicalTempDir = fs.realpathSync(os.tmpdir());
run(process.execPath, [vitest, "run", ...testFiles], {
  ...process.env,
  TMPDIR: canonicalTempDir,
  TMP: canonicalTempDir,
  TEMP: canonicalTempDir,
});

function testSelection() {
  const base = process.env.PI_EXTENSIONS_TEST_BASE;
  if (!base) {
    return {
      mode: "full",
      includeRootTests: true,
      workspaceDirectories: [],
      reason: "no affected-test base was provided",
    };
  }

  try {
    const changedFiles = changedFilesSince(root, base);
    return selectAffectedTests(root, changedFiles);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not select affected tests (${message}); falling back to the full suite.`);
    return {
      mode: "full",
      includeRootTests: true,
      workspaceDirectories: [],
      reason: "affected-test selection failed",
    };
  }
}

function selectedTestFile(testFile, selection) {
  if (selection.mode === "full") return true;
  const relativePath = path.relative(root, testFile).split(path.sep).join("/");
  if (selection.includeRootTests && relativePath.startsWith("test/")) return true;
  return selection.workspaceDirectories.some((directoryName) =>
    relativePath.startsWith(`packages/${directoryName}/test/`),
  );
}

function activeExtensionDirectories(directory) {
  const directories = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;

    const entryPath = path.join(directory, entry.name);
    const manifestPath = path.join(entryPath, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.pi?.extensions !== undefined) directories.push(entryPath);
      continue;
    }
    directories.push(...activeExtensionDirectories(entryPath));
  }
  return directories.sort();
}

function hasTestFile(directory) {
  return findFiles(directory, ".test.ts").length > 0;
}

function runNpm(args) {
  const command = process.env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
  run(command, commandArgs);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function findFiles(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(entryPath, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entryPath);
  }
  return files.sort();
}
