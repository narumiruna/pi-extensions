#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFilesSince, selectAffectedTests } from "./select-affected-tests.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runTests({ root = repositoryRoot, env = process.env, execute = spawnSync, log = console.log } = {}) {
  const outDir = path.join(root, "node_modules", ".cache", "pi-extensions-test");
  const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
  // Diagnostics are advisory: an unlink failure must not replace a command's exit status.
  try {
    fs.rmSync(path.join(root, "node_modules", ".cache", "pi-extensions-test-report.json"), { force: true });
  } catch {
    console.warn("Could not clear the previous test timing report; it may be stale.");
  }
  const missingTests = activeExtensionDirectories(path.join(root, "packages"))
    .filter((extensionDir) => !hasTestFile(path.join(extensionDir, "test")))
    .map((extensionDir) => path.relative(root, extensionDir));
  if (missingTests.length > 0) {
    console.error(`Missing test files for active extension(s): ${missingTests.join(", ")}`);
    return 1;
  }

  const selection = testSelection(root, env);
  if (selection.mode === "skip") {
    log(`Skipping tests: ${selection.reason}.`);
    return 0;
  }
  log(
    selection.mode === "full"
      ? `Running the full test suite: ${selection.reason}.`
      : `Running affected tests for ${selection.workspaceDirectories.join(", ") || "root only"}: ${selection.reason}.`,
  );

  function run(stage, command, args, commandEnv = env) {
    const started = performance.now();
    const result = execute(command, args, { cwd: root, stdio: "inherit", env: commandEnv });
    const failed = result.error || result.status !== 0;
    log(`[test timing] ${stage}: ${(performance.now() - started).toFixed(0)} ms${failed ? " (failed)" : ""}`);
    if (result.error) console.error(result.error.message);
    return result.error ? 1 : (result.status ?? 1);
  }

  if (env.PI_EXTENSIONS_BUILD_READY !== "1") {
    const command = env.npm_execpath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const args = env.npm_execpath ? [env.npm_execpath, "run", "build"] : ["run", "build"];
    const status = run("Build", command, args);
    if (status !== 0) return status;
  } else log("[test timing] Build: reused successful prerequisite output");

  fs.rmSync(outDir, { recursive: true, force: true });
  const compilationStatus = run("Test compilation", tsc, ["-p", "tsconfig.test.json"]);
  if (compilationStatus !== 0) return compilationStatus;

  const sourceTestFiles = [
    ...findFiles(path.join(root, "test"), ".test.ts"),
    ...findFiles(path.join(root, "packages"), ".test.ts"),
  ];
  const testFiles = sourceTestFiles.filter((testFile) => selectedTestFile(testFile, selection, root));
  if (testFiles.length === 0) {
    console.error("No selected test files found.");
    return 1;
  }

  const canonicalTempDir = fs.realpathSync(os.tmpdir());
  return run("Vitest", process.execPath, [vitest, "run", ...testFiles], {
    ...env,
    // Cache bytecode, not module instances: isolated forks keep fresh runtime state.
    // Honor Node's overrides and do not opt external V8 coverage into less precise
    // source positions. Vitest also disables caching in its precise-coverage workers
    // and flushes each fork's cache before teardown.
    NODE_COMPILE_CACHE:
      env.NODE_COMPILE_CACHE ??
      (env.NODE_V8_COVERAGE === undefined
        ? path.join(root, "node_modules", ".cache", "pi-extensions-node-compile-cache")
        : undefined),
    TMPDIR: canonicalTempDir,
    TMP: canonicalTempDir,
    TEMP: canonicalTempDir,
  });
}

function testSelection(root, env) {
  const base = env.PI_EXTENSIONS_TEST_BASE;
  if (!base) return fullSelection("no affected-test base was provided");
  try {
    return selectAffectedTests(root, changedFilesSince(root, base));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not select affected tests (${message}); falling back to the full suite.`);
    return fullSelection("affected-test selection failed");
  }
}

function fullSelection(reason) {
  return { mode: "full", includeRootTests: true, workspaceDirectories: [], reason };
}

function selectedTestFile(testFile, selection, root) {
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

if (import.meta.main) {
  process.exitCode = runTests();
}
