import { execFileSync } from "node:child_process";
import path from "node:path";
import {
	expandDependencies,
	expandReverseDependencies,
	orderDependenciesFirst,
	readWorkspaces,
} from "./workspace-graph.mjs";

const DOCUMENTATION_BASENAMES = new Set([
	"CHANGELOG.md",
	"LICENSE",
	"LICENSE.md",
	"NOTICES.md",
	"README.md",
]);
const ROOT_FULL_TYPECHECK_FILES = new Set([
	"package-lock.json",
	"package.json",
	"tsconfig.json",
	"tsconfig.test.json",
]);
const ROOT_IGNORED_PREFIXES = [".changeset/", ".github/", "docs/"];

export function stagedFiles(root) {
	const unstagedManifests = gitPaths(root, [
		"diff",
		"--name-only",
		"-z",
		"--",
		":(glob)packages/*/package.json",
	]);
	const untrackedManifests = gitPaths(root, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		":(glob)packages/*/package.json",
	]);
	const inconsistentManifests = [...new Set([...unstagedManifests, ...untrackedManifests])];
	if (inconsistentManifests.length > 0) {
		throw new Error(
			`workspace manifests differ from the index: ${inconsistentManifests.join(", ")}`,
		);
	}

	return gitPaths(root, [
		"diff",
		"--cached",
		"--no-renames",
		"--name-only",
		"-z",
		"--diff-filter=ACDMRTUXB",
	]);
}

function gitPaths(root, args) {
	const output = execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return output.split("\0").filter(Boolean);
}

export function selectStagedTypechecks(root, changedFiles) {
	const workspaces = readWorkspaces(root);
	const workspaceByDirectory = new Map(
		workspaces.map((workspace) => [workspace.directoryName, workspace]),
	);
	const directlyAffected = new Set();
	let fullReason;

	for (const changedFile of changedFiles) {
		const normalized = changedFile.split(path.sep).join("/").replace(/^\.\//u, "");
		if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
			fullReason = `unsafe staged path: ${changedFile}`;
			break;
		}

		const packageMatch = /^packages\/([^/]+)(?:\/(.*))?$/u.exec(normalized);
		if (packageMatch) {
			const [, directoryName, relativePath = ""] = packageMatch;
			if (isDocumentation(relativePath)) continue;

			const workspace = workspaceByDirectory.get(directoryName);
			if (!workspace) {
				fullReason = `staged package is not present in the current workspace: ${directoryName}`;
				break;
			}
			directlyAffected.add(workspace.name);
			continue;
		}

		if (ROOT_FULL_TYPECHECK_FILES.has(normalized) || normalized.startsWith("scripts/")) {
			fullReason = `shared typecheck input staged: ${normalized}`;
			break;
		}

		if (isIgnoredRootFile(normalized)) continue;
		if (/\.(?:[cm]?[jt]sx?|json)$/u.test(normalized)) {
			fullReason = `unscoped code or configuration staged: ${normalized}`;
			break;
		}
	}

	if (fullReason) return fullSelection(workspaces, fullReason);

	const affectedNames = expandReverseDependencies(workspaces, directlyAffected);
	if (affectedNames.size === 0) {
		return {
			mode: "skip",
			buildWorkspaceNames: [],
			workspaceDirectories: [],
			workspaceNames: [],
			reason: "no typecheck-relevant files are staged",
		};
	}

	const buildNames = expandDependencies(workspaces, affectedNames);
	return {
		mode: "affected",
		buildWorkspaceNames: orderDependenciesFirst(
			workspaces,
			new Set(
				workspaces
					.filter(({ hasBuildScript, name }) => hasBuildScript && buildNames.has(name))
					.map(({ name }) => name),
			),
		),
		workspaceDirectories: workspaces
			.filter(({ name }) => affectedNames.has(name))
			.map(({ directoryName }) => directoryName),
		workspaceNames: orderDependenciesFirst(workspaces, affectedNames),
		reason: `${directlyAffected.size} directly staged workspace(s), ${affectedNames.size} affected workspace(s)`,
	};
}

function fullSelection(workspaces, reason) {
	const workspaceNames = new Set(workspaces.map(({ name }) => name));
	return {
		mode: "full",
		buildWorkspaceNames: orderDependenciesFirst(
			workspaces,
			new Set(workspaces.filter(({ hasBuildScript }) => hasBuildScript).map(({ name }) => name)),
		),
		workspaceDirectories: workspaces.map(({ directoryName }) => directoryName),
		workspaceNames: orderDependenciesFirst(workspaces, workspaceNames),
		reason,
	};
}

function isDocumentation(relativePath) {
	return (
		relativePath &&
		(relativePath.endsWith(".md") || DOCUMENTATION_BASENAMES.has(path.posix.basename(relativePath)))
	);
}

function isIgnoredRootFile(filePath) {
	if (ROOT_IGNORED_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return true;
	return DOCUMENTATION_BASENAMES.has(path.posix.basename(filePath));
}
