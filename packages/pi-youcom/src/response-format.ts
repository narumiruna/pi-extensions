import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

export interface YoucomResultDetails {
	truncated: boolean;
	truncatedBy?: "lines" | "bytes";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	fullResponsePath?: string;
}

interface BoundTextResult {
	text: string;
	details: YoucomResultDetails;
}

interface ResponseArtifactStore {
	directoryPromise: Promise<string>;
	pendingWrites: Set<Promise<unknown>>;
}

const responseArtifactStores = new WeakMap<object, ResponseArtifactStore>();
const closedArtifactOwners = new WeakSet<object>();

export async function formatJsonResult(payload: unknown, artifactOwner: object) {
	const serialized = JSON.stringify(payload, null, 2) ?? String(payload);
	const bounded = await boundResponseText(serialized, artifactOwner);
	return {
		content: [{ type: "text" as const, text: bounded.text }],
		details: bounded.details,
	};
}

export async function boundResponseText(
	text: string,
	artifactOwner: object,
): Promise<BoundTextResult> {
	const maxBytes = DEFAULT_MAX_BYTES;
	const maxLines = DEFAULT_MAX_LINES;
	const initial = truncateHead(text, { maxBytes, maxLines });
	if (!initial.truncated) {
		return {
			text: initial.content,
			details: {
				truncated: false,
				totalLines: initial.totalLines,
				totalBytes: initial.totalBytes,
				outputLines: initial.outputLines,
				outputBytes: initial.outputBytes,
			},
		};
	}

	const fullResponsePath = await writeResponseArtifact(text, artifactOwner);
	const content = `${initial.content}\n\n${truncationFooter(initial, fullResponsePath)}`;
	if (Buffer.byteLength(content, "utf8") <= maxBytes && countLines(content) <= maxLines) {
		return {
			text: content,
			details: {
				truncated: true,
				truncatedBy: initial.truncatedBy ?? undefined,
				totalLines: initial.totalLines,
				totalBytes: initial.totalBytes,
				outputLines: initial.outputLines,
				outputBytes: initial.outputBytes,
				fullResponsePath,
			},
		};
	}

	const excerpt = truncateHead(initial.content, {
		maxBytes: Math.max(0, maxBytes - 400),
		maxLines: Math.max(0, maxLines - 4),
	});
	return {
		text: `${excerpt.content}\n\n${truncationFooter(excerpt, fullResponsePath)}`,
		details: {
			truncated: true,
			truncatedBy: initial.truncatedBy ?? undefined,
			totalLines: initial.totalLines,
			totalBytes: initial.totalBytes,
			outputLines: excerpt.outputLines,
			outputBytes: excerpt.outputBytes,
			fullResponsePath,
		},
	};
}

export function openResponses(artifactOwner: object) {
	closedArtifactOwners.delete(artifactOwner);
}

export async function cleanupResponses(artifactOwner: object) {
	closedArtifactOwners.add(artifactOwner);
	const store = responseArtifactStores.get(artifactOwner);
	if (!store) return;
	responseArtifactStores.delete(artifactOwner);
	await Promise.allSettled([...store.pendingWrites]);
	try {
		await rm(await store.directoryPromise, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup must not make session shutdown fail.
	}
}

function truncationFooter(
	truncation: Pick<
		YoucomResultDetails,
		"outputLines" | "totalLines" | "outputBytes" | "totalBytes"
	>,
	fullResponsePath: string,
) {
	return `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full response saved to: ${fullResponsePath}]`;
}

function countLines(content: string) {
	if (!content) return 0;
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines.length;
}

function writeResponseArtifact(text: string, artifactOwner: object) {
	const store = responseArtifactStore(artifactOwner);
	const operation = store.directoryPromise.then(async (directory) => {
		const path = join(directory, `response-${Date.now()}-${randomUUID()}.json`);
		await writeFile(path, text, { mode: 0o600 });
		await chmod(path, 0o600);
		return path;
	});
	store.pendingWrites.add(operation);
	operation.then(
		() => store.pendingWrites.delete(operation),
		() => store.pendingWrites.delete(operation),
	);
	return operation;
}

function responseArtifactStore(artifactOwner: object): ResponseArtifactStore {
	if (closedArtifactOwners.has(artifactOwner)) {
		throw new Error("You.com response arrived after session shutdown; full response was discarded");
	}
	const existing = responseArtifactStores.get(artifactOwner);
	if (existing) return existing;

	const store: ResponseArtifactStore = {
		directoryPromise: Promise.resolve(""),
		pendingWrites: new Set(),
	};
	store.directoryPromise = mkdtemp(join(tmpdir(), "pi-youcom-"))
		.then(async (directory) => {
			await chmod(directory, 0o700);
			return directory;
		})
		.catch((error) => {
			if (responseArtifactStores.get(artifactOwner) === store) {
				responseArtifactStores.delete(artifactOwner);
			}
			throw error;
		});
	responseArtifactStores.set(artifactOwner, store);
	return store;
}
