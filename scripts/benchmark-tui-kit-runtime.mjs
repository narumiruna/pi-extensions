#!/usr/bin/env node

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_RUNS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const SCENARIOS = [
  "import",
  "terminal-text-import",
  "interaction-hints-import",
  "actions",
  "review",
  "mermaid",
  "task",
];
const IMPORT_SPECIFIERS = {
  import: "@narumitw/pi-tui-kit",
  "terminal-text-import": "@narumitw/pi-tui-kit/terminal-text",
  "interaction-hints-import": "@narumitw/pi-tui-kit/interaction-hints",
  actions: "@narumitw/pi-tui-kit",
  review: "@narumitw/pi-tui-kit",
  mermaid: "@narumitw/pi-tui-kit",
  task: "@narumitw/pi-tui-kit",
};

const options = parseArguments(process.argv.slice(2));
if (options.worker) {
  await runWorker(options.worker);
} else if (options.help) {
  printHelp();
} else {
  const warmup = {};
  const measurements = {};
  for (const scenario of SCENARIOS) {
    warmup[scenario] = await measure(scenario, options.timeoutMs);
    measurements[scenario] = [];
    for (let index = 0; index < options.runs; index += 1) {
      measurements[scenario].push(await measure(scenario, options.timeoutMs));
    }
  }
  const summary = Object.fromEntries(
    SCENARIOS.map((scenario) => [
      scenario,
      {
        importSpecifier: IMPORT_SPECIFIERS[scenario],
        importMs: summarize(measurements[scenario].map((result) => result.importMs)),
        firstFrameMs: summarize(
          measurements[scenario].map((result) => result.firstFrameMs).filter((value) => value !== undefined),
        ),
        kitRootLoaded: measurements[scenario].some((result) => result.kitRootLoaded),
        kitRuntimeLoaded: measurements[scenario].some((result) => result.kitRuntimeLoaded),
        kitComponentsLoaded: measurements[scenario].some((result) => result.kitComponentsLoaded),
        codingAgentLoaded: measurements[scenario].some((result) => result.codingAgentLoaded),
        highlightJsLoaded: measurements[scenario].some((result) => result.highlightJsLoaded),
        mermaidRendererLoaded: measurements[scenario].some((result) => result.mermaidRendererLoaded),
        syntaxHighlighted: measurements[scenario].some((result) => result.syntaxHighlighted),
      },
    ]),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        protocolVersion: 1,
        measuredAt: new Date().toISOString(),
        node: process.version,
        cwd: process.cwd(),
        runs: options.runs,
        warmup,
        measurements,
        summary,
      },
      null,
      2,
    )}\n`,
  );
}

async function runWorker(scenario) {
  if (!SCENARIOS.includes(scenario)) fail(`Unknown worker scenario: ${scenario}`);
  const importSpecifier = IMPORT_SPECIFIERS[scenario];
  if (!importSpecifier) fail(`Missing import specifier for worker scenario: ${scenario}`);
  const loadedUrls = [];
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      loadedUrls.push(result.url);
      return result;
    },
  });

  const startedAt = performance.now();
  const kit = await import(importSpecifier);
  const importMs = performance.now() - startedAt;
  const kitLoadedCodingAgent = loadedUrls.some((url) => url.includes("/@earendil-works/pi-coding-agent/"));
  if (kitLoadedCodingAgent) {
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme("dark", false);
  }
  let firstFrameMs;
  let syntaxHighlighted = false;
  if (scenario === "actions") {
    ({ firstFrameMs, syntaxHighlighted } = await runMenuFrame(kit, startedAt, {
      kind: "actions",
      title: "Benchmark actions",
      items: [{ id: "close", label: "Close", close: true }],
      hint: "close",
    }));
  } else if (scenario === "review") {
    ({ firstFrameMs, syntaxHighlighted } = await runMenuFrame(kit, startedAt, {
      kind: "review",
      title: "Benchmark review",
      content: "const answer: number = 42;",
      format: { kind: "code", filePath: "benchmark.ts" },
      hint: "close",
    }));
  } else if (scenario === "mermaid") {
    ({ firstFrameMs, syntaxHighlighted } = await runMenuFrame(kit, startedAt, {
      kind: "review",
      title: "Benchmark Mermaid",
      content: "```mermaid\nflowchart LR\n A[Start] --> B[Done]\n```",
      format: { kind: "markdown" },
      hint: "close",
    }));
  } else if (scenario === "task") {
    const context = benchmarkContext(
      (elapsed) => {
        firstFrameMs ??= elapsed;
      },
      startedAt,
      false,
    );
    const result = await kit.runTask(context, {
      label: "Benchmark task",
      task: async () => "done",
    });
    if (result.kind !== "completed") {
      throw new Error(
        `Unexpected task result: ${result.kind}${result.kind === "error" ? `: ${result.error?.stack ?? result.error}` : ""}`,
      );
    }
  }

  const packageUrls = [...new Set(loadedUrls)].filter((url) => /\/(?:node_modules|packages)\//u.test(url)).sort();
  const kitDistPaths = packageUrls.map(kitDistRelativePath).filter((path) => path !== undefined);
  process.stdout.write(
    `${JSON.stringify({
      scenario,
      importSpecifier,
      importMs: round(importMs),
      firstFrameMs: firstFrameMs === undefined ? undefined : round(firstFrameMs),
      kitRootLoaded: kitDistPaths.includes("index.js"),
      kitRuntimeLoaded: kitDistPaths.includes("runtime.js"),
      kitComponentsLoaded: kitDistPaths.some((path) => path.startsWith("components/")),
      codingAgentLoaded: packageUrls.some((url) => url.includes("/@earendil-works/pi-coding-agent/")),
      highlightJsLoaded: packageUrls.some((url) => url.includes("/highlight.js/")),
      mermaidRendererLoaded: packageUrls.some((url) => url.includes("/grok-mermaid/")),
      syntaxHighlighted,
      packageUrls,
    })}\n`,
  );
}

function kitDistRelativePath(url) {
  for (const marker of ["/packages/pi-tui-kit/dist/", "/node_modules/@narumitw/pi-tui-kit/dist/"]) {
    const index = url.lastIndexOf(marker);
    if (index >= 0) return url.slice(index + marker.length);
  }
  return undefined;
}

async function runMenuFrame(kit, startedAt, screen) {
  let firstFrameMs;
  let syntaxHighlighted = false;
  const context = benchmarkContext((elapsed, frame) => {
    firstFrameMs ??= elapsed;
    syntaxHighlighted ||= frame.syntaxHighlighted;
  }, startedAt);
  const menu = kit.defineMenu({
    start: "main",
    screens: { main: () => screen },
    actions: { unused: async () => ({ kind: "close" }) },
  });
  const result = await kit.runMenu(context, menu, { getState: () => undefined });
  if (result.kind !== "closed") throw new Error(`Unexpected menu result: ${result.kind}`);
  if (firstFrameMs === undefined) throw new Error("Menu did not render a frame");
  return { firstFrameMs, syntaxHighlighted };
}

function benchmarkContext(onFirstFrame, startedAt, closeAfterFirstFrame = true) {
  let syntaxHighlighted = false;
  const theme = {
    fg: (color, text) => {
      syntaxHighlighted ||= color.startsWith("syntax");
      return text;
    },
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
  };
  const keybindings = {
    matches(data, binding) {
      return binding === "tui.select.cancel" && data === "\u001b";
    },
    getKeys(binding) {
      return binding === "tui.select.cancel" ? ["escape", "ctrl+c"] : [];
    },
  };
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  return {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      notify() {},
      async custom(factory) {
        let resolveResult;
        const resultPromise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const component = factory(tui, theme, keybindings, resolveResult);
        component.render(80);
        onFirstFrame(performance.now() - startedAt, { syntaxHighlighted });
        if (closeAfterFirstFrame) resolveResult(undefined);
        const result = await resultPromise;
        component.dispose?.();
        return result;
      },
    },
  };
}

async function measure(scenario, timeoutMs) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", scenario], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  if (exit.code !== 0) {
    throw new Error(
      `Benchmark worker failed (scenario=${scenario}, code=${exit.code}, signal=${exit.signal ?? "none"}).\n${stderr}\n${stdout}`,
    );
  }
  return JSON.parse(stdout.trim());
}

function summarize(values) {
  if (values.length === 0) return undefined;
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
    help: false,
    runs: DEFAULT_RUNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    worker: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--runs") {
      parsed.runs = positiveInteger(requireValue(args, ++index, argument), argument);
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = positiveInteger(requireValue(args, ++index, argument), argument);
    } else if (argument === "--worker") parsed.worker = requireValue(args, ++index, argument);
    else fail(`Unknown argument: ${argument}`);
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
  process.stdout.write("Usage: node scripts/benchmark-tui-kit-runtime.mjs [options]\n\n");
  process.stdout.write(`  --runs <count>       Measured runs after warm-up (default: ${DEFAULT_RUNS})\n`);
  process.stdout.write(`  --timeout-ms <n>     Per-worker timeout (default: ${DEFAULT_TIMEOUT_MS})\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
