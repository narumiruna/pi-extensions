import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { DevToolsPage } from "./runtime.js";

function unique<T>(values: T[]) {
	return Array.from(new Set(values));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export interface ResolvedScreenshotPath {
	path: string;
	allowedRoots: string[];
	isDefault: boolean;
}
export interface ScreenshotSaveResult {
	savedPath: string;
	bytes: number;
	isDefaultPath: boolean;
}

export async function saveScreenshot(
	base64Png: string,
	savePath: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<ScreenshotSaveResult> {
	const resolvedPath = resolveScreenshotPath(savePath, cwd);
	const pngBytes = Buffer.from(base64Png, "base64");

	await withFileMutationQueue(resolvedPath.path, async () => {
		throwIfAborted(signal);
		await ensureSafeScreenshotParent(resolvedPath);
		await assertSafeScreenshotTargetPath(resolvedPath);
		await writeScreenshotFileSafely(resolvedPath, pngBytes, signal);
	});

	return {
		savedPath: resolvedPath.path,
		bytes: pngBytes.byteLength,
		isDefaultPath: resolvedPath.isDefault,
	};
}

export function resolveScreenshotPath(savePath: string | undefined, cwd: string): ResolvedScreenshotPath {
	const cwdRoot = resolve(cwd);
	const tempRoot = resolve(tmpdir());

	if (savePath === undefined) {
		return {
			path: join(tempRoot, `pi-chrome-devtools-screenshot-${randomUUID()}.png`),
			allowedRoots: [tempRoot],
			isDefault: true,
		};
	}

	const normalizedPath = stripLeadingAtPath(savePath);
	if (!normalizedPath.trim()) {
		throw new Error("Screenshot savePath must not be empty.");
	}
	if (normalizedPath.includes("\0")) {
		throw new Error("Screenshot savePath must not contain NUL bytes.");
	}
	if (hasParentPathSegment(normalizedPath)) {
		throw new Error("Screenshot savePath must not contain '..' path segments.");
	}

	const isAbsolutePath = isAbsolute(normalizedPath);
	const path = isAbsolutePath ? resolve(normalizedPath) : resolve(cwdRoot, normalizedPath);
	const allowedRoots = isAbsolutePath ? unique([cwdRoot, tempRoot]) : [cwdRoot];
	if (!allowedRoots.some((root) => isPathInsideRoot(path, root))) {
		throw new Error(
			"Screenshot savePath must be relative to the current working directory, or an absolute path inside the current working directory or OS temp directory.",
		);
	}

	return { path, allowedRoots, isDefault: false };
}

function stripLeadingAtPath(path: string) {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function hasParentPathSegment(path: string) {
	return path.split(/[\\/]+/).some((part) => part === "..");
}

async function ensureSafeScreenshotParent(resolvedPath: ResolvedScreenshotPath) {
	const parentPath = dirname(resolvedPath.path);
	const rootPath = selectAllowedRoot(parentPath, resolvedPath.allowedRoots);
	if (!rootPath) {
		throw new Error(
			"Screenshot savePath parent must stay inside the current working directory or OS temp directory.",
		);
	}

	const realRootPath = await realpath(rootPath);
	let currentPath = rootPath;
	const parentSegments = relative(rootPath, parentPath)
		.split(/[\\/]+/)
		.filter((part) => part.length > 0);

	for (const segment of parentSegments) {
		currentPath = join(currentPath, segment);
		await ensureSafeDirectorySegment(currentPath, realRootPath);
	}
}

export function selectAllowedRoot(path: string, roots: readonly string[]) {
	const matchingRoots = roots.filter((root) => isPathInsideRoot(path, root));
	matchingRoots.sort(
		(left, right) =>
			normalizePathForComparison(resolve(right)).length -
			normalizePathForComparison(resolve(left)).length,
	);
	return matchingRoots[0];
}

async function ensureSafeDirectorySegment(path: string, realRootPath: string) {
	const existingDirectory = await lstat(path).catch(async (error: unknown) => {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		await mkdir(path).catch((mkdirError: unknown) => {
			if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
		});
		return lstat(path);
	});

	if (existingDirectory.isSymbolicLink()) {
		throw new Error("Screenshot savePath parent directories must not contain symbolic links.");
	}
	if (!existingDirectory.isDirectory()) {
		throw new Error("Screenshot savePath parent must be a directory.");
	}
	await assertPathWithinRealRoot(path, realRootPath);
}

async function assertSafeScreenshotTargetPath(resolvedPath: ResolvedScreenshotPath) {
	const existingTarget = await lstat(resolvedPath.path).catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (existingTarget?.isSymbolicLink()) {
		throw new Error("Screenshot savePath must not point to a symbolic link.");
	}
	if (existingTarget?.isDirectory()) {
		throw new Error("Screenshot savePath must point to a file, not a directory.");
	}
	if (existingTarget && !existingTarget.isFile()) {
		throw new Error("Screenshot savePath may only replace regular files.");
	}

	const realAllowedRoots = await Promise.all(resolvedPath.allowedRoots.map(realpathOrResolvedPath));
	const realParent = await realpath(dirname(resolvedPath.path));
	const realTargetPath = join(realParent, basename(resolvedPath.path));
	if (!realAllowedRoots.some((root) => isPathInsideRoot(realTargetPath, root))) {
		throw new Error(
			"Screenshot savePath resolves outside the current working directory or OS temp directory.",
		);
	}
}

async function assertPathWithinRealRoot(path: string, realRootPath: string) {
	const realPath = await realpath(path);
	if (!isPathInsideRoot(realPath, realRootPath)) {
		throw new Error(
			"Screenshot savePath parent resolves outside the current working directory or OS temp directory.",
		);
	}
}

async function writeScreenshotFileSafely(
	resolvedPath: ResolvedScreenshotPath,
	pngBytes: Buffer,
	signal: AbortSignal | undefined,
) {
	const tempFile = join(
		dirname(resolvedPath.path),
		`.${basename(resolvedPath.path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(tempFile, pngBytes, { flag: "wx", signal });
		throwIfAborted(signal);
		await replaceScreenshotFile(resolvedPath, tempFile, signal);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function replaceScreenshotFile(
	resolvedPath: ResolvedScreenshotPath,
	tempFile: string,
	signal: AbortSignal | undefined,
) {
	try {
		await rename(tempFile, resolvedPath.path);
		return;
	} catch (error) {
		if (!shouldRetryRenameAfterRemovingDestination(error)) throw error;
	}

	// Some Windows filesystems reject renaming over an existing file. Revalidate before
	// removing the destination so the fallback still refuses directories and symlinks.
	await assertSafeScreenshotTargetPath(resolvedPath);
	throwIfAborted(signal);
	await rm(resolvedPath.path, { force: true });
	await rename(tempFile, resolvedPath.path);
}

function shouldRetryRenameAfterRemovingDestination(error: unknown) {
	return (
		process.platform === "win32" &&
		isNodeError(error) &&
		["EACCES", "EEXIST", "EPERM"].includes(error.code ?? "")
	);
}

async function realpathOrResolvedPath(path: string) {
	return realpath(path).catch(() => resolve(path));
}

export function isPathInsideRoot(path: string, root: string) {
	const normalizedPath = normalizePathForComparison(resolve(path));
	const normalizedRoot = normalizePathForComparison(resolve(root));
	if (normalizedPath === normalizedRoot) return true;
	const rootWithSeparator = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	return normalizedPath.startsWith(rootWithSeparator);
}

function normalizePathForComparison(path: string) {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

export function throwIfAborted(signal: AbortSignal | undefined) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Screenshot capture cancelled.");
}

export function formatScreenshotText(page: DevToolsPage, screenshot: ScreenshotSaveResult) {
	const pathLabel = screenshot.isDefaultPath ? "Saved to temp file" : "Saved to";
	return [
		`Captured PNG screenshot from ${page.title || page.url || page.id}.`,
		`${pathLabel}: ${screenshot.savedPath}`,
		`Bytes: ${screenshot.bytes}`,
		`Use read({ path: ${JSON.stringify(screenshot.savedPath)} }) to inspect the saved screenshot if inline image content is not available.`,
	].join("\n");
}

