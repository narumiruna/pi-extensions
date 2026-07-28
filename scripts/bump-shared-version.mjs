#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const bump = process.argv[2];
const listPackages = bump === "--list-packages";
const allowedBumps = new Set(["major", "minor", "patch"]);

if (!listPackages && !allowedBumps.has(bump)) {
	throw new Error("Usage: scripts/bump-shared-version.mjs <major|minor|patch|--list-packages>");
}

const rootPackagePath = "package.json";
const rootPackage = readPackage(rootPackagePath);
const packagePaths = new Set([rootPackagePath]);

for (const workspace of rootPackage.workspaces ?? []) {
	if (!workspace.endsWith("/*")) {
		throw new Error(`Unsupported workspace pattern: ${workspace}`);
	}

	const workspaceRoot = workspace.slice(0, -2);
	if (!fs.existsSync(workspaceRoot)) continue;
	for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;

		const packagePath = path.join(workspaceRoot, entry.name, "package.json");
		if (!fs.existsSync(packagePath) || readPackage(packagePath).private) continue;
		packagePaths.add(packagePath);
	}
}

const sortedPackagePaths = [...packagePaths].sort();
if (listPackages) {
	console.log(JSON.stringify(sortedPackagePaths));
	process.exit(0);
}

const packages = sortedPackagePaths.map((packagePath) => ({
	packagePath,
	packageJson: readPackage(packagePath),
}));

const currentVersion = packages
	.map(({ packageJson }) => parseVersion(packageJson.version))
	.sort(compareVersions)
	.at(-1);

const newVersionParts = bumpVersion(currentVersion, bump);
const newVersion = newVersionParts.join(".");
const internalPackageNames = new Set(
	packages
		.map(({ packageJson }) => packageJson.name)
		.filter((name) => typeof name === "string" && name.length > 0),
);
const internalDependencyRange = `<${newVersionParts[0] + 1}`;

for (const { packagePath, packageJson } of packages) {
	packageJson.version = newVersion;
	updateInternalDependencyRanges(packageJson, internalPackageNames, internalDependencyRange);
	fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, "\t")}\n`);
}

execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
	stdio: "inherit",
});

console.log(newVersion);

function readPackage(packagePath) {
	return JSON.parse(fs.readFileSync(packagePath, "utf8"));
}

function updateInternalDependencyRanges(packageJson, internalPackageNames, range) {
	for (const field of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const dependencies = packageJson[field];
		if (!dependencies) continue;
		for (const dependencyName of Object.keys(dependencies)) {
			if (internalPackageNames.has(dependencyName)) dependencies[dependencyName] = range;
		}
	}
}

function parseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`Unsupported SemVer version: ${version}`);
	return match.slice(1).map(Number);
}

function compareVersions(a, b) {
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

function bumpVersion(version, bumpType) {
	const nextVersion = [...version];

	if (bumpType === "major") {
		nextVersion[0] += 1;
		nextVersion[1] = 0;
		nextVersion[2] = 0;
	} else if (bumpType === "minor") {
		nextVersion[1] += 1;
		nextVersion[2] = 0;
	} else {
		nextVersion[2] += 1;
	}

	return nextVersion;
}
