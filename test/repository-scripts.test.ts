import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const bumpScript = path.join(repositoryRoot, "scripts", "bump-shared-version.mjs");
const checkScript = path.join(repositoryRoot, "scripts", "run-checks.mjs");
const expectedChecks = ["biome:check", "check:boundaries", "test", "typecheck"];

test("shared-version discovery skips publishable experimental workspaces", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-workspaces-"));
	try {
		writeJson(path.join(fixture, "package.json"), {
			name: "fixture-root",
			private: true,
			version: "1.2.3",
			workspaces: ["extensions/*", "extensions/experimental/*"],
		});
		writeJson(path.join(fixture, "extensions/pi-public/package.json"), {
			name: "@fixture/public",
			version: "1.2.3",
		});
		writeJson(path.join(fixture, "extensions/experimental/pi-manual/package.json"), {
			name: "@fixture/manual-experiment",
			version: "0.0.0",
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

test("shared-version discovery skips workspace roots that are not present", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "pi-workspaces-missing-"));
	try {
		writeJson(path.join(fixture, "package.json"), {
			name: "fixture-root",
			private: true,
			version: "1.2.3",
			workspaces: ["extensions/*", "extensions/experimental/*"],
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

test("experimental publishing is manual-only", () => {
	const selector = readFileSync(
		path.join(repositoryRoot, "scripts/list-publish-workspaces.mjs"),
		"utf8",
	);
	const justfile = readFileSync(path.join(repositoryRoot, "justfile"), "utf8");
	assert.match(selector, /new Set\(\["experimental"\]\)/);
	assert.match(justfile, /package_json="\.\/extensions\/experimental\/pi-\$name\/package\.json"/);
	assert.match(justfile, /WARNING: manually publishing experimental Pi extension/);
	assert.match(justfile, /^publish name:/m);
	assert.doesNotMatch(justfile, /\botp\b|--otp/);
});

test("repository checks start in parallel", () => {
	const result = runFakeChecks();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(traceEntries(result.trace, "start"), expectedChecks);
	assert.deepEqual(traceEntries(result.trace, "finish"), expectedChecks);
});

test("repository checks report a failing gate after all gates run", () => {
	const result = runFakeChecks("typecheck");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /typecheck failed/);
	assert.deepEqual(traceEntries(result.trace, "start"), expectedChecks);
	assert.deepEqual(traceEntries(result.trace, "finish"), expectedChecks);
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
const deadline = Date.now() + 2_000;
while (fs.readFileSync(tracePath, "utf8").match(/^start:/gm)?.length !== 4) {
	if (Date.now() > deadline) process.exit(70);
	await new Promise((resolve) => setTimeout(resolve, 10));
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

function traceEntries(trace: string, event: string) {
	return trace
		.split("\n")
		.filter((line) => line.startsWith(`${event}:`))
		.map((line) => line.slice(event.length + 1))
		.sort();
}

function writeJson(filePath: string, value: unknown) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}
