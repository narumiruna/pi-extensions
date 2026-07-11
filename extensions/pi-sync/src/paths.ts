import path from "node:path";

export function isDeniedPath(relativePath: string) {
	const normalized = toPosix(relativePath);
	const lower = normalized.toLowerCase();
	const segments = lower.split("/");
	const base = path.posix.basename(lower);
	return (
		segments.includes("node_modules") ||
		segments.includes(".git") ||
		segments.includes(".pisync") ||
		base === ".env" ||
		base.startsWith(".env.") ||
		base.endsWith(".env") ||
		base.includes("secret") ||
		base.includes("token") ||
		base === "pi-sync.local.json"
	);
}

export function isPathInside(parent: string, child: string) {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function safeJoin(root: string, relativePath: string) {
	const target = path.resolve(root, relativePath);
	assertWithinRoot(root, target, relativePath);
	return target;
}

export function assertWithinRoot(root: string, target: string, label = target) {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
		throw new Error(`Unsafe path in snapshot: ${label}`);
	}
}

export function encodeKey(key: string) {
	return key.split("/").map(encodeURIComponent).join("/");
}

export function posixJoin(...parts: string[]) {
	return parts.map((part) => trimSlashes(part)).filter(Boolean).join("/");
}

export function parentPaths(relativePath: string) {
	const results: string[] = [];
	let index = relativePath.lastIndexOf("/");
	while (index > 0) {
		results.push(relativePath.slice(0, index));
		index = relativePath.lastIndexOf("/", index - 1);
	}
	return results;
}

export function toPosix(value: string) {
	return value.split(path.sep).join("/");
}

function trimSlashes(value: string) {
	return value.replace(/^\/+|\/+$/g, "");
}

export function safeName(value: string) {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
