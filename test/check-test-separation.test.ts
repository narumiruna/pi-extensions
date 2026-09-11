import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string) {
	return readFileSync(resolve(root, relativePath), "utf8");
}

test("check and test remain separate CI gates", () => {
	const runChecks = read("scripts/run-checks.mjs");
	const checksMatch = /const checks = (\[[^\n]+\]);/u.exec(runChecks);
	assert.ok(checksMatch, "run-checks must declare its task list");
	assert.deepEqual(JSON.parse(checksMatch[1] ?? "[]"), [
		"check:biome",
		"check:boundaries",
		"typecheck",
	]);

	const manifest = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
	assert.match(manifest.scripts?.check ?? "", /run-checks\.mjs/u);
	assert.match(manifest.scripts?.test ?? "", /run-tests\.mjs/u);
	assert.doesNotMatch(manifest.scripts?.check ?? "", /npm (?:run )?test/u);

	const ciWorkflow = read(".github/workflows/ci.yml");
	const checkIndex = ciWorkflow.indexOf("run: npm run check");
	const testIndex = ciWorkflow.indexOf("run: npm test");
	assert.ok(checkIndex >= 0, "CI must run checks");
	assert.ok(testIndex > checkIndex, "CI must run tests after checks");
});

test("publish releases only the revision from a successful main CI push", () => {
	const publishWorkflow = read(".github/workflows/publish.yml");
	assert.match(
		publishWorkflow,
		/workflow_run:\n\s+workflows: \["CI"\]\n\s+types: \[completed\]\n\s+branches: \[main\]/u,
		"publish must run after main-branch CI completes",
	);
	assert.match(
		publishWorkflow,
		/event_name == 'workflow_dispatch' \|\|\n\s+\(github\.event\.workflow_run\.event == 'push' &&\n\s+github\.event\.workflow_run\.conclusion == 'success'\)/u,
		"publish must reject unsuccessful and non-push CI runs",
	);
	assert.match(
		publishWorkflow,
		/ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/u,
		"publish must check out the CI-tested revision, with a manual-dispatch fallback",
	);
	assert.doesNotMatch(
		publishWorkflow,
		/\bnpm (?:run )?(?:check|typecheck|test)\b/u,
		"publish must rely on CI instead of rerunning tests or typechecks",
	);
});
