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
const selectorUrl = pathToFileURL(
	path.join(repositoryRoot, "scripts", "select-staged-typechecks.mjs"),
).href;
const testSelectorUrl = pathToFileURL(
	path.join(repositoryRoot, "scripts", "select-affected-tests.mjs"),
).href;
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
	assert.deepEqual(selection.buildWorkspaceNames, [
		"@fixture/library",
		"@fixture/feature",
		"@fixture/app",
	]);
});

test("a staged shared library selects local dependents but not registry-resolved consumers", () => {
	const selection = selector.selectStagedTypechecks(fixtureRoot, ["packages/library/src/index.ts"]);

	assert.equal(selection.mode, "affected");
	assert.deepEqual(selection.workspaceNames, [
		"@fixture/library",
		"@fixture/feature",
		"@fixture/app",
	]);
	assert.doesNotMatch(selection.workspaceNames.join(" "), /registry-consumer|unrelated/u);
});

test("an incompatible dependency range does not build the unrelated local workspace", () => {
	const selection = selector.selectStagedTypechecks(fixtureRoot, [
		"packages/registry-consumer/src/index.ts",
	]);

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
	}
});

test("the existing affected-test selector retains reverse-dependent behavior", () => {
	const selection = testSelector.selectAffectedTests(fixtureRoot, [
		"packages/feature/src/index.ts",
	]);

	assert.equal(selection.mode, "affected");
	assert.equal(selection.includeRootTests, true);
	assert.deepEqual(selection.workspaceDirectories, ["app", "feature"]);
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

test("the pre-commit hook narrows typechecks without narrowing the repository gate", () => {
	const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	assert.match(manifest.scripts.precommit, /run-typechecks\.mjs --staged/u);
	assert.doesNotMatch(manifest.scripts.typecheck, /--staged/u);
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
