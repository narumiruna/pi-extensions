#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS, parseArguments } from "./config.mjs";
import {
	BENCHMARK_ID,
	buildProbePrompt,
	scoreProbeResponse,
	summarizeBenchmarkTrials,
} from "./core.mjs";
import {
	compactionOrderFor,
	createFixturePlan,
	evaluationOrderFor,
	fixtureMetadata,
	plannedProviderRequests,
} from "./planning.mjs";
import {
	CONSUMED_SEEDS,
	classifyEvidence,
	PROFILES,
	protocolEligibilityDeviations,
} from "./protocol.mjs";
import {
	captureRuntimeInputSnapshot,
	checkRuntimeInputSnapshot,
	collectRuntimeProvenance,
	createImmutableRuntimeSnapshot,
	releaseRuntimeSnapshot,
} from "./provenance.mjs";
import { writeResultFile } from "./result-file.mjs";
import { cloneSessionBranch } from "./session-clone.mjs";

const SYSTEM_PROMPT = [
	"You are a deterministic benchmark recovery agent.",
	"Follow the user's output schema exactly.",
	"Do not use tools.",
	"Do not invent unavailable state.",
].join("\n");
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
	const options = await parseArguments(process.argv.slice(2));
	if (options.help) printHelp();
	else {
		const result = options.live ? await runLiveBenchmark(options) : await createDryRun(options);
		await publishResult(result, options.output);
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Benchmark failed: ${terminalText(message)}\n`);
	process.exitCode = 1;
}

async function createDryRun(benchmarkOptions) {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const plan = createFixturePlan(benchmarkOptions, sdk.estimateTokens);
	const profile = PROFILES[benchmarkOptions.profile];
	const runtimeInputSnapshot = await captureRuntimeInputSnapshot({
		packageRoot: PACKAGE_ROOT,
		protocol: benchmarkOptions.protocol,
	});
	const provenance = await collectRuntimeProvenance(
		PACKAGE_ROOT,
		benchmarkOptions.protocol?.path,
		runtimeInputSnapshot,
	);
	const planningDeviations = benchmarkOptions.protocol
		? [
				...protocolEligibilityDeviations(benchmarkOptions.protocol.manifest),
				...(provenance.trackedBenchmarkChangesPresent === false
					? []
					: ["Tracked benchmark cleanliness is unavailable or dirty."]),
				...(provenance.protocolManifestTrackedAtSourceRevision === true
					? []
					: ["The protocol manifest is not unchanged and tracked at the source revision."]),
			]
		: ["No locked protocol manifest was supplied."];
	const protocolPlanConformant =
		Boolean(benchmarkOptions.protocol) && planningDeviations.length === 0;
	return {
		benchmark: BENCHMARK_ID,
		mode: "dry-run",
		createdAt: new Date().toISOString(),
		note: "No provider request was made. Pass --live to execute the quota-consuming benchmark.",
		config: publicConfig(benchmarkOptions, profile),
		planningEvidence: {
			classification: protocolPlanConformant ? "confirmatory-plan" : "diagnostic-plan",
			protocolConformant: protocolPlanConformant,
			...(benchmarkOptions.protocol
				? {
						protocolSha256: benchmarkOptions.protocol.sha256,
						deviations: planningDeviations,
					}
				: { deviations: planningDeviations }),
			humanPrimaryClaim: false,
		},
		provenance,
		fixtures: plan.map((entry) => entry.metadata),
		plannedProviderRequests: plannedProviderRequests(benchmarkOptions, plan.length),
		requestBreakdownPerFixture: {
			compactionRepetitions: benchmarkOptions.compactionRepetitions,
			piNativeCompactions: benchmarkOptions.compactionRepetitions,
			codexRemoteCompactions: benchmarkOptions.compactionRepetitions,
			fullContextQualityProbes:
				benchmarkOptions.compactionRepetitions * benchmarkOptions.probesPerArtifact,
			piNativeQualityProbes:
				benchmarkOptions.compactionRepetitions * benchmarkOptions.probesPerArtifact,
			codexRemoteQualityProbes:
				benchmarkOptions.compactionRepetitions * benchmarkOptions.probesPerArtifact,
		},
		costWarning:
			"USD values are Pi model-catalog estimates from returned usage, not an OpenAI subscription invoice. Live cost is unknown until requests finish.",
	};
}

async function runLiveBenchmark(benchmarkOptions) {
	const sourceAgentDir = resolveAgentDir(benchmarkOptions.agentDir);
	const authPath = path.join(sourceAgentDir, "auth.json");
	if (!existsSync(authPath)) {
		throw new Error(`OpenAI Codex credentials were not found at ${authPath}`);
	}
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-codex-compact-benchmark-"));
	const temporaryAgentDir = path.join(temporaryRoot, "agent");
	const profile = PROFILES[benchmarkOptions.profile];
	try {
		await mkdir(temporaryAgentDir, { recursive: true });
		await writeFile(
			path.join(temporaryAgentDir, "pi-codex-compact.json"),
			`${JSON.stringify(
				{
					enabled: true,
					requestTimeoutMs: benchmarkOptions.timeoutMs,
					maxRetries: 0,
					replacementTokenBudget: profile.codexReplacementTokenBudget,
					notifyOnFallback: false,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	} catch (error) {
		await rm(temporaryRoot, { recursive: true, force: true });
		throw error;
	}

	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporaryAgentDir;
	const activeSessions = new Set();
	let runtimeInputSnapshot;
	let cancelled = false;
	const lifecycleController = new AbortController();
	const cancel = () => {
		cancelled = true;
		lifecycleController.abort();
		for (const session of activeSessions) {
			session.abortCompaction();
			void session.abort().catch(() => undefined);
		}
	};
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const sdk = await import("@earendil-works/pi-coding-agent");
		if (cancelled) throw new Error("cancelled");
		const modelsPath = path.join(sourceAgentDir, "models.json");
		const modelRuntime = await sdk.ModelRuntime.create({
			authPath,
			modelsPath: existsSync(modelsPath) ? modelsPath : null,
			signal: lifecycleController.signal,
		});
		if (cancelled) throw new Error("cancelled");
		const model = modelRuntime.getModel("openai-codex", benchmarkOptions.model);
		if (!model) throw new Error(`Unknown openai-codex model: ${benchmarkOptions.model}`);
		if (model.api !== "openai-codex-responses") {
			throw new Error(`${model.provider}/${model.id} does not use openai-codex-responses`);
		}
		if (!modelRuntime.hasConfiguredAuth("openai-codex")) {
			throw new Error("OpenAI Codex OAuth is not configured; run /login openai-codex in Pi");
		}
		const fixturePlan = createFixturePlan(benchmarkOptions, sdk.estimateTokens);
		const fixtures = fixturePlan.map((entry) => entry.fixture);
		for (const fixture of fixtures) {
			assertFixtureIntegrity(fixture);
			if (fixture.estimatedTokens + 16_384 >= model.contextWindow) {
				throw new Error(
					`Fixture ${fixture.id} leaves too little room in the ${model.contextWindow}-token model context`,
				);
			}
		}
		runtimeInputSnapshot = await createImmutableRuntimeSnapshot({
			packageRoot: PACKAGE_ROOT,
			protocol: benchmarkOptions.protocol,
			snapshotRoot: path.join(temporaryRoot, "runtime-snapshot"),
		});
		const provenance = await collectRuntimeProvenance(
			PACKAGE_ROOT,
			benchmarkOptions.protocol?.path,
			runtimeInputSnapshot,
		);
		const trials = [];
		let stopReason = "completed";
		for (let index = 0; index < fixtures.length; index += 1) {
			if (cancelled) throw new Error("cancelled");
			await revalidateRuntimeInputs({
				boundary: `before-fixture-${index + 1}`,
				provenance,
				runtimeInputSnapshot,
			});
			const recordedCost = trials.reduce((total, trial) => total + trial.recordedCostUsd, 0);
			if (trials.length > 0 && recordedCost >= benchmarkOptions.maxCostUsd) {
				stopReason = "estimated-cost-guard";
				break;
			}
			const fixture = fixtures[index];
			process.stderr.write(
				`[fixture ${index + 1}/${fixtures.length}] ${fixture.id}; ` +
					`records=${fixture.authoritativeRecords}; questions=${fixture.questions.length}; ` +
					`repetitions=${benchmarkOptions.compactionRepetitions}\n`,
			);
			const trial = await runTrial({
				activeSessions,
				benchmarkOptions,
				fixture,
				isCancelled: () => cancelled,
				model,
				modelRuntime,
				profile,
				extensionEntry: runtimeInputSnapshot.extensionEntry,
				sdk,
				signal: lifecycleController.signal,
				temporaryAgentDir,
				trialIndex: index,
			});
			trials.push(trial);
			await revalidateRuntimeInputs({
				boundary: `checkpoint-after-fixture-${index + 1}`,
				provenance,
				runtimeInputSnapshot,
			});
			if (benchmarkOptions.output) {
				await writeResultFile(
					benchmarkOptions.output,
					createLiveResult({
						benchmarkOptions,
						fixtures,
						model,
						profile,
						provenance,
						stopReason: "in-progress",
						trials,
					}),
				);
			}
		}
		if (trials.length === 0) throw new Error("no benchmark trial completed");
		await revalidateRuntimeInputs({
			boundary: "before-final-classification",
			provenance,
			runtimeInputSnapshot,
		});
		return createLiveResult({
			benchmarkOptions,
			fixtures,
			model,
			profile,
			provenance,
			stopReason,
			trials,
		});
	} finally {
		await Promise.allSettled(
			[...activeSessions].map((session) => closeSession(session, activeSessions)),
		);
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await releaseRuntimeSnapshot(runtimeInputSnapshot);
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function revalidateRuntimeInputs({ boundary, provenance, runtimeInputSnapshot }) {
	const check = await checkRuntimeInputSnapshot(runtimeInputSnapshot);
	const runtimeInputs = provenance.runtimeInputs;
	if (!runtimeInputs) throw new Error("runtime input provenance is unavailable");
	runtimeInputs.validationCount = (runtimeInputs.validationCount ?? 0) + 1;
	if (check.clean) return;
	const previousFiles = new Set(runtimeInputs.changedFiles);
	const changedFiles = [...new Set([...previousFiles, ...check.changedFiles])].sort();
	const newlyChanged = changedFiles.filter((file) => !previousFiles.has(file));
	runtimeInputs.driftDetected = true;
	runtimeInputs.changedFiles = changedFiles;
	runtimeInputs.firstDetectedBoundary ??= boundary;
	if (newlyChanged.length > 0 || runtimeInputs.validationCount === 1) {
		process.stderr.write(
			`Runtime input drift detected at ${terminalText(boundary)}; ` +
				`evidence will remain diagnostic: ${terminalText(check.changedFiles.join(", "))}\n`,
		);
	}
}

function createLiveResult({
	benchmarkOptions,
	fixtures,
	model,
	profile,
	provenance,
	stopReason,
	trials,
}) {
	const summary = summarizeBenchmarkTrials(trials, {
		evaluatorDisagreementThreshold: benchmarkOptions.evaluatorDisagreementThreshold,
	});
	const evidence = classifyEvidence({
		protocol: benchmarkOptions.protocol?.manifest,
		options: benchmarkOptions,
		status: stopReason,
		fullContextPassed: summary.fullContextControl.passed,
		evaluatorPassed: summary.evaluatorReliability.passed,
		sourceClean:
			provenance.trackedBenchmarkChangesPresent === false &&
			(!benchmarkOptions.protocol || provenance.protocolManifestTrackedAtSourceRevision === true) &&
			provenance.runtimeInputs?.driftDetected === false,
	});
	return {
		benchmark: BENCHMARK_ID,
		mode: "live",
		status: stopReason,
		measuredAt: new Date().toISOString(),
		config: {
			...publicConfig(benchmarkOptions, profile),
			provider: model.provider,
			api: model.api,
			contextWindow: model.contextWindow,
			modelCostRatesPerMillionTokens: model.cost,
			retries: {
				piSummarizationRetries: 0,
				providerRetries: 0,
				codexRemoteRetries: 0,
			},
			transport: "sse",
			systemPromptSha256: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
		},
		provenance,
		plannedFixtures: fixtures.length,
		completedFixtures: trials.length,
		fixtures: fixtures.map(fixtureMetadata),
		costSemantics:
			"usage.cost uses Pi's current model catalog and is an estimate, not an OpenAI subscription invoice.",
		qualitySemantics:
			"Scoring and fixtures are deterministic, but model compactions and probes are not. Question totals are descriptive; seed-level paired deltas are the independent comparison.",
		retentionSemantics: {
			comparison: "nominal-setting-alignment",
			equalInformationCapacity: false,
			note: "Pi retains all-role recent messages while Codex retains approximate user text plus an opaque item.",
		},
		evidence,
		trials,
		summary,
	};
}

async function runTrial(input) {
	const {
		activeSessions,
		benchmarkOptions,
		fixture,
		isCancelled,
		model,
		modelRuntime,
		profile,
		extensionEntry,
		sdk,
		signal,
		temporaryAgentDir,
		trialIndex,
	} = input;
	const arms = {
		full: { probes: [] },
		native: { artifacts: [] },
		codex: { artifacts: [] },
	};
	const requestOrder = [];
	let providerRequestStarted = false;
	const spaceProviderRequest = async () => {
		if (providerRequestStarted) await requestDelay(benchmarkOptions.requestDelayMs, signal);
		providerRequestStarted = true;
	};
	const densityPosition = benchmarkOptions.densities.indexOf(fixture.density);
	for (
		let repetitionIndex = 0;
		repetitionIndex < benchmarkOptions.compactionRepetitions;
		repetitionIndex += 1
	) {
		if (isCancelled()) throw new Error("cancelled");
		const compactionOrder = compactionOrderFor(
			densityPosition,
			repetitionIndex,
			benchmarkOptions.compactionRepetitions,
		);
		const snapshots = {};
		for (let orderPosition = 0; orderPosition < compactionOrder.length; orderPosition += 1) {
			const arm = compactionOrder[orderPosition];
			const state = await createBenchmarkSession({
				activeSessions,
				arm,
				benchmarkOptions,
				fixture,
				isCancelled,
				model,
				modelRuntime,
				profile,
				extensionEntry,
				sdk,
				temporaryAgentDir,
			});
			try {
				await spaceProviderRequest();
				process.stderr.write(
					`  compacting ${arm} repetition ${repetitionIndex + 1} on ${terminalText(model.id)}\n`,
				);
				requestOrder.push({
					type: "compaction",
					arm,
					repetition: repetitionIndex + 1,
					position: orderPosition + 1,
				});
				const compaction = await compactArm({ arm, isCancelled, sessionState: state });
				const artifact = {
					repetition: repetitionIndex + 1,
					compactionOrderPosition: orderPosition + 1,
					checkpoint: compaction.checkpoint,
					compaction: compaction.metrics,
					probes: [],
				};
				arms[arm].artifacts.push(artifact);
				snapshots[arm] = {
					artifact,
					entries: structuredClone(state.session.sessionManager.getBranch()),
				};
			} finally {
				await closeSession(state.session, activeSessions);
			}
		}

		for (let probeIndex = 0; probeIndex < benchmarkOptions.probesPerArtifact; probeIndex += 1) {
			const evaluationOrder = evaluationOrderFor(
				densityPosition,
				repetitionIndex,
				benchmarkOptions.compactionRepetitions,
				probeIndex,
				benchmarkOptions.probesPerArtifact,
			);
			for (let orderPosition = 0; orderPosition < evaluationOrder.length; orderPosition += 1) {
				const arm = evaluationOrder[orderPosition];
				const state = await createBenchmarkSession({
					activeSessions,
					arm,
					benchmarkOptions,
					branchEntries: arm === "full" ? undefined : snapshots[arm].entries,
					fixture,
					isCancelled,
					model,
					modelRuntime,
					profile,
					extensionEntry,
					sdk,
					temporaryAgentDir,
				});
				try {
					await spaceProviderRequest();
					process.stderr.write(
						`  probing ${arm} repetition ${repetitionIndex + 1}.${probeIndex + 1} on ${terminalText(model.id)}\n`,
					);
					requestOrder.push({
						type: "quality-probe",
						arm,
						repetition: repetitionIndex + 1,
						probeRepetition: probeIndex + 1,
						position: orderPosition + 1,
					});
					const evaluation = await probeArm({
						arm,
						fixture,
						isCancelled,
						probeThinking: benchmarkOptions.probeThinking,
						sessionState: state,
					});
					const sample = {
						repetition: repetitionIndex + 1,
						probeRepetition: probeIndex + 1,
						evaluationOrderPosition: orderPosition + 1,
						probe: evaluation.probe,
						quality: evaluation.quality,
					};
					if (arm === "full") {
						arms.full.probes.push({
							...sample,
							total: {
								latencyMs: evaluation.probe.latencyMs,
								costUsd: evaluation.probe.costUsd,
							},
						});
					} else {
						const artifact = snapshots[arm].artifact;
						artifact.probes.push({
							...sample,
							total: {
								latencyMs: round(artifact.compaction.latencyMs + evaluation.probe.latencyMs),
								costUsd: round(artifact.compaction.costUsd + evaluation.probe.costUsd),
							},
						});
					}
				} finally {
					await closeSession(state.session, activeSessions);
				}
			}
		}
	}
	const trial = {
		trial: trialIndex + 1,
		fixture: fixtureMetadata(fixture),
		requestOrder,
		arms,
	};
	return { ...trial, recordedCostUsd: round(trialCost(trial)) };
}

async function createBenchmarkSession(input) {
	const {
		activeSessions,
		arm,
		benchmarkOptions,
		branchEntries,
		fixture,
		isCancelled,
		model,
		modelRuntime,
		profile,
		extensionEntry,
		sdk,
		temporaryAgentDir,
	} = input;
	const sessionManager = branchEntries
		? cloneSessionBranch(sdk, branchEntries, PACKAGE_ROOT)
		: sdk.SessionManager.inMemory(PACKAGE_ROOT);
	if (!branchEntries) {
		sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange(benchmarkOptions.compactionThinking);
		for (const message of fixture.messages) sessionManager.appendMessage(structuredClone(message));
	}
	const settingsManager = sdk.SettingsManager.inMemory({
		transport: "sse",
		compaction: {
			enabled: false,
			reserveTokens: 16_384,
			keepRecentTokens: profile.piKeepRecentTokens,
		},
		retry: {
			enabled: false,
			maxRetries: 0,
			provider: {
				timeoutMs: benchmarkOptions.timeoutMs,
				maxRetries: 0,
				maxRetryDelayMs: 0,
			},
		},
	});
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd: PACKAGE_ROOT,
		agentDir: temporaryAgentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: arm === "codex" ? [extensionEntry] : [],
		systemPromptOverride: () => SYSTEM_PROMPT,
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();
	if (isCancelled()) throw new Error("cancelled");
	const loadErrors = resourceLoader.getExtensions().errors;
	if (loadErrors.length > 0) {
		throw new Error(
			`Could not load benchmark extensions: ${loadErrors.map((error) => `${error.path}: ${error.error}`).join("; ")}`,
		);
	}
	let session;
	try {
		({ session } = await sdk.createAgentSession({
			cwd: PACKAGE_ROOT,
			agentDir: temporaryAgentDir,
			model,
			thinkingLevel: benchmarkOptions.compactionThinking,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager,
			noTools: "all",
		}));
		activeSessions.add(session);
		if (isCancelled()) throw new Error("cancelled");
		const extensionErrors = [];
		await session.bindExtensions({
			mode: "json",
			onError: (error) => extensionErrors.push(error),
		});
		if (isCancelled()) throw new Error("cancelled");
		return { extensionErrors, session };
	} catch (error) {
		if (session) await closeSession(session, activeSessions);
		throw error;
	}
}

async function compactArm({ arm, isCancelled, sessionState }) {
	const { extensionErrors, session } = sessionState;
	assertSessionReady({ arm, extensionErrors, isCancelled, operation: "compaction" });
	const started = performance.now();
	const compaction = await session.compact();
	const latencyMs = performance.now() - started;
	assertSessionReady({ arm, extensionErrors, isCancelled, operation: "compaction" });
	const isCodexCheckpoint =
		compaction.details?.kind === "pi-codex-remote-compaction" &&
		compaction.details?.protocol === "remote-v2";
	if (arm === "codex" && !isCodexCheckpoint) {
		throw new Error(
			"Codex arm did not produce a Remote V2 checkpoint; refusing to report a Pi fallback as Codex",
		);
	}
	if (arm === "native" && isCodexCheckpoint) {
		throw new Error("Native arm unexpectedly produced a Codex checkpoint");
	}
	const usage = requireUsage(compaction.usage, `${arm} compaction`);
	return {
		checkpoint: checkpointMetrics(compaction, isCodexCheckpoint),
		metrics: {
			latencyMs: round(latencyMs),
			tokensBefore: compaction.tokensBefore,
			estimatedTokensAfter: compaction.estimatedTokensAfter ?? 0,
			inputTokens: inputTokens(usage),
			outputTokens: usage.output,
			costUsd: round(usageCost(usage)),
			usage,
		},
	};
}

async function probeArm({ arm, fixture, isCancelled, probeThinking, sessionState }) {
	const { extensionErrors, session } = sessionState;
	assertSessionReady({ arm, extensionErrors, isCancelled, operation: "quality probe" });
	session.setThinkingLevel(probeThinking);
	const messageCountBefore = session.messages.length;
	const started = performance.now();
	await session.prompt(buildProbePrompt(fixture.questions), { source: "rpc" });
	const latencyMs = performance.now() - started;
	assertSessionReady({ arm, extensionErrors, isCancelled, operation: "quality probe" });
	const probeMessage = session.messages
		.slice(messageCountBefore)
		.reverse()
		.find((message) => message.role === "assistant");
	if (probeMessage?.role !== "assistant") {
		throw new Error(`${arm} quality probe produced no assistant message`);
	}
	if (probeMessage.stopReason === "error" || probeMessage.stopReason === "aborted") {
		throw new Error(
			`${arm} quality probe ended with ${probeMessage.stopReason}: ${probeMessage.errorMessage ?? "unknown error"}`,
		);
	}
	const text = probeMessage.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const usage = requireUsage(probeMessage.usage, `${arm} quality probe`);
	return {
		probe: {
			latencyMs: round(latencyMs),
			inputTokens: inputTokens(usage),
			outputTokens: usage.output,
			costUsd: round(usageCost(usage)),
			stopReason: probeMessage.stopReason,
			responseTextBytes: Buffer.byteLength(text, "utf8"),
			responseTextSha256: createHash("sha256").update(text).digest("hex"),
			usage,
		},
		quality: scoreProbeResponse(text, fixture.questions),
	};
}

function assertSessionReady({ arm, extensionErrors, isCancelled, operation }) {
	if (isCancelled()) throw new Error("cancelled");
	if (extensionErrors.length > 0) {
		throw new Error(
			`Extension error during ${arm} ${operation}: ${formatExtensionErrors(extensionErrors)}`,
		);
	}
}

async function closeSession(session, activeSessions) {
	if (!session || !activeSessions.has(session)) return;
	try {
		session.abortCompaction();
		if (session.isStreaming) await session.abort().catch(() => undefined);
		await session.extensionRunner
			.emit({ type: "session_shutdown", reason: "quit" })
			.catch(() => undefined);
	} finally {
		try {
			session.dispose();
		} finally {
			activeSessions.delete(session);
		}
	}
}

function checkpointMetrics(compaction, isCodexCheckpoint) {
	const summaryBytes = Buffer.byteLength(compaction.summary, "utf8");
	if (!isCodexCheckpoint) return { kind: "pi-native-plaintext", summaryBytes };
	const history = compaction.details.replacementHistory;
	const opaque = history.at(-1);
	return {
		kind: "codex-remote-v2",
		summaryBytes,
		replacementItems: history.length,
		retainedPlaintextItems: Math.max(0, history.length - 1),
		replacementBytes: Buffer.byteLength(JSON.stringify(history), "utf8"),
		opaqueItemBytes: Buffer.byteLength(JSON.stringify(opaque), "utf8"),
		opaqueItemSha256: createHash("sha256").update(JSON.stringify(opaque)).digest("hex"),
	};
}

function requireUsage(usage, label) {
	if (!usage || typeof usage !== "object") throw new Error(`${label} returned no usage`);
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
		if (typeof usage[field] !== "number" || !Number.isFinite(usage[field])) {
			throw new Error(`${label} returned invalid usage.${field}`);
		}
	}
	if (typeof usage.cost?.total !== "number" || !Number.isFinite(usage.cost.total)) {
		throw new Error(`${label} returned invalid usage.cost.total`);
	}
	return structuredClone(usage);
}

function inputTokens(usage) {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function usageCost(usage) {
	return usage.cost.total;
}

function formatExtensionErrors(errors) {
	return errors
		.map((error) =>
			typeof error === "object" && error !== null && "error" in error
				? String(error.error)
				: String(error),
		)
		.join("; ");
}

function assertFixtureIntegrity(fixture) {
	const userText = fixture.messages
		.filter((message) => message.role === "user")
		.map((message) => message.content)
		.join("\n");
	const serializedMessages = JSON.stringify(fixture.messages);
	for (const question of fixture.questions) {
		if (userText.includes(question.expected)) {
			throw new Error(`${fixture.id} leaks ${question.id}'s answer into historical user text`);
		}
		if (serializedMessages.includes(question.question)) {
			throw new Error(`${fixture.id} includes ${question.id}'s question before compaction`);
		}
	}
}

function publicConfig(benchmarkOptions, profile) {
	return {
		model: benchmarkOptions.model,
		suite: benchmarkOptions.suite,
		seeds: benchmarkOptions.seeds,
		densities: benchmarkOptions.densities,
		questionsPerCategory: benchmarkOptions.questionsPerCategory,
		epochs: benchmarkOptions.epochs,
		profile: benchmarkOptions.profile,
		fixtureTargetTokens: benchmarkOptions.fixtureTokens,
		contextRegime: benchmarkOptions.contextRegime,
		requestTimeoutMs: benchmarkOptions.timeoutMs,
		requestDelayMs: benchmarkOptions.requestDelayMs,
		maxEstimatedCostUsd: benchmarkOptions.maxCostUsd,
		compactionThinkingLevel: benchmarkOptions.compactionThinking,
		probeThinkingLevel: benchmarkOptions.probeThinking,
		compactionRepetitions: benchmarkOptions.compactionRepetitions,
		probesPerArtifact: benchmarkOptions.probesPerArtifact,
		evaluatorDisagreementThreshold: benchmarkOptions.evaluatorDisagreementThreshold,
		piKeepRecentTokens: profile.piKeepRecentTokens,
		codexReplacementTokenBudget: profile.codexReplacementTokenBudget,
		compactionOrder: "balanced within each complete seed block",
		evaluationOrder: "three-way rotation within each complete seed block",
		toolsDuringProbe: [],
		consumedSeedsUsed: benchmarkOptions.seeds.filter((seed) => CONSUMED_SEEDS.includes(seed)),
		suiteDefaultsUsed: benchmarkOptions.suiteDefaultsUsed,
		studyDesign: benchmarkOptions.protocol
			? benchmarkOptions.contextRegime === "controlled-manual-50k"
				? "Locked confirmatory-candidate protocol; human held-out provenance is not asserted by the runner."
				: "Locked diagnostic context-scale protocol."
			: benchmarkOptions.profile === "matched-tail"
				? "Diagnostic nominal 20K retained-setting comparison."
				: "Diagnostic shipped retention-policy comparison.",
		...(benchmarkOptions.protocol
			? {
					protocol: {
						id: benchmarkOptions.protocol.manifest.protocolId,
						sha256: benchmarkOptions.protocol.sha256,
						manifest: benchmarkOptions.protocol.manifest,
					},
				}
			: {}),
	};
}

function trialCost(trial) {
	let total = trial.arms.full.probes.reduce((sum, probe) => sum + (probe.probe?.costUsd ?? 0), 0);
	for (const arm of ["native", "codex"]) {
		for (const artifact of trial.arms[arm].artifacts) {
			total += artifact.compaction.costUsd;
			total += artifact.probes.reduce((sum, probe) => sum + (probe.probe?.costUsd ?? 0), 0);
		}
	}
	return total;
}

async function requestDelay(milliseconds, signal) {
	if (milliseconds === 0) return;
	await delay(milliseconds, undefined, { signal });
}

async function publishResult(value, outputPath) {
	if (outputPath) {
		await writeResultFile(outputPath, value);
		process.stderr.write(`Wrote benchmark result to ${terminalText(path.resolve(outputPath))}\n`);
	}
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function resolveAgentDir(input) {
	const raw = input ?? process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
	if (raw === "~") return homedir();
	if (raw.startsWith(`~${path.sep}`)) return path.join(homedir(), raw.slice(2));
	return path.resolve(raw);
}

function printHelp() {
	process.stdout.write("Usage: node packages/pi-codex-compact/benchmark/run.mjs [options]\n\n");
	process.stdout.write("Without --live, the command performs a zero-network dry run.\n\n");
	process.stdout.write(
		"  --live                              Execute provider calls and consume quota or billable usage.\n",
	);
	process.stdout.write(
		"  --protocol <path>                   Lock confirmatory controls from a validated manifest.\n",
	);
	process.stdout.write("  --model <id>                        OpenAI Codex model.\n");
	process.stdout.write(
		"  --suite <name>                      exploratory, calibration, or confirmatory.\n",
	);
	process.stdout.write(
		"  --seeds <csv>                       Override deterministic diagnostic seeds.\n",
	);
	process.stdout.write("  --densities <csv>                   Override records per category.\n");
	process.stdout.write(
		"  --questions-per-category <n>        Override scored questions per category.\n",
	);
	process.stdout.write("  --epochs <n>                        History epochs from 2 to 20.\n");
	process.stdout.write("  --profile <name>                    production or matched-tail.\n");
	process.stdout.write("  --fixture-tokens <count>            Fixed history target.\n");
	process.stdout.write(
		"  --context-regime <name>             Manual-50K or context-scale claim scope.\n",
	);
	process.stdout.write("  --compaction-thinking <level>       Compaction thinking level.\n");
	process.stdout.write("  --probe-thinking <level>            Evaluation thinking level.\n");
	process.stdout.write(
		"  --repetitions <n>                   Independent artifacts per arm and fixture.\n",
	);
	process.stdout.write(
		"  --probes-per-artifact <n>           Isolated probes per artifact and full context.\n",
	);
	process.stdout.write(
		"  --evaluator-disagreement-threshold  Maximum exact-answer disagreement rate.\n",
	);
	process.stdout.write(
		"  --max-cost-usd <amount>             Between-fixture estimated-cost guard.\n",
	);
	process.stdout.write("  --request-delay-ms <ms>             Delay between requests.\n");
	process.stdout.write(
		`  --timeout-ms <ms>                   Per-request timeout (default: ${DEFAULT_TIMEOUT_MS}).\n`,
	);
	process.stdout.write("  --agent-dir <path>                  Source Pi auth/models directory.\n");
	process.stdout.write(
		"  --output <path>                     Atomically checkpoint JSON results.\n",
	);
	process.stdout.write("  -h, --help                          Show this help.\n");
}

function terminalText(value) {
	return [...String(value)]
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint > 31 && (codePoint < 127 || codePoint > 159);
		})
		.join("");
}

function round(value) {
	return Number(value.toFixed(6));
}
