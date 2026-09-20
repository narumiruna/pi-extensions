import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const benchmarkScript = resolve("scripts/benchmark-extension-startup.mjs");
const benchmarkUrl = pathToFileURL(benchmarkScript).href;

type BenchmarkModule = {
  childEnvironment(environment: NodeJS.ProcessEnv, agentDir: string, cacheMode: "warm" | "cold"): NodeJS.ProcessEnv;
  parseArguments(
    args: string[],
    environment?: NodeJS.ProcessEnv,
  ): {
    baseline: boolean;
    cacheMode: "warm" | "cold";
    entries: string[];
    help: boolean;
    pi: string;
    piArgs: string[];
    runs: number;
    timeoutMs: number;
  };
  parseExtensionTimings(
    output: string,
    options?: { allowEmpty?: boolean },
  ): { imports: Array<{ entry: string; ms: number }>; total: number };
  summarize(values: number[]): {
    median: number | null;
    medianAbsoluteDeviation: number | null;
    min: number | null;
    max: number | null;
  };
};

async function loadBenchmark(): Promise<BenchmarkModule> {
  return (await import(`${benchmarkUrl}?test=${crypto.randomUUID()}`)) as BenchmarkModule;
}

test("startup benchmark parses cold, warm, baseline, and process options", async () => {
  const benchmark = await loadBenchmark();
  assert.deepEqual(benchmark.parseArguments([], { PI_STARTUP_BENCHMARK_PI: "custom-pi" }), {
    baseline: false,
    cacheMode: "warm",
    entries: [],
    help: false,
    pi: "custom-pi",
    piArgs: [],
    runs: 5,
    timeoutMs: 60_000,
  });
  assert.deepEqual(
    benchmark.parseArguments([
      "--baseline",
      "--cache-mode",
      "cold",
      "--entry",
      "first.ts",
      "-e",
      "second.ts",
      "--pi",
      "pi-test",
      "--pi-arg",
      "custom-cli.mjs",
      "--runs",
      "3",
      "--timeout-ms",
      "2500",
    ]),
    {
      baseline: true,
      cacheMode: "cold",
      entries: ["first.ts", "second.ts"],
      help: false,
      pi: "pi-test",
      piArgs: ["custom-cli.mjs"],
      runs: 3,
      timeoutMs: 2500,
    },
  );

  for (const [args, expected] of [
    [["--cache-mode", "unknown"], /must be warm or cold/u],
    [["--cache-mode"], /requires a value/u],
    [["--runs", "0"], /positive integer/u],
    [["--timeout-ms", "1.5"], /positive integer/u],
    [["--unknown"], /Unknown argument/u],
  ] as const) {
    assert.throws(() => benchmark.parseArguments([...args]), expected);
  }
});

test("startup benchmark controls Jiti cache state without dropping caller environment", async () => {
  const benchmark = await loadBenchmark();
  const base = {
    CUSTOM_VALUE: "preserved",
    JITI_FS_CACHE: "inherited",
    JITI_REBUILD_FS_CACHE: "inherited",
  };
  assert.deepEqual(benchmark.childEnvironment(base, "relative-agent", "cold"), {
    ...base,
    PI_CODING_AGENT_DIR: resolve("relative-agent"),
    PI_OFFLINE: "1",
    PI_TIMING: "1",
    JITI_FS_CACHE: "false",
    JITI_REBUILD_FS_CACHE: "false",
  });
  assert.equal(benchmark.childEnvironment(base, "relative-agent", "warm").JITI_FS_CACHE, "true");
});

test("startup benchmark parses per-extension timings and an empty baseline", async () => {
  const benchmark = await loadBenchmark();
  const output = [
    "unrelated",
    "--- Startup Timings: extensions ---",
    "  first.ts module import: 12ms",
    "  first.ts factory: 1ms",
    "  second.ts module import: 7ms",
    "-------------------------------",
  ].join("\n");
  assert.deepEqual(benchmark.parseExtensionTimings(output), {
    imports: [
      { entry: "first.ts", ms: 12 },
      { entry: "second.ts", ms: 7 },
    ],
    total: 19,
  });
  assert.deepEqual(benchmark.parseExtensionTimings("no extension timings", { allowEmpty: true }), {
    imports: [],
    total: 0,
  });
  assert.throws(() => benchmark.parseExtensionTimings("no extension timings"), /No extension module-import timings/u);
});

test("startup benchmark summarizes stable and empty samples", async () => {
  const benchmark = await loadBenchmark();
  assert.deepEqual(benchmark.summarize([10, 14, 30]), {
    median: 14,
    medianAbsoluteDeviation: 4,
    min: 10,
    max: 30,
  });
  assert.deepEqual(benchmark.summarize([]), {
    median: null,
    medianAbsoluteDeviation: null,
    min: null,
    max: null,
  });
});

test("cold benchmark reports a baseline and cleans every isolated agent directory", () => {
  const fixture = createFakePi();
  try {
    const result = spawnSync(
      process.execPath,
      [
        benchmarkScript,
        "--baseline",
        "--cache-mode",
        "cold",
        "--entry",
        "fixture-extension.ts",
        "--pi",
        process.execPath,
        "--pi-arg",
        fixture.script,
        "--runs",
        "1",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: { ...process.env, FAKE_PI_CAPTURE: fixture.capture },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      protocolVersion: number;
      cacheMode: string;
      environment: { node: string; platform: string };
      warmup: { importTotalMs: number };
      baseline: { measurements: Array<{ importTotalMs: number }> };
      measurements: Array<{ imports: Array<{ entry: string; ms: number }> }>;
    };
    assert.equal(report.protocolVersion, 2);
    assert.equal(report.cacheMode, "cold");
    assert.equal(report.environment.node, process.version);
    assert.equal(report.environment.platform, process.platform);
    assert.equal(report.warmup.importTotalMs, 3);
    assert.deepEqual(report.measurements[0]?.imports, [{ entry: resolve("fixture-extension.ts"), ms: 3 }]);
    assert.equal(report.baseline.measurements[0]?.importTotalMs, 0);

    const captures = readFileSync(fixture.capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { agentDir: string; fsCache: string; rebuildCache: string });
    assert.equal(captures.length, 4);
    for (const capture of captures) {
      assert.equal(capture.fsCache, "false");
      assert.equal(capture.rebuildCache, "false");
      assert.equal(existsSync(capture.agentDir), false);
    }
  } finally {
    fixture.cleanup();
  }
});

test("startup benchmark kills a timed-out child and removes its agent directory", () => {
  const fixture = createFakePi();
  try {
    const result = spawnSync(
      process.execPath,
      [
        benchmarkScript,
        "--entry",
        "fixture-extension.ts",
        "--pi",
        process.execPath,
        "--pi-arg",
        fixture.script,
        "--runs",
        "1",
        "--timeout-ms",
        "100",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: { ...process.env, FAKE_PI_CAPTURE: fixture.capture, FAKE_PI_HANG: "1" },
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Pi benchmark failed/u);
    const capture = JSON.parse(readFileSync(fixture.capture, "utf8").trim()) as { agentDir: string };
    assert.equal(existsSync(capture.agentDir), false);
  } finally {
    fixture.cleanup();
  }
});

function createFakePi() {
  const root = mkdtempSync(join(tmpdir(), "pi-startup-benchmark-fixture-"));
  const capture = join(root, "capture.jsonl");
  const script = join(root, "fake-pi.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
const extensions = process.argv.flatMap((argument, index, args) => argument === "--extension" ? [args[index + 1]] : []);
appendFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({ agentDir: process.env.PI_CODING_AGENT_DIR, fsCache: process.env.JITI_FS_CACHE, rebuildCache: process.env.JITI_REBUILD_FS_CACHE }) + "\\n");
if (process.env.FAKE_PI_HANG === "1") {
  setInterval(() => {}, 1000);
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stderr.write("--- Startup Timings: extensions ---\\n");
    for (const extension of extensions) process.stderr.write("  " + extension + " module import: 3ms\\n");
    process.stderr.write("-------------------------------\\n");
    process.stdout.write(JSON.stringify({ type: "response", command: "get_commands", success: true }) + "\\n");
  });
}
`,
    "utf8",
  );

  return {
    capture,
    script,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}
