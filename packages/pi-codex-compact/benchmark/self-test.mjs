#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArguments } from "./config.mjs";
import {
  BENCHMARK_ID,
  buildProbePrompt,
  CATEGORIES,
  createBenchmarkFixture,
  scoreProbeResponse,
  summarizeBenchmarkTrials,
  summarizeNumbers,
} from "./core.mjs";
import { compactionOrderFor, createFixturePlan, evaluationOrderFor, plannedProviderRequests } from "./planning.mjs";
import {
  CONSUMED_SEEDS,
  classifyEvidence,
  PROFILES,
  protocolDeviations,
  protocolEligibilityDeviations,
  protocolSha256,
  validateProtocolManifest,
} from "./protocol.mjs";
import {
  checkRuntimeInputSnapshot,
  createImmutableRuntimeSnapshot,
  publicRuntimeInputSnapshot,
  releaseRuntimeSnapshot,
} from "./provenance.mjs";
import { writeResultFile } from "./result-file.mjs";
import { cloneSessionBranch } from "./session-clone.mjs";

assert.equal(BENCHMARK_ID, "pi-codex-compact-comparison:v3");
assert.deepEqual(PROFILES["matched-tail"], {
  piKeepRecentTokens: 20_000,
  codexReplacementTokenBudget: 20_000,
});
assert.deepEqual(PROFILES.production, {
  piKeepRecentTokens: 20_000,
  codexReplacementTokenBudget: 64_000,
});
assert.deepEqual(CONSUMED_SEEDS, [301, 302, 303, 304]);

const protocolInput = {
  schemaVersion: 1,
  protocolId: "matched-tail-confirmatory-v3-test",
  benchmarkId: BENCHMARK_ID,
  createdAt: "2026-08-14T00:00:00.000Z",
  calibrationEvidenceSha256: "a".repeat(64),
  model: "gpt-5.6-sol",
  profile: "matched-tail",
  seeds: [901, 902, 903, 904, 905, 906, 907, 908],
  densities: [180, 200],
  questionsPerCategory: 15,
  epochs: 10,
  fixtureTargetTokens: 50_000,
  compactionThinkingLevel: "medium",
  probeThinkingLevel: "low",
  compactionRepetitions: 3,
  probesPerArtifact: 1,
  evaluatorDisagreementThreshold: 0.02,
  contextRegime: "controlled-manual-50k",
};
const protocol = validateProtocolManifest(protocolInput);
assert.deepEqual(protocol, protocolInput);
assert.equal(protocolSha256(protocol), protocolSha256(structuredClone(protocolInput)));
assert.throws(() => validateProtocolManifest({ ...protocolInput, unexpected: true }), /unknown field: unexpected/);
assert.throws(
  () => validateProtocolManifest({ ...protocolInput, schemaVersion: 2 }),
  /unsupported protocol schemaVersion/,
);
assert.throws(
  () => validateProtocolManifest({ ...protocolInput, createdAt: "2026-02-30T00:00:00.000Z" }),
  /createdAt is invalid/,
);
assert.throws(
  () => validateProtocolManifest({ ...protocolInput, densities: [10, 20] }),
  /questionsPerCategory cannot exceed/,
);
assert.throws(() => validateProtocolManifest({ ...protocolInput, seeds: [901, 901] }), /duplicate seed/);
assert.throws(() => validateProtocolManifest({ ...protocolInput, seeds: [301, 901] }), /consumed seed: 301/);
assert.throws(() => validateProtocolManifest({ ...protocolInput, seeds: [901, 902] }), /at least 8 fresh seeds/);
assert.throws(
  () => validateProtocolManifest({ ...protocolInput, fixtureTargetTokens: 180_000 }),
  /controlled-manual-50k requires fixtureTargetTokens to equal 50000/,
);
const contextScaleProtocol = validateProtocolManifest({
  ...protocolInput,
  fixtureTargetTokens: 180_000,
  contextRegime: "context-scale-diagnostic",
});
assert.deepEqual(protocolEligibilityDeviations(protocol), []);
assert.deepEqual(protocolEligibilityDeviations(contextScaleProtocol), [
  "The context-scale regime is diagnostic and cannot support confirmatory evidence.",
]);
const protocolOptions = {
  model: protocol.model,
  profile: protocol.profile,
  seeds: protocol.seeds,
  densities: protocol.densities,
  questionsPerCategory: protocol.questionsPerCategory,
  epochs: protocol.epochs,
  fixtureTokens: protocol.fixtureTargetTokens,
  compactionThinking: protocol.compactionThinkingLevel,
  probeThinking: protocol.probeThinkingLevel,
  compactionRepetitions: protocol.compactionRepetitions,
  probesPerArtifact: protocol.probesPerArtifact,
  evaluatorDisagreementThreshold: protocol.evaluatorDisagreementThreshold,
  contextRegime: protocol.contextRegime,
};
assert.deepEqual(protocolDeviations(protocol, protocolOptions), []);
assert.match(protocolDeviations(protocol, { ...protocolOptions, densities: [15, 16] }).join("; "), /densities/);
assert.deepEqual(
  classifyEvidence({
    protocol,
    options: protocolOptions,
    status: "completed",
    fullContextPassed: true,
    evaluatorPassed: true,
  }),
  {
    classification: "confirmatory-candidate",
    protocolConformant: true,
    protocolSha256: protocolSha256(protocol),
    humanPrimaryClaim: false,
    deviations: [],
  },
);
assert.equal(
  classifyEvidence({
    options: protocolOptions,
    status: "completed",
    fullContextPassed: true,
    evaluatorPassed: true,
  }).classification,
  "diagnostic",
);
assert.equal(
  classifyEvidence({
    protocol,
    options: protocolOptions,
    status: "completed",
    fullContextPassed: true,
    evaluatorPassed: true,
    sourceClean: false,
  }).classification,
  "diagnostic",
);
const contextScaleOptions = {
  ...protocolOptions,
  fixtureTokens: contextScaleProtocol.fixtureTargetTokens,
  contextRegime: contextScaleProtocol.contextRegime,
};
const contextScaleEvidence = classifyEvidence({
  protocol: contextScaleProtocol,
  options: contextScaleOptions,
  status: "completed",
  fullContextPassed: true,
  evaluatorPassed: true,
});
assert.equal(contextScaleEvidence.protocolConformant, false);
assert.equal(contextScaleEvidence.classification, "diagnostic");
assert.deepEqual(contextScaleEvidence.deviations, protocolEligibilityDeviations(contextScaleProtocol));

const protocolArguments = await parseArguments(["--protocol", "protocol.json"], {
  readProtocol: async () => protocolInput,
});
assert.deepEqual(protocolArguments.seeds, protocol.seeds);
assert.deepEqual(protocolArguments.densities, protocol.densities);
assert.equal(protocolArguments.compactionRepetitions, 3);
assert.equal(protocolArguments.protocol.sha256, protocolSha256(protocol));
await assert.rejects(
  parseArguments(["--protocol", "protocol.json", "--densities", "180,200"], {
    readProtocol: async () => protocolInput,
  }),
  /locked option cannot be combined with --protocol: --densities/,
);
const diagnosticArguments = await parseArguments(["--suite", "confirmatory", "--densities", "15,16"]);
assert.equal(diagnosticArguments.protocol, undefined);
assert.equal(diagnosticArguments.suiteDefaultsUsed, false);

const fixtureOptions = {
  seed: 301,
  density: 120,
  targetTokens: 50_000,
  questionsPerCategory: 10,
  epochs: 10,
};
const fixture = createBenchmarkFixture(fixtureOptions);
const repeated = createBenchmarkFixture(fixtureOptions);
const differentSeed = createBenchmarkFixture({ ...fixtureOptions, seed: 302 });
const planOptions = {
  seeds: [301, 302],
  densities: [120, 160],
  fixtureTokens: 50_000,
  questionsPerCategory: 10,
  epochs: 10,
  compactionRepetitions: 3,
  probesPerArtifact: 1,
};
const deterministicEstimator = (message) => Math.ceil(JSON.stringify(message).length / 5);
const dryPlan = createFixturePlan(planOptions, deterministicEstimator);
const injectedLivePlan = createFixturePlan(planOptions, deterministicEstimator);
assert.deepEqual(
  dryPlan.map((entry) => entry.metadata),
  injectedLivePlan.map((entry) => entry.metadata),
);
assert.equal(plannedProviderRequests(planOptions, dryPlan.length), 60);
const compactionFirst = { native: 0, codex: 0 };
const evaluationPositions = Object.fromEntries(["full", "native", "codex"].map((arm) => [arm, [0, 0, 0]]));
for (let densityPosition = 0; densityPosition < 2; densityPosition += 1) {
  for (let repetitionIndex = 0; repetitionIndex < 3; repetitionIndex += 1) {
    compactionFirst[compactionOrderFor(densityPosition, repetitionIndex, 3)[0]] += 1;
    const order = evaluationOrderFor(densityPosition, repetitionIndex, 3, 0, 1);
    order.forEach((arm, position) => {
      evaluationPositions[arm][position] += 1;
    });
  }
}
assert.deepEqual(compactionFirst, { native: 3, codex: 3 });
assert.deepEqual(evaluationPositions, {
  full: [2, 2, 2],
  native: [2, 2, 2],
  codex: [2, 2, 2],
});

assert.deepEqual(repeated, fixture, "the same seed must reproduce the whole fixture");
assert.notDeepEqual(
  differentSeed.questions.map((question) => question.expected),
  fixture.questions.map((question) => question.expected),
  "different seeds must produce different authoritative values",
);
assert.ok(
  Math.abs(fixture.historyEstimatedTokens - fixture.targetTokens) / fixture.targetTokens <= 0.02,
  `fixed-length fixture drifted to ${fixture.historyEstimatedTokens} tokens`,
);
assert.equal(fixture.authoritativeRecords, fixture.density * CATEGORIES.length);
assert.equal(fixture.questions.length, CATEGORIES.length * fixtureOptions.questionsPerCategory);
assert.deepEqual([...new Set(fixture.questions.map((question) => question.category))].sort(), [...CATEGORIES].sort());
assert.deepEqual(
  [...new Set(fixture.questions.map((question) => question.epoch))].sort((a, b) => a - b),
  Array.from({ length: fixtureOptions.epochs }, (_, index) => index),
  "selected questions must cover every history epoch",
);

const userHistory = fixture.messages
  .filter((message) => message.role === "user")
  .map((message) => message.content)
  .join("\n");
for (const question of fixture.questions) {
  assert.equal(
    userHistory.includes(question.expected),
    false,
    `expected value leaked into a retained user message: ${question.id}`,
  );
  assert.equal(
    JSON.stringify(fixture.messages).includes(question.question),
    false,
    `quality question appeared before compaction: ${question.id}`,
  );
}

for (const density of [120, 200]) {
  const fixedLength = createBenchmarkFixture({
    ...fixtureOptions,
    density,
    questionsPerCategory: 15,
  });
  assert.ok(
    Math.abs(fixedLength.historyEstimatedTokens - fixedLength.targetTokens) / fixedLength.targetTokens <= 0.02,
    `density ${density} drifted to ${fixedLength.historyEstimatedTokens} tokens`,
  );
}

const prompt = buildProbePrompt(fixture.questions);
for (const question of fixture.questions) assert.match(prompt, new RegExp(question.id));

const perfectAnswers = Object.fromEntries(fixture.questions.map((question) => [question.id, question.expected]));
const perfect = scoreProbeResponse(JSON.stringify({ answers: perfectAnswers }), fixture.questions);
assert.equal(perfect.matched, fixture.questions.length);
assert.equal(perfect.rate, 1);
assert.equal(perfect.parseError, undefined);
assert.equal(perfect.byCategory.exact_recall.rate, 1);
assert.equal(perfect.byEpoch["0"].rate, 1);

const malformed = scoreProbeResponse("not JSON", fixture.questions);
assert.equal(malformed.matched, 0);
assert.ok(malformed.parseError);

const oneQuestionFixture = createBenchmarkFixture({
  seed: 401,
  density: 20,
  targetTokens: 30_000,
  questionsPerCategory: 1,
  epochs: 5,
});
const makeQuality = (wrongFirst = false) => {
  const answers = Object.fromEntries(
    oneQuestionFixture.questions.map((question, index) => [
      question.id,
      wrongFirst && index === 0 ? "wrong" : question.expected,
    ]),
  );
  return scoreProbeResponse(JSON.stringify({ answers }), oneQuestionFixture.questions);
};
const metric = (value) => ({
  compaction: {
    latencyMs: 100 + value,
    costUsd: 0.1 + value / 100,
    inputTokens: 1_000,
    outputTokens: 100,
    estimatedTokensAfter: 500,
  },
  probe: { latencyMs: 50, costUsd: 0.05, inputTokens: 600, outputTokens: 60 },
  total: { latencyMs: 150 + value, costUsd: 0.15 + value / 100 },
});
const artifact = (value, quality) => ({
  repetition: value + 1,
  checkpoint: { kind: "test" },
  compactionOrderPosition: value % 2,
  compaction: metric(value).compaction,
  probes: [
    {
      probeRepetition: 1,
      evaluationOrderPosition: value % 3,
      probe: metric(value).probe,
      quality,
      total: metric(value).total,
    },
  ],
});
const trials = [401, 402].map((seed, index) => ({
  fixture: { id: `fixture-${seed}`, seed, density: 20 },
  arms: {
    full: {
      probes: [
        {
          repetition: 1,
          probeRepetition: 1,
          evaluationOrderPosition: 0,
          probe: metric(0).probe,
          quality: makeQuality(false),
        },
      ],
    },
    native: {
      artifacts: [artifact(index, makeQuality(true)), artifact(index + 2, makeQuality(true))],
    },
    codex: {
      artifacts: [artifact(index + 10, makeQuality(false)), artifact(index + 12, makeQuality(false))],
    },
  },
}));
const summary = summarizeBenchmarkTrials(trials, { evaluatorDisagreementThreshold: 0.02 });
assert.equal(summary.trials, 2);
assert.equal(summary.independentSeeds, 2);
assert.equal(summary.quality.overall.full.rate, 1);
assert.equal(summary.quality.overall.codex.rate, 1);
assert.equal(summary.quality.overall.native.matched, 16);
assert.equal(summary.fullContextControl.passed, true);
assert.deepEqual(summary.fullContextControl.failedFixtures, []);
assert.equal(summary.evaluatorReliability.passed, true);
assert.equal(summary.reliability.native.artifacts, 4);
assert.equal(summary.reliability.codex.artifacts, 4);
assert.equal(summary.pairedCodexVsNative.codexOnly, 4);
assert.equal(summary.pairedCodexVsNative.nativeOnly, 0);
assert.equal(summary.quality.byDensity["20"].codex.rate, 1);
assert.equal(summary.quality.bySeed["401"].full.rate, 1);
assert.equal(summary.seedPairedQuality.seeds.length, 2);
assert.equal(summary.seedPairedQuality.delta.median, 0.2);
assert.deepEqual(summary.seedPairedQuality.bootstrap95, { lower: 0.2, upper: 0.2 });
assert.equal(summary.codexMinusNative.compactionLatencyMs.median, 10);
const failedControlTrials = structuredClone(trials);
failedControlTrials[0].arms.full.probes[0].quality.scores[0].matched = false;
const failedControlSummary = summarizeBenchmarkTrials(failedControlTrials, {
  evaluatorDisagreementThreshold: 0.02,
});
assert.equal(failedControlSummary.fullContextControl.passed, false);
assert.equal(failedControlSummary.fullContextControl.failedFixtures.length, 1);
const unreliableTrials = structuredClone(trials);
unreliableTrials[0].arms.full.probes.push({
  ...structuredClone(unreliableTrials[0].arms.full.probes[0]),
  probeRepetition: 2,
  quality: makeQuality(true),
});
const unreliableSummary = summarizeBenchmarkTrials(unreliableTrials, {
  evaluatorDisagreementThreshold: 0.02,
});
assert.equal(unreliableSummary.evaluatorReliability.passed, false);
assert.equal(unreliableSummary.evaluatorReliability.failedFixtures.length, 1);
assert.deepEqual(summarizeNumbers([3, 1, 2]), {
  count: 3,
  median: 2,
  medianAbsoluteDeviation: 1,
  min: 1,
  max: 3,
});

const sdk = await import("@earendil-works/pi-coding-agent");
const sourceManager = sdk.SessionManager.inMemory("/benchmark");
sourceManager.appendModelChange("openai-codex", "gpt-5.6-sol");
sourceManager.appendThinkingLevelChange("medium");
sourceManager.appendMessage({ role: "user", content: "old", timestamp: 1 });
const keptId = sourceManager.appendMessage({ role: "user", content: "recent", timestamp: 2 });
sourceManager.appendCompaction("summary", keptId, 100, { kind: "test-checkpoint", nested: { value: 1 } }, true);
const clonedManager = cloneSessionBranch(sdk, sourceManager.getBranch(), "/benchmark");
const contextWithoutTimestamps = (context) => ({
  ...context,
  messages: context.messages.map(({ timestamp: _timestamp, ...message }) => message),
});
assert.deepEqual(
  contextWithoutTimestamps(clonedManager.buildSessionContext()),
  contextWithoutTimestamps(sourceManager.buildSessionContext()),
);
const sourceCompaction = sourceManager.getBranch().find((entry) => entry.type === "compaction");
const clonedCompaction = clonedManager.getBranch().find((entry) => entry.type === "compaction");
assert.notEqual(clonedCompaction.firstKeptEntryId, sourceCompaction.firstKeptEntryId);
assert.deepEqual(clonedCompaction.details, sourceCompaction.details);
sourceCompaction.details.nested.value = 2;
assert.equal(clonedCompaction.details.nested.value, 1);

const runtimeRoot = await mkdtemp(path.join(tmpdir(), "pi-codex-compact-runtime-test-"));
let runtimeSnapshot;
try {
  const runtimePackageRoot = path.join(runtimeRoot, "packages", "pi-codex-compact");
  const runtimeBenchmarkRoot = path.join(runtimePackageRoot, "benchmark");
  const runtimeSourceRoot = path.join(runtimePackageRoot, "src");
  const runtimeProtocolPath = path.join(runtimeBenchmarkRoot, "protocol.json");
  await mkdir(runtimeSourceRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(
    path.join(runtimePackageRoot, "package.json"),
    '{"name":"@narumitw/pi-codex-compact","version":"0.0.0"}\n',
  );
  await mkdir(runtimeBenchmarkRoot, { recursive: true });
  await writeFile(path.join(runtimeBenchmarkRoot, "run.mjs"), "export const version = 1;\n");
  await writeFile(path.join(runtimeSourceRoot, "helper.ts"), "export const value = 1;\n");
  await writeFile(
    path.join(runtimeSourceRoot, "index.ts"),
    [
      'import { value } from "./helper.js";',
      "export default (pi) => {",
      '\tpi.registerCommand("snapshot-smoke", { description: String(value), handler: () => {} });',
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(runtimeProtocolPath, `${JSON.stringify(protocolInput)}\n`);

  runtimeSnapshot = await createImmutableRuntimeSnapshot({
    packageRoot: runtimePackageRoot,
    protocol: { path: runtimeProtocolPath, sha256: protocolSha256(protocolInput) },
    snapshotRoot: path.join(runtimeRoot, "immutable"),
  });
  assert.equal(
    await readFile(path.join(runtimeSnapshot.extensionRoot, "helper.ts"), "utf8"),
    "export const value = 1;\n",
  );
  const runtimeAgentDir = path.join(runtimeRoot, "agent");
  await mkdir(runtimeAgentDir);
  const snapshotLoader = new sdk.DefaultResourceLoader({
    cwd: runtimePackageRoot,
    agentDir: runtimeAgentDir,
    settingsManager: sdk.SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [runtimeSnapshot.extensionEntry],
  });
  await snapshotLoader.reload();
  assert.deepEqual(snapshotLoader.getExtensions().errors, []);
  assert.equal(snapshotLoader.getExtensions().extensions.length, 1);
  assert.equal((await checkRuntimeInputSnapshot(runtimeSnapshot)).clean, true);
  const publicSnapshot = publicRuntimeInputSnapshot(runtimeSnapshot);
  assert.match(publicSnapshot.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    publicSnapshot.files.some((file) => file.path === "package/src/helper.ts"),
    true,
  );
  assert.equal("absolutePath" in publicSnapshot.files[0], false);

  await writeFile(path.join(runtimeSourceRoot, "helper.ts"), "export const value = 2;\n");
  const changedSnapshot = await checkRuntimeInputSnapshot(runtimeSnapshot);
  assert.equal(changedSnapshot.clean, false);
  assert.deepEqual(changedSnapshot.changedFiles, ["package/src/helper.ts"]);
  assert.equal(
    await readFile(path.join(runtimeSnapshot.extensionRoot, "helper.ts"), "utf8"),
    "export const value = 1;\n",
    "the live extension snapshot must not follow worktree changes",
  );
  await writeFile(path.join(runtimeSourceRoot, "helper.ts"), "export const value = 1;\n");
  await writeFile(path.join(runtimeBenchmarkRoot, "added.mjs"), "export const added = true;\n");
  assert.deepEqual((await checkRuntimeInputSnapshot(runtimeSnapshot)).changedFiles, ["package/benchmark/added.mjs"]);
  await rm(path.join(runtimeBenchmarkRoot, "added.mjs"));
  await rm(path.join(runtimeSourceRoot, "helper.ts"));
  assert.deepEqual((await checkRuntimeInputSnapshot(runtimeSnapshot)).changedFiles, ["package/src/helper.ts"]);
  await writeFile(path.join(runtimeSourceRoot, "helper.ts"), "export const value = 1;\n");
  assert.equal((await checkRuntimeInputSnapshot(runtimeSnapshot)).clean, true);
  await writeFile(runtimeProtocolPath, `${JSON.stringify(protocolInput, null, 2)}\n`);
  assert.deepEqual((await checkRuntimeInputSnapshot(runtimeSnapshot)).changedFiles, ["protocol/manifest.json"]);
  await writeFile(runtimeProtocolPath, `${JSON.stringify(protocolInput)}\n`);
  assert.equal((await checkRuntimeInputSnapshot(runtimeSnapshot)).clean, true);
  assert.equal(
    classifyEvidence({
      protocol,
      options: protocolOptions,
      status: "completed",
      fullContextPassed: true,
      evaluatorPassed: true,
      sourceClean: changedSnapshot.clean,
    }).classification,
    "diagnostic",
  );
} finally {
  await releaseRuntimeSnapshot(runtimeSnapshot);
  await rm(runtimeRoot, { recursive: true, force: true });
}

const resultDirectory = await mkdtemp(path.join(tmpdir(), "pi-codex-compact-result-test-"));
try {
  const resultPath = path.join(resultDirectory, "result.json");
  const original = '{"status":"previous"}\n';
  await writeFile(resultPath, original, "utf8");
  await assert.rejects(
    writeResultFile(
      resultPath,
      { status: "replacement" },
      {
        renameFile: async () => {
          throw new Error("simulated publication failure");
        },
      },
    ),
    /simulated publication failure/,
  );
  assert.equal(await readFile(resultPath, "utf8"), original);
  assert.deepEqual(await readdir(resultDirectory), ["result.json"]);

  await writeResultFile(resultPath, { status: "replacement" });
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), { status: "replacement" });
  assert.deepEqual(await readdir(resultDirectory), ["result.json"]);
} finally {
  await rm(resultDirectory, { recursive: true, force: true });
}

process.stdout.write("pi-codex-compact benchmark self-test passed\n");
