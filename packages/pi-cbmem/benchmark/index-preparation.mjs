import { performance } from "node:perf_hooks";
import { sha256 } from "./core.mjs";

export async function prepareFullIndex({ callTool, options, signal }) {
	const request = {
		repo_path: options.repo,
		mode: "full",
		name: options.project,
		persistence: false,
	};
	const started = performance.now();
	const packet = await callTool(options, "index_repository", request, signal);
	const wallMs = round(performance.now() - started);
	const result = parseIndexResult(packet);

	if (result.status !== "indexed") {
		throw new Error(`full indexing did not complete: ${String(result.status)}`);
	}
	if (result.project !== options.project) {
		throw new Error(
			`full indexing returned project ${String(result.project)}, expected ${options.project}`,
		);
	}
	for (const field of [
		"nodes",
		"edges",
		"expected_nodes",
		"expected_edges",
		"skipped_count",
		"not_indexed_files_count",
		"parse_partial_count",
	]) {
		requireNonNegativeInteger(result[field], field);
	}
	if (result.nodes !== result.expected_nodes || result.edges !== result.expected_edges) {
		throw new Error("full indexing returned incomplete node or edge totals");
	}
	if (result.skipped_count > 0) {
		throw new Error(`full indexing skipped ${result.skipped_count} files`);
	}

	return {
		mode: request.mode,
		persistence: request.persistence,
		project: result.project,
		status: result.status,
		wallMs,
		nodes: result.nodes,
		edges: result.edges,
		expectedNodes: result.expected_nodes,
		expectedEdges: result.expected_edges,
		skippedFiles: result.skipped_count,
		notIndexedFiles: result.not_indexed_files_count,
		parsePartialFiles: result.parse_partial_count,
		responseSha256: sha256(packet),
	};
}

export function validateFullIndexMetadata(packet, project) {
	const result = parseObject(packet, "check_index_coverage");
	const metadata = result.metadata;
	if (result.project !== project) {
		throw new Error(
			`coverage metadata returned project ${String(result.project)}, expected ${project}`,
		);
	}
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		Array.isArray(metadata) ||
		metadata.index_mode !== "full" ||
		metadata.recording_status !== "complete" ||
		metadata.generation_matches !== true ||
		metadata.hash_records_complete !== true ||
		typeof metadata.generation !== "string" ||
		typeof result.indexed_at !== "string"
	) {
		throw new Error("coverage metadata does not confirm a complete full-index generation");
	}
	return {
		generation: metadata.generation,
		indexedAt: result.indexed_at,
		indexMode: metadata.index_mode,
		recordingStatus: metadata.recording_status,
		generationMatches: metadata.generation_matches,
		hashRecordsComplete: metadata.hash_records_complete,
		responseSha256: sha256(packet),
	};
}

export function assertRepositoryStable(before, after, phase) {
	if (before.gitCommit !== after.gitCommit || before.statusSha256 !== after.statusSha256) {
		throw new Error(`repository changed ${phase}`);
	}
}

function parseIndexResult(packet) {
	return parseObject(packet, "index_repository");
}

function parseObject(packet, source) {
	let result;
	try {
		result = JSON.parse(packet);
	} catch (error) {
		throw new Error(
			`${source} returned invalid JSON: ${error instanceof Error ? error.message : error}`,
		);
	}
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		throw new Error(`${source} response must be an object`);
	}
	return result;
}

function requireNonNegativeInteger(value, field) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`index_repository.${field} must be a non-negative integer`);
	}
}

function round(value) {
	return Number(value.toFixed(3));
}
