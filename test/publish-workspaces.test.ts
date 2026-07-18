import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const publishSelector = path.join(repositoryRoot, "scripts", "list-publish-workspaces.mjs");
const gitEnvironment = {
	...process.env,
	GIT_AUTHOR_EMAIL: "fixture@example.com",
	GIT_AUTHOR_NAME: "Fixture Author",
	GIT_COMMITTER_EMAIL: "fixture@example.com",
	GIT_COMMITTER_NAME: "Fixture Author",
};

test("canonical releases select only changed production extensions in deterministic order", () => {
	withRepository(
		[
			{ directory: "pi-zulu", name: "@fixture/zulu" },
			{ directory: "pi-alpha", name: "@fixture/alpha" },
			{ directory: "pi-private", name: "@fixture/private", private: true },
			{ directory: "experimental/pi-experiment", name: "@fixture/experiment" },
			{ directory: "deprecated/pi-legacy", name: "@fixture/legacy" },
		],
		(repository) => {
			tag(repository, "v1.0.0");
			write(repository, "README.md", "root-only change\n");
			write(repository, "extensions/pi-zulu/src/index.ts", "export const zulu = 1;\n");
			write(repository, "extensions/pi-zulu/test/index.test.ts", "// second zulu path\n");
			write(repository, "extensions/pi-private/src/index.ts", "private change\n");
			write(
				repository,
				"extensions/experimental/pi-experiment/src/index.ts",
				"experimental change\n",
			);
			write(repository, "extensions/deprecated/pi-legacy/src/index.ts", "legacy change\n");
			addPackage(repository, { directory: "pi-middle", name: "@fixture/middle" });
			refreshLockfile(repository);
			commit(repository, "feat: change selected extensions");

			createRelease(repository, "v1.1.0");

			assert.deepEqual(select(repository, "--release", "v1.1.0"), [
				["@fixture/middle", "1.1.0"],
				["@fixture/zulu", "1.1.0"],
			]);
		},
	);
});

test("release selection ignores root-only changes and the generated version bump", () => {
	withRepository(
		[
			{ directory: "pi-alpha", name: "@fixture/alpha" },
			{ directory: "pi-beta", name: "@fixture/beta" },
		],
		(repository) => {
			tag(repository, "v1.0.0");
			write(repository, "README.md", "root-only change\n");
			commit(repository, "docs: update root readme");
			createRelease(repository, "v1.1.0");

			assert.deepEqual(select(repository, "--release", "v1.1.0"), []);
		},
	);
});

test("release selection omits deleted and unchanged packages", () => {
	withRepository(
		[
			{ directory: "pi-alpha", name: "@fixture/alpha" },
			{ directory: "pi-deleted", name: "@fixture/deleted" },
		],
		(repository) => {
			tag(repository, "v1.0.0");
			rmSync(path.join(repository, "extensions/pi-deleted"), { recursive: true });
			refreshLockfile(repository);
			commit(repository, "chore: remove deleted extension");
			createRelease(repository, "v1.1.0");

			assert.deepEqual(select(repository, "--release", "v1.1.0"), []);
		},
	);
});

test("first and nonstandard releases safely select every production package", () => {
	withRepository(
		[
			{ directory: "pi-beta", name: "@fixture/beta" },
			{ directory: "pi-alpha", name: "@fixture/alpha" },
			{ directory: "pi-private", name: "@fixture/private", private: true },
			{ directory: "experimental/pi-experiment", name: "@fixture/experiment" },
		],
		(repository) => {
			createRelease(repository, "v1.0.0");
			assert.deepEqual(select(repository, "--release", "v1.0.0"), [
				["@fixture/alpha", "1.0.0"],
				["@fixture/beta", "1.0.0"],
			]);
		},
	);

	withRepository(
		[
			{ directory: "pi-beta", name: "@fixture/beta" },
			{ directory: "pi-alpha", name: "@fixture/alpha" },
		],
		(repository) => {
			tag(repository, "v1.0.0");
			write(repository, "extensions/pi-alpha/src/index.ts", "export const alpha = 1;\n");
			commit(repository, "feat: manually tagged change");
			tag(repository, "v1.1.0");

			assert.deepEqual(select(repository, "--release", "v1.1.0"), [
				["@fixture/alpha", "0.0.0"],
				["@fixture/beta", "0.0.0"],
			]);
		},
	);
});

test("a release-shaped commit with extra source changes falls back to all packages", () => {
	withRepository(
		[
			{ directory: "pi-alpha", name: "@fixture/alpha" },
			{ directory: "pi-beta", name: "@fixture/beta" },
		],
		(repository) => {
			tag(repository, "v1.0.0");
			write(repository, "extensions/pi-alpha/src/index.ts", "export const alpha = 1;\n");
			createRelease(repository, "v1.1.0");

			assert.deepEqual(select(repository, "--release", "v1.1.0"), [
				["@fixture/alpha", "1.1.0"],
				["@fixture/beta", "1.1.0"],
			]);
		},
	);
});

test("a package introduced inside the release commit falls back to all packages", () => {
	withRepository([{ directory: "pi-alpha", name: "@fixture/alpha" }], (repository) => {
		tag(repository, "v1.0.0");
		writeJson(repository, "extensions/pi-new/package.json", {
			name: "@fixture/new",
			version: "0.0.0",
		});
		createRelease(repository, "v1.1.0");

		assert.deepEqual(select(repository, "--release", "v1.1.0"), [
			["@fixture/alpha", "1.1.0"],
			["@fixture/new", "1.1.0"],
		]);
	});
});

test("all-packages mode is deterministic and excludes non-production workspaces", () => {
	withRepository(
		[
			{ directory: "pi-zulu", name: "@fixture/zulu" },
			{ directory: "pi-alpha", name: "@fixture/alpha" },
			{ directory: "pi-private", name: "@fixture/private", private: true },
			{ directory: "experimental/pi-experiment", name: "@fixture/experiment" },
			{ directory: "deprecated/pi-legacy", name: "@fixture/legacy" },
		],
		(repository) => {
			assert.deepEqual(select(repository, "--all"), [
				["@fixture/alpha", "0.0.0"],
				["@fixture/zulu", "0.0.0"],
			]);
		},
	);
});

type PackageFixture = {
	directory: string;
	name: string;
	private?: boolean;
};

function withRepository(packages: PackageFixture[], run: (repository: string) => void) {
	const repository = mkdtempSync(path.join(tmpdir(), "pi-publish-workspaces-"));
	try {
		git(repository, "init", "--quiet");
		writeJson(repository, "package.json", {
			name: "fixture-root",
			version: "0.0.0",
			private: true,
			workspaces: ["extensions/*", "extensions/experimental/*"],
		});
		for (const packageFixture of packages) addPackage(repository, packageFixture);
		refreshLockfile(repository);
		commit(repository, "chore: initial fixture");
		run(repository);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
}

function addPackage(repository: string, packageFixture: PackageFixture) {
	writeJson(repository, `extensions/${packageFixture.directory}/package.json`, {
		name: packageFixture.name,
		version: "0.0.0",
		...(packageFixture.private ? { private: true } : {}),
	});
	write(repository, `extensions/${packageFixture.directory}/src/index.ts`, "export {};\n");
}

function createRelease(repository: string, tagName: string) {
	const version = tagName.slice(1);
	const rootPackage = readJson(path.join(repository, "package.json"));
	rootPackage.version = version;
	writeJson(repository, "package.json", rootPackage);

	for (const directory of productionPackageDirectories(repository)) {
		const packagePath = path.join(repository, "extensions", directory, "package.json");
		const packageJson = readJson(packagePath);
		packageJson.version = version;
		writeJson(repository, path.relative(repository, packagePath), packageJson);
	}
	refreshLockfile(repository);
	commit(repository, `chore(release): ${tagName}`);
	tag(repository, tagName);
}

function refreshLockfile(repository: string) {
	const rootPackage = readJson(path.join(repository, "package.json"));
	const packages: Record<string, unknown> = {
		"": {
			name: rootPackage.name,
			version: rootPackage.version,
			workspaces: rootPackage.workspaces,
		},
	};
	const extensions = path.join(repository, "extensions");
	if (existsSync(extensions)) {
		for (const directory of listPackageDirectories(repository)) {
			const packagePath = path.join(extensions, directory, "package.json");
			const packageJson = readJson(packagePath);
			packages[`extensions/${directory}`] = {
				name: packageJson.name,
				version: packageJson.version,
				...(packageJson.private ? { private: true } : {}),
			};
		}
	}
	writeJson(repository, "package-lock.json", {
		name: rootPackage.name,
		version: rootPackage.version,
		lockfileVersion: 3,
		requires: true,
		packages,
	});
}

function productionPackageDirectories(repository: string) {
	return listPackageDirectories(repository).filter((directory) => {
		if (directory.includes("/")) return false;
		if (directory === "experimental" || directory === "deprecated") return false;
		const packageJson = readJson(path.join(repository, "extensions", directory, "package.json"));
		return packageJson.private !== true;
	});
}

function listPackageDirectories(repository: string) {
	const output = git(repository, "ls-files", "extensions/**/package.json");
	const tracked = output
		.split("\n")
		.filter(Boolean)
		.map((file) => path.posix.dirname(file).slice("extensions/".length));
	const untracked = git(repository, "ls-files", "--others", "--exclude-standard", "extensions")
		.split("\n")
		.filter((file) => file.endsWith("/package.json"))
		.map((file) => path.posix.dirname(file).slice("extensions/".length));
	return [...new Set([...tracked, ...untracked])]
		.filter((directory) =>
			existsSync(path.join(repository, "extensions", directory, "package.json")),
		)
		.sort();
}

function select(repository: string, ...args: string[]): string[][] {
	const output = execFileSync(process.execPath, [publishSelector, ...args], {
		cwd: repository,
		encoding: "utf8",
	});
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
}

function commit(repository: string, message: string) {
	git(repository, "add", "--all");
	git(repository, "commit", "--quiet", "--message", message);
}

function tag(repository: string, tagName: string) {
	git(repository, "tag", tagName);
}

function git(repository: string, ...args: string[]) {
	return execFileSync("git", args, {
		cwd: repository,
		encoding: "utf8",
		env: gitEnvironment,
	}).trimEnd();
}

function write(repository: string, relativePath: string, contents: string) {
	const filePath = path.join(repository, relativePath);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
}

function writeJson(repository: string, relativePath: string, value: unknown) {
	write(repository, relativePath, `${JSON.stringify(value, null, "\t")}\n`);
}

function readJson(filePath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(filePath, "utf8"));
}
