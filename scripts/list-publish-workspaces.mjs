#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const releaseTagPattern = /^v(\d+)\.(\d+)\.(\d+)$/;
const excludedDirectories = new Set(["deprecated", "experimental"]);
const [mode, ...args] = process.argv.slice(2);

let releaseCommit;
let selectedDirectories;

if (mode === "--all" && args.length === 0) {
	releaseCommit = resolveCommit("HEAD");
} else if (mode === "--release" && args.length === 1) {
	const [tag] = args;
	releaseCommit = resolveTagCommit(tag);
	selectedDirectories = selectChangedDirectories(tag, releaseCommit);
} else {
	throw new Error(
		"Usage: scripts/list-publish-workspaces.mjs --all | --release <vMAJOR.MINOR.PATCH>",
	);
}

const packages = listProductionPackages(releaseCommit);
const selectedPackages = selectedDirectories
	? packages.filter(({ directory }) => selectedDirectories.has(directory))
	: packages;

process.stdout.write(
	selectedPackages.length > 0
		? `${selectedPackages.map(({ name, version }) => `${name}\t${version}`).join("\n")}\n`
		: "",
);

function selectChangedDirectories(tag, commit) {
	const match = releaseTagPattern.exec(tag);
	if (!match) return fallbackToAll(`tag ${JSON.stringify(tag)} is not a stable release tag`);

	const parent = tryResolveCommit(`${commit}^`);
	if (!parent) return fallbackToAll(`release ${tag} has no parent commit`);

	const previousRelease = findPreviousRelease(parent);
	if (!previousRelease) return fallbackToAll(`release ${tag} has no previous release tag`);

	const packages = listProductionPackages(commit);
	const releaseVersion = match.slice(1).join(".");
	if (!isCanonicalReleaseCommit(tag, releaseVersion, commit, parent, packages)) {
		return fallbackToAll(`release ${tag} was not created by the shared version-bump workflow`);
	}

	const changedDirectories = new Set();
	for (const changedPath of gitNullList([
		"diff",
		"--name-only",
		"-z",
		previousRelease.commit,
		parent,
		"--",
		"extensions",
	])) {
		const [topLevel, directory, child] = changedPath.split("/");
		if (topLevel === "extensions" && directory && child) changedDirectories.add(directory);
	}
	return changedDirectories;
}

function fallbackToAll(reason) {
	console.error(`Publish selection fallback: ${reason}; considering all production packages.`);
	return undefined;
}

function findPreviousRelease(commit) {
	const tagsByCommit = new Map();
	for (const tag of gitLines(["tag", "--merged", commit, "--list"])) {
		if (!releaseTagPattern.test(tag)) continue;
		const tagCommit = tryResolveCommit(`refs/tags/${tag}^{commit}`);
		if (!tagCommit) continue;
		const tags = tagsByCommit.get(tagCommit) ?? [];
		tags.push(tag);
		tagsByCommit.set(tagCommit, tags);
	}

	for (const candidate of gitLines(["rev-list", "--first-parent", commit])) {
		const tags = tagsByCommit.get(candidate);
		if (!tags) continue;
		tags.sort(compareStrings);
		return { tag: tags.at(-1), commit: candidate };
	}
	return undefined;
}

function isCanonicalReleaseCommit(tag, version, commit, parent, packages) {
	const subject = git(["show", "--no-patch", "--format=%s", commit]).trimEnd();
	if (subject !== `chore(release): ${tag}`) return false;

	const parents = gitLines(["rev-list", "--parents", "--max-count=1", commit]);
	if (parents.length !== 1 || parents[0].split(" ").length !== 2) return false;

	const manifestPaths = ["package.json", ...packages.map(({ manifestPath }) => manifestPath)];
	const expectedPaths = [...manifestPaths, "package-lock.json"].sort(compareStrings);
	const actualPaths = gitNullList(["diff", "--name-only", "-z", parent, commit]).sort(
		compareStrings,
	);
	if (!isDeepStrictEqual(actualPaths, expectedPaths)) return false;

	for (const manifestPath of manifestPaths) {
		const before = tryReadJsonAt(parent, manifestPath);
		const after = tryReadJsonAt(commit, manifestPath);
		if (!before || !after) return false;
		if (after.version !== version || typeof before.version !== "string") return false;
		delete before.version;
		delete after.version;
		if (!isDeepStrictEqual(before, after)) return false;
	}

	const beforeLock = tryReadJsonAt(parent, "package-lock.json");
	const afterLock = tryReadJsonAt(commit, "package-lock.json");
	if (!beforeLock || !afterLock) return false;
	const workspacePaths = packages.map(({ directory }) => `extensions/${directory}`);
	if (!normalizeLockfileVersions(beforeLock, workspacePaths)) return false;
	if (!normalizeLockfileVersions(afterLock, workspacePaths, version)) return false;
	return isDeepStrictEqual(beforeLock, afterLock);
}

function normalizeLockfileVersions(lockfile, workspacePaths, expectedVersion) {
	if (!isObject(lockfile) || !isObject(lockfile.packages)) return false;
	if (!normalizeVersion(lockfile, expectedVersion)) return false;

	for (const packagePath of ["", ...workspacePaths]) {
		const packageEntry = lockfile.packages[packagePath];
		if (!isObject(packageEntry) || !normalizeVersion(packageEntry, expectedVersion)) return false;
	}
	return true;
}

function normalizeVersion(value, expectedVersion) {
	if (typeof value.version !== "string") return false;
	if (expectedVersion !== undefined && value.version !== expectedVersion) return false;
	value.version = "<workspace-version>";
	return true;
}

function listProductionPackages(commit) {
	const packages = [];
	for (const directory of gitNullList(["ls-tree", "-z", "--name-only", `${commit}:extensions`])) {
		if (excludedDirectories.has(directory) || directory.includes("/")) continue;
		const manifestPath = `extensions/${directory}/package.json`;
		const packageJson = tryReadJsonAt(commit, manifestPath);
		if (!packageJson || packageJson.private) continue;

		const { name, version } = packageJson;
		if (!isTsvValue(name) || !isTsvValue(version)) {
			throw new Error(`${manifestPath} must contain string name and version fields without tabs`);
		}
		packages.push({ directory, manifestPath, name, version });
	}

	packages.sort(
		(a, b) => compareStrings(a.name, b.name) || compareStrings(a.directory, b.directory),
	);
	for (let index = 1; index < packages.length; index += 1) {
		if (packages[index - 1].name === packages[index].name) {
			throw new Error(`Duplicate production package name: ${packages[index].name}`);
		}
	}
	return packages;
}

function isTsvValue(value) {
	return typeof value === "string" && value.length > 0 && !/[\t\r\n]/.test(value);
}

function resolveTagCommit(tag) {
	git(["check-ref-format", `refs/tags/${tag}`]);
	return resolveCommit(`refs/tags/${tag}^{commit}`);
}

function resolveCommit(revision) {
	const commit = tryResolveCommit(revision);
	if (!commit) throw new Error(`Cannot resolve Git commit: ${revision}`);
	return commit;
}

function tryResolveCommit(revision) {
	const result = runGit(["rev-parse", "--verify", revision], true);
	return result.status === 0 ? result.stdout.trimEnd() : undefined;
}

function tryReadJsonAt(commit, filePath) {
	const result = runGit(["show", `${commit}:${filePath}`], true);
	if (result.status !== 0) return undefined;
	return parseJson(result.stdout, `${commit}:${filePath}`);
}

function parseJson(contents, source) {
	const value = JSON.parse(contents);
	if (!isObject(value)) throw new Error(`${source} must contain a JSON object`);
	return value;
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function git(args) {
	const result = runGit(args);
	return result.stdout;
}

function gitLines(args) {
	return git(args).split("\n").filter(Boolean);
}

function gitNullList(args) {
	const output = git(args);
	return output.split("\0").filter(Boolean);
}

function runGit(args, allowFailure = false) {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (!allowFailure && result.status !== 0) {
		throw new Error(
			[`git ${args.join(" ")} failed with status ${result.status}`, result.stderr.trimEnd()]
				.filter(Boolean)
				.join(": "),
		);
	}
	return {
		status: result.status,
		stdout: result.stdout ?? "",
	};
}

function compareStrings(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
