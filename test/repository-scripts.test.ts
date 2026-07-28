import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const boundaryScript = path.join(repositoryRoot, "scripts/check-extension-boundaries.mjs");
const bumpScript = path.join(repositoryRoot, "scripts/bump-shared-version.mjs");
const checkScript = path.join(repositoryRoot, "scripts/run-checks.mjs");
const runTypechecksScript = path.join(repositoryRoot, "scripts/run-typechecks.mjs");
const setPiVersionScript = path.join(repositoryRoot, "scripts/set-pi-version.mjs");
const expectedChecks = ["biome:check", "check:boundaries", "test", "typecheck"];

test("shared-version discovery includes publishable library and extension workspaces", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-workspaces-"));
	try {
		writeJson(path.join(fixture, "package.json"), {
			name: "fixture-root",
			private: true,
			version: "1.2.3",
			workspaces: ["packages/*", "extensions/*", "experimental/*"],
		});
		writeJson(path.join(fixture, "packages/pi-tui-kit/package.json"), {
			name: "@fixture/menu",
			version: "1.2.3",
		});
		writeJson(path.join(fixture, "extensions/pi-public/package.json"), {
			name: "@fixture/public",
			version: "1.2.3",
		});
		writeJson(path.join(fixture, "experimental/pi-manual/package.json"), {
			name: "@fixture/manual-experiment",
			version: "0.0.0",
		});

		const output = execFileSync(process.execPath, [bumpScript, "--list-packages"], {
			cwd: fixture,
			encoding: "utf8",
		});
		assert.deepEqual(JSON.parse(output), [
			"experimental/pi-manual/package.json",
			"extensions/pi-public/package.json",
			"package.json",
			"packages/pi-tui-kit/package.json",
		]);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("shared major bumps advance internal workspace dependency ranges", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-workspace-ranges-"));
	try {
		writeJson(path.join(fixture, "package.json"), {
			name: "fixture-root",
			private: true,
			version: "0.35.0",
			workspaces: ["packages/*", "extensions/*"],
		});
		writeJson(path.join(fixture, "packages/menu/package.json"), {
			name: "@fixture/menu",
			version: "0.35.0",
		});
		writeJson(path.join(fixture, "extensions/consumer/package.json"), {
			name: "@fixture/consumer",
			version: "0.35.0",
			dependencies: { "@fixture/menu": "<1" },
		});
		const fixtureScript = path.join(fixture, "scripts/bump-shared-version.mjs");
		mkdirSync(path.dirname(fixtureScript), { recursive: true });
		writeFileSync(fixtureScript, readFileSync(bumpScript, "utf8"));
		const fixtureBin = path.join(fixture, "bin");
		mkdirSync(fixtureBin, { recursive: true });
		writeFileSync(path.join(fixtureBin, "npm"), "#!/usr/bin/env node\n", { mode: 0o755 });

		execFileSync(process.execPath, [fixtureScript, "major"], {
			cwd: fixture,
			env: { ...process.env, PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}` },
		});
		const consumer = JSON.parse(
			readFileSync(path.join(fixture, "extensions/consumer/package.json"), "utf8"),
		);
		assert.equal(consumer.version, "1.0.0");
		assert.equal(consumer.dependencies["@fixture/menu"], "<2");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("shared-version discovery skips workspace roots that are not present", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-workspaces-missing-"));
	try {
		writeJson(path.join(fixture, "package.json"), {
			name: "fixture-root",
			private: true,
			version: "1.2.3",
			workspaces: ["packages/*", "extensions/*", "experimental/*"],
		});
		writeJson(path.join(fixture, "extensions/pi-public/package.json"), {
			name: "@fixture/public",
			version: "1.2.3",
		});

		const output = execFileSync(process.execPath, [bumpScript, "--list-packages"], {
			cwd: fixture,
			encoding: "utf8",
		});
		assert.deepEqual(JSON.parse(output), ["extensions/pi-public/package.json", "package.json"]);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("latest-Pi setup updates library, production, and experimental workspaces", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-version-workspaces-"));
	try {
		writeJson(path.join(fixture, "package.json"), {
			name: "fixture-root",
			private: true,
			devDependencies: { "@earendil-works/pi-coding-agent": "1.0.0" },
		});
		writeJson(path.join(fixture, "packages/pi-tui-kit/package.json"), {
			name: "@fixture/menu",
			devDependencies: { "@earendil-works/pi-coding-agent": "1.0.0" },
		});
		writeJson(path.join(fixture, "extensions/pi-public/package.json"), {
			name: "@fixture/public",
			devDependencies: { "@earendil-works/pi-tui": "1.0.0" },
		});
		writeJson(path.join(fixture, "experimental/pi-manual/package.json"), {
			name: "@fixture/manual-experiment",
			devDependencies: { "@earendil-works/pi-ai": "1.0.0" },
		});

		const fixtureScript = path.join(fixture, "scripts/set-pi-version.mjs");
		mkdirSync(path.dirname(fixtureScript), { recursive: true });
		writeFileSync(fixtureScript, readFileSync(setPiVersionScript, "utf8"));
		execFileSync(process.execPath, [fixtureScript, "9.9.9"], { cwd: fixture });
		assert.equal(
			JSON.parse(readFileSync(path.join(fixture, "package.json"), "utf8")).devDependencies[
				"@earendil-works/pi-coding-agent"
			],
			"9.9.9",
		);
		assert.equal(
			JSON.parse(readFileSync(path.join(fixture, "packages/pi-tui-kit/package.json"), "utf8"))
				.devDependencies["@earendil-works/pi-coding-agent"],
			"9.9.9",
		);
		assert.equal(
			JSON.parse(readFileSync(path.join(fixture, "experimental/pi-manual/package.json"), "utf8"))
				.devDependencies["@earendil-works/pi-ai"],
			"9.9.9",
		);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("publish workflow selects changed tag packages and all manual recovery packages", () => {
	const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
	assert.match(workflow, /fetch-depth: 0/);
	assert.match(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
	assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/);
	assert.match(workflow, /list-publish-workspaces\.mjs --release "\$RELEASE_TAG"/);
	assert.match(workflow, /list-publish-workspaces\.mjs --all/);
	assert.match(workflow, /npm view "\$\{package\}@\$\{version\}" version/);
	assert.match(workflow, /NPM_CONFIG_PROVENANCE: "true"/);
	assert.match(workflow, /printf '%s\\t%s\\n'.*>> \/tmp\/pi-published\.tsv/);
	assert.match(workflow, /if: always\(\)/);
	assert.match(workflow, /PUBLISH_OUTCOME: \$\{\{ steps\.publish\.outcome \}\}/);
	assert.match(workflow, />> "\$GITHUB_STEP_SUMMARY"/);
});

test("libraries and extensions participate in automated and manual publishing", () => {
	const selector = readFileSync(
		path.join(repositoryRoot, "scripts/list-publish-workspaces.mjs"),
		"utf8",
	);
	const justfile = readFileSync(path.join(repositoryRoot, "justfile"), "utf8");
	const bumpWorkflow = readFileSync(
		path.join(repositoryRoot, ".github/workflows/bump-version.yml"),
		"utf8",
	);
	assert.match(selector, /const packageRoots = \["packages", "extensions", "experimental"\]/);
	assert.match(justfile, /package_json="\.\/experimental\/pi-\$name\/package\.json"/);
	assert.match(
		justfile,
		/for package_json in packages\/\*\/package\.json extensions\/\*\/package\.json experimental\/\*\/package\.json/,
	);
	assert.match(bumpWorkflow, /packages\/\*\/package\.json/);
	assert.match(bumpWorkflow, /experimental\/\*\/package\.json/);
	assert.match(justfile, /^publish name:/m);
	assert.doesNotMatch(justfile, /\botp\b|--otp/);
});

test("extension boundaries allow helper libraries but still reject extension dependencies", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-boundaries-"));
	try {
		writeJson(path.join(fixture, "package.json"), { name: "fixture", private: true });
		writeJson(path.join(fixture, "tsconfig.json"), {
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
			},
			include: ["extensions/**/*.ts"],
		});
		writeLibraryFixture(fixture, "pi-tui-kit", "@narumitw/pi-tui-kit");
		writeExtensionFixture(fixture, "pi-alpha", "@narumitw/pi-alpha", {
			"@narumitw/pi-tui-kit": "<1",
		});
		writeExtensionFixture(fixture, "pi-beta", "@narumitw/pi-beta", {});

		const allowed = spawnSync(process.execPath, [boundaryScript], {
			cwd: fixture,
			encoding: "utf8",
		});
		assert.equal(allowed.status, 0, allowed.stderr);
		assert.match(allowed.stdout, /1 libraries and 2 active extensions/);

		const libraryPath = path.join(fixture, "packages/pi-tui-kit/package.json");
		const library = JSON.parse(readFileSync(libraryPath, "utf8"));
		library.pi = { extensions: ["./src/index.ts"] };
		writeJson(libraryPath, library);
		const invalidLibrary = spawnSync(process.execPath, [boundaryScript], {
			cwd: fixture,
			encoding: "utf8",
		});
		assert.equal(invalidLibrary.status, 1);
		assert.match(invalidLibrary.stderr, /libraries must not declare pi\.extensions/);
		delete library.pi;
		writeJson(libraryPath, library);

		const alphaPath = path.join(fixture, "extensions/pi-alpha/package.json");
		const alpha = JSON.parse(readFileSync(alphaPath, "utf8"));
		alpha.dependencies["@narumitw/pi-beta"] = "<1";
		writeJson(alphaPath, alpha);
		const rejected = spawnSync(process.execPath, [boundaryScript], {
			cwd: fixture,
			encoding: "utf8",
		});
		assert.equal(rejected.status, 1);
		assert.match(rejected.stderr, /must not reference @narumitw\/pi-beta/);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("standalone typechecks build workspaces unless a verified build is ready", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-typecheck-order-"));
	try {
		const tracePath = path.join(fixture, "trace.log");
		const fakeNpmPath = path.join(fixture, "fake-npm.mjs");
		writeFileSync(
			fakeNpmPath,
			`import fs from "node:fs";\nfs.appendFileSync(process.env.FAKE_CHECK_TRACE, process.argv.slice(2).join(" ") + "\\n");\n`,
		);
		const baseEnv = {
			...process.env,
			FAKE_CHECK_TRACE: tracePath,
			npm_execpath: fakeNpmPath,
			PI_EXTENSIONS_BUILD_READY: "",
		};

		const standalone = spawnSync(process.execPath, [runTypechecksScript], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: baseEnv,
		});
		assert.equal(standalone.status, 0, standalone.stderr);
		assert.deepEqual(readFileSync(tracePath, "utf8").trim().split("\n"), [
			"run build",
			"--workspaces run typecheck",
		]);

		writeFileSync(tracePath, "");
		const prebuilt = spawnSync(process.execPath, [runTypechecksScript], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: { ...baseEnv, PI_EXTENSIONS_BUILD_READY: "1" },
		});
		assert.equal(prebuilt.status, 0, prebuilt.stderr);
		assert.equal(readFileSync(tracePath, "utf8").trim(), "--workspaces run typecheck");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("repository checks build before starting independent gates in parallel", () => {
	const result = runFakeChecks();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(traceEntries(result.trace, "start"), ["build", ...expectedChecks].sort());
	assert.deepEqual(traceEntries(result.trace, "finish"), ["build", ...expectedChecks].sort());
	assertBuildFinishedFirst(result.trace);
});

test("repository checks report a failing gate after all gates run", () => {
	const result = runFakeChecks("typecheck");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /typecheck failed/);
	assert.deepEqual(traceEntries(result.trace, "start"), ["build", ...expectedChecks].sort());
	assert.deepEqual(traceEntries(result.trace, "finish"), ["build", ...expectedChecks].sort());
	assertBuildFinishedFirst(result.trace);
});

test("repository checks stop before consumer gates when the prerequisite build fails", () => {
	const result = runFakeChecks("build");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /build failed/);
	assert.deepEqual(result.trace.trim().split("\n"), ["start:build", "finish:build"]);
});

function runFakeChecks(failingCheck = "") {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-checks-"));
	try {
		const tracePath = path.join(fixture, "trace.log");
		const fakeNpmPath = path.join(fixture, "fake-npm.mjs");
		writeFileSync(
			fakeNpmPath,
			`import fs from "node:fs";
const check = process.argv.at(-1);
const tracePath = process.env.FAKE_CHECK_TRACE;
fs.appendFileSync(tracePath, \`start:\${check}\\n\`);
if (check === "build") {
\tfs.appendFileSync(tracePath, \`finish:\${check}\\n\`);
\tif (check === process.env.FAKE_CHECK_FAILURE) process.exit(23);
\tprocess.exit(0);
}
if (process.env.PI_EXTENSIONS_BUILD_READY !== "1") process.exit(71);
const deadline = Date.now() + 2_000;
while (
\tfs
\t\t.readFileSync(tracePath, "utf8")
\t\t.split("\\n")
\t\t.filter((line) => line.startsWith("start:") && line !== "start:build").length !== 4
) {
\tif (Date.now() > deadline) process.exit(70);
\tawait new Promise((resolve) => setTimeout(resolve, 10));
}
fs.appendFileSync(tracePath, \`finish:\${check}\\n\`);
if (check === process.env.FAKE_CHECK_FAILURE) process.exit(23);
`,
		);

		const result = spawnSync(process.execPath, [checkScript], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: {
				...process.env,
				FAKE_CHECK_FAILURE: failingCheck,
				FAKE_CHECK_TRACE: tracePath,
				npm_execpath: fakeNpmPath,
			},
		});
		return {
			...result,
			trace: readFileSync(tracePath, "utf8"),
		};
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

function assertBuildFinishedFirst(trace: string) {
	const entries = trace.trim().split("\n");
	const buildFinished = entries.indexOf("finish:build");
	assert.notEqual(buildFinished, -1);
	for (const check of expectedChecks) {
		assert.ok(buildFinished < entries.indexOf(`start:${check}`));
	}
}

function traceEntries(trace: string, event: string) {
	return trace
		.split("\n")
		.filter((line) => line.startsWith(`${event}:`))
		.map((line) => line.slice(event.length + 1))
		.sort();
}

function writeLibraryFixture(fixture: string, directory: string, name: string) {
	writeJson(path.join(fixture, "packages", directory, "package.json"), {
		name,
		files: ["dist"],
		main: "./dist/index.js",
		types: "./dist/index.d.ts",
		scripts: { build: "tsc" },
	});
}

function writeExtensionFixture(
	fixture: string,
	directory: string,
	name: string,
	dependencies: Record<string, string>,
) {
	const root = path.join(fixture, "extensions", directory);
	writeJson(path.join(root, "package.json"), {
		name,
		dependencies,
		pi: { extensions: ["./src/index.ts"] },
	});
	mkdirSync(path.join(root, "src"), { recursive: true });
	writeFileSync(path.join(root, "src/index.ts"), "export default function extension() {}\n");
}

function writeJson(filePath: string, value: unknown) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}
