#!/usr/bin/env node

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	analyzeCapabilityEvents,
	buildCapabilityPrompt,
	CAPABILITY_TASKS,
	type CapabilityBenchmarkArm,
	type CapabilityBenchmarkOptions,
	type CapabilityBenchmarkOutcome,
	type CapabilityTask,
	type CapabilityTrialPlan,
	type CapabilityTrialRecord,
	capabilityBenchmarkVersion,
	capabilityMatrix,
	createCapabilityFixture,
	createCapabilityTrialPlan,
	parseCapabilityBenchmarkArgs,
	projectCapabilityEvents,
	redactCapabilityValue,
	summarizeCapabilityBenchmark,
	trialSucceeded,
} from "../test/support/subagent-capability-benchmark.ts";

const help = `Usage:
  just benchmark-subagent-capabilities --model <provider/model> [options]
  just benchmark-subagent-capabilities --run --model <provider/model> --output <file> [options]

Options:
  --model <provider/model>       Fixed parent and child model (required)
  --thinking <level>             Fixed thinking level (default: medium)
  --repetitions <count>          Paired repetitions per task, maximum 10 (default: 1)
  --timeout-ms <ms>              Hard trial deadline after readiness (default: 180000)
  --readiness-timeout-ms <ms>    RPC readiness deadline (default: 15000)
  --output <file>                Redacted JSON record path (required with --run)
  --pi <command>                 Pi executable (default: pi)
  --workspace <path>             Source repository root (default: current repository)
  --job-version <v2|v3>          Bounded-job arm version (default: v3)
  --v1-extension <path>          pi-subagents entrypoint override
  --v2-extension <path>          Historical v2 entrypoint (required for v2)
  --v3-extension <path>          pi-subagents-v3 entrypoint override
  --run                          Execute live-provider trials; otherwise preview only
  --resume                       Continue missing trials from a compatible output file
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	process.stdout.write(help);
	process.exit(0);
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseCapabilityBenchmarkArgs(process.argv.slice(2));
const root = path.resolve(options.workspace ?? sourceRoot);
const v1Extension = path.resolve(root, options.v1Extension ?? "packages/pi-subagents/src/index.ts");
const jobArm: CapabilityBenchmarkArm = options.jobVersion === "v2" ? "v2-job" : "v3-job";
let jobExtension: string;
if (options.jobVersion === "v2") {
	if (!options.v2Extension) throw new Error("Historical v2 benchmarks require --v2-extension");
	jobExtension = path.resolve(root, options.v2Extension);
} else {
	jobExtension = path.resolve(root, options.v3Extension ?? "packages/pi-subagents-v3/src/index.ts");
}
const extensions: Partial<Record<CapabilityBenchmarkArm, string | undefined>> = {
	"parent-only": undefined,
	"v1-sync": v1Extension,
	"v1-async": v1Extension,
	[jobArm]: jobExtension,
};
const plan = createCapabilityTrialPlan(options.repetitions, options.jobVersion);
const version = capabilityBenchmarkVersion(options.jobVersion);
const configuration = {
	version,
	model: options.model,
	thinkingLevel: options.thinkingLevel,
	repetitions: options.repetitions,
	pairedInstances: CAPABILITY_TASKS.length * options.repetitions,
	trials: plan.length,
	retries: 0,
	timeoutMs: options.timeoutMs,
	readinessTimeoutMs: options.readinessTimeoutMs,
	concurrency: 1,
	controls: {
		fixture: "fresh generated identical fixture per four-arm instance",
		parent: "same model, thinking, prompt information, core tools, and disabled resources",
		child: "same explicit user-agent model, thinking, prompt, and tool allow-list",
		order: "balanced four-arm rotation by task and repetition",
		evaluator: "fixed text rubric plus independent node:test for mutation",
		eventRetention: "bounded responses, lifecycle boundaries, and non-user message_end evidence",
	},
	comparability: {
		quality: "diagnostic matched-task comparison; provider seeds unavailable",
		cost: `not comparable because arms use different call counts and ${options.jobVersion} omits nested child usage`,
		equalInferenceBudget: false,
		toolSurface:
			"arm-specific names and surface size are product differences and cannot be blinded",
	},
	tasks: CAPABILITY_TASKS.map((task) => ({
		id: task.id,
		category: task.category,
		description: task.description,
		evidence: task.evidence,
	})),
	capabilityMatrix: capabilityMatrix(options.jobVersion),
	order: plan,
	resumeFingerprint: {
		extensions: Object.fromEntries(
			Object.entries(extensions).map(([arm, value]) => [
				arm,
				value ? createHash("sha256").update(path.resolve(value)).digest("hex") : null,
			]),
		),
	},
	environment: {
		node: process.version,
		platform: process.platform,
		architecture: process.arch,
		piCommand: options.piCommand,
		repository: repositoryIdentity(root),
		extensions: Object.fromEntries(
			Object.entries(extensions).map(([arm, value]) => [
				arm,
				value ? displayPath(value, root) : null,
			]),
		),
	},
};

if (!options.run) {
	process.stdout.write(
		`${JSON.stringify(
			{
				...configuration,
				preview: true,
				note: "No provider request was made. Add --run and --output to execute the benchmark.",
			},
			null,
			2,
		)}\n`,
	);
	process.exit(0);
}

const outputPath = path.resolve(options.outputPath);
const records: CapabilityTrialRecord[] = options.resume
	? loadResumeRecords(outputPath, configuration, plan)
	: [];
const completedTrials = new Set(records.map(trialRecordKey));
const activeClients = new Set<RpcClient>();
let interrupted = false;
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		if (interrupted) return;
		interrupted = true;
		void Promise.allSettled([...activeClients].map((client) => client.stop())).finally(() => {
			process.exit(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143);
		});
	});
}

await persist();
for (const trial of plan) {
	if (interrupted) break;
	if (completedTrials.has(trialPlanKey(trial))) continue;
	const task = requireTask(trial.taskId);
	const record = await runTrial(options, trial, task, extensions[trial.arm], root);
	records.push(record);
	completedTrials.add(trialRecordKey(record));
	await persist();
	process.stderr.write(
		`${trial.taskId} ${trial.arm}: ${record.outcome}, success=${record.success}, evidence=${record.evidenceScore}, tools=${record.toolCompliance}\n`,
	);
}

process.stdout.write(
	`${JSON.stringify(
		{
			outputPath,
			summary: summarizeCapabilityBenchmark(records, options.jobVersion),
		},
		null,
		2,
	)}\n`,
);

async function persist(): Promise<void> {
	const document = {
		...configuration,
		preview: false,
		generatedAt: new Date().toISOString(),
		rawRecords: [...records],
		summary: summarizeCapabilityBenchmark(records, options.jobVersion),
	};
	await mkdir(path.dirname(outputPath), { recursive: true });
	const temporary = `${outputPath}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(document, null, "\t")}\n`, { mode: 0o600 });
	await rename(temporary, outputPath);
}

function loadResumeRecords(
	outputPath: string,
	expected: {
		version: string;
		model: string;
		thinkingLevel: string;
		repetitions: number;
		timeoutMs: number;
		readinessTimeoutMs: number;
		order: CapabilityTrialPlan[];
		resumeFingerprint: { extensions: Record<string, string | null> };
		environment: { extensions: Record<string, string | null> };
	},
	plan: readonly CapabilityTrialPlan[],
): CapabilityTrialRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(outputPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Cannot resume benchmark output: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.rawRecords)) {
		throw new Error("Cannot resume benchmark output without rawRecords");
	}
	for (const key of [
		"version",
		"model",
		"thinkingLevel",
		"repetitions",
		"timeoutMs",
		"readinessTimeoutMs",
	] as const) {
		if (parsed[key] !== expected[key]) {
			throw new Error(`Cannot resume benchmark output with different ${key}`);
		}
	}
	const parsedEnvironment = isRecord(parsed.environment) ? parsed.environment : undefined;
	const parsedExtensions = parsedEnvironment?.extensions;
	const parsedFingerprint = isRecord(parsed.resumeFingerprint)
		? parsed.resumeFingerprint.extensions
		: undefined;
	if (
		!isRecord(parsedExtensions) ||
		JSON.stringify(parsedExtensions) !== JSON.stringify(expected.environment.extensions) ||
		!isRecord(parsedFingerprint) ||
		JSON.stringify(parsedFingerprint) !== JSON.stringify(expected.resumeFingerprint.extensions)
	) {
		throw new Error("Cannot resume benchmark output with different extension identities");
	}
	if (JSON.stringify(parsed.order) !== JSON.stringify(expected.order)) {
		throw new Error("Cannot resume benchmark output with a different trial order");
	}
	const allowed = new Set(plan.map(trialPlanKey));
	const records = parsed.rawRecords as CapabilityTrialRecord[];
	const seen = new Set<string>();
	for (const record of records) {
		if (!isRecord(record)) throw new Error("Cannot resume malformed benchmark records");
		const key = trialRecordKey(record as CapabilityTrialRecord);
		if (!allowed.has(key) || seen.has(key)) {
			throw new Error("Cannot resume unknown or duplicate benchmark records");
		}
		seen.add(key);
	}
	return records;
}

function trialPlanKey(trial: CapabilityTrialPlan): string {
	return `${trial.pairIndex}:${trial.repetition}:${trial.orderIndex}:${trial.arm}:${trial.taskId}`;
}

function trialRecordKey(record: CapabilityTrialRecord): string {
	return trialPlanKey(record);
}

async function runTrial(
	benchmarkOptions: CapabilityBenchmarkOptions,
	trial: CapabilityTrialPlan,
	task: CapabilityTask,
	extension: string | undefined,
	rootDirectory: string,
): Promise<CapabilityTrialRecord> {
	const launchedAt = performance.now();
	const startedAt = new Date().toISOString();
	const events: unknown[] = [];
	const fixture = mkdtempSync(path.join(os.tmpdir(), `subagent-capability-${trial.arm}-`));
	createCapabilityFixture(fixture, `pair-${trial.pairIndex}`);
	let client: RpcClient | undefined;
	let readinessMs = 0;
	let elapsedMs = 0;
	let parentVisibleCost: number | null = null;
	let outcome: CapabilityBenchmarkOutcome = "process-error";
	let fixturePassed: boolean | null = task.fixtureCheck ? false : null;
	let error: string | undefined;
	let readinessTimedOut = false;

	try {
		client = startRpcClient(
			benchmarkOptions,
			trial.arm,
			extension,
			fixture,
			rootDirectory,
			(value) => events.push(value),
		);
		activeClients.add(client);
		try {
			await withDeadline(
				client.request("get_state"),
				benchmarkOptions.readinessTimeoutMs,
				"Pi RPC readiness timed out",
			);
		} catch (caught) {
			readinessMs = performance.now() - launchedAt;
			readinessTimedOut = caught instanceof DeadlineError;
			throw caught;
		}
		readinessMs = performance.now() - launchedAt;
		const workStarted = performance.now();
		await withDeadline(
			(async () => {
				await client.request("prompt", {
					message: buildCapabilityPrompt(trial.arm, task, benchmarkOptions.thinkingLevel),
				});
				while (!analyzeCapabilityEvents(trial.arm, task, events).marker) {
					await client.waitForEvent("message_end");
				}
			})(),
			benchmarkOptions.timeoutMs,
			"Capability benchmark trial timed out",
		);
		elapsedMs = performance.now() - workStarted;
		const stats = await client.request("get_session_stats");
		parentVisibleCost = extractCost(stats);
		const analysis = analyzeCapabilityEvents(trial.arm, task, events);
		outcome = analysis.marker ? "completed" : "invalid-output";
		if (task.fixtureCheck) fixturePassed = verifyMutationFixture(fixture);
	} catch (caught) {
		if (readinessMs > 0 && elapsedMs === 0 && !readinessTimedOut) {
			elapsedMs = Math.max(0, performance.now() - launchedAt - readinessMs);
		}
		outcome = readinessTimedOut
			? "readiness-timeout"
			: caught instanceof DeadlineError
				? "timed-out"
				: classifyError(caught);
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		await client?.stop();
		if (client) activeClients.delete(client);
	}

	const analysis = redactCapabilityValue(
		analyzeCapabilityEvents(trial.arm, task, events),
	) as ReturnType<typeof analyzeCapabilityEvents>;
	const record: CapabilityTrialRecord = {
		version,
		pairIndex: trial.pairIndex,
		repetition: trial.repetition,
		orderIndex: trial.orderIndex,
		arm: trial.arm,
		taskId: trial.taskId,
		outcome,
		success: trialSucceeded(analysis, outcome, fixturePassed),
		fixturePassed,
		readinessMs: round(readinessMs),
		elapsedMs: round(elapsedMs),
		parentVisibleCost,
		startedAt,
		completedAt: new Date().toISOString(),
		...analysis,
		events: redactCapabilityValue(projectCapabilityEvents(events)) as unknown[],
		...(client?.stderr ? { stderr: String(redactCapabilityValue(client.stderr)) } : {}),
		...(error ? { error: String(redactCapabilityValue(error)) } : {}),
	};
	rmSync(fixture, { recursive: true, force: true });
	return record;
}

function startRpcClient(
	benchmarkOptions: CapabilityBenchmarkOptions,
	arm: CapabilityBenchmarkArm,
	extension: string | undefined,
	cwd: string,
	rootDirectory: string,
	onRecord: (value: unknown) => void,
): RpcClient {
	const agentDir = mkdtempSync(path.join(os.tmpdir(), `subagent-capability-agent-${arm}-`));
	copyAuthentication(agentDir);
	writeBenchmarkAgents(agentDir, benchmarkOptions);
	if (arm === "v1-sync" || arm === "v1-async") {
		writeFileSync(
			path.join(agentDir, "pi-subagents.json"),
			`${JSON.stringify(
				arm === "v1-sync"
					? { blocking: { enabled: true }, stateful: { enabled: false } }
					: {
							blocking: { enabled: true },
							stateful: { enabled: true, completionDelivery: "auto-resume" },
						},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	}
	const extensionArguments = extension ? ["-e", extension] : [];
	const child = spawn(
		benchmarkOptions.piCommand,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			benchmarkOptions.model,
			"--thinking",
			benchmarkOptions.thinkingLevel,
			"--no-extensions",
			...extensionArguments,
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-approve",
		],
		{
			cwd,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: agentDir,
				PI_SUBAGENT_DEPTH: "0",
				SUBAGENT_CAPABILITY_SOURCE_ROOT: rootDirectory,
			},
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	return createRpcClient(child, onRecord, () => rmSync(agentDir, { recursive: true, force: true }));
}

function writeBenchmarkAgents(
	agentDir: string,
	benchmarkOptions: CapabilityBenchmarkOptions,
): void {
	const directory = path.join(agentDir, "agents");
	mkdirSync(directory, { recursive: true });
	const frontmatter = (name: string, description: string, tools: string, prompt: string) =>
		[
			"---",
			`name: ${name}`,
			`description: ${description}`,
			`model: ${benchmarkOptions.model}`,
			`thinkingLevel: ${benchmarkOptions.thinkingLevel}`,
			"timeoutMs: 120000",
			`tools: ${tools}`,
			"---",
			"",
			prompt,
			"",
		].join("\n");
	writeFileSync(
		path.join(directory, "benchmark-explorer.md"),
		frontmatter(
			"benchmark-explorer",
			"Read-only benchmark evidence explorer.",
			"read, grep, find, ls",
			"Inspect only the delegated fixture scope. Do not edit files. Cite exact paths and symbols.",
		),
		{ mode: 0o600 },
	);
	writeFileSync(
		path.join(directory, "benchmark-worker.md"),
		frontmatter(
			"benchmark-worker",
			"Bounded benchmark implementation worker.",
			"read, grep, find, ls, edit, write, bash",
			"Edit only the delegated fixture paths. Run the requested check and report exact evidence.",
		),
		{ mode: 0o600 },
	);
}

function verifyMutationFixture(fixture: string): boolean {
	try {
		execFileSync(process.execPath, ["--test", "test/math.test.mjs"], {
			cwd: fixture,
			stdio: "ignore",
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

class DeadlineError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeadlineError";
	}
}

async function withDeadline<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new DeadlineError(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

interface RpcResponse extends Record<string, unknown> {
	type: "response";
	success: boolean;
	id?: string;
}

interface RpcClient {
	request(type: string, payload?: Record<string, unknown>): Promise<RpcResponse>;
	waitForEvent(type: string): Promise<Record<string, unknown>>;
	stop(): Promise<void>;
	readonly stderr: string;
}

function createRpcClient(
	child: ChildProcessWithoutNullStreams,
	onRecord: (value: unknown) => void,
	cleanup: () => void,
): RpcClient {
	let buffer = "";
	let stderr = "";
	let nextId = 0;
	let closed = false;
	let protocolError: Error | undefined;
	const pending = new Map<
		string,
		{ resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	>();
	const eventWaiters = new Map<
		string,
		Array<{ resolve: (event: Record<string, unknown>) => void; reject: (error: Error) => void }>
	>();
	const fail = (error: Error): void => {
		protocolError ??= error;
		for (const request of pending.values()) request.reject(error);
		pending.clear();
		for (const waiters of eventWaiters.values()) {
			for (const waiter of waiters) waiter.reject(error);
		}
		eventWaiters.clear();
	};
	const handleLine = (rawLine: string): void => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			fail(protocolFailure("Pi RPC emitted malformed JSONL"));
			return;
		}
		onRecord(value);
		if (!isRecord(value) || typeof value.type !== "string") return;
		if (value.type === "response" && typeof value.id === "string") {
			const request = pending.get(value.id);
			if (request) {
				pending.delete(value.id);
				const response = value as RpcResponse;
				if (response.success) request.resolve(response);
				else request.reject(protocolFailure(String(response.error ?? "RPC request failed")));
			}
		}
		const waiters = eventWaiters.get(value.type);
		const waiter = waiters?.shift();
		if (waiter) waiter.resolve(value);
		if (waiters?.length === 0) eventWaiters.delete(value.type);
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			handleLine(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16 * 1024);
	});
	child.once("error", (error) => fail(error));
	child.once("close", (code, signal) => {
		closed = true;
		if (buffer) handleLine(buffer);
		fail(
			protocolError ??
				new Error(`Pi RPC exited early (code=${code ?? "null"}, signal=${signal ?? "null"})`),
		);
	});
	const request = (type: string, payload: Record<string, unknown> = {}): Promise<RpcResponse> => {
		if (closed || protocolError) {
			return Promise.reject(protocolError ?? new Error("Pi RPC is closed"));
		}
		const id = `capability_benchmark_${++nextId}`;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`, (error) => {
				if (!error) return;
				pending.delete(id);
				reject(error);
			});
		});
	};
	const waitForEvent = (type: string): Promise<Record<string, unknown>> => {
		if (closed || protocolError) {
			return Promise.reject(protocolError ?? new Error("Pi RPC is closed"));
		}
		return new Promise((resolve, reject) => {
			const waiters = eventWaiters.get(type) ?? [];
			waiters.push({ resolve, reject });
			eventWaiters.set(type, waiters);
		});
	};
	const waitForClose = (timeoutMs: number): Promise<boolean> =>
		new Promise((resolve) => {
			if (closed) {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => {
				child.off("close", onClose);
				resolve(false);
			}, timeoutMs);
			const onClose = (): void => {
				clearTimeout(timer);
				resolve(true);
			};
			child.once("close", onClose);
		});
	let stopPromise: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		stopPromise ??= (async () => {
			try {
				if (!closed) {
					child.stdin.end();
					signalProcessGroup(child, "SIGTERM");
					if (!(await waitForClose(1_000))) {
						signalProcessGroup(child, "SIGKILL");
						await waitForClose(1_000);
					}
				}
			} finally {
				cleanup();
			}
		})();
		return stopPromise;
	};
	return {
		request,
		waitForEvent,
		stop,
		get stderr() {
			return stderr;
		},
	};
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall back to the immediate process.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The process may already be terminal.
	}
}

function copyAuthentication(targetDir: string): void {
	const sourceDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	for (const name of ["auth.json", "pi-accounts.json", "models-store.json"] as const) {
		const source = path.join(sourceDir, name);
		try {
			if (!lstatSync(source).isFile()) continue;
			const target = path.join(targetDir, name);
			copyFileSync(source, target);
			chmodSync(target, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function extractCost(response: RpcResponse): number | null {
	const data = isRecord(response.data) ? response.data : undefined;
	return data && typeof data.cost === "number" && Number.isFinite(data.cost) ? data.cost : null;
}

function classifyError(error: unknown): CapabilityBenchmarkOutcome {
	return error instanceof Error && error.name === "RpcProtocolError"
		? "protocol-error"
		: "process-error";
}

function protocolFailure(message: string): Error {
	const error = new Error(message);
	error.name = "RpcProtocolError";
	return error;
}

function requireTask(taskId: CapabilityTask["id"]): CapabilityTask {
	const task = CAPABILITY_TASKS.find((candidate) => candidate.id === taskId);
	if (!task) throw new Error(`Unknown capability task: ${taskId}`);
	return task;
}

function displayPath(value: string, cwd: string): string {
	const relative = path.relative(cwd, value);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	return path.basename(value);
}

function repositoryIdentity(cwd: string): {
	commit: string | null;
	dirty: boolean;
	stateDigest: string | null;
} {
	try {
		const runGit = (args: string[]): Buffer =>
			execFileSync("git", args, {
				cwd,
				encoding: "buffer",
				maxBuffer: 32 * 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			});
		const commit = runGit(["rev-parse", "HEAD"]).toString("utf8").trim();
		const status = runGit(["status", "--porcelain=v1", "-z"]);
		const hash = createHash("sha256")
			.update(status)
			.update(runGit(["diff", "--binary", "HEAD"]));
		const untracked = runGit(["ls-files", "--others", "--exclude-standard", "-z"])
			.toString("utf8")
			.split("\0")
			.filter(Boolean)
			.sort();
		for (const relativePath of untracked) {
			hash
				.update(relativePath)
				.update("\0")
				.update(readFileSync(path.join(cwd, relativePath)));
		}
		return { commit, dirty: status.length > 0, stateDigest: hash.digest("hex") };
	} catch {
		return { commit: null, dirty: true, stateDigest: null };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
	return Number(value.toFixed(3));
}
