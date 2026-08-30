#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArguments, printHelp } from "./config.mjs";
import {
	BENCHMARK_ID,
	createSchedule,
	extractLastJson,
	materializeTask,
	sha256,
	summarizeTrials,
} from "./core.mjs";
import { buildPiArguments, runPiTrial } from "./rpc-runner.mjs";

try {
	const options = await parseArguments(process.argv.slice(2));
	if (options.help) printHelp();
	else {
		const result = options.live ? await runLive(options) : createDryRun(options);
		await publishResult(result, options.output);
		if (result.status === "failed") process.exitCode = 1;
	}
} catch (error) {
	process.stderr.write(`Benchmark failed: ${safeText(errorMessage(error))}\n`);
	process.exitCode = 1;
}

function createDryRun(options) {
	const tasks = options.suite.tasks.map((task) =>
		materializeTask(task, options.project ?? "<indexed-project>"),
	);
	const schedule = createSchedule(tasks, options.runs);
	return {
		benchmark: BENCHMARK_ID,
		mode: "dry-run",
		createdAt: new Date().toISOString(),
		note: "No Pi subprocess, Codebase Memory command, or provider request was made. Pass --live to execute.",
		config: publicConfig(options),
		suite: suiteMetadata(options.suite),
		plannedTrials: schedule.length,
		plannedOrder: schedule,
		minimumProviderRequests: schedule.reduce(
			(total, trial) =>
				total + (trial.arm === "baseline" && trial.kind === "exact-payload" ? 1 : 2),
			0,
		),
		commandShapes: commandShapes(options, tasks),
		liveRequirements: [
			"A prepared Codebase Memory index whose root exactly matches --repo.",
			"A fixed --model and explicit --max-cost-usd guard.",
			"Provider credentials available to the selected Pi installation.",
		],
	};
}

async function runLive(options) {
	const controller = new AbortController();
	const cancel = () => controller.abort(new DOMException("benchmark cancelled", "AbortError"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	const trials = [];
	let status = "completed";
	let failure;
	try {
		const provenance = await collectProvenance(options, controller.signal);
		const tasks = options.suite.tasks.map((task) => materializeTask(task, options.project));
		const exactPayloads = await captureExactPayloads(options, tasks, controller.signal);
		const schedule = createSchedule(tasks, options.runs);
		for (const [index, entry] of schedule.entries()) {
			controller.signal.throwIfAborted();
			const recordedCost = trials.reduce((total, trial) => total + trial.metrics.usage.costUsd, 0);
			if (trials.length > 0 && recordedCost >= options.maxCostUsd) {
				status = "estimated-cost-guard";
				break;
			}
			const task = tasks.find((candidate) => candidate.id === entry.taskId);
			process.stderr.write(
				`[${index + 1}/${schedule.length}] ${entry.taskId} ${entry.arm} repetition ${entry.repetition}\n`,
			);
			try {
				const trial = await runPiTrial({
					arm: entry.arm,
					evidencePacket: exactPayloads.get(entry.taskId)?.text,
					options,
					repetition: entry.repetition,
					signal: controller.signal,
					task,
				});
				trials.push({ ...entry, ...trial });
			} catch (error) {
				status = "failed";
				failure = errorMessage(error);
				break;
			}
			if (options.output) {
				await writeResult(
					options.output,
					createLiveResult({
						exactPayloads,
						failure: undefined,
						options,
						provenance,
						status: "in-progress",
						tasks,
						trials,
					}),
				);
			}
		}
		try {
			provenance.runtimeDrift = await checkRuntimeDrift(options, provenance, controller.signal);
			provenance.treatmentPackages = treatmentPackageVariants(trials);
			provenance.runtimeDrift.checks.treatmentPackage = provenance.treatmentPackages.length <= 1;
			provenance.runtimeDrift.detected ||= provenance.treatmentPackages.length > 1;
			if (provenance.runtimeDrift.detected && status === "completed") status = "runtime-drift";
		} catch (error) {
			status = "failed";
			failure = failure ? `${failure}\n${errorMessage(error)}` : errorMessage(error);
		}
		return createLiveResult({
			exactPayloads,
			failure,
			options,
			provenance,
			status,
			tasks,
			trials,
		});
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}

function createLiveResult({ exactPayloads, failure, options, provenance, status, tasks, trials }) {
	const summary = summarizeTrials(trials);
	const amortizedIndexing =
		options.indexingMs === undefined
			? undefined
			: {
					indexingMs: options.indexingMs,
					indexReuseCount: options.indexReuseCount,
					indexingMsPerRun: round(options.indexingMs / options.indexReuseCount),
					cbmemMedianAmortizedProcessWallMs:
						summary.byArm.cbmem.successful.processWallMs?.median === undefined
							? undefined
							: round(
									summary.byArm.cbmem.successful.processWallMs.median +
										options.indexingMs / options.indexReuseCount,
								),
				};
	return {
		benchmark: BENCHMARK_ID,
		mode: "live",
		status,
		measuredAt: new Date().toISOString(),
		...(failure ? { failure: safeText(failure) } : {}),
		config: publicConfig(options),
		suite: suiteMetadata(options.suite),
		provenance,
		exactPayloads: Object.fromEntries(
			[...exactPayloads.entries()].map(([id, packet]) => [
				id,
				{ bytes: Buffer.byteLength(packet.text, "utf8"), sha256: sha256(packet.text) },
			]),
		),
		plannedTrials: createSchedule(tasks, options.runs).length,
		completedTrials: trials.length,
		trials,
		summary: {
			...summary,
			...(amortizedIndexing ? { amortizedIndexing } : {}),
		},
		interpretation: {
			primarySuccessRule:
				"A run must recover every exact fact and obey its arm's retrieval-method policy.",
			tokensPerSuccess:
				"All provider-reported tokens spent by an arm divided by that arm's successful runs.",
			latency:
				"processWallMs includes Pi startup and temporary npm package resolution; agentWallMs begins immediately before the RPC prompt command.",
		},
	};
}

async function collectProvenance(options, signal) {
	const processOptions = { cwd: options.repo, signal };
	const [repoRoot, binaryPath, piVersion, cbmemVersion, gitCommit, gitStatus, indexPacket] =
		await Promise.all([
			realpath(options.repo),
			realpath(options.cbmemBin),
			runText(options.pi, ["--version"], processOptions),
			runText(options.cbmemBin, ["--version"], processOptions),
			runText("git", ["-C", options.repo, "rev-parse", "HEAD"], { signal }),
			runText("git", ["-C", options.repo, "status", "--short"], { signal }),
			callCbmem(options, "index_status", { project: options.project }, signal),
		]);
	const index = JSON.parse(indexPacket);
	if (index.status !== "ready")
		throw new Error(`Codebase Memory index is not ready: ${index.status}`);
	if ((await realpath(index.root_path)) !== repoRoot) {
		throw new Error(`indexed root ${index.root_path} does not match repository ${repoRoot}`);
	}
	const bridgeBinaryPath = await realpath(
		path.join(homedir(), ".local", "bin", "codebase-memory-mcp"),
	);
	if (binaryPath !== bridgeBinaryPath) {
		throw new Error(
			`--cbmem-bin resolves to ${binaryPath}, but pi-cbmem invokes ${bridgeBinaryPath}`,
		);
	}
	const binary = await readFile(binaryPath);
	return {
		pi: { command: options.pi, version: piVersion.trim() },
		cbmem: {
			path: binaryPath,
			version: cbmemVersion.trim(),
			sha256: createHash("sha256").update(binary).digest("hex"),
		},
		repository: {
			root: repoRoot,
			gitCommit: gitCommit.trim(),
			dirty: gitStatus.trim().length > 0,
			statusSha256: sha256(gitStatus),
		},
		index: {
			project: index.project,
			status: index.status,
			rootPath: index.root_path,
			nodes: index.nodes,
			edges: index.edges,
			statusSha256: sha256(indexPacket),
		},
	};
}

function treatmentPackageVariants(trials) {
	const variants = new Map();
	for (const trial of trials.filter((candidate) => candidate.arm === "cbmem")) {
		if (!trial.package) continue;
		const key = `${trial.package.name}@${trial.package.version}:${trial.package.manifestSha256}`;
		variants.set(key, trial.package);
	}
	return [...variants.values()];
}

async function checkRuntimeDrift(options, provenance, signal) {
	const [gitCommit, gitStatus, indexPacket] = await Promise.all([
		runText("git", ["-C", options.repo, "rev-parse", "HEAD"], { signal }),
		runText("git", ["-C", options.repo, "status", "--short"], { signal }),
		callCbmem(options, "index_status", { project: options.project }, signal),
	]);
	const checks = {
		gitCommit: gitCommit.trim() === provenance.repository.gitCommit,
		gitStatus: sha256(gitStatus) === provenance.repository.statusSha256,
		indexStatus: sha256(indexPacket) === provenance.index.statusSha256,
	};
	return { detected: Object.values(checks).includes(false), checks };
}

async function captureExactPayloads(options, tasks, signal) {
	const packets = new Map();
	for (const task of tasks.filter((candidate) => candidate.kind === "exact-payload")) {
		signal.throwIfAborted();
		packets.set(task.id, {
			text: await callCbmem(options, task.exactTool.name, task.exactTool.args, signal),
		});
	}
	return packets;
}

async function callCbmem(options, tool, args, signal) {
	const result = await runProcess(options.cbmemBin, ["cli", tool], {
		cwd: options.repo,
		env: { ...process.env, CBM_LOG_LEVEL: "error" },
		input: JSON.stringify(args),
		maxBytes: 512 * 1024,
		signal,
		timeoutMs: options.timeoutMs,
	});
	return extractLastJson(result.stdout);
}

function commandShapes(options, tasks) {
	const representative = Object.fromEntries(
		["exact-payload", "same-evidence"].flatMap((kind) => {
			const task = tasks.find((candidate) => candidate.kind === kind);
			if (!task) return [];
			return [
				[
					kind,
					{
						baseline: [options.pi, ...buildPiArguments({ arm: "baseline", options, task })],
						cbmem: [options.pi, ...buildPiArguments({ arm: "cbmem", options, task })],
					},
				],
			];
		}),
	);
	return representative;
}

function publicConfig(options) {
	return {
		model: options.model ?? "<required-for-live>",
		thinking: options.thinking,
		runsPerTaskAndArm: options.runs,
		cacheMode: options.cacheMode,
		repository: options.repo,
		project: options.project ?? "<required-for-live>",
		extension: options.extension,
		baselineInvocation: "pi -ne",
		cbmemInvocation: `pi -ne -e ${options.extension}`,
		readOnly: true,
		timeoutMs: options.timeoutMs,
		maxEstimatedCostUsd: options.maxCostUsd,
		...(options.indexingMs === undefined
			? {}
			: { indexingMs: options.indexingMs, indexReuseCount: options.indexReuseCount }),
	};
}

function suiteMetadata(suite) {
	return {
		id: suite.id,
		description: suite.description,
		tasks: suite.tasks.map((task) => ({
			id: task.id,
			kind: task.kind,
			factIds: task.facts.map((fact) => fact.id),
		})),
	};
}

async function publishResult(value, outputPath) {
	if (outputPath) {
		await writeResult(outputPath, value);
		process.stderr.write(`Wrote benchmark result to ${safeText(outputPath)}\n`);
	}
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function writeResult(outputPath, value) {
	await mkdir(path.dirname(outputPath), { recursive: true });
	const temporary = `${outputPath}.tmp-${process.pid}`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, outputPath);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function runText(command, args, options = {}) {
	const result = await runProcess(command, args, {
		...options,
		maxBytes: 1024 * 1024,
		timeoutMs: options.timeoutMs ?? 30_000,
	});
	return result.stdout;
}

async function runProcess(command, args, options) {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let settled = false;
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			callback(value);
		};
		const fail = (error) => {
			finish(reject, error instanceof Error ? error : new Error(String(error)));
		};
		const append = (current, chunk) => {
			const next = Buffer.concat([current, chunk]);
			if (next.length <= options.maxBytes) return next;
			child.kill("SIGKILL");
			fail(new Error(`${command} output exceeded ${options.maxBytes} bytes`));
			return current;
		};
		const onAbort = () => {
			child.kill("SIGKILL");
			fail(abortReason(options.signal));
		};
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			fail(new Error(`${command} exceeded ${options.timeoutMs}ms`));
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		child.stdout.on("data", (chunk) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = append(stderr, chunk);
		});
		child.stdin.on("error", () => {
			// Spawn and exit failures are handled by the child events below.
		});
		child.once("error", fail);
		child.once("exit", (code, exitSignal) => {
			if (code !== 0) {
				fail(
					new Error(
						`${command} exited with code ${code} (signal=${exitSignal ?? "none"}): ${stderr.toString("utf8").trim()}`,
					),
				);
				return;
			}
			finish(resolve, { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
		});
		child.stdin.end(options.input);
	});
}

function errorMessage(error) {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function abortReason(signal) {
	return signal?.reason instanceof Error
		? signal.reason
		: new DOMException("benchmark command aborted", "AbortError");
}

function safeText(value) {
	return [...String(value)]
		.filter((character) => {
			const point = character.codePointAt(0);
			return point > 31 && (point < 127 || point > 159);
		})
		.join("");
}

function round(value) {
	return Number(value.toFixed(3));
}
