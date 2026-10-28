import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";

interface CommandResult {
  status: number | null;
  error?: Error;
}
interface Invocation {
  command: string;
  args: string[];
  options: { cwd: string; stdio: string; env: NodeJS.ProcessEnv };
}
interface Runner {
  runTests(options: {
    root: string;
    env: NodeJS.ProcessEnv;
    execute: (command: string, args: string[], options: Invocation["options"]) => CommandResult;
    log: (message: string) => void;
  }): number;
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
let runner: Runner;
let root: string;
let calls: Invocation[];
let logs: string[];

beforeAll(async () => {
  runner = await import(pathToFileURL(path.join(repositoryRoot, "scripts/run-tests.mjs")).href);
});
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "pi-test-runner-"));
  mkdirSync(path.join(root, "packages"));
  mkdirSync(path.join(root, "test"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  writeFileSync(path.join(root, "test/example.test.ts"), "// fixture\n");
  calls = [];
  logs = [];
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

function run(env: NodeJS.ProcessEnv = {}, results: CommandResult[] = []) {
  return runner.runTests({
    root,
    env,
    execute(command, args, options) {
      calls.push({ command, args, options });
      return results[calls.length - 1] ?? { status: 0 };
    },
    log: (message) => logs.push(message),
  });
}

for (const ready of [undefined, "0", "true", "1"]) {
  test(`build reuse requires exactly 1, received ${String(ready)}`, () => {
    const cache = path.join(root, "node_modules/.cache/pi-extensions-test");
    mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, "stale.js"), "stale");
    assert.equal(run({ PI_EXTENSIONS_BUILD_READY: ready }), 0);
    assert.equal(calls.length, ready === "1" ? 2 : 3);
    if (ready !== "1") assert.deepEqual(calls[0]?.args, ["run", "build"]);
    assert.deepEqual(calls.at(-2)?.args, ["-p", "tsconfig.test.json"]);
    assert.deepEqual(calls.at(-1)?.args.slice(1), ["run", path.join(root, "test/example.test.ts")]);
    assert.equal(calls.at(-1)?.command, process.execPath);
    assert.equal(existsSync(cache), false);
    const temp = calls.at(-1)?.options.env;
    assert.equal(temp?.TMPDIR, temp?.TMP);
    assert.equal(temp?.TMP, temp?.TEMP);
    assert.equal(temp?.TMPDIR, realpathSync(os.tmpdir()));
    assert.equal(temp?.NODE_COMPILE_CACHE, path.join(root, "node_modules/.cache/pi-extensions-node-compile-cache"));
    assert.ok(logs.some((line) => /^\[test timing\] Test compilation: \d+ ms$/u.test(line)));
    assert.ok(logs.some((line) => /^\[test timing\] Vitest: \d+ ms$/u.test(line)));
    assert.equal(
      logs.some((line) => line.includes("reused")),
      ready === "1",
    );
  });
}

for (const configured of ["/custom/node-cache", "", undefined]) {
  test(`Node cache overrides and explicit disabling are preserved (${String(configured)})`, () => {
    assert.equal(run({ NODE_COMPILE_CACHE: configured, NODE_DISABLE_COMPILE_CACHE: "1" }), 0);
    const env = calls.at(-1)?.options.env;
    assert.equal(
      env?.NODE_COMPILE_CACHE,
      configured ?? path.join(root, "node_modules/.cache/pi-extensions-node-compile-cache"),
    );
    assert.equal(env?.NODE_DISABLE_COMPILE_CACHE, "1");
  });
}

for (const coverage of ["", "/external/v8-coverage"]) {
  for (const cache of [undefined, "", "/explicit/node-cache"]) {
    test(`external V8 coverage suppresses only the automatic cache (${coverage}, ${String(cache)})`, () => {
      assert.equal(run({ NODE_V8_COVERAGE: coverage, NODE_COMPILE_CACHE: cache }), 0);
      assert.equal(calls.at(-1)?.options.env.NODE_COMPILE_CACHE, cache);
      assert.equal(calls.at(-1)?.options.env.NODE_V8_COVERAGE, coverage);
    });
  }
}

test("Node bytecode caching preserves source invalidation and falls back when disabled or unwritable", () => {
  const modulePath = path.join(root, "value.mjs");
  const cachePath = path.join(root, "bytecode");
  const probe = (cache: string, disabled?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: cache };
    // This child loads only generated fixture code, not source covered by the caller.
    delete env.NODE_V8_COVERAGE;
    if (disabled === undefined) delete env.NODE_DISABLE_COMPILE_CACHE;
    else env.NODE_DISABLE_COMPILE_CACHE = disabled;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { getCompileCacheDir } from "node:module";
      const { value } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      console.log(JSON.stringify({ value, cache: getCompileCacheDir() ?? null }));
    `,
      ],
      { encoding: "utf8", env },
    );
    return JSON.parse(output) as { value: number; cache: string | null };
  };
  writeFileSync(modulePath, "export const value = 1;\n");
  const cold = probe(cachePath);
  assert.equal(cold.value, 1);
  assert.ok(cold.cache);
  assert.ok(realpathSync(cold.cache).startsWith(`${realpathSync(cachePath)}${path.sep}`));
  assert.equal(probe(cachePath).value, 1);
  writeFileSync(modulePath, "export const value = 2;\n");
  assert.equal(probe(cachePath).value, 2);
  assert.deepEqual(probe(cachePath, "1"), { value: 2, cache: null });
  assert.deepEqual(probe(cachePath, ""), { value: 2, cache: null });
  const unavailable = path.join(root, "not-a-directory");
  writeFileSync(unavailable, "occupied");
  assert.deepEqual(probe(unavailable), { value: 2, cache: null });
});

test("optional report cleanup failure warns without replacing the test exit code", () => {
  const reportPath = path.join(root, "node_modules/.cache/pi-extensions-test-report.json");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, "stale");
  const remove = fs.rmSync;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const spy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (target === reportPath) throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
    return remove(target, options);
  });
  try {
    assert.equal(run({}, [{ status: 0 }, { status: 0 }, { status: 31 }]), 31);
    assert.equal(calls.length, 3);
    assert.equal(readFileSync(reportPath, "utf8"), "stale");
    assert.ok(warning.mock.calls.some(([message]) => String(message).includes("may be stale")));
  } finally {
    spy.mockRestore();
    warning.mockRestore();
  }
});

test("npm_execpath runs npm through the current Node executable", () => {
  assert.equal(run({ npm_execpath: "/fixture/npm-cli.js" }), 0);
  assert.equal(calls[0]?.command, process.execPath);
  assert.deepEqual(calls[0]?.args, ["/fixture/npm-cli.js", "run", "build"]);
});

for (const [stage, results, count, code] of [
  ["Build", [{ status: 17 }], 1, 17],
  ["Test compilation", [{ status: 0 }, { status: 23 }], 2, 23],
  ["Vitest", [{ status: 0 }, { status: 0 }, { status: 31 }], 3, 31],
] as const) {
  test(`${stage} failure stops the pipeline and retains the exit code`, () => {
    assert.equal(run({}, [...results]), code);
    assert.equal(calls.length, count);
    assert.ok(logs.some((line) => line.startsWith(`[test timing] ${stage}:`) && line.endsWith("(failed)")));
  });
}

for (const result of [{ status: null }, { status: null, error: new Error("fixture spawn failure") }]) {
  test(`an unavailable child fails closed (${result.error ? "spawn error" : "signal"})`, () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    assert.equal(run({}, [result]), 1);
    assert.equal(calls.length, 1);
  });
}

test("the CLI runs through a symlink while importing its API stays side-effect free", () => {
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts);
  const entry = path.join(scripts, "run-tests.mjs");
  copyFileSync(path.join(repositoryRoot, "scripts/run-tests.mjs"), entry);
  // Early validation must run before either selector or any external command.
  writeFileSync(
    path.join(scripts, "select-affected-tests.mjs"),
    "export function changedFilesSince() { throw Error('unexpected selector'); }\nexport function selectAffectedTests() { throw Error('unexpected selector'); }\n",
  );
  mkdirSync(path.join(root, "packages/missing"));
  writeFileSync(
    path.join(root, "packages/missing/package.json"),
    JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
  );
  const alias = path.join(scripts, "alias.mjs");
  symlinkSync(entry, alias);
  for (const script of [entry, alias]) {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Missing test files for active extension/u);
  }
  const imported = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)})`],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(imported, "");
});

test("missing active-extension tests fail before build", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mkdirSync(path.join(root, "packages/missing"));
  writeFileSync(
    path.join(root, "packages/missing/package.json"),
    JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
  );
  assert.equal(run(), 1);
  assert.equal(calls.length, 0);
});

test("an empty selected inventory never starts Vitest", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  rmSync(path.join(root, "test/example.test.ts"));
  assert.equal(run(), 1);
  assert.equal(calls.length, 2);
});

test("a failed selection falls back to the full suite", () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  assert.equal(run({ PI_EXTENSIONS_TEST_BASE: "not-a-commit" }), 0);
  assert.equal(calls.length, 3);
  assert.match(logs[0] ?? "", /selection failed/u);
});

test("documentation-only changes skip all commands", () => {
  function git(args: string[]) {
    return execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  }
  git(["init", "-q"]);
  git(["add", "package.json", "test/example.test.ts"]);
  git(["commit", "-qm", "fixture base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "fixture docs"]);
  assert.equal(run({ PI_EXTENSIONS_TEST_BASE: base }), 0);
  assert.equal(calls.length, 0);
});

test("CI reuses build output only after the separate successful check gate", () => {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.match(manifest.scripts.check, /^npm run build && /u);
  assert.equal((manifest.scripts.check.match(/npm run build/gu) ?? []).length, 1);
  const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const [before, tests = ""] = workflow.split("      - name: Run affected tests\n");
  assert.match(before ?? "", /- name: Run checks\s+run: npm run check/u);
  assert.doesNotMatch(before ?? "", /PI_EXTENSIONS_BUILD_READY|continue-on-error/u);
  assert.match(tests, /env:\s+PI_EXTENSIONS_BUILD_READY: "1"/u);
  assert.match(tests, /run: npm test/u);
  assert.doesNotMatch(tests, /always\(|continue-on-error/u);
});
