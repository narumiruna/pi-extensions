#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const DEFAULT_RUNS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
if (options.entries.length === 0) fail("Provide at least one --entry path.");

const entries = options.entries.map((entry) => resolve(entry));
const warmup = await measure(entries, options);
const runs = [];
for (let index = 0; index < options.runs; index += 1) {
  runs.push(await measure(entries, options));
}
const importSamples = runs.map((run) => run.importTotalMs);
const responseSamples = runs.map((run) => run.firstResponseMs);
const result = {
  protocolVersion: 1,
  measuredAt: new Date().toISOString(),
  pi: options.pi,
  cwd: process.cwd(),
  entries,
  runs: options.runs,
  warmup,
  measurements: runs,
  summary: {
    importTotalMs: summarize(importSamples),
    firstResponseMs: summarize(responseSamples),
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function measure(extensionEntries, benchmarkOptions) {
  const root = await mkdtemp(resolve(tmpdir(), "pi-extension-startup-"));
  const startedAt = performance.now();
  let firstResponseMs;
  let stdout = "";
  let stderr = "";
  try {
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ];
    for (const entry of extensionEntries) args.push("--extension", entry);
    const child = spawn(benchmarkOptions.pi, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: resolve(root, "agent"),
        PI_OFFLINE: "1",
        PI_TIMING: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), benchmarkOptions.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (firstResponseMs === undefined && hasSuccessfulCommandResponse(stdout)) {
        firstResponseMs = performance.now() - startedAt;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(`${JSON.stringify({ type: "get_commands" })}\n`);
    let exit;
    try {
      exit = await new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      });
    } finally {
      clearTimeout(timeout);
    }
    if (exit.code !== 0 || firstResponseMs === undefined) {
      throw new Error(
        `Pi benchmark failed (code=${exit.code}, signal=${exit.signal ?? "none"}).\n${stderr}\n${stdout}`,
      );
    }
    const timings = parseExtensionTimings(stderr);
    return {
      importTotalMs: timings.total,
      firstResponseMs: round(firstResponseMs),
      imports: timings.imports,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hasSuccessfulCommandResponse(output) {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message?.type === "response" && message.command === "get_commands") {
        return message.success === true;
      }
    } catch {
      // Ignore incomplete or non-JSON protocol lines until the complete response arrives.
    }
  }
  return false;
}

function parseExtensionTimings(output) {
  const imports = [];
  let inExtensions = false;
  for (const line of output.split("\n")) {
    if (line.includes("--- Startup Timings: extensions ---")) {
      inExtensions = true;
      continue;
    }
    if (!inExtensions) continue;
    if (/^-{5,}\s*$/u.test(line.trim())) break;
    const match = line.match(/^\s{2}(.+?) module import: (\d+)ms\s*$/u);
    if (match) imports.push({ entry: match[1], ms: Number(match[2]) });
  }
  if (imports.length === 0) throw new Error(`No extension module-import timings found.\n${output}`);
  return { imports, total: imports.reduce((total, item) => total + item.ms, 0) };
}

function summarize(values) {
  const center = median(values);
  return {
    median: round(center),
    medianAbsoluteDeviation: round(median(values.map((value) => Math.abs(value - center)))),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2 : (ordered[middle] ?? 0);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function parseArguments(args) {
  const parsed = {
    entries: [],
    help: false,
    pi: process.env.PI_STARTUP_BENCHMARK_PI ?? "pi",
    runs: DEFAULT_RUNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--entry" || argument === "-e") {
      parsed.entries.push(requireValue(args, ++index, argument));
    } else if (argument === "--pi") parsed.pi = requireValue(args, ++index, argument);
    else if (argument === "--runs") {
      parsed.runs = positiveInteger(requireValue(args, ++index, argument), argument);
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = positiveInteger(requireValue(args, ++index, argument), argument);
    } else fail(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value) fail(`${option} requires a value.`);
  return value;
}

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${option} must be a positive integer.`);
  return number;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/benchmark-extension-startup.mjs [options]\n\n`);
  process.stdout.write(`  -e, --entry <path>   Extension entrypoint (repeatable)\n`);
  process.stdout.write(`      --pi <path>      Pi executable (default: pi)\n`);
  process.stdout.write(`      --runs <count>   Measured runs after one warm-up (default: ${DEFAULT_RUNS})\n`);
  process.stdout.write(`      --timeout-ms <n> Per-run timeout (default: ${DEFAULT_TIMEOUT_MS})\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
