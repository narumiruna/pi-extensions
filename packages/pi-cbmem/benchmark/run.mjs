#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { prepareDaemon, prepareProjectDiscovery } from "./cbmem-preparation.mjs";
import { parseArguments, printHelp } from "./config.mjs";
import {
	BENCHMARK_ID,
	createSchedule,
	extractLastJson,
	materializeTask,
	sha256,
	summarizeTrials,
} from "./core.mjs";
import {
	assertRepositoryStable,
	prepareFullIndex,
	validateFullIndexMetadata,
} from "./index-preparation.mjs";
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
		materializeTask(task, options.project ?? "<project-to-rebuild>"),
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
			"Permission to start and, when benchmark-owned, stop the Codebase Memory daemon.",
			"Permission to fully rebuild the named Codebase Memory project for --repo.",
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
	let daemonHandle;
	try {
		const binaryPath = await resolveCbmemBinary(options);
		daemonHandle = await prepareDaemon({
			execute: (args, signal) => runDaemonCommand(options, args, signal),
			signal: controller.signal,
		});
		process.stderr.write(
			`Using Codebase Memory daemon PID ${daemonHandle.provenance.pid} before measured trials\n`,
		);
		const repositoryBeforeIndex = await collectRepositoryState(options, controller.signal);
		process.stderr.write("Preparing a fresh full Codebase Memory index before measured trials\n");
		const indexPreparation = await prepareFullIndex({
			callTool: callCbmem,
			options,
			signal: controller.signal,
		});
		const projectDiscovery = await prepareProjectDiscovery({
			callTool: callCbmem,
			options,
			signal: controller.signal,
		});
		const provenance = await collectProvenance(options, binaryPath, controller.signal);
		assertRepositoryStable(
			repositoryBeforeIndex,
			provenance.repository,
			"during unmeasured cbmem setup",
		);
		provenance.daemon = daemonHandle.provenance;
		provenance.projectDiscovery = projectDiscovery;
		provenance.index.preparation = indexPreparation;
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
			provenance.runtimeDrift.checks.daemon = await daemonHandle.verify(controller.signal);
			provenance.runtimeDrift.detected ||= !provenance.runtimeDrift.checks.daemon;
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
		try {
			await daemonHandle?.dispose();
		} finally {
			process.off("SIGINT", cancel);
			process.off("SIGTERM", cancel);
		}
	}
}

function createLiveResult({ exactPayloads, failure, options, provenance, status, tasks, trials }) {
	const summary = summarizeTrials(trials);
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
		summary,
		interpretation: {
			primarySuccessRule:
				"A run must recover every exact fact and obey its arm's retrieval-method policy.",
			tokensPerSuccess:
				"All provider-reported tokens spent by an arm divided by that arm's successful runs.",
			latency:
				"processWallMs includes Pi startup and temporary npm package resolution; agentWallMs begins immediately before the RPC prompt command.",
			cbmemSetup:
				"Daemon startup, full indexing, project discovery, and graph warmup complete before measured trial latency.",
		},
	};
}

async function collectProvenance(options, binaryPath, signal) {
	const processOptions = { cwd: options.repo, signal };
	const [repoRoot, piVersion, cbmemVersion, repository, indexPacket, coveragePacket] =
		await Promise.all([
			realpath(options.repo),
			runText(options.pi, ["--version"], processOptions),
			runText(options.cbmemBin, ["--version"], processOptions),
			collectRepositoryState(options, signal),
			callCbmem(options, "index_status", { project: options.project }, signal),
			callCbmem(options, "check_index_coverage", coverageArguments(options), signal),
		]);
	const index = JSON.parse(indexPacket);
	const coverage = validateFullIndexMetadata(coveragePacket, options.project);
	if (index.status !== "ready")
		throw new Error(`Codebase Memory index is not ready: ${index.status}`);
	if (index.project !== options.project) {
		throw new Error(`indexed project ${index.project} does not match ${options.project}`);
	}
	if ((await realpath(index.root_path)) !== repoRoot) {
		throw new Error(`indexed root ${index.root_path} does not match repository ${repoRoot}`);
	}
	const binary = await readFile(binaryPath);
	return {
		pi: { command: options.pi, version: piVersion.trim() },
		cbmem: {
			path: binaryPath,
			version: cbmemVersion.trim(),
			sha256: createHash("sha256").update(binary).digest("hex"),
		},
		repository: { root: repoRoot, ...repository },
		index: {
			project: index.project,
			status: index.status,
			rootPath: index.root_path,
			nodes: index.nodes,
			edges: index.edges,
			statusSha256: sha256(indexPacket),
			coverage,
		},
	};
}

async function resolveCbmemBinary(options) {
	const [binaryPath, bridgeBinaryPath] = await Promise.all([
		realpath(options.cbmemBin),
		realpath(path.join(homedir(), ".local", "bin", "codebase-memory-mcp")),
	]);
	if (binaryPath !== bridgeBinaryPath) {
		throw new Error(
			`--cbmem-bin resolves to ${binaryPath}, but pi-cbmem invokes ${bridgeBinaryPath}`,
		);
	}
	return binaryPath;
}

async function collectRepositoryState(options, signal) {
	const [gitCommit, gitStatus] = await Promise.all([
		runText("git", ["-C", options.repo, "rev-parse", "HEAD"], { signal }),
		runText("git", ["-C", options.repo, "status", "--short"], { signal }),
	]);
	return {
		gitCommit: gitCommit.trim(),
		dirty: gitStatus.trim().length > 0,
		statusSha256: sha256(gitStatus),
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
	const [gitCommit, gitStatus, indexPacket, coveragePacket] = await Promise.all([
		runText("git", ["-C", options.repo, "rev-parse", "HEAD"], { signal }),
		runText("git", ["-C", options.repo, "status", "--short"], { signal }),
		callCbmem(options, "index_status", { project: options.project }, signal),
		callCbmem(options, "check_index_coverage", coverageArguments(options), signal),
	]);
	const checks = {
		gitCommit: gitCommit.trim() === provenance.repository.gitCommit,
		gitStatus: sha256(gitStatus) === provenance.repository.statusSha256,
		indexStatus: sha256(indexPacket) === provenance.index.statusSha256,
		indexCoverage: sha256(coveragePacket) === provenance.index.coverage.responseSha256,
	};
	return { detected: Object.values(checks).includes(false), checks };
}

function coverageArguments(options) {
	return { project: options.project, scopes: ["."], scope_limit: 1 };
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

async function runDaemonCommand(options, args, signal) {
	return await runText(options.cbmemBin, args, {
		cwd: options.repo,
		env: { ...process.env, CBM_LOG_LEVEL: "error" },
		signal,
		timeoutMs: options.timeoutMs,
	});
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
		measuredTrialsReadOnly: true,
		timeoutMs: options.timeoutMs,
		maxEstimatedCostUsd: options.maxCostUsd,
		cbmemPreparation: {
			daemon: "required-warm",
			projectDiscovery: "unmeasured-once",
			measuredDiscoveryCalls: "forbidden",
		},
		indexPreparation: {
			mode: "full",
			persistence: false,
			includedInTrialLatency: false,
		},
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
