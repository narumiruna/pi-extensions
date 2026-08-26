import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import {
	analyzeCapabilityEvents,
	buildCapabilityPrompt,
	CAPABILITY_BENCHMARK_ARMS,
	CAPABILITY_RESULT_PREFIX,
	CAPABILITY_TASKS,
	type CapabilityBenchmarkArm,
	type CapabilityTrialRecord,
	capabilityBenchmarkArms,
	capabilityBenchmarkVersion,
	capabilityMatrix,
	createCapabilityFixture,
	createCapabilityTrialPlan,
	parseCapabilityBenchmarkArgs,
	projectCapabilityEvents,
	redactCapabilityValue,
	SUBAGENT_CAPABILITY_BENCHMARK_VERSION,
	scoreCapabilityEvidence,
	summarizeCapabilityBenchmark,
	trialSucceeded,
} from "./support/subagent-capability-benchmark.js";

const execFileAsync = promisify(execFile);

function assistant(text: string): Record<string, unknown> {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

function toolResult(
	toolName: string,
	details: Record<string, unknown> = {},
	isError = false,
): Record<string, unknown> {
	return {
		type: "message_end",
		message: { role: "toolResult", toolName, isError, details, content: [] },
	};
}

function completedSingleResearch(): string {
	return [
		"src/queue.ts defines RETRY_ATTEMPTS as 4.",
		"src/delivery.ts defines COMPLETION_CHANNEL as steer.",
		"src/shutdown.ts defines stop-delivery, abort-children, await-streams.",
		`${CAPABILITY_RESULT_PREFIX} {"taskId":"single-research","complete":true}`,
	].join("\n");
}

test("argument parsing fixes model and bounded matched repetitions", () => {
	assert.deepEqual(
		parseCapabilityBenchmarkArgs([
			"--model",
			"provider/model",
			"--thinking",
			"high",
			"--repetitions",
			"3",
			"--timeout-ms",
			"500",
			"--output",
			"result.json",
			"--run",
		]),
		{
			model: "provider/model",
			thinkingLevel: "high",
			repetitions: 3,
			timeoutMs: 500,
			readinessTimeoutMs: 15_000,
			piCommand: "pi",
			outputPath: "result.json",
			run: true,
			resume: false,
			jobVersion: "v3",
		},
	);
	assert.throws(() => parseCapabilityBenchmarkArgs([]), /--model is required/i);
	assert.throws(
		() => parseCapabilityBenchmarkArgs(["--model", "p/m", "--resume"]),
		/--resume requires --run and --output/i,
	);
	assert.throws(
		() => parseCapabilityBenchmarkArgs(["--model", "p/m", "--repetitions", "11"]),
		/1 through 10/i,
	);
	assert.equal(
		parseCapabilityBenchmarkArgs(["--model", "p/m", "--job-version", "v3"]).jobVersion,
		"v3",
	);
	assert.throws(
		() => parseCapabilityBenchmarkArgs(["--model", "p/m", "--job-version", "v2"]),
		/requires --v2-extension/i,
	);
});

test("trial plan rotates all four arms across every matched workload", () => {
	const plan = createCapabilityTrialPlan(1);
	assert.equal(plan.length, CAPABILITY_TASKS.length * CAPABILITY_BENCHMARK_ARMS.length);
	assert.deepEqual(
		plan.map(({ taskId, arm }) => [taskId, arm]),
		[
			["single-research", "parent-only"],
			["single-research", "v1-sync"],
			["single-research", "v1-async"],
			["single-research", "v3-job"],
			["parallel-research", "v1-sync"],
			["parallel-research", "v1-async"],
			["parallel-research", "v3-job"],
			["parallel-research", "parent-only"],
			["security-review", "v1-async"],
			["security-review", "v3-job"],
			["security-review", "parent-only"],
			["security-review", "v1-sync"],
			["worker-fix", "v3-job"],
			["worker-fix", "parent-only"],
			["worker-fix", "v1-sync"],
			["worker-fix", "v1-async"],
		],
	);
	for (let pairIndex = 0; pairIndex < CAPABILITY_TASKS.length; pairIndex++) {
		assert.deepEqual(
			new Set(plan.filter((trial) => trial.pairIndex === pairIndex).map((trial) => trial.arm)),
			new Set(CAPABILITY_BENCHMARK_ARMS),
		);
	}
	assert.deepEqual(
		new Set(createCapabilityTrialPlan(1, "v2").map((trial) => trial.arm)),
		new Set(capabilityBenchmarkArms("v2")),
	);
});

test("arm prompts require direct, blocking, detached, and bounded-job topologies", () => {
	const single = CAPABILITY_TASKS[0];
	const parallel = CAPABILITY_TASKS[1];
	assert.match(buildCapabilityPrompt("parent-only", single, "low"), /directly.*do not delegate/is);
	assert.match(
		buildCapabilityPrompt("v1-sync", single, "low"),
		/blocking subagent.*exactly once/is,
	);
	assert.match(
		buildCapabilityPrompt("v1-sync", parallel, "low"),
		/one parallel batch.*no aggregator/is,
	);
	assert.match(
		buildCapabilityPrompt("v1-async", single, "low"),
		/subagent_spawn[\s\S]*subagent_await/,
	);
	assert.match(
		buildCapabilityPrompt("v2-job", single, "low"),
		/subagent-v2-start[\s\S]*subagent-v2-wait/,
	);
	assert.match(
		buildCapabilityPrompt("v3-job", single, "low"),
		/subagent-v3-start[\s\S]*subagent-v3-wait/,
	);
	assert.doesNotMatch(buildCapabilityPrompt("v1-sync", CAPABILITY_TASKS[2], "low"), /consult/iu);
});

test("event analysis enforces each arm topology and completion order", () => {
	const task = CAPABILITY_TASKS[0];
	const final = completedSingleResearch();
	for (const [arm, events] of [
		["parent-only", [assistant(final)]],
		["v1-sync", [toolResult("subagent"), assistant(final)]],
		[
			"v1-async",
			[
				toolResult("subagent_spawn"),
				toolResult("subagent_await", { state: "completed", timedOut: false }),
				assistant(final),
			],
		],
		[
			"v2-job",
			[
				toolResult("subagent-v2-start"),
				toolResult("subagent-v2-wait", { state: "completed", timedOut: false }),
				assistant(final),
			],
		],
		[
			"v3-job",
			[
				toolResult("subagent-v3-start"),
				toolResult("subagent-v3-wait", { state: "completed", timedOut: false }),
				assistant(final),
			],
		],
	] as Array<[CapabilityBenchmarkArm, Record<string, unknown>[]]>) {
		const analysis = analyzeCapabilityEvents(arm, task, events);
		assert.equal(analysis.evidenceScore, 1, arm);
		assert.equal(analysis.toolCompliance, true, arm);
		assert.equal(analysis.completionObserved, true, arm);
		assert.equal(analysis.prematureFinal, false, arm);
		assert.equal(trialSucceeded(analysis, "completed", null), true, arm);
	}

	const premature = analyzeCapabilityEvents("v1-async", task, [
		toolResult("subagent_spawn"),
		assistant(final),
		toolResult("subagent_await", { state: "completed" }),
	]);
	assert.equal(premature.prematureFinal, true);
	assert.equal(premature.completionObserved, false);

	const wrongTopology = analyzeCapabilityEvents("v1-sync", task, [
		toolResult("subagent_spawn"),
		toolResult("subagent"),
		assistant(final),
	]);
	assert.equal(wrongTopology.toolCompliance, false);
	assert.equal(wrongTopology.toolCounts.unexpected, 1);
});

test("failed topology attempts make v2 and v3 trials noncompliant", () => {
	const task = CAPABILITY_TASKS[0];
	const final = completedSingleResearch();
	for (const version of ["v2", "v3"] as const) {
		const start = `subagent-${version}-start`;
		const wait = `subagent-${version}-wait`;
		const analysis = analyzeCapabilityEvents(`${version}-job`, task, [
			toolResult(start, {}, true),
			toolResult(start),
			toolResult(wait, {}, true),
			toolResult(wait, { state: "completed", timedOut: false }),
			assistant(final),
		]);
		assert.deepEqual(analysis.toolCounts, { sync: 0, start: 1, wait: 1, unexpected: 2 });
		assert.equal(analysis.completionObserved, true);
		assert.equal(analysis.toolCompliance, false);
		assert.equal(trialSucceeded(analysis, "completed", null), false);
	}
});

test("wait timeouts and incomplete parallel joins fail topology compliance", () => {
	const task = CAPABILITY_TASKS[1];
	const events = [
		toolResult("subagent-v2-start"),
		toolResult("subagent-v2-start"),
		toolResult("subagent-v2-wait", { state: "completed", timedOut: false }),
		toolResult("subagent-v2-wait", { state: "running", timedOut: true }),
		assistant(
			[
				"src/protocol.ts PROTOCOL_VERSION job-v3 MAX_FRAME_BYTES 49152",
				"src/retention.ts MAX_TERMINAL_JOBS 32 RETENTION_HOURS 24",
				`${CAPABILITY_RESULT_PREFIX} {"taskId":"parallel-research","complete":true}`,
			].join("\n"),
		),
	];
	const analysis = analyzeCapabilityEvents("v2-job", task, events);
	assert.equal(analysis.toolCounts.wait, 1);
	assert.equal(analysis.toolCompliance, false);
	assert.equal(analysis.completionObserved, false);
});

test("fixed rubrics normalize numeric separators and keep writer verification independent", () => {
	const parallelTask = CAPABILITY_TASKS[1];
	assert.deepEqual(
		scoreCapabilityEvidence("src/protocol.ts MAX_FRAME_BYTES 49_152", parallelTask.evidence),
		{ score: 0.25, matched: ["frame-limit"] },
	);
	const task = CAPABILITY_TASKS[3];
	assert.deepEqual(scoreCapabilityEvidence("src/math.mjs clamp pass", task.evidence), {
		score: 0.333,
		matched: ["clamp-fixed"],
	});
	const analysis = {
		matchedEvidence: task.evidence.map((item) => item.id),
		evidenceScore: 1,
		toolCompliance: true,
		completionObserved: true,
		prematureFinal: false,
		toolCounts: { sync: 0, start: 0, wait: 0, unexpected: 0 },
	};
	assert.equal(trialSucceeded(analysis, "completed", true), true);
	assert.equal(trialSucceeded(analysis, "completed", false), false);
});

test("generated mutation fixture starts failing deterministic tests", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "subagent-capability-fixture-"));
	try {
		createCapabilityFixture(directory, "fixture-test");
		await assert.rejects(
			() =>
				execFileAsync(process.execPath, ["--test", "test/math.test.mjs"], {
					cwd: directory,
				}),
			/Command failed/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("persisted event projection keeps evidence and removes reasoning payloads", () => {
	assert.deepEqual(
		projectCapabilityEvents([
			{ type: "message_update", delta: "private streaming detail" },
			{ type: "message_end", message: { role: "user", content: "prompt duplicate" } },
			toolResult("subagent-v2-wait", { state: "completed" }),
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private reasoning", thinkingSignature: "opaque" },
						{ type: "text", text: "final evidence" },
					],
				},
			},
			{ type: "turn_end", usage: { input: 100 } },
			{
				type: "response",
				id: "stats",
				command: "get_session_stats",
				success: true,
				data: { cost: 1 },
			},
		]),
		[
			toolResult("subagent-v2-wait", { state: "completed" }),
			assistant("final evidence"),
			{ type: "turn_end" },
			{
				type: "response",
				id: "stats",
				command: "get_session_stats",
				success: true,
				data: { cost: 1 },
			},
		],
	);
});

test("redaction removes nested reasoning payloads from tool details", () => {
	const redacted = redactCapabilityValue({
		details: {
			content: [
				{
					type: "thinking",
					thinking: "private reasoning",
					thinkingSignature: "opaque",
					encrypted_content: "ciphertext",
				},
				{ type: "text", text: "retained evidence" },
			],
		},
	});
	const serialized = JSON.stringify(redacted);
	assert.doesNotMatch(
		serialized,
		/private reasoning|thinkingSignature|encrypted_content|ciphertext/,
	);
	assert.match(serialized, /retained evidence/);
});

test("summary keeps four arms, quality, latency, and budget limitations separate", () => {
	const record = (arm: CapabilityBenchmarkArm, success: boolean): CapabilityTrialRecord => ({
		version: SUBAGENT_CAPABILITY_BENCHMARK_VERSION,
		pairIndex: 0,
		repetition: 0,
		orderIndex: capabilityBenchmarkArms("v3").indexOf(arm),
		arm,
		taskId: "single-research",
		outcome: "completed",
		success,
		fixturePassed: null,
		readinessMs: 10,
		elapsedMs: 100,
		parentVisibleCost: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:01.000Z",
		matchedEvidence: success ? ["a"] : [],
		evidenceScore: success ? 1 : 0,
		toolCompliance: success,
		completionObserved: success,
		prematureFinal: false,
		toolCounts: { sync: 0, start: 0, wait: 0, unexpected: 0 },
		events: [],
	});
	const summary = summarizeCapabilityBenchmark(
		CAPABILITY_BENCHMARK_ARMS.map((arm, index) => record(arm, index !== 3)),
	);
	assert.equal(summary.costComparable, false);
	assert.equal(summary.equalInferenceBudget, false);
	assert.equal(summary.pairedInstances, 1);
	assert.equal(summary.arms["parent-only"].successRate, 1);
	assert.equal(summary.arms["v3-job"].successRate, 0);
});

test("manual runner executes all four RPC arms and cleans temporary directories", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "subagent-capability-runner-"));
	const fakePi = path.join(directory, "fake-pi.mjs");
	const output = path.join(directory, "result.json");
	writeFileSync(
		fakePi,
		[
			"#!/usr/bin/env node",
			'import fs from "node:fs";',
			'import readline from "node:readline";',
			'const extensionIndex=process.argv.indexOf("-e");const extension=extensionIndex>=0?process.argv[extensionIndex+1]||"":"";',
			'const settings=extension&&!extension.includes("v3")?JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR+"/pi-subagents.json","utf8")):undefined;',
			'const runtimeArm=!extension?"parent-only":extension.includes("v3")?"v3-job":settings.stateful.enabled?"v1-async":"v1-sync";',
			'const send=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");',
			"const lines=readline.createInterface({input:process.stdin});",
			'const final=(taskId)=>["src/queue.ts RETRY_ATTEMPTS 4","src/delivery.ts COMPLETION_CHANNEL steer","src/shutdown.ts stop-delivery abort-children await-streams","src/protocol.ts PROTOCOL_VERSION job-v3 MAX_FRAME_BYTES 49152","src/retention.ts MAX_TERMINAL_JOBS 32 RETENTION_HOURS 24","src/review.ts startsWith owner path.join traversal slice(0, 8) token","src/math.mjs clamp pass isEven pass","node --test test/math.test.mjs pass","CAPABILITY_BENCHMARK_RESULT: "+JSON.stringify({taskId,complete:true})].join("\\n");',
			'lines.on("line",(line)=>{const request=JSON.parse(line);if(request.type==="get_state"){send({id:request.id,type:"response",success:true,data:{}});return;}if(request.type==="get_session_stats"){send({id:request.id,type:"response",success:true,data:{cost:0.01}});return;}if(request.type!=="prompt")return;const arm=/Arm: ([a-z0-9-]+)/.exec(request.message)?.[1]||"unknown";if(arm!==runtimeArm){send({id:request.id,type:"response",success:false,error:"wrong runtime arm"});return;}send({id:request.id,type:"response",success:true,data:{}});const taskId=/Task ID: ([a-z-]+)/.exec(request.message)?.[1]||"unknown";const count=taskId==="parallel-research"?2:1;const tool=(name)=>send({type:"message_end",message:{role:"toolResult",toolName:name,isError:false,details:{state:"completed",timedOut:false},content:[]}});if(arm==="v1-sync")tool("subagent");if(arm==="v1-async"){for(let index=0;index<count;index++)tool("subagent_spawn");for(let index=0;index<count;index++)tool("subagent_await");}if(arm==="v3-job"){for(let index=0;index<count;index++)tool("subagent-v3-start");for(let index=0;index<count;index++)tool("subagent-v3-wait");}if(taskId==="worker-fix")fs.writeFileSync("src/math.mjs","export function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }\\nexport function isEven(value) { return value % 2 === 0; }\\n");send({type:"message_end",message:{role:"assistant",content:[{type:"text",text:final(taskId)}]}});});',
		].join("\n"),
		{ mode: 0o700 },
	);
	try {
		await execFileAsync(
			process.execPath,
			[
				"scripts/benchmark-subagent-capabilities.ts",
				"--run",
				"--model",
				"provider/model",
				"--pi",
				fakePi,
				"--output",
				output,
			],
			{
				cwd: path.resolve(import.meta.dirname, ".."),
				env: { ...process.env, TMPDIR: directory },
				timeout: 4_000,
			},
		);
		const result = JSON.parse(readFileSync(output, "utf8")) as {
			rawRecords: Array<{ success: boolean }>;
			summary: { arms: Record<string, { successes: number }> };
		};
		assert.equal(result.rawRecords.length, 16);
		assert.ok(result.rawRecords.every((item) => item.success));
		for (const arm of CAPABILITY_BENCHMARK_ARMS) {
			assert.equal(result.summary.arms[arm].successes, 4);
		}
		result.rawRecords.splice(-2);
		writeFileSync(output, JSON.stringify(result));
		await execFileAsync(
			process.execPath,
			[
				"scripts/benchmark-subagent-capabilities.ts",
				"--run",
				"--resume",
				"--model",
				"provider/model",
				"--pi",
				fakePi,
				"--output",
				output,
			],
			{
				cwd: path.resolve(import.meta.dirname, ".."),
				env: { ...process.env, TMPDIR: directory },
				timeout: 4_000,
			},
		);
		const resumed = JSON.parse(readFileSync(output, "utf8")) as {
			rawRecords: Array<{ success: boolean }>;
		};
		assert.equal(resumed.rawRecords.length, 16);
		assert.ok(resumed.rawRecords.every((item) => item.success));
		assert.equal(
			readdirSync(directory).some(
				(name) =>
					name.startsWith("subagent-capability-") || name.startsWith("subagent-capability-agent-"),
			),
			false,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("manual runner preview exposes four-arm controls without a provider request", async () => {
	const { stdout } = await execFileAsync(
		process.execPath,
		["scripts/benchmark-subagent-capabilities.ts", "--model", "provider/model"],
		{ cwd: path.resolve(import.meta.dirname, ".."), timeout: 3_000 },
	);
	const preview = JSON.parse(stdout) as {
		preview: boolean;
		pairedInstances: number;
		trials: number;
		retries: number;
		comparability: { cost: string; equalInferenceBudget: boolean };
		order: Array<{ arm: string }>;
	};
	assert.equal(preview.preview, true);
	assert.equal(preview.pairedInstances, 4);
	assert.equal(preview.trials, 16);
	assert.equal(preview.retries, 0);
	assert.equal(preview.comparability.equalInferenceBudget, false);
	assert.match(preview.comparability.cost, /not comparable/i);
	assert.deepEqual(
		new Set(preview.order.map((trial) => trial.arm)),
		new Set(CAPABILITY_BENCHMARK_ARMS),
	);
});

test("manual runner selects the historical v2 protocol explicitly", async () => {
	const { stdout } = await execFileAsync(
		process.execPath,
		[
			"scripts/benchmark-subagent-capabilities.ts",
			"--model",
			"provider/model",
			"--job-version",
			"v2",
			"--v2-extension",
			"custom-v2.ts",
		],
		{ cwd: path.resolve(import.meta.dirname, ".."), timeout: 3_000 },
	);
	const preview = JSON.parse(stdout) as {
		version: string;
		order: Array<{ arm: string }>;
		capabilityMatrix: Array<Record<string, unknown>>;
		environment: { extensions: Record<string, string | null> };
	};
	assert.equal(preview.version, capabilityBenchmarkVersion("v2"));
	assert.deepEqual(
		new Set(preview.order.map((trial) => trial.arm)),
		new Set(capabilityBenchmarkArms("v2")),
	);
	assert.equal(preview.environment.extensions["v2-job"], "custom-v2.ts");
	assert.deepEqual(preview.capabilityMatrix, capabilityMatrix("v2"));
});

for (const testCase of [
	{ protocol: [] as string[], option: "--v1-extension", name: "v1" },
	{ protocol: ["--job-version", "v2"], option: "--v2-extension", name: "v2" },
	{ protocol: [] as string[], option: "--v3-extension", name: "v3" },
]) {
	test(`resume rejects a changed ${testCase.name} extension identity`, async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "subagent-capability-resume-identity-"));
		const root = path.resolve(import.meta.dirname, "..");
		const script = "scripts/benchmark-subagent-capabilities.ts";
		try {
			const output = path.join(directory, `${testCase.name}.json`);
			const initial = path.join(directory, "initial", "extension.ts");
			const changed = path.join(directory, "changed", "extension.ts");
			const { stdout } = await execFileAsync(
				process.execPath,
				[script, "--model", "provider/model", ...testCase.protocol, testCase.option, initial],
				{ cwd: root, timeout: 3_000 },
			);
			writeFileSync(
				output,
				JSON.stringify({ ...JSON.parse(stdout), preview: false, rawRecords: [] }),
			);
			await assert.rejects(
				() =>
					execFileAsync(
						process.execPath,
						[
							script,
							"--run",
							"--resume",
							"--model",
							"provider/model",
							"--output",
							output,
							...testCase.protocol,
							testCase.option,
							changed,
						],
						{ cwd: root, timeout: 3_000 },
					),
				(error: Error & { stderr?: string }) =>
					/different extension identities/i.test(error.stderr ?? ""),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
