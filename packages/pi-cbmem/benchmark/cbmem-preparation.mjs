import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { sha256 } from "./core.mjs";

export async function prepareDaemon({ execute, signal }) {
	const started = performance.now();
	const startOutput = await execute(["daemon", "start"], signal);
	const owned = !/daemon:\s+already active\b/i.test(startOutput);
	try {
		const initial = parseDaemonStatus(await execute(["daemon", "status"], signal));
		let disposed = false;
		return {
			provenance: {
				active: true,
				pid: initial.pid,
				build: initial.build,
				startedByBenchmark: owned,
				wallMs: round(performance.now() - started),
			},
			async verify(signal) {
				const current = parseDaemonStatus(await execute(["daemon", "status"], signal));
				return current.pid === initial.pid && current.build === initial.build;
			},
			async dispose() {
				if (disposed) return;
				disposed = true;
				if (owned) await execute(["daemon", "stop"]);
			},
		};
	} catch (error) {
		if (!owned) throw error;
		try {
			await execute(["daemon", "stop"]);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "daemon setup and cleanup failed");
		}
		throw error;
	}
}

export async function prepareProjectDiscovery({ callTool, options, signal }) {
	const started = performance.now();
	const projectsPacket = await callTool(options, "list_projects", {}, signal);
	const projectsResult = parseObject(projectsPacket, "list_projects");
	if (!Array.isArray(projectsResult.projects)) {
		throw new Error("list_projects.projects must be an array");
	}
	const project = projectsResult.projects.find((candidate) => candidate?.name === options.project);
	if (!project || typeof project.root_path !== "string") {
		throw new Error(`list_projects did not discover project ${options.project}`);
	}
	const [discoveredRoot, repositoryRoot] = await Promise.all([
		realpath(project.root_path),
		realpath(options.repo),
	]);
	if (discoveredRoot !== repositoryRoot) {
		throw new Error(
			`discovered root ${project.root_path} does not match repository ${repositoryRoot}`,
		);
	}
	signal?.throwIfAborted();
	const warmupPacket = await callTool(
		options,
		"get_graph_schema",
		{ project: options.project },
		signal,
	);
	JSON.parse(warmupPacket);
	return {
		project: options.project,
		rootPath: discoveredRoot,
		wallMs: round(performance.now() - started),
		projectsResponseSha256: sha256(projectsPacket),
		warmup: {
			tool: "get_graph_schema",
			bytes: Buffer.byteLength(warmupPacket, "utf8"),
			responseSha256: sha256(warmupPacket),
		},
	};
}

function parseDaemonStatus(output) {
	if (!/^daemon:\s+active\b/im.test(output)) {
		throw new Error("Codebase Memory daemon is not active after startup");
	}
	const pid = Number(output.match(/^\s*pid:\s*(\d+)\s*$/im)?.[1]);
	const build = output.match(/^\s*build:\s*([^\s]+)(?:\s|$)/im)?.[1];
	if (!Number.isSafeInteger(pid) || pid <= 0 || !build) {
		throw new Error("Codebase Memory daemon status omitted its PID or build");
	}
	return { pid, build };
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

function round(value) {
	return Number(value.toFixed(3));
}
