import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { LspServerAdapter } from "./types.js";

export function resolveRoot(root?: string) {
	const resolvedRoot = path.resolve(root?.trim() || process.cwd());
	if (!existsSync(resolvedRoot)) throw new Error(`Workspace root does not exist: ${resolvedRoot}`);
	if (!statSync(resolvedRoot).isDirectory()) {
		throw new Error(`Expected workspace root to be a directory: ${resolvedRoot}`);
	}
	return resolvedRoot;
}

export function directoryUri(directory: string) {
	return pathToFileURL(directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`).href;
}

export function resolveSupportedFile(adapter: LspServerAdapter, root: string, filePath: string) {
	const resolvedPath = resolveWorkspacePath(root, filePath, "File path");
	if (!existsSync(resolvedPath)) throw new Error(`${adapter.label} file does not exist: ${resolvedPath}`);
	if (!isInsidePath(realpathSync(root), realpathSync(resolvedPath))) {
		throw new Error(`File resolves outside workspace root: ${resolvedPath}`);
	}
	if (!statSync(resolvedPath).isFile()) throw new Error(`Expected a file: ${resolvedPath}`);
	if (!adapter.isSupportedFile(resolvedPath)) {
		throw new Error(`Expected a ${adapter.label} supported file: ${resolvedPath}`);
	}
	return resolvedPath;
}

export function collectSupportedFiles(
	adapter: LspServerAdapter,
	root: string,
	requestedPaths: string[] | undefined,
	limit: number,
) {
	const cappedLimit = Math.max(1, Math.floor(limit));
	const files: string[] = [];
	const seen = new Set<string>();
	const visitedDirectories = new Set<string>();
	const realRoot = realpathSync(root);
	const inputs = requestedPaths?.length ? requestedPaths : [root];

	for (const input of inputs) {
		const targetPath = resolveWorkspacePath(root, input, "Requested path");
		if (!existsSync(targetPath)) throw new Error(`Requested path does not exist: ${targetPath}`);
		if (!isInsidePath(realRoot, realpathSync(targetPath))) {
			throw new Error(`Requested path resolves outside workspace root: ${targetPath}`);
		}
		collectPath(adapter, targetPath, files, seen, visitedDirectories, realRoot, cappedLimit);
		if (files.length >= cappedLimit) break;
	}

	return files;
}

function collectPath(
	adapter: LspServerAdapter,
	targetPath: string,
	files: string[],
	seen: Set<string>,
	visitedDirectories: Set<string>,
	realRoot: string,
	limit: number,
) {
	if (files.length >= limit || !existsSync(targetPath)) return;
	if (!isInsidePath(realRoot, realpathSync(targetPath))) return;

	const stats = statSync(targetPath);
	if (stats.isFile()) {
		if (adapter.isSupportedFile(targetPath) && !seen.has(targetPath)) {
			seen.add(targetPath);
			files.push(targetPath);
		}
		return;
	}

	if (!stats.isDirectory()) return;
	const directoryKey = realpathSync(targetPath);
	if (visitedDirectories.has(directoryKey)) return;
	visitedDirectories.add(directoryKey);

	const entries = readdirSync(targetPath, { withFileTypes: true }).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	for (const entry of entries) {
		if (files.length >= limit) break;
		if ((entry.isDirectory() || entry.isSymbolicLink()) && adapter.skipDirectories.has(entry.name)) continue;
		collectPath(adapter, path.join(targetPath, entry.name), files, seen, visitedDirectories, realRoot, limit);
	}
}

function resolveWorkspacePath(root: string, inputPath: string, label: string) {
	const resolvedPath = path.resolve(root, inputPath);
	if (!isInsidePath(root, resolvedPath)) {
		throw new Error(`${label} escapes workspace root: ${resolvedPath}`);
	}
	return resolvedPath;
}

function isInsidePath(parent: string, child: string) {
	const relativePath = path.relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
