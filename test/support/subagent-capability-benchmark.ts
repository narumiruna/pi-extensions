import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SUBAGENT_CAPABILITY_BENCHMARK_VERSION =
	"pi-extensions:subagent-capability-benchmark:v3" as const;
export const CAPABILITY_RESULT_PREFIX = "CAPABILITY_BENCHMARK_RESULT:";
export const CAPABILITY_BENCHMARK_ARMS = ["parent-only", "v1-sync", "v1-async", "v3-job"] as const;
export const CAPABILITY_BENCHMARK_JOB_VERSIONS = ["v2", "v3"] as const;
const CAPABILITY_BENCHMARK_V2_ARMS = ["parent-only", "v1-sync", "v1-async", "v2-job"] as const;
export const CAPABILITY_BENCHMARK_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type CapabilityBenchmarkJobVersion = (typeof CAPABILITY_BENCHMARK_JOB_VERSIONS)[number];
export type CapabilityBenchmarkArm =
	| (typeof CAPABILITY_BENCHMARK_ARMS)[number]
	| (typeof CAPABILITY_BENCHMARK_V2_ARMS)[number];
export type CapabilityBenchmarkThinkingLevel =
	(typeof CAPABILITY_BENCHMARK_THINKING_LEVELS)[number];
export type CapabilityBenchmarkOutcome =
	| "completed"
	| "invalid-output"
	| "timed-out"
	| "readiness-timeout"
	| "process-error"
	| "protocol-error";

export interface CapabilityEvidenceItem {
	id: string;
	terms: string[];
}

export interface CapabilityTask {
	id: "single-research" | "parallel-research" | "security-review" | "worker-fix";
	category: "background" | "parallel" | "review" | "mutation";
	description: string;
	childTasks: string[];
	parentWork: string;
	evidence: CapabilityEvidenceItem[];
	requiredStartCount: number;
	requiredWaitCount: number;
	fixtureCheck: boolean;
}

export const CAPABILITY_TASKS: readonly CapabilityTask[] = [
	{
		id: "single-research",
		category: "background",
		description: "One explorer returns three exact implementation facts.",
		childTasks: [
			[
				"Inspect src/queue.ts, src/delivery.ts, and src/shutdown.ts in the current fixture.",
				"Report the retry attempt count, completion channel, and exact shutdown order.",
				"Cite each repository-relative path and symbol.",
				"Do not edit files.",
			].join("\n"),
		],
		parentWork: "While the child runs, read BENCHMARK.md and retain its fixture identifier.",
		evidence: [
			{ id: "retry-attempts", terms: ["src/queue.ts", "RETRY_ATTEMPTS", "4"] },
			{ id: "completion-channel", terms: ["src/delivery.ts", "COMPLETION_CHANNEL", "steer"] },
			{
				id: "shutdown-order",
				terms: ["src/shutdown.ts", "stop-delivery", "abort-children", "await-streams"],
			},
		],
		requiredStartCount: 1,
		requiredWaitCount: 1,
		fixtureCheck: false,
	},
	{
		id: "parallel-research",
		category: "parallel",
		description: "Two independent scopes cover protocol and retention files.",
		childTasks: [
			[
				"Inspect only src/protocol.ts in the current fixture.",
				"Report the protocol version and maximum frame bytes with exact symbol and path evidence.",
				"Do not edit files.",
			].join("\n"),
			[
				"Inspect only src/retention.ts in the current fixture.",
				"Report the retained terminal-job limit and retention hours with exact symbol and path evidence.",
				"Do not edit files.",
			].join("\n"),
		],
		parentWork: "While both children run, read BENCHMARK.md and retain its fixture identifier.",
		evidence: [
			{ id: "protocol-version", terms: ["src/protocol.ts", "PROTOCOL_VERSION", "job-v3"] },
			{ id: "frame-limit", terms: ["src/protocol.ts", "MAX_FRAME_BYTES", "49152"] },
			{ id: "terminal-limit", terms: ["src/retention.ts", "MAX_TERMINAL_JOBS", "32"] },
			{ id: "retention-hours", terms: ["src/retention.ts", "RETENTION_HOURS", "24"] },
		],
		requiredStartCount: 2,
		requiredWaitCount: 2,
		fixtureCheck: false,
	},
	{
		id: "security-review",
		category: "review",
		description: "One bounded read-only review finds three planted security defects.",
		childTasks: [
			[
				"Review only src/review.ts in the current fixture for three security defects.",
				"For each defect, cite the exact operation and explain the safe replacement.",
				"Do not edit files.",
			].join("\n"),
		],
		parentWork: "Read BENCHMARK.md while the delegated review runs, then synthesize its evidence.",
		evidence: [
			{ id: "owner-prefix", terms: ["src/review.ts", "startsWith", "owner"] },
			{ id: "path-traversal", terms: ["src/review.ts", "path.join", "traversal"] },
			{ id: "token-leak", terms: ["src/review.ts", "slice(0, 8)", "token"] },
		],
		requiredStartCount: 1,
		requiredWaitCount: 1,
		fixtureCheck: false,
	},
	{
		id: "worker-fix",
		category: "mutation",
		description: "One implementation scope fixes two functions and verifies the fixture.",
		childTasks: [
			[
				"Fix only src/math.mjs so all tests in test/math.test.mjs pass.",
				"Do not edit tests or BENCHMARK.md.",
				"Run node --test test/math.test.mjs and report changed paths and check output.",
			].join("\n"),
		],
		parentWork: [
			"While the child runs, read BENCHMARK.md and test/math.test.mjs without editing them.",
			"After the child settles, run node --test test/math.test.mjs yourself and inspect src/math.mjs.",
		].join(" "),
		evidence: [
			{ id: "clamp-fixed", terms: ["src/math.mjs", "clamp", "pass"] },
			{ id: "even-fixed", terms: ["src/math.mjs", "isEven", "pass"] },
			{ id: "parent-verification", terms: ["node --test", "test/math.test.mjs", "pass"] },
		],
		requiredStartCount: 1,
		requiredWaitCount: 1,
		fixtureCheck: true,
	},
] as const;

export interface CapabilityBenchmarkOptions {
	model: string;
	thinkingLevel: CapabilityBenchmarkThinkingLevel;
	repetitions: number;
	timeoutMs: number;
	readinessTimeoutMs: number;
	piCommand: string;
	outputPath?: string;
	run: boolean;
	resume: boolean;
	workspace?: string;
	jobVersion: CapabilityBenchmarkJobVersion;
	v1Extension?: string;
	v2Extension?: string;
	v3Extension?: string;
}

export interface CapabilityTrialPlan {
	pairIndex: number;
	repetition: number;
	orderIndex: number;
	arm: CapabilityBenchmarkArm;
	taskId: CapabilityTask["id"];
}

export interface CapabilityEventAnalysis {
	finalAnswer?: string;
	marker?: Record<string, unknown>;
	matchedEvidence: string[];
	evidenceScore: number;
	toolCompliance: boolean;
	completionObserved: boolean;
	prematureFinal: boolean;
	toolCounts: {
		sync: number;
		start: number;
		wait: number;
		unexpected: number;
	};
}

export interface CapabilityTrialRecord extends CapabilityEventAnalysis {
	version: ReturnType<typeof capabilityBenchmarkVersion>;
	pairIndex: number;
	repetition: number;
	orderIndex: number;
	arm: CapabilityBenchmarkArm;
	taskId: CapabilityTask["id"];
	outcome: CapabilityBenchmarkOutcome;
	success: boolean;
	fixturePassed: boolean | null;
	readinessMs: number;
	elapsedMs: number;
	parentVisibleCost: number | null;
	startedAt: string;
	completedAt: string;
	events: unknown[];
	stderr?: string;
	error?: string;
}

export interface CapabilityArmSummary {
	trials: number;
	successes: number;
	successRate: number;
	meanEvidenceScore: number;
	toolComplianceRate: number;
	completionCoverage: number;
	medianReadinessMs: number | null;
	medianElapsedMs: number | null;
	parentVisibleCost: number | null;
	outcomes: Record<CapabilityBenchmarkOutcome, number>;
}

export const CAPABILITY_MATRIX = [
	{
		capability: "Bounded background start, inspect, cancel, wait, and read-only consult",
		v1: "supported",
		v2: "supported",
		evidence: "Both package READMEs and lifecycle tool tests",
	},
	{
		capability: "One terminal asynchronous completion with stale-result suppression",
		v1: "supported",
		v2: "supported",
		evidence: "completion-delivery and SubagentRuntime tests",
	},
	{
		capability: "Retained follow-up conversation and queue-only mailbox",
		v1: "supported",
		v2: "intentionally omitted",
		evidence: "pi-subagents capability matrix; pi-subagents-v2 limitations",
	},
	{
		capability: "Blocking chain, fan-in, panel, workflow DAG, and managed verification",
		v1: "supported",
		v2: "intentionally omitted",
		evidence: "pi-subagents execution and workflow tests; pi-subagents-v2 limitations",
	},
	{
		capability: "Subprocess, in-process, RPC, and automatic transport selection",
		v1: "supported",
		v2: "subprocess only",
		evidence: "pi-subagents transport tests; pi-subagents-v2 process runtime",
	},
	{
		capability: "Durable logical history across reload and explicit semantic revalidation",
		v1: "supported",
		v2: "intentionally omitted",
		evidence: "pi-subagents persistence tests; pi-subagents-v2 retention limits",
	},
	{
		capability: "Automatic idle-parent wake for required completion",
		v1: "opt-in supported",
		v2: "not supported",
		evidence: "pi-subagents auto-resume tests; pi-subagents-v2 limitations",
	},
	{
		capability: "Contracts, structured-v2 outcomes, capability grants, and exact-tree acceptance",
		v1: "supported",
		v2: "intentionally omitted",
		evidence: "pi-subagents contract and verified-execution tests; pi-subagents-v2 limitations",
	},
	{
		capability: "Extension-owned settings, status, diagnostics, and local usage recording",
		v1: "supported",
		v2: "intentionally omitted",
		evidence: "pi-subagents settings and inspection tests; v2 registers no commands",
	},
] as const;

export function capabilityBenchmarkVersion(
	jobVersion: CapabilityBenchmarkJobVersion,
): `pi-extensions:subagent-capability-benchmark:${CapabilityBenchmarkJobVersion}` {
	return `pi-extensions:subagent-capability-benchmark:${jobVersion}`;
}

export function capabilityBenchmarkArms(
	jobVersion: CapabilityBenchmarkJobVersion,
): readonly CapabilityBenchmarkArm[] {
	return jobVersion === "v2" ? CAPABILITY_BENCHMARK_V2_ARMS : CAPABILITY_BENCHMARK_ARMS;
}

export function capabilityMatrix(jobVersion: CapabilityBenchmarkJobVersion) {
	if (jobVersion === "v2") return CAPABILITY_MATRIX;
	return CAPABILITY_MATRIX.map(({ v2, ...item }) => ({
		...item,
		v3: v2,
		evidence: item.evidence
			.replaceAll("pi-subagents-v2", "pi-subagents-v3")
			.replaceAll("v2 registers", "v3 registers"),
	}));
}

export function parseCapabilityBenchmarkArgs(args: readonly string[]): CapabilityBenchmarkOptions {
	let model = "";
	let thinkingLevel: CapabilityBenchmarkThinkingLevel = "medium";
	let repetitions = 1;
	let timeoutMs = 180_000;
	let readinessTimeoutMs = 15_000;
	let piCommand = "pi";
	let outputPath: string | undefined;
	let workspace: string | undefined;
	let jobVersion: CapabilityBenchmarkJobVersion = "v3";
	let v1Extension: string | undefined;
	let v2Extension: string | undefined;
	let v3Extension: string | undefined;
	let run = false;
	let resume = false;

	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--run") {
			run = true;
			continue;
		}
		if (argument === "--resume") {
			resume = true;
			continue;
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		index++;
		switch (argument) {
			case "--model":
				model = value.trim();
				break;
			case "--thinking":
				if (!isOneOf(value, CAPABILITY_BENCHMARK_THINKING_LEVELS)) {
					throw new Error(`Unsupported thinking level: ${value}`);
				}
				thinkingLevel = value;
				break;
			case "--repetitions":
				repetitions = positiveInteger(value, argument, 10);
				break;
			case "--timeout-ms":
				timeoutMs = positiveInteger(value, argument);
				break;
			case "--readiness-timeout-ms":
				readinessTimeoutMs = positiveInteger(value, argument);
				break;
			case "--pi":
				piCommand = value;
				break;
			case "--output":
				outputPath = value;
				break;
			case "--workspace":
				workspace = value;
				break;
			case "--job-version":
				if (!isOneOf(value, CAPABILITY_BENCHMARK_JOB_VERSIONS)) {
					throw new Error(`Unsupported job version: ${value}`);
				}
				jobVersion = value;
				break;
			case "--v1-extension":
				v1Extension = value;
				break;
			case "--v2-extension":
				v2Extension = value;
				break;
			case "--v3-extension":
				v3Extension = value;
				break;
			default:
				throw new Error(`Unknown benchmark argument: ${argument}`);
		}
	}
	if (!model) throw new Error("--model is required so parent and child use one fixed model");
	if (run && !outputPath) throw new Error("--output is required with --run");
	if (resume && (!run || !outputPath)) throw new Error("--resume requires --run and --output");
	if (jobVersion === "v2" && v3Extension) {
		throw new Error("--v3-extension requires --job-version v3");
	}
	if (jobVersion === "v2" && !v2Extension) {
		throw new Error("--job-version v2 requires --v2-extension because v2 is historical");
	}
	if (jobVersion === "v3" && v2Extension) {
		throw new Error("--v2-extension requires --job-version v2");
	}
	return {
		model,
		thinkingLevel,
		repetitions,
		timeoutMs,
		readinessTimeoutMs,
		piCommand,
		run,
		resume,
		jobVersion,
		...(outputPath ? { outputPath } : {}),
		...(workspace ? { workspace } : {}),
		...(v1Extension ? { v1Extension } : {}),
		...(v2Extension ? { v2Extension } : {}),
		...(v3Extension ? { v3Extension } : {}),
	};
}

export function createCapabilityTrialPlan(
	repetitions: number,
	jobVersion: CapabilityBenchmarkJobVersion = "v3",
): CapabilityTrialPlan[] {
	const plan: CapabilityTrialPlan[] = [];
	const arms = capabilityBenchmarkArms(jobVersion);
	let pairIndex = 0;
	for (let repetition = 0; repetition < repetitions; repetition++) {
		for (const [taskIndex, task] of CAPABILITY_TASKS.entries()) {
			const rotation = (repetition * CAPABILITY_TASKS.length + taskIndex) % 4;
			const order = [...arms.slice(rotation), ...arms.slice(0, rotation)];
			for (const [orderIndex, arm] of order.entries()) {
				plan.push({ pairIndex, repetition, orderIndex, arm, taskId: task.id });
			}
			pairIndex++;
		}
	}
	return plan;
}

export function buildCapabilityPrompt(
	arm: CapabilityBenchmarkArm,
	task: CapabilityTask,
	thinkingLevel: CapabilityBenchmarkThinkingLevel,
): string {
	const agent = task.category === "mutation" ? "benchmark-worker" : "benchmark-explorer";
	const steps: string[] = [];
	if (arm === "parent-only") {
		steps.push(
			"Complete the workload directly with core tools and do not delegate.",
			...task.childTasks.map((childTask, index) => `Direct scope ${index + 1}:\n${childTask}`),
			"Read BENCHMARK.md and retain its fixture identifier.",
		);
		if (task.fixtureCheck) {
			steps.push("Run node --test test/math.test.mjs after editing and inspect src/math.mjs.");
		}
	} else if (arm === "v1-sync") {
		steps.push(
			"Call the blocking subagent tool exactly once and wait for its result.",
			`Use agent ${agent}, thinkingLevel ${thinkingLevel}, and timeoutMs 120000.`,
		);
		if (task.childTasks.length === 1) {
			steps.push(`Pass this exact task:\n${task.childTasks[0]}`);
		} else {
			steps.push(
				"Use one parallel batch with no aggregator and these exact tasks:",
				...task.childTasks.map((childTask, index) => `Parallel task ${index + 1}:\n${childTask}`),
			);
		}
		steps.push("After the blocking result returns, read BENCHMARK.md.");
		if (task.fixtureCheck) {
			steps.push("Then independently run node --test test/math.test.mjs and inspect src/math.mjs.");
		}
	} else {
		const names = capabilityToolNames(arm);
		steps.push(
			`Start exactly ${task.requiredStartCount} background job(s) with ${names.start}.`,
			`Use ${agent}, thinkingLevel ${thinkingLevel}, and timeoutMs 120000.`,
			...task.childTasks.map((childTask, index) => `Job ${index + 1} exact task:\n${childTask}`),
			task.parentWork,
			`Then call ${names.wait} exactly once for each started job with timeoutMs 120000.`,
			"Do not poll with inspection and do not start replacement jobs.",
		);
	}
	return [
		"This is one non-interactive four-arm subagent benchmark trial.",
		`Arm: ${arm}.`,
		`Task ID: ${task.id}.`,
		`Use the configured ${thinkingLevel} thinking level and do not change models.`,
		...steps,
		"Synthesize the available evidence and include every requested fact with exact paths and symbols.",
		...(arm === "parent-only"
			? []
			: ["Do not claim success before the required subagent result is visible."]),
		`End with exactly one line: ${CAPABILITY_RESULT_PREFIX} {"taskId":"${task.id}","complete":true}`,
	].join("\n\n");
}

export function analyzeCapabilityEvents(
	arm: CapabilityBenchmarkArm,
	task: CapabilityTask,
	events: readonly unknown[],
): CapabilityEventAnalysis {
	const expected = expectedToolCounts(arm, task);
	let sync = 0;
	let start = 0;
	let wait = 0;
	let unexpected = 0;
	let completionIndex = -1;
	let finalIndex = -1;
	let finalAnswer: string | undefined;
	let marker: Record<string, unknown> | undefined;

	for (const [index, value] of events.entries()) {
		if (!isRecord(value) || value.type !== "message_end" || !isRecord(value.message)) continue;
		const message = value.message;
		if (message.role === "toolResult") {
			const toolName = typeof message.toolName === "string" ? message.toolName : "";
			if (message.isError === true) {
				if (toolName.startsWith("subagent")) unexpected++;
				continue;
			}
			if (toolName === "subagent") {
				sync++;
				if (arm === "v1-sync") completionIndex = index;
			} else if (toolName === capabilityToolNames(arm).start) {
				start++;
			} else if (toolName === capabilityToolNames(arm).wait && !isTimedOutResult(message.details)) {
				wait++;
				if (wait >= expected.wait) completionIndex = index;
			} else if (toolName.startsWith("subagent")) {
				unexpected++;
			}
			continue;
		}
		if (message.role !== "assistant") continue;
		const text = messageText(message);
		const candidate = extractResultMarker(text);
		if (!candidate) continue;
		finalAnswer = text;
		marker = candidate;
		finalIndex = index;
	}
	const score = scoreCapabilityEvidence(finalAnswer ?? "", task.evidence);
	const toolCompliance =
		sync === expected.sync &&
		start === expected.start &&
		wait === expected.wait &&
		unexpected === 0;
	const markerValid = marker?.taskId === task.id && marker.complete === true;
	const completionObserved =
		arm === "parent-only"
			? markerValid && finalIndex >= 0
			: completionIndex >= 0 && finalIndex > completionIndex;
	return {
		...(finalAnswer ? { finalAnswer } : {}),
		...(markerValid && marker ? { marker } : {}),
		matchedEvidence: score.matched,
		evidenceScore: score.score,
		toolCompliance,
		completionObserved,
		prematureFinal:
			arm === "parent-only"
				? false
				: finalIndex >= 0 && (completionIndex < 0 || finalIndex < completionIndex),
		toolCounts: { sync, start, wait, unexpected },
	};
}

function expectedToolCounts(
	arm: CapabilityBenchmarkArm,
	task: CapabilityTask,
): { sync: number; start: number; wait: number } {
	if (arm === "v1-sync") return { sync: 1, start: 0, wait: 0 };
	if (arm === "v1-async" || arm === "v2-job" || arm === "v3-job") {
		return {
			sync: 0,
			start: task.requiredStartCount,
			wait: task.requiredWaitCount,
		};
	}
	return { sync: 0, start: 0, wait: 0 };
}

function capabilityToolNames(arm: CapabilityBenchmarkArm): { start: string; wait: string } {
	if (arm === "v1-async") return { start: "subagent_spawn", wait: "subagent_await" };
	if (arm === "v3-job") return { start: "subagent-v3-start", wait: "subagent-v3-wait" };
	return { start: "subagent-v2-start", wait: "subagent-v2-wait" };
}

export function scoreCapabilityEvidence(
	text: string,
	evidence: readonly CapabilityEvidenceItem[],
): { score: number; matched: string[] } {
	const normalized = normalizeEvidenceText(text);
	const matched = evidence
		.filter((item) => item.terms.every((term) => normalized.includes(normalizeEvidenceText(term))))
		.map((item) => item.id);
	return { score: evidence.length === 0 ? 1 : round(matched.length / evidence.length), matched };
}

export function trialSucceeded(
	analysis: CapabilityEventAnalysis,
	outcome: CapabilityBenchmarkOutcome,
	fixturePassed: boolean | null,
): boolean {
	return (
		outcome === "completed" &&
		analysis.evidenceScore === 1 &&
		analysis.toolCompliance &&
		analysis.completionObserved &&
		!analysis.prematureFinal &&
		fixturePassed !== false
	);
}

export function summarizeCapabilityBenchmark(
	records: readonly CapabilityTrialRecord[],
	jobVersion: CapabilityBenchmarkJobVersion = "v3",
) {
	const arms = capabilityBenchmarkArms(jobVersion);
	const summarize = (arm: CapabilityBenchmarkArm): CapabilityArmSummary => {
		const selected = records.filter((record) => record.arm === arm);
		const outcomes = emptyOutcomes();
		for (const record of selected) outcomes[record.outcome]++;
		const parentCosts = selected.flatMap((record) =>
			record.parentVisibleCost === null ? [] : [record.parentVisibleCost],
		);
		return {
			trials: selected.length,
			successes: selected.filter((record) => record.success).length,
			successRate: ratio(selected.filter((record) => record.success).length, selected.length),
			meanEvidenceScore:
				selected.length === 0
					? 0
					: round(
							selected.reduce((sum, record) => sum + record.evidenceScore, 0) / selected.length,
						),
			toolComplianceRate: ratio(
				selected.filter((record) => record.toolCompliance).length,
				selected.length,
			),
			completionCoverage: ratio(
				selected.filter((record) => record.completionObserved).length,
				selected.length,
			),
			medianReadinessMs: median(selected.map((record) => record.readinessMs)),
			medianElapsedMs: median(selected.map((record) => record.elapsedMs)),
			parentVisibleCost:
				parentCosts.length === 0 ? null : round(parentCosts.reduce((sum, cost) => sum + cost, 0)),
			outcomes,
		};
	};
	return {
		version: capabilityBenchmarkVersion(jobVersion),
		pairedInstances: new Set(records.map((record) => record.pairIndex)).size,
		costComparable: false,
		equalInferenceBudget: false,
		arms: Object.fromEntries(arms.map((arm) => [arm, summarize(arm)])) as Record<
			CapabilityBenchmarkArm,
			CapabilityArmSummary
		>,
	};
}

export function createCapabilityFixture(directory: string, fixtureId: string): void {
	mkdirSync(path.join(directory, "src"), { recursive: true });
	mkdirSync(path.join(directory, "test"), { recursive: true });
	const files: Record<string, string> = {
		"BENCHMARK.md": `# Generated capability fixture\n\nFixture ID: ${fixtureId}.\n`,
		"src/queue.ts": [
			"export const RETRY_ATTEMPTS = 4;",
			"export const RETRY_DELAYS_MS = [25, 50, 100];",
			"",
		].join("\n"),
		"src/delivery.ts": [
			'export const COMPLETION_CHANNEL = "steer";',
			"export function deliveryKey(jobId: string, generation: number): string {",
			'\treturn jobId + ":" + generation;',
			"}",
			"",
		].join("\n"),
		"src/shutdown.ts": [
			'export const SHUTDOWN_ORDER = ["stop-delivery", "abort-children", "await-streams"];',
			"",
		].join("\n"),
		"src/protocol.ts": [
			'export const PROTOCOL_VERSION = "job-v3";',
			"export const MAX_FRAME_BYTES = 49_152;",
			"",
		].join("\n"),
		"src/retention.ts": [
			"export const MAX_TERMINAL_JOBS = 32;",
			"export const RETENTION_HOURS = 24;",
			"",
		].join("\n"),
		"src/review.ts": [
			'import path from "node:path";',
			"",
			"export function canRead(userId: string, ownerId: string): boolean {",
			"\treturn ownerId.startsWith(userId);",
			"}",
			"",
			"export function resolveUpload(root: string, requested: string): string {",
			"\treturn path.join(root, requested);",
			"}",
			"",
			"export function tokenLabel(token: string): string {",
			"\treturn token.slice(0, 8);",
			"}",
			"",
		].join("\n"),
		"src/math.mjs": [
			"export function clamp(value, minimum, maximum) {",
			"\treturn Math.max(maximum, Math.min(minimum, value));",
			"}",
			"",
			"export function isEven(value) {",
			"\treturn value % 2 === 1;",
			"}",
			"",
		].join("\n"),
		"test/math.test.mjs": [
			'import assert from "node:assert/strict";',
			'import { test } from "node:test";',
			'import { clamp, isEven } from "../src/math.mjs";',
			"",
			'test("clamp keeps values inside inclusive bounds", () => {',
			"\tassert.equal(clamp(-2, 0, 10), 0);",
			"\tassert.equal(clamp(5, 0, 10), 5);",
			"\tassert.equal(clamp(12, 0, 10), 10);",
			"});",
			"",
			'test("isEven classifies positive and negative integers", () => {',
			"\tassert.equal(isEven(2), true);",
			"\tassert.equal(isEven(3), false);",
			"\tassert.equal(isEven(-4), true);",
			"});",
			"",
		].join("\n"),
	};
	for (const [relativePath, content] of Object.entries(files)) {
		writeFileSync(path.join(directory, relativePath), content, "utf8");
	}
}

export function projectCapabilityEvents(events: readonly unknown[]): unknown[] {
	return events.flatMap((event) => {
		if (!isRecord(event) || typeof event.type !== "string") return [];
		if (event.type === "response") {
			return [
				{
					type: event.type,
					...(typeof event.id === "string" ? { id: event.id } : {}),
					...(typeof event.command === "string" ? { command: event.command } : {}),
					...(typeof event.success === "boolean" ? { success: event.success } : {}),
					...(event.command === "get_session_stats" && isRecord(event.data)
						? { data: event.data }
						: {}),
				},
			];
		}
		if (event.type === "message_end" && isRecord(event.message)) {
			const message = event.message;
			if (message.role === "user") return [];
			return [
				{
					type: event.type,
					message: {
						...(typeof message.role === "string" ? { role: message.role } : {}),
						...(typeof message.customType === "string" ? { customType: message.customType } : {}),
						...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
						...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
						...(projectMessageContent(message.content) !== undefined
							? { content: projectMessageContent(message.content) }
							: {}),
						...(message.details !== undefined ? { details: message.details } : {}),
					},
				},
			];
		}
		if (["agent_start", "agent_end", "turn_start", "turn_end"].includes(event.type)) {
			return [{ type: event.type }];
		}
		return [];
	});
}

export function redactCapabilityValue(value: unknown): unknown {
	return redactValue(value, new WeakSet<object>());
}

function projectMessageContent(content: unknown): unknown {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content.flatMap((part) =>
		isRecord(part) && part.type === "text" && typeof part.text === "string"
			? [{ type: "text", text: part.text }]
			: [],
	);
}

function normalizeEvidenceText(value: string): string {
	return value
		.toLowerCase()
		.replaceAll("`", "")
		.replace(/(?<=\d)[_,](?=\d)/gu, "");
}

function extractResultMarker(text: string): Record<string, unknown> | undefined {
	for (const line of text.split("\n").reverse()) {
		const index = line.indexOf(CAPABILITY_RESULT_PREFIX);
		if (index < 0) continue;
		try {
			const parsed: unknown = JSON.parse(
				line.slice(index + CAPABILITY_RESULT_PREFIX.length).trim(),
			);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function messageText(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((item) =>
			isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
		)
		.join("\n");
}

function isTimedOutResult(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return value.timedOut === true || value.state === "timed_out";
}

function emptyOutcomes(): Record<CapabilityBenchmarkOutcome, number> {
	return {
		completed: 0,
		"invalid-output": 0,
		"timed-out": 0,
		"readiness-timeout": 0,
		"process-error": 0,
		"protocol-error": 0,
	};
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return round(
		sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
	);
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : round(numerator / denominator);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
	if (!isRecord(value)) return value;
	if (value.type === "thinking") return "[reasoning omitted]";
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (reasoningKey(key)) continue;
		output[key] = sensitiveKey(key) ? "[redacted]" : redactValue(item, seen);
	}
	return output;
}

function redactString(value: string): string {
	const home = process.env.HOME;
	let output = value.replace(/<private>[\s\S]*?<\/private>/giu, "[private content omitted]");
	output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [redacted]");
	output = output.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, "[redacted-key]");
	output = output.replace(
		/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)/gu,
		"$1=[redacted]",
	);
	if (home) output = output.split(home).join("$HOME");
	return output.length <= 16 * 1024 ? output : `${output.slice(0, 16 * 1024)}\n[truncated]`;
}

function reasoningKey(key: string): boolean {
	return /^(?:thinking|thinkingSignature|encrypted_content)$/u.test(key);
}

function sensitiveKey(key: string): boolean {
	return /^(?:authorization|api[-_]?key|token|secret|password|headers|environment|env)$/iu.test(
		key,
	);
}

function positiveInteger(value: string, name: string, maximum = 2_147_483_647): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new Error(`${name} must be an integer from 1 through ${maximum}`);
	}
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(value: string, values: T): value is T[number] {
	return values.includes(value);
}

function round(value: number): number {
	return Number(value.toFixed(3));
}
