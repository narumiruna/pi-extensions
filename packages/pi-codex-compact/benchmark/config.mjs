import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  applyProtocolOptions,
  DEFAULT_MODEL,
  DEFAULT_PROFILE,
  PROFILES,
  protocolSha256,
  SUITES,
  validateProtocolManifest,
} from "./protocol.mjs";

export const DEFAULT_TIMEOUT_MS = 300_000;
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const LOCKED_OPTIONS = new Set([
  "--model",
  "--suite",
  "--seeds",
  "--densities",
  "--questions-per-category",
  "--epochs",
  "--fixture-tokens",
  "--compaction-thinking",
  "--probe-thinking",
  "--profile",
  "--repetitions",
  "--probes-per-artifact",
  "--evaluator-disagreement-threshold",
  "--context-regime",
]);

async function readProtocolFile(protocolPath) {
  let value;
  try {
    const text = await readFile(protocolPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw new Error("protocol manifest exceeds 64 KiB");
    }
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Could not read protocol manifest ${protocolPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}

export async function parseArguments(args, options = {}) {
  const parsed = {
    agentDir: undefined,
    compactionThinking: "medium",
    compactionRepetitions: 1,
    contextRegime: "controlled-manual-50k",
    densities: undefined,
    epochs: 10,
    evaluatorDisagreementThreshold: 0.02,
    fixtureTokens: 50_000,
    help: false,
    live: false,
    maxCostUsd: 20,
    model: DEFAULT_MODEL,
    output: undefined,
    probeThinking: "low",
    probesPerArtifact: 1,
    profile: DEFAULT_PROFILE,
    protocol: undefined,
    protocolPath: undefined,
    questionsPerCategory: undefined,
    requestDelayMs: 300,
    seeds: undefined,
    suite: "exploratory",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const seenLocked = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (LOCKED_OPTIONS.has(argument)) seenLocked.push(argument);
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--live") parsed.live = true;
    else if (argument === "--agent-dir") parsed.agentDir = requireValue(args, ++index, argument);
    else if (argument === "--compaction-thinking") {
      parsed.compactionThinking = thinkingLevel(requireValue(args, ++index, argument), argument);
    } else if (argument === "--densities") {
      parsed.densities = integerList(requireValue(args, ++index, argument), argument, 1, 1_000);
    } else if (argument === "--epochs") {
      parsed.epochs = boundedInteger(requireValue(args, ++index, argument), argument, 2, 20);
    } else if (argument === "--evaluator-disagreement-threshold") {
      parsed.evaluatorDisagreementThreshold = boundedNumber(requireValue(args, ++index, argument), argument, 0, 1);
    } else if (argument === "--fixture-tokens") {
      parsed.fixtureTokens = boundedInteger(requireValue(args, ++index, argument), argument, 25_000, 180_000);
    } else if (argument === "--max-cost-usd") {
      parsed.maxCostUsd = boundedNumber(requireValue(args, ++index, argument), argument, 0.01, 1_000);
    } else if (argument === "--model") parsed.model = requireValue(args, ++index, argument);
    else if (argument === "--output") parsed.output = requireValue(args, ++index, argument);
    else if (argument === "--probe-thinking") {
      parsed.probeThinking = thinkingLevel(requireValue(args, ++index, argument), argument);
    } else if (argument === "--probes-per-artifact") {
      parsed.probesPerArtifact = boundedInteger(requireValue(args, ++index, argument), argument, 1, 10);
    } else if (argument === "--profile") {
      const profile = requireValue(args, ++index, argument);
      if (!Object.hasOwn(PROFILES, profile)) {
        throw new Error(`--profile must be one of: ${Object.keys(PROFILES).join(", ")}`);
      }
      parsed.profile = profile;
    } else if (argument === "--protocol") {
      parsed.protocolPath = requireValue(args, ++index, argument);
    } else if (argument === "--questions-per-category") {
      parsed.questionsPerCategory = boundedInteger(requireValue(args, ++index, argument), argument, 1, 100);
    } else if (argument === "--repetitions") {
      parsed.compactionRepetitions = boundedInteger(requireValue(args, ++index, argument), argument, 1, 10);
    } else if (argument === "--request-delay-ms") {
      parsed.requestDelayMs = boundedInteger(requireValue(args, ++index, argument), argument, 0, 5_000);
    } else if (argument === "--seeds") {
      parsed.seeds = integerList(requireValue(args, ++index, argument), argument, 1, 1_000_000);
    } else if (argument === "--suite") {
      const suite = requireValue(args, ++index, argument);
      if (!Object.hasOwn(SUITES, suite)) {
        throw new Error(`--suite must be one of: ${Object.keys(SUITES).join(", ")}`);
      }
      parsed.suite = suite;
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = boundedInteger(requireValue(args, ++index, argument), argument, 30_000, 600_000);
    } else if (argument === "--context-regime") {
      const regime = requireValue(args, ++index, argument);
      if (!["controlled-manual-50k", "context-scale-diagnostic"].includes(regime)) {
        throw new Error("--context-regime is unsupported");
      }
      parsed.contextRegime = regime;
    } else throw new Error(`Unknown argument: ${argument}`);
  }

  if (parsed.protocolPath) {
    if (seenLocked.length > 0) {
      throw new Error(`locked option cannot be combined with --protocol: ${seenLocked[0]}`);
    }
    const readProtocol = options.readProtocol ?? readProtocolFile;
    const manifest = validateProtocolManifest(await readProtocol(parsed.protocolPath));
    Object.assign(parsed, applyProtocolOptions(parsed, manifest), {
      protocol: {
        path: path.resolve(parsed.protocolPath),
        manifest,
        sha256: protocolSha256(manifest),
      },
      suite: "confirmatory",
    });
  }

  const suite = SUITES[parsed.suite];
  parsed.seeds ??= [...suite.seeds];
  parsed.densities ??= [...suite.densities];
  parsed.questionsPerCategory ??= suite.questionsPerCategory;
  parsed.suiteDefaultsUsed =
    !parsed.protocol &&
    arraysEqual(parsed.seeds, suite.seeds) &&
    arraysEqual(parsed.densities, suite.densities) &&
    parsed.questionsPerCategory === suite.questionsPerCategory;
  if (!parsed.protocol && parsed.fixtureTokens !== 50_000) {
    parsed.contextRegime = "context-scale-diagnostic";
  }
  const minimumDensity = Math.min(...parsed.densities);
  if (parsed.questionsPerCategory > minimumDensity) {
    throw new Error("--questions-per-category cannot exceed the smallest density");
  }
  if (parsed.epochs > minimumDensity) {
    throw new Error("--epochs cannot exceed the smallest density");
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function boundedInteger(value, option, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${option} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function boundedNumber(value, option, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${option} must be a number between ${minimum} and ${maximum}`);
  }
  return number;
}

function integerList(value, option, minimum, maximum) {
  const values = value.split(",").map((part) => boundedInteger(part, option, minimum, maximum));
  if (values.length === 0) throw new Error(`${option} requires at least one integer`);
  return [...new Set(values)].sort((left, right) => left - right);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function thinkingLevel(value, option) {
  if (!THINKING_LEVELS.includes(value)) {
    throw new Error(`${option} is not a supported Pi thinking level`);
  }
  return value;
}
