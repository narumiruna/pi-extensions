import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
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
	const resolvedPath = path.resolve(root, filePath);
	if (!existsSync(resolvedPath)) throw new Error(`${adapter.label} file does not exist: ${resolvedPath}`);
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
	const inputs = requestedPaths?.length ? requestedPaths : [root];

	for (const input of inputs) {
		const targetPath = path.resolve(root, input);
		if (!existsSync(targetPath)) throw new Error(`Requested path does not exist: ${targetPath}`);
		collectPath(adapter, targetPath, files, seen, cappedLimit);
		if (files.length >= cappedLimit) break;
	}

	return files;
}

function collectPath(
	adapter: LspServerAdapter,
	targetPath: string,
	files: string[],
	seen: Set<string>,
	limit: number,
) {
	if (files.length >= limit || !existsSync(targetPath)) return;

	const linkStats = lstatSync(targetPath);
	if (linkStats.isSymbolicLink()) return;

	const stats = statSync(targetPath);
	if (stats.isFile()) {
		if (adapter.isSupportedFile(targetPath) && !seen.has(targetPath)) {
			seen.add(targetPath);
			files.push(targetPath);
		}
		return;
	}

	if (!stats.isDirectory()) return;
	const entries = readdirSync(targetPath, { withFileTypes: true }).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	for (const entry of entries) {
		if (files.length >= limit) break;
		if (entry.isDirectory() && adapter.skipDirectories.has(entry.name)) continue;
		collectPath(adapter, path.join(targetPath, entry.name), files, seen, limit);
	}
}
