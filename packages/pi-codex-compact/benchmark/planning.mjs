import { createHash } from "node:crypto";
import { createBenchmarkFixtures } from "./core.mjs";

export function fixtureOptions(benchmarkOptions) {
  return {
    seeds: benchmarkOptions.seeds,
    densities: benchmarkOptions.densities,
    targetTokens: benchmarkOptions.fixtureTokens,
    questionsPerCategory: benchmarkOptions.questionsPerCategory,
    epochs: benchmarkOptions.epochs,
  };
}

export function fixtureMetadata(fixture) {
  return {
    id: fixture.id,
    fixtureVersion: fixture.fixtureVersion,
    seed: fixture.seed,
    density: fixture.density,
    targetTokens: fixture.targetTokens,
    historyEstimatedTokens: fixture.historyEstimatedTokens,
    estimatedTokens: fixture.estimatedTokens,
    messageCount: fixture.messages.length,
    sharedTailMessageCount: fixture.sharedTailMessageCount,
    authoritativeRecords: fixture.authoritativeRecords,
    questionCount: fixture.questions.length,
    qualityCategories: [...new Set(fixture.questions.map((question) => question.category))],
    epochs: fixture.epochs,
    fixtureSha256: createHash("sha256")
      .update(JSON.stringify({ messages: fixture.messages, questions: fixture.questions }))
      .digest("hex"),
  };
}

export function createFixturePlan(benchmarkOptions, estimateTokens) {
  if (typeof estimateTokens !== "function") throw new Error("estimateTokens must be a function");
  return createBenchmarkFixtures({
    ...fixtureOptions(benchmarkOptions),
    estimateTokens,
  }).map((fixture) => ({ fixture, metadata: fixtureMetadata(fixture) }));
}

export function plannedProviderRequests(benchmarkOptions, fixtureCount) {
  return fixtureCount * benchmarkOptions.compactionRepetitions * (2 + 3 * benchmarkOptions.probesPerArtifact);
}

export function compactionOrderFor(densityPosition, repetitionIndex, repetitions) {
  const blockIndex = densityPosition * repetitions + repetitionIndex;
  return blockIndex % 2 === 0 ? ["native", "codex"] : ["codex", "native"];
}

export function evaluationOrderFor(densityPosition, repetitionIndex, repetitions, probeIndex, probesPerArtifact) {
  const rotations = [
    ["full", "native", "codex"],
    ["native", "codex", "full"],
    ["codex", "full", "native"],
  ];
  const blockIndex = densityPosition * repetitions + repetitionIndex;
  return rotations[(blockIndex * probesPerArtifact + probeIndex) % rotations.length];
}
