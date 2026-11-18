import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, test } from "vitest";

interface TypecheckSelection {
  mode: "affected" | "full" | "skip";
  buildWorkspaceNames: string[];
  workspaceDirectories: string[];
  workspaceNames: string[];
  reason: string;
}

interface SelectorModule {
  selectStagedTypechecks(root: string, changedFiles: string[]): TypecheckSelection;
  stagedFiles(root: string): string[];
}

interface TestSelectorModule {
  changedFilesSince(root: string, base: string, head?: string): string[];
  selectAffectedTests(
    root: string,
    changedFiles: string[],
  ): {
    mode: "affected" | "full" | "skip";
    includeRootTests: boolean;
    workspaceDirectories: string[];
  };
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const selectorUrl = pathToFileURL(path.join(repositoryRoot, "scripts", "select-staged-typechecks.mjs")).href;
const testSelectorUrl = pathToFileURL(path.join(repositoryRoot, "scripts", "select-affected-tests.mjs")).href;
let fixtureRoot: string;
let selector: SelectorModule;
let testSelector: TestSelectorModule;

beforeAll(async () => {
  selector = (await import(selectorUrl)) as SelectorModule;
  testSelector = (await import(testSelectorUrl)) as TestSelectorModule;
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "pi-precommit-selection-"));
  writeWorkspace("library", {
    name: "@fixture/library",
    scripts: { build: "build" },
    version: "1.0.0",
  });
  writeWorkspace("feature", {
    dependencies: { "@fixture/library": "^1.0.0" },
    name: "@fixture/feature",
    scripts: { build: "build" },
    version: "1.0.0",
  });
  writeWorkspace("app", {
    devDependencies: { "@fixture/feature": "workspace:*" },
    name: "@fixture/app",
    scripts: { build: "build" },
    version: "1.0.0",
  });
  writeWorkspace("registry-consumer", {
    dependencies: { "@fixture/library": "^0.9.0" },
    name: "@fixture/registry-consumer",
    scripts: { build: "build" },
    version: "1.0.0",
  });
  writeWorkspace("unrelated", {
    name: "@fixture/unrelated",
    scripts: { build: "build" },
    version: "1.0.0",
  });
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("a staged workspace selects transitive dependents and required build dependencies", () => {
  const selection = selector.selectStagedTypechecks(fixtureRoot, ["packages/feature/src/index.ts"]);

  assert.equal(selection.mode, "affected");
  assert.deepEqual(selection.workspaceNames, ["@fixture/feature", "@fixture/app"]);
  assert.deepEqual(selection.workspaceDirectories, ["app", "feature"]);
  assert.deepEqual(selection.buildWorkspaceNames, ["@fixture/library", "@fixture/feature", "@fixture/app"]);
});

test("a staged shared library selects local dependents but not registry-resolved consumers", () => {
  const selection = selector.selectStagedTypechecks(fixtureRoot, ["packages/library/src/index.ts"]);

  assert.equal(selection.mode, "affected");
  assert.deepEqual(selection.workspaceNames, ["@fixture/library", "@fixture/feature", "@fixture/app"]);
  assert.doesNotMatch(selection.workspaceNames.join(" "), /registry-consumer|unrelated/u);
});

test("an incompatible dependency range does not build the unrelated local workspace", () => {
  const selection = selector.selectStagedTypechecks(fixtureRoot, ["packages/registry-consumer/src/index.ts"]);

  assert.equal(selection.mode, "affected");
  assert.deepEqual(selection.workspaceNames, ["@fixture/registry-consumer"]);
  assert.deepEqual(selection.buildWorkspaceNames, ["@fixture/registry-consumer"]);
});

test("documentation-only staging skips workspace typechecks", () => {
  const selection = selector.selectStagedTypechecks(fixtureRoot, [
    "README.md",
    "packages/feature/docs/usage.md",
    "packages/feature/LICENSE",
  ]);

  assert.equal(selection.mode, "skip");
  assert.deepEqual(selection.workspaceNames, []);
  assert.deepEqual(selection.buildWorkspaceNames, []);
});

test("shared root inputs and removed workspaces fall back to all workspaces", () => {
  for (const changedFiles of [
    ["package-lock.json"],
    ["tsconfig.json"],
    ["biome.json"],
    ["prek.toml"],
    ["scripts/run-typechecks.mjs"],
    ["packages/removed/src/index.ts"],
    ["../outside.ts"],
  ]) {
    const selection = selector.selectStagedTypechecks(fixtureRoot, changedFiles);
    assert.equal(selection.mode, "full", changedFiles.join(", "));
    assert.deepEqual(selection.workspaceNames, [
      "@fixture/library",
      "@fixture/feature",
      "@fixture/app",
      "@fixture/registry-consumer",
      "@fixture/unrelated",
    ]);
    assert.equal(testSelector.selectAffectedTests(fixtureRoot, changedFiles).mode, "full", changedFiles.join(", "));
  }
});

test("the existing affected-test selector retains reverse-dependent behavior", () => {
  const selection = testSelector.selectAffectedTests(fixtureRoot, ["packages/feature/src/index.ts"]);

  assert.equal(selection.mode, "affected");
  assert.equal(selection.includeRootTests, true);
  assert.deepEqual(selection.workspaceDirectories, ["app", "feature"]);
});

test("GitHub Actions scripts retain full test selection", () => {
  for (const name of [
    "check-version-plan.mjs",
    "publish-command.mjs",
    "publish-packages-sequentially.mjs",
    "publish-packed-packages.mjs",
  ]) {
    const script = `.github/scripts/${name}`;
    for (const changedFiles of [[script], ["packages/feature/src/index.ts", script]]) {
      const selection = testSelector.selectAffectedTests(fixtureRoot, changedFiles);
      assert.equal(selection.mode, "full", changedFiles.join(", "));
      assert.equal(selection.includeRootTests, true);
      assert.deepEqual(selection.workspaceDirectories, ["app", "feature", "library", "registry-consumer", "unrelated"]);
    }
  }
});

test("workflow-only changes retain skipped test selection", () => {
  const selection = testSelector.selectAffectedTests(fixtureRoot, [
    ".github/workflows/ci.yml",
    ".github/workflows/publish.yml",
  ]);
  assert.equal(selection.mode, "skip");
  assert.equal(selection.includeRootTests, false);
  assert.deepEqual(selection.workspaceDirectories, []);
});

test("shared root test support selects all workspaces regardless of change order", () => {
  for (const sharedPath of [
    "test/generated-runtime-fixture.ts",
    "test/runtime-builder-contract.ts",
    "test/support.ts",
    "test/vitest.global-setup.ts",
    "test/vitest.runner.ts",
    "test/vitest.setup.ts",
    "test/test-timeout-policy.ts",
  ]) {
    for (const changedFiles of [
      [sharedPath],
      ["packages/feature/src/index.ts", sharedPath],
      [sharedPath, "packages/feature/src/index.ts"],
    ]) {
      const selection = testSelector.selectAffectedTests(fixtureRoot, changedFiles);
      assert.equal(selection.mode, "full", changedFiles.join(", "));
      assert.equal(selection.includeRootTests, true);
      assert.deepEqual(selection.workspaceDirectories, ["app", "feature", "library", "registry-consumer", "unrelated"]);
    }
  }
});

test("the shared generated-runtime fixture selects its real package consumers", () => {
  const selection = testSelector.selectAffectedTests(repositoryRoot, ["test/generated-runtime-fixture.ts"]);
  assert.equal(selection.mode, "full");
  assert.equal(selection.includeRootTests, true);
  for (const consumer of ["pi-analytics", "pi-chat", "pi-fleet", "pi-lsp", "pi-tool"]) {
    assert.ok(selection.workspaceDirectories.includes(consumer), `missing fixture consumer: ${consumer}`);
  }
});

test("individual root test cases retain root-only affected selection", () => {
  const selection = testSelector.selectAffectedTests(fixtureRoot, ["test/generated-runtime-fixture.test.ts"]);
  assert.equal(selection.mode, "affected");
  assert.equal(selection.includeRootTests, true);
  assert.deepEqual(selection.workspaceDirectories, []);

  const mixed = testSelector.selectAffectedTests(fixtureRoot, [
    "test/generated-runtime-fixture.test.ts",
    "packages/feature/src/index.ts",
  ]);
  assert.equal(mixed.mode, "affected");
  assert.equal(mixed.includeRootTests, true);
  assert.deepEqual(mixed.workspaceDirectories, ["app", "feature"]);
});

test("staged file discovery tracks both rename paths and rejects unstaged manifests", () => {
  const gitRoot = mkdtempSync(path.join(os.tmpdir(), "pi-precommit-git-"));
  try {
    git(gitRoot, ["init", "-q"]);
    writeFileSync(path.join(gitRoot, "staged.ts"), "export const staged = 1;\n");
    writeFileSync(path.join(gitRoot, "unstaged.ts"), "export const unstaged = 1;\n");
    mkdirSync(path.join(gitRoot, "packages", "source", "src"), { recursive: true });
    writeFileSync(
      path.join(gitRoot, "packages", "source", "package.json"),
      '{"name":"@fixture/source","version":"1.0.0"}\n',
    );
    writeFileSync(path.join(gitRoot, "packages", "source", "src", "moved.ts"), "export {};\n");
    git(gitRoot, ["add", "."]);
    commitFixture(gitRoot, "fixture");
    const base = git(gitRoot, ["rev-parse", "HEAD"]).trim();

    writeFileSync(path.join(gitRoot, "staged.ts"), "export const staged = 2;\n");
    writeFileSync(path.join(gitRoot, "unstaged.ts"), "export const unstaged = 2;\n");
    mkdirSync(path.join(gitRoot, "docs"), { recursive: true });
    git(gitRoot, ["mv", "packages/source/src/moved.ts", "docs/moved.ts"]);
    git(gitRoot, ["add", "staged.ts"]);

    const renamedPaths = ["docs/moved.ts", "packages/source/src/moved.ts", "staged.ts"];
    assert.deepEqual(selector.stagedFiles(gitRoot), renamedPaths);

    commitFixture(gitRoot, "rename fixture");
    assert.deepEqual(testSelector.changedFilesSince(gitRoot, base), renamedPaths);

    writeFileSync(
      path.join(gitRoot, "packages", "source", "package.json"),
      '{"name":"@fixture/source","version":"2.0.0"}\n',
    );
    assert.throws(
      () => selector.stagedFiles(gitRoot),
      /workspace manifests differ from the index: packages\/source\/package\.json/u,
    );
  } finally {
    rmSync(gitRoot, { recursive: true, force: true });
  }
});

test("file-scoped Biome checks preserve ordered repository gates", () => {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    allowScripts: Record<string, boolean>;
  };
  const config = readFileSync(path.join(repositoryRoot, "prek.toml"), "utf8");
  const [settings, ...hooks] = config.split("[[repos.hooks]]");
  const commands = [
    ["biome-migrate", "npx @biomejs/biome migrate --write"],
    ["biome-check", "npx @biomejs/biome check --write --files-ignore-unknown=true --no-errors-on-unmatched"],
    ["check-readmes", "uv run scripts/check_readmes.py"],
    ["zizmor", "uvx zizmor --pedantic .github"],
    ["typecheck-staged", "npm run typecheck -- --staged"],
  ] as const;

  assert.match(settings ?? "", /^fail_fast = true$/mu);
  assert.match(settings ?? "", /^repo = "local"$/mu);
  assert.equal(hooks.length, commands.length);
  assert.doesNotMatch(config, /\.\/scripts\//u);
  for (const [priority, [id, entry]] of commands.entries()) {
    const lines = hooks[priority]?.split("\n") ?? [];
    for (const setting of [
      `id = "${id}"`,
      `entry = "${entry}"`,
      'language = "system"',
      `pass_filenames = ${id === "biome-check"}`,
      `priority = ${priority}`,
    ]) {
      assert.ok(lines.includes(setting), `${id}: ${setting}`);
    }
    if (id !== "biome-check") assert.ok(lines.includes("always_run = true"), id);
  }
  const biomeHook = hooks[1] ?? "";
  assert.match(biomeHook, /^types = \["text"\]$/mu);
  assert.doesNotMatch(biomeHook, /^always_run = true$/mu);
  const filter = /^files = '(.+)'$/mu.exec(biomeHook)?.[1];
  assert.ok(filter);
  const pattern = new RegExp(filter);
  for (const extension of [
    "js",
    "jsx",
    "ts",
    "tsx",
    "cjs",
    "cts",
    "mjs",
    "mts",
    "d.ts",
    "d.cts",
    "d.mts",
    "json",
    "jsonc",
    "css",
  ]) {
    assert.match(`src/file.${extension}`, pattern);
  }
  for (const file of ["README.md", "prek.toml", ".github/workflows/check.yml", "logo.png", "file.ts.md"]) {
    assert.doesNotMatch(file, pattern);
  }
  assert.equal(manifest.devDependencies.husky, undefined);
  assert.equal(manifest.allowScripts[`tsc-rs@${manifest.devDependencies["tsc-rs"]}`], true);
  assert.equal(manifest.scripts.precommit, undefined);
  assert.equal(manifest.scripts["check:biome"], "biome check . --error-on-warnings");
  assert.doesNotMatch(manifest.scripts.typecheck, /--staged|--tsc-rs/u);
});

function writeWorkspace(directoryName: string, manifest: Record<string, unknown>) {
  const workspaceRoot = path.join(fixtureRoot, "packages", directoryName);
  mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, "package.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(path.join(workspaceRoot, "src", "index.ts"), "export {};\n");
}

function commitFixture(cwd: string, message: string) {
  git(cwd, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-qm",
    message,
  ]);
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
