import fs from "node:fs";
import path from "node:path";
import semver from "semver";

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

export function readWorkspaces(root) {
	const packagesDirectory = path.join(root, "packages");
	if (!fs.existsSync(packagesDirectory)) return [];

	const workspaceManifests = [];
	for (const entry of fs.readdirSync(packagesDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifestPath = path.join(packagesDirectory, entry.name, "package.json");
		if (!fs.existsSync(manifestPath)) continue;
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		if (typeof manifest.name !== "string") continue;
		workspaceManifests.push({ directoryName: entry.name, manifest });
	}
	workspaceManifests.sort((left, right) => left.directoryName.localeCompare(right.directoryName));

	const workspaceVersions = new Map(
		workspaceManifests.map(({ manifest }) => [manifest.name, manifest.version]),
	);
	return workspaceManifests.map(({ directoryName, manifest }) => ({
		dependencies: dependencyNames(manifest, workspaceVersions),
		directoryName,
		hasBuildScript: typeof manifest.scripts?.build === "string",
		name: manifest.name,
	}));
}

export function expandReverseDependencies(workspaces, directlyAffected) {
	const affected = new Set(directlyAffected);
	let changed = true;
	while (changed) {
		changed = false;
		for (const workspace of workspaces) {
			if (affected.has(workspace.name)) continue;
			if (![...workspace.dependencies].some((dependency) => affected.has(dependency))) continue;
			affected.add(workspace.name);
			changed = true;
		}
	}
	return affected;
}

export function expandDependencies(workspaces, workspaceNames) {
	const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
	const expanded = new Set(workspaceNames);
	const pending = [...workspaceNames];
	while (pending.length > 0) {
		const workspace = workspaceByName.get(pending.pop());
		if (!workspace) continue;
		for (const dependency of workspace.dependencies) {
			if (!workspaceByName.has(dependency) || expanded.has(dependency)) continue;
			expanded.add(dependency);
			pending.push(dependency);
		}
	}
	return expanded;
}

export function orderDependenciesFirst(workspaces, workspaceNames) {
	const selected = new Set(workspaceNames);
	const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
	const visiting = new Set();
	const visited = new Set();
	const ordered = [];

	function visit(name) {
		if (visited.has(name) || visiting.has(name)) return;
		visiting.add(name);
		const workspace = workspaceByName.get(name);
		if (workspace) {
			for (const dependency of workspace.dependencies) {
				if (selected.has(dependency)) visit(dependency);
			}
		}
		visiting.delete(name);
		visited.add(name);
		ordered.push(name);
	}

	for (const workspace of workspaces) {
		if (selected.has(workspace.name)) visit(workspace.name);
	}
	return ordered;
}

function dependencyNames(manifest, workspaceVersions) {
	const names = new Set();
	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = manifest[field];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
		for (const [name, specifier] of Object.entries(dependencies)) {
			if (!workspaceVersions.has(name)) continue;
			if (!usesLocalWorkspace(specifier, workspaceVersions.get(name))) continue;
			names.add(name);
		}
	}
	return names;
}

function usesLocalWorkspace(specifier, workspaceVersion) {
	if (typeof specifier !== "string") return false;
	if (specifier.startsWith("workspace:")) return true;
	if (typeof workspaceVersion !== "string" || !semver.valid(workspaceVersion)) return false;
	const range = semver.validRange(specifier);
	return range !== null && semver.satisfies(workspaceVersion, range, { includePrerelease: true });
}
