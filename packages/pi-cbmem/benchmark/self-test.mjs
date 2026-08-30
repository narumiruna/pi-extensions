#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArguments } from "./config.mjs";
import {
	BENCHMARK_ID,
	buildPrompt,
	createSchedule,
	extractLastJson,
	materializeTask,
	scoreTrial,
	summarizeNumbers,
	summarizeTrials,
	validateSuite,
} from "./core.mjs";
import {
	assertRepositoryStable,
	prepareFullIndex,
	validateFullIndexMetadata,
} from "./index-preparation.mjs";
import { buildPiArguments, runPiTrial } from "./rpc-runner.mjs";

assert.equal(BENCHMARK_ID, "pi-cbmem-retrieval-comparison:v1");

const projectPlaceholder = `$${"{project}"}`;
const suiteInput = {
	schemaVersion: 1,
	id: "test:v1",
	description: "Test suite.",
	tasks: [
		{
			id: "exact",
			kind: "exact-payload",
			question: "Recover the value.",
			facts: [{ id: "value", expected: "alpha" }],
			exactTool: {
				name: "search_code",
				args: { project: projectPlaceholder, pattern: "alpha" },
			},
		},
		{
			id: "same",
			kind: "same-evidence",
			question: "Recover the second value.",
			facts: [{ id: "value", expected: "beta" }],
		},
	],
};
const suite = validateSuite(suiteInput);
assert.deepEqual(suite, suiteInput);
assert.throws(() => validateSuite({ ...suiteInput, unknown: true }), /unknown field/);
assert.throws(
	() => validateSuite({ ...suiteInput, tasks: [suiteInput.tasks[1], suiteInput.tasks[1]] }),
	/duplicate task id/,
);
const exact = materializeTask(suite.tasks[0], "project-name");
assert.equal(exact.exactTool.args.project, "project-name");
assert.equal(suite.tasks[0].exactTool.args.project, projectPlaceholder);

assert.deepEqual(
	createSchedule(suite.tasks, 3).map(({ taskId, arm }) => `${taskId}:${arm}`),
	[
		"exact:baseline",
		"exact:cbmem",
		"exact:cbmem",
		"exact:baseline",
		"exact:baseline",
		"exact:cbmem",
		"same:baseline",
		"same:cbmem",
		"same:cbmem",
		"same:baseline",
		"same:baseline",
		"same:cbmem",
	],
);

const packet = '{"value":"alpha"}';
const baselinePrompt = buildPrompt({ arm: "baseline", task: exact, evidencePacket: packet });
assert.match(baselinePrompt, /Do not call tools/);
assert.match(baselinePrompt, /alpha/);
const cbmemPrompt = buildPrompt({ arm: "cbmem", task: exact, evidencePacket: packet });
assert.match(cbmemPrompt, /Call search_code exactly once/);
assert.doesNotMatch(cbmemPrompt, /"value":"alpha"/);

const responseText = '{"answers":{"value":"alpha"}}';
const exactScore = scoreTrial({
	arm: "cbmem",
	task: exact,
	responseText,
	toolCalls: [{ name: "search_code", args: exact.exactTool.args }],
	toolResults: [{ name: "search_code", text: packet }],
	evidencePacket: packet,
});
assert.equal(exactScore.success, true);
assert.equal(exactScore.exactPayload.matched, true);
assert.equal(
	scoreTrial({
		arm: "cbmem",
		task: exact,
		responseText,
		toolCalls: [{ name: "search_code", args: exact.exactTool.args }],
		toolResults: [{ name: "search_code", text: `${packet}\n` }],
		evidencePacket: packet,
	}).success,
	false,
);
assert.equal(
	scoreTrial({
		arm: "baseline",
		task: exact,
		responseText,
		toolCalls: [{ name: "read", args: { path: "x" } }],
		toolResults: [],
		evidencePacket: packet,
	}).success,
	false,
);
assert.equal(
	scoreTrial({
		arm: "cbmem",
		task: suite.tasks[1],
		responseText: '{"answers":{"value":"beta"}}',
		toolCalls: [],
		toolResults: [],
	}).success,
	false,
);

assert.equal(extractLastJson('noise\n{"ok":true}\n'), '{"ok":true}');
assert.throws(() => extractLastJson("noise"), /no complete JSON/);
assert.deepEqual(summarizeNumbers([1, 2, 3, 4]), {
	count: 4,
	median: 2.5,
	medianAbsoluteDeviation: 1,
	p95: 3.85,
	min: 1,
	max: 4,
});

const makeTrial = (arm, success, tokens, wall) => ({
	arm,
	score: { success },
	metrics: {
		agentWallMs: wall,
		processWallMs: wall + 10,
		startupMs: 10,
		usage: { providerTokens: tokens },
	},
});
const summary = summarizeTrials([
	makeTrial("baseline", true, 100, 1000),
	makeTrial("baseline", false, 50, 500),
	makeTrial("cbmem", true, 80, 800),
	makeTrial("cbmem", true, 90, 900),
]);
assert.equal(summary.byArm.baseline.providerTokensPerSuccess, 150);
assert.equal(summary.byArm.cbmem.providerTokensPerSuccess, 85);
assert.equal(summary.comparison.medianProviderTokensPerSuccessfulRunDelta, -15);
assert.equal(summary.comparison.medianAgentWallMsPerSuccessfulRunDelta, -150);

const options = {
	cacheMode: "warm",
	extension: "npm:@narumitw/pi-cbmem",
	model: "provider/model",
	pi: "pi",
	repo: "/repo",
	thinking: "off",
};
const baselineArguments = buildPiArguments({ arm: "baseline", options, task: suite.tasks[1] });
const treatmentArguments = buildPiArguments({ arm: "cbmem", options, task: suite.tasks[1] });
assert.ok(baselineArguments.includes("-ne"));
assert.equal(baselineArguments.includes("-e"), false);
assert.deepEqual(treatmentArguments.slice(-2), ["-e", "npm:@narumitw/pi-cbmem"]);
assert.match(treatmentArguments[treatmentArguments.indexOf("--tools") + 1], /search_graph/);
assert.doesNotMatch(
	treatmentArguments[treatmentArguments.indexOf("--tools") + 1],
	/delete_project/,
);

const parsed = await parseArguments([
	"--runs",
	"2",
	"--kind",
	"same-evidence",
	"--max-cost-usd",
	"5",
]);
assert.equal(parsed.live, false);
assert.equal(parsed.runs, 2);
assert.equal(parsed.maxCostUsd, 5);
assert.equal(
	parsed.suite.tasks.every((task) => task.kind === "same-evidence"),
	true,
);
await assert.rejects(parseArguments(["--live"]), /requires --model/);
await assert.rejects(parseArguments(["--indexing-ms", "10"]), /unknown argument/);

const fullIndexCalls = [];
const fullIndexPacket = JSON.stringify({
	project: "project-name",
	status: "indexed",
	nodes: 20,
	edges: 30,
	expected_nodes: 20,
	expected_edges: 30,
	skipped_count: 0,
	not_indexed_files_count: 17,
	parse_partial_count: 1,
});
const fullIndex = await prepareFullIndex({
	callTool: async (...args) => {
		fullIndexCalls.push(args);
		return fullIndexPacket;
	},
	options: { ...options, project: "project-name" },
	signal: undefined,
});
assert.deepEqual(fullIndexCalls[0].slice(1, 3), [
	"index_repository",
	{
		repo_path: "/repo",
		mode: "full",
		name: "project-name",
		persistence: false,
	},
]);
assert.equal(fullIndex.status, "indexed");
assert.equal(fullIndex.notIndexedFiles, 17);
assert.equal(fullIndex.parsePartialFiles, 1);
assert.equal(fullIndex.responseSha256.length, 64);
const coverageMetadata = validateFullIndexMetadata(
	JSON.stringify({
		project: "project-name",
		indexed_at: "2026-08-30T00:00:00Z",
		metadata: {
			generation: "2026-08-30T00:00:00Z",
			index_mode: "full",
			recording_status: "complete",
			generation_matches: true,
			hash_records_complete: true,
		},
	}),
	"project-name",
);
assert.equal(coverageMetadata.indexMode, "full");
assert.equal(coverageMetadata.responseSha256.length, 64);
assert.throws(
	() =>
		validateFullIndexMetadata(
			JSON.stringify({
				project: "project-name",
				indexed_at: "2026-08-30T00:00:00Z",
				metadata: {
					generation: "2026-08-30T00:00:00Z",
					index_mode: "fast",
					recording_status: "complete",
					generation_matches: true,
					hash_records_complete: true,
				},
			}),
			"project-name",
		),
	/does not confirm a complete full-index generation/,
);
await assert.rejects(
	prepareFullIndex({
		callTool: async () =>
			JSON.stringify({
				...JSON.parse(fullIndexPacket),
				skipped_count: 1,
			}),
		options: { ...options, project: "project-name" },
	}),
	/skipped 1 files/,
);
assert.doesNotThrow(() =>
	assertRepositoryStable(
		{ gitCommit: "abc", statusSha256: "clean" },
		{ gitCommit: "abc", statusSha256: "clean" },
		"during full indexing",
	),
);
assert.throws(
	() =>
		assertRepositoryStable(
			{ gitCommit: "abc", statusSha256: "clean" },
			{ gitCommit: "def", statusSha256: "clean" },
			"during full indexing",
		),
	/repository changed during full indexing/,
);

const rpcRoot = await mkdtemp(path.join(tmpdir(), "pi-cbmem-benchmark-rpc-"));
try {
	const packageRoot = path.join(rpcRoot, "package");
	const skillPath = path.join(packageRoot, "skills", "codebase-memory", "SKILL.md");
	await mkdir(path.dirname(skillPath), { recursive: true });
	await writeFile(
		path.join(packageRoot, "package.json"),
		'{"name":"@narumitw/pi-cbmem","version":"9.9.9"}\n',
	);
	await writeFile(skillPath, "# Test skill\n");
	const fakePiPath = path.join(rpcRoot, "fake-pi.mjs");
	await writeFile(
		fakePiPath,
		`#!/usr/bin/env node
import process from "node:process";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (buffer.includes("\\n")) {
		const index = buffer.indexOf("\\n");
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
	}
});
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function response(command, data) {
	send({ id: command.id, type: "response", command: command.type, success: true, ...(data ? { data } : {}) });
}
function handle(command) {
	if (command.type === "get_commands") {
		response(command, { commands: [{ name: "skill:codebase-memory", sourceInfo: { path: ${JSON.stringify(skillPath)} } }] });
	} else if (command.type === "prompt") {
		response(command);
		if (process.argv.includes("hang-model")) return;
		send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "search_code", args: ${JSON.stringify(exact.exactTool.args)} });
		send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "search_code", result: { content: [{ type: "text", text: ${JSON.stringify(packet)} }] }, isError: false });
		send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(responseText)} }], usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16, cost: { total: 0.01 } } } });
		send({ type: "turn_end", message: {}, toolResults: [] });
		send({ type: "agent_settled" });
	} else if (command.type === "get_session_stats") {
		response(command, { tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, total: 16 }, cost: 0.01 });
	} else response(command);
}
`,
	);
	await chmod(fakePiPath, 0o755);
	const rpcTrial = await runPiTrial({
		arm: "cbmem",
		evidencePacket: packet,
		options: {
			...options,
			cacheMode: "warm",
			pi: fakePiPath,
			repo: rpcRoot,
			suite: { id: "test:v1" },
			timeoutMs: 2_000,
		},
		repetition: 1,
		task: exact,
	});
	assert.equal(rpcTrial.score.success, true);
	assert.equal(rpcTrial.metrics.usage.providerTokens, 16);
	assert.equal(rpcTrial.metrics.providerRequests, 1);
	assert.equal(rpcTrial.metrics.requestUsage[0].providerTokens, 16);
	assert.equal(rpcTrial.package.version, "9.9.9");
	assert.equal(rpcTrial.method.toolResults[0].bytes, Buffer.byteLength(packet));
	await assert.rejects(
		runPiTrial({
			arm: "baseline",
			evidencePacket: packet,
			options: {
				...options,
				cacheMode: "warm",
				model: "hang-model",
				pi: fakePiPath,
				repo: rpcRoot,
				suite: { id: "test:v1" },
				timeoutMs: 100,
			},
			repetition: 1,
			task: exact,
		}),
		/exceeded 100ms/,
	);
} finally {
	await rm(rpcRoot, { recursive: true, force: true });
}

process.stdout.write("pi-cbmem benchmark self-test passed\n");
