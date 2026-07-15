import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const bumpScript = path.join(repositoryRoot, "scripts", "bump-shared-version.mjs");

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

test("experimental publishing is manual-only", () => {
	const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
	const justfile = readFileSync(path.join(repositoryRoot, "justfile"), "utf8");
	assert.match(workflow, /dirent\.name === "experimental"/);
	assert.match(justfile, /package_json="\.\/extensions\/experimental\/pi-\$name\/package\.json"/);
	assert.match(justfile, /WARNING: manually publishing experimental Pi extension/);
	assert.match(justfile, /publish name otp=""/);
	assert.match(justfile, /otp_flag=\(\).*--otp "\$otp"/);
});

function writeJson(filePath: string, value: unknown) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}
