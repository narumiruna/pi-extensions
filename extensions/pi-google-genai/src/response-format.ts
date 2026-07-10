import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { cleanObject } from "./config.js";

const SOURCE_LIMIT = 10;
interface GoogleGenaiSource {
	type: string;
	title?: string;
	name?: string;
	url?: string;
	status?: string;
	placeId?: string;
}
interface GoogleGenaiDetails {
	model: string;
	outputText: string;
	sources: GoogleGenaiSource[];
	toolSteps: unknown[];
	truncated: boolean;
	truncation?: {
		truncatedBy: "lines" | "bytes" | null;
		totalLines: number;
		totalBytes: number;
		outputLines: number;
		outputBytes: number;
	};
	fullResponsePath?: string;
}
let rawResponseDirectoryPromise: Promise<string> | undefined;

export async function formatToolResult(raw: unknown, model: string) {
	const outputText = extractOutputText(raw).trim() || "No response received.";
	const sources = extractSources(raw);
	const toolSteps = extractToolSteps(raw);
	const text = formatContent(outputText, sources);
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const details: GoogleGenaiDetails = {
		model,
		outputText,
		sources,
		toolSteps,
		truncated: truncation.truncated,
	};

	if (!truncation.truncated) {
		return { content: [{ type: "text" as const, text: truncation.content }], details };
	}

	const fullResponsePath = await writeRawResponse(raw);
	details.fullResponsePath = fullResponsePath;
	details.truncation = {
		truncatedBy: truncation.truncatedBy,
		totalLines: truncation.totalLines,
		totalBytes: truncation.totalBytes,
		outputLines: truncation.outputLines,
		outputBytes: truncation.outputBytes,
	};
	const footer = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full response saved to: ${fullResponsePath}]`;
	const suffix = joinBlocks([sources.length > 0 ? formatSourcesSection(sources) : "", footer]);
	const truncatedOutput = truncateHead(outputText, {
		maxLines: Math.max(0, DEFAULT_MAX_LINES - countLines(suffix) - 1),
		maxBytes: Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8") - 2),
	});
	const content = joinBlocks([truncatedOutput.content, suffix]);

	return { content: [{ type: "text" as const, text: content }], details };
}

function extractOutputText(raw: unknown): string {
	if (!raw || typeof raw !== "object") return "";
	const object = raw as { output_text?: unknown; outputText?: unknown; steps?: unknown };
	if (typeof object.output_text === "string") return object.output_text;
	if (typeof object.outputText === "string") return object.outputText;
	const lines: string[] = [];
	for (const step of asArray(object.steps)) {
		if (!isObject(step) || step.type !== "model_output") continue;
		for (const block of asArray(step.content)) {
			if (isObject(block) && block.type === "text" && typeof block.text === "string") {
				lines.push(block.text);
			}
		}
	}
	return lines.join("\n");
}

function extractSources(raw: unknown): GoogleGenaiSource[] {
	const sources: GoogleGenaiSource[] = [];
	if (!raw || typeof raw !== "object") return sources;
	const steps = asArray((raw as { steps?: unknown }).steps);

	for (const step of steps) {
		if (!isObject(step)) continue;
		if (step.type === "model_output") {
			for (const block of asArray(step.content)) {
				if (!isObject(block)) continue;
				for (const annotation of asArray(block.annotations)) addAnnotationSource(sources, annotation);
			}
		} else if (step.type === "google_maps_result") {
			for (const result of asArray(step.result)) {
				if (!isObject(result)) continue;
				for (const place of asArray(result.places)) {
					if (!isObject(place)) continue;
					addSource(sources, {
						type: "place",
						name: stringValue(place.name),
						url: stringValue(place.url),
						placeId: stringValue(place.place_id),
					});
				}
			}
		} else if (step.type === "url_context_result") {
			for (const result of asArray(step.result)) {
				if (!isObject(result)) continue;
				addSource(sources, {
					type: "url_context",
					url: stringValue(result.url),
					status: stringValue(result.status),
				});
			}
		}
	}
	return sources;
}

function addAnnotationSource(sources: GoogleGenaiSource[], annotation: unknown) {
	if (!isObject(annotation) || typeof annotation.type !== "string") return;
	if (annotation.type === "url_citation") {
		addSource(sources, {
			type: "url",
			title: stringValue(annotation.title),
			url: stringValue(annotation.url),
		});
	} else if (annotation.type === "place_citation") {
		addSource(sources, {
			type: "place",
			name: stringValue(annotation.name),
			url: stringValue(annotation.url),
			placeId: stringValue(annotation.place_id),
		});
	} else if (annotation.type === "file_citation") {
		addSource(sources, {
			type: "file",
			title: stringValue(annotation.file_name),
			url: stringValue(annotation.document_uri),
		});
	}
}

function addSource(sources: GoogleGenaiSource[], source: GoogleGenaiSource) {
	if (!source.url && !source.name && !source.title) return;
	const key = `${source.type}\0${source.url ?? ""}\0${source.name ?? ""}\0${source.title ?? ""}`;
	if (sources.some((existing) => `${existing.type}\0${existing.url ?? ""}\0${existing.name ?? ""}\0${existing.title ?? ""}` === key)) return;
	sources.push(source);
}

function extractToolSteps(raw: unknown) {
	if (!raw || typeof raw !== "object") return [];
	return asArray((raw as { steps?: unknown }).steps)
		.filter((step) => isObject(step) && step.type !== "model_output")
		.map((step) => cleanObject(step));
}

function formatContent(outputText: string, sources: GoogleGenaiSource[]) {
	return joinBlocks([outputText, sources.length > 0 ? formatSourcesSection(sources) : ""]);
}

function formatSourcesSection(sources: GoogleGenaiSource[]) {
	const visibleSources = sources.slice(0, SOURCE_LIMIT);
	return [
		"Sources:",
		...visibleSources.map((source, index) =>
			truncateLine(`${index + 1}. ${formatSource(source)}`).text,
		),
	].join("\n");
}

function joinBlocks(blocks: string[]) {
	return blocks.filter(Boolean).join("\n\n");
}

function countLines(content: string) {
	if (!content) return 0;
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines.length;
}

function formatSource(source: GoogleGenaiSource) {
	const label = source.title ?? source.name ?? source.url ?? source.type;
	const url = source.url && source.url !== label ? ` — ${source.url}` : "";
	const status = source.status ? ` (${source.status})` : "";
	return `${label}${url}${status}`;
}

async function writeRawResponse(raw: unknown) {
	const directory = await rawResponseDirectory();
	const path = join(directory, `interaction-${Date.now()}-${randomUUID()}.json`);
	await writeFile(path, `${JSON.stringify(raw, null, "\t")}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return path;
}

function rawResponseDirectory() {
	rawResponseDirectoryPromise ??= mkdtemp(join(tmpdir(), "pi-google-genai-"))
		.then(async (directory) => {
			await chmod(directory, 0o700);
			return directory;
		})
		.catch((error) => {
			rawResponseDirectoryPromise = undefined;
			throw error;
		});
	return rawResponseDirectoryPromise;
}

export async function cleanupRawResponseDirectory() {
	const directoryPromise = rawResponseDirectoryPromise;
	rawResponseDirectoryPromise = undefined;
	if (!directoryPromise) return;
	try {
		await rm(await directoryPromise, { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup; avoid making session shutdown fail.
	}
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
	return typeof value === "string" && value ? value : undefined;
}

