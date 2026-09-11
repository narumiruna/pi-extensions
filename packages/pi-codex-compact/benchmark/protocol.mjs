import { createHash } from "node:crypto";
import { BENCHMARK_ID } from "./core.mjs";

export const DEFAULT_MODEL = "gpt-5.6-sol";
export const DEFAULT_PROFILE = "matched-tail";
export const CONSUMED_SEEDS = Object.freeze([301, 302, 303, 304]);

export const PROFILES = Object.freeze({
  production: Object.freeze({
    piKeepRecentTokens: 20_000,
    codexReplacementTokenBudget: 64_000,
  }),
  "matched-tail": Object.freeze({
    piKeepRecentTokens: 20_000,
    codexReplacementTokenBudget: 20_000,
  }),
});

export const SUITES = Object.freeze({
  exploratory: Object.freeze({
    seeds: Object.freeze([1]),
    densities: Object.freeze([120]),
    questionsPerCategory: 3,
  }),
  calibration: Object.freeze({
    seeds: Object.freeze([111]),
    densities: Object.freeze([120, 160, 200]),
    questionsPerCategory: 15,
  }),
  confirmatory: Object.freeze({
    seeds: Object.freeze([301, 302, 303, 304]),
    densities: Object.freeze([180, 200]),
    questionsPerCategory: 15,
  }),
});

const PROTOCOL_FIELDS = Object.freeze([
  "schemaVersion",
  "protocolId",
  "benchmarkId",
  "createdAt",
  "calibrationEvidenceSha256",
  "model",
  "profile",
  "seeds",
  "densities",
  "questionsPerCategory",
  "epochs",
  "fixtureTargetTokens",
  "compactionThinkingLevel",
  "probeThinkingLevel",
  "compactionRepetitions",
  "probesPerArtifact",
  "evaluatorDisagreementThreshold",
  "contextRegime",
]);

const OPTION_FIELDS = Object.freeze([
  ["model", "model"],
  ["profile", "profile"],
  ["seeds", "seeds"],
  ["densities", "densities"],
  ["questionsPerCategory", "questionsPerCategory"],
  ["epochs", "epochs"],
  ["fixtureTargetTokens", "fixtureTokens"],
  ["compactionThinkingLevel", "compactionThinking"],
  ["probeThinkingLevel", "probeThinking"],
  ["compactionRepetitions", "compactionRepetitions"],
  ["probesPerArtifact", "probesPerArtifact"],
  ["evaluatorDisagreementThreshold", "evaluatorDisagreementThreshold"],
  ["contextRegime", "contextRegime"],
]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireNumber(value, field, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireString(value, field, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function requireIntegerList(value, field, minimum, maximum) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  const result = value.map((entry) => requireInteger(entry, field, minimum, maximum));
  if (new Set(result).size !== result.length) {
    throw new Error(`${field === "seeds" ? "duplicate seed" : `duplicate ${field.slice(0, -1)}`}`);
  }
  if (!result.every((entry, index) => index === 0 || result[index - 1] < entry)) {
    throw new Error(`${field} must be strictly increasing`);
  }
  return result;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateProtocolManifest(value) {
  if (!isObject(value)) throw new Error("protocol manifest must be an object");
  for (const field of Object.keys(value)) {
    if (!PROTOCOL_FIELDS.includes(field)) throw new Error(`unknown field: ${field}`);
  }
  for (const field of PROTOCOL_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new Error(`missing field: ${field}`);
  }
  if (value.schemaVersion !== 1) throw new Error("unsupported protocol schemaVersion");
  requireString(value.protocolId, "protocolId", /^[a-z0-9][a-z0-9-]{7,79}$/);
  if (value.benchmarkId !== BENCHMARK_ID) {
    throw new Error(`benchmarkId must be ${BENCHMARK_ID}`);
  }
  requireString(value.createdAt, "createdAt", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  const createdAt = new Date(value.createdAt);
  const normalizedCreatedAt = value.createdAt.includes(".") ? value.createdAt : value.createdAt.replace(/Z$/, ".000Z");
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== normalizedCreatedAt) {
    throw new Error("createdAt is invalid");
  }
  requireString(value.calibrationEvidenceSha256, "calibrationEvidenceSha256", /^[a-f0-9]{64}$/);
  requireString(value.model, "model", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  if (!Object.hasOwn(PROFILES, value.profile)) throw new Error("profile is unsupported");
  const seeds = requireIntegerList(value.seeds, "seeds", 1, 1_000_000);
  for (const seed of seeds) {
    if (CONSUMED_SEEDS.includes(seed)) throw new Error(`consumed seed: ${seed}`);
  }
  if (seeds.length < 8) throw new Error("confirmatory protocol requires at least 8 fresh seeds");
  const densities = requireIntegerList(value.densities, "densities", 1, 1_000);
  if (densities.length !== 2) {
    throw new Error("confirmatory protocol requires exactly 2 calibrated densities");
  }
  const questionsPerCategory = requireInteger(value.questionsPerCategory, "questionsPerCategory", 1, 100);
  const epochs = requireInteger(value.epochs, "epochs", 2, 20);
  if (questionsPerCategory > Math.min(...densities)) {
    throw new Error("questionsPerCategory cannot exceed the smallest density");
  }
  if (epochs > Math.min(...densities)) throw new Error("epochs cannot exceed the smallest density");
  requireInteger(value.fixtureTargetTokens, "fixtureTargetTokens", 25_000, 180_000);
  requireString(
    value.compactionThinkingLevel,
    "compactionThinkingLevel",
    /^(?:off|minimal|low|medium|high|xhigh|max)$/,
  );
  requireString(value.probeThinkingLevel, "probeThinkingLevel", /^(?:off|minimal|low|medium|high|xhigh|max)$/);
  requireInteger(value.compactionRepetitions, "compactionRepetitions", 3, 10);
  requireInteger(value.probesPerArtifact, "probesPerArtifact", 1, 10);
  requireNumber(value.evaluatorDisagreementThreshold, "evaluatorDisagreementThreshold", 0, 1);
  if (!["controlled-manual-50k", "context-scale-diagnostic"].includes(value.contextRegime)) {
    throw new Error("contextRegime is unsupported");
  }
  if (value.contextRegime === "controlled-manual-50k" && value.fixtureTargetTokens !== 50_000) {
    throw new Error("controlled-manual-50k requires fixtureTargetTokens to equal 50000");
  }
  return structuredClone(value);
}

export function canonicalProtocolText(protocol) {
  return `${JSON.stringify(stableValue(validateProtocolManifest(protocol)))}\n`;
}

export function protocolSha256(protocol) {
  return createHash("sha256").update(canonicalProtocolText(protocol)).digest("hex");
}

export function applyProtocolOptions(options, protocol) {
  const next = { ...options };
  for (const [protocolField, optionField] of OPTION_FIELDS) {
    next[optionField] = structuredClone(protocol[protocolField]);
  }
  return next;
}

export function protocolDeviations(protocol, options) {
  const deviations = [];
  for (const [protocolField, optionField] of OPTION_FIELDS) {
    if (!sameValue(protocol[protocolField], options[optionField])) {
      deviations.push(`${optionField} differs from the locked protocol`);
    }
  }
  return deviations;
}

export function protocolEligibilityDeviations(protocol) {
  return protocol.contextRegime === "context-scale-diagnostic"
    ? ["The context-scale regime is diagnostic and cannot support confirmatory evidence."]
    : [];
}

export function classifyEvidence({
  protocol,
  options,
  status,
  fullContextPassed,
  evaluatorPassed,
  sourceClean = true,
}) {
  const configDeviations = protocol
    ? [...protocolDeviations(protocol, options), ...protocolEligibilityDeviations(protocol)]
    : ["No locked protocol manifest was supplied."];
  const outcomeDeviations = [];
  if (status !== "completed") outcomeDeviations.push(`Run status is ${status}, not completed.`);
  if (!fullContextPassed) outcomeDeviations.push("The full-context answerability control failed.");
  if (!evaluatorPassed) outcomeDeviations.push("The evaluator reliability gate failed.");
  if (!sourceClean) outcomeDeviations.push("Tracked benchmark or extension inputs were dirty.");
  const deviations = [...configDeviations, ...outcomeDeviations];
  const protocolConformant = Boolean(protocol) && configDeviations.length === 0;
  return {
    classification: protocolConformant && outcomeDeviations.length === 0 ? "confirmatory-candidate" : "diagnostic",
    protocolConformant,
    ...(protocol ? { protocolSha256: protocolSha256(protocol) } : {}),
    humanPrimaryClaim: false,
    deviations,
  };
}
