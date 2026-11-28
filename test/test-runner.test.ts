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
    args: string[];
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
  root = mkdtempSync(path.join(os.tmpdir(), "pi test runner &-"));
  mkdirSync(path.join(root, "packages"));
  mkdirSync(path.join(root, "test"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  writeFileSync(path.join(root, "test/example.test.ts"), "// fixture\n");
  calls = [];
  logs = [];
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

function run(env: NodeJS.ProcessEnv = {}, results: CommandResult[] = [], args: string[] = []) {
  return runner.runTests({
    args,
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
    if (ready !== "1") assert.deepEqual(calls[0]?.args.slice(-2), ["run", "build"]);
    assert.equal(calls.at(-2)?.command, process.execPath);
    assert.deepEqual(calls.at(-2)?.args, [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.test.json",
    ]);
    assert.deepEqual(calls.at(-1)?.args, [path.join(root, "node_modules/vitest/vitest.mjs"), "run"]);
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

for (const platform of ["win32", "linux"]) {
  for (const npmCli of [undefined, path.join("npm path & spaces", "npm-cli.js")]) {
    test(`launchers use executable entries without a shell (${platform}, npm_execpath=${String(npmCli)})`, () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      assert.ok(descriptor);
      try {
        Object.defineProperty(process, "platform", { value: platform });
        assert.equal(run({ npm_execpath: npmCli }), 0);
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
      const cli =
        npmCli ??
        (platform === "win32"
          ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
          : undefined);
      assert.equal(calls[0]?.command, cli ? process.execPath : "npm");
      assert.deepEqual(calls[0]?.args, [...(cli ? [cli] : []), "run", "build"]);
      assert.equal(calls[1]?.command, process.execPath);
      assert.deepEqual(calls[1]?.args, [
        path.join(root, "node_modules/typescript/bin/tsc"),
        "-p",
        "tsconfig.test.json",
      ]);
      assert.ok(calls.every(({ options }) => !Object.hasOwn(options, "shell")));
      assert.ok(calls.every(({ options }) => options.cwd === root && options.stdio === "inherit"));
    });
  }
}

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

for (const stage of [0, 1, 2]) {
  for (const result of [{ status: null }, { status: null, error: new Error("fixture spawn failure") }]) {
    test(`an unavailable child fails closed (stage=${stage}, ${result.error ? "spawn error" : "signal"})`, () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      assert.equal(run({}, [...Array.from({ length: stage }, () => ({ status: 0 })), result]), 1);
      assert.equal(calls.length, stage + 1);
    });
  }
}

function cliFixture() {
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts);
  const entry = path.join(scripts, "run-tests.mjs");
  for (const script of ["npm-invocation.mjs", "run-tests.mjs"]) {
    copyFileSync(path.join(repositoryRoot, "scripts", script), path.join(scripts, script));
  }
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
  return entry;
}

function assertCliValidation(script: string) {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Missing test files for active extension/u);
}

test("the CLI validates its inventory while importing its API stays side-effect free", () => {
  const entry = cliFixture();
  assertCliValidation(entry);
  const imported = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)})`],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(imported, "");
});

test("the CLI runs through a symlink when the host permits its creation", ({ skip }) => {
  const entry = cliFixture();
  const alias = path.join(path.dirname(entry), "alias.mjs");
  try {
    symlinkSync(entry, alias);
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      skip("Windows file symlinks require Developer Mode or symlink privileges.");
    }
    throw error;
  }
  assertCliValidation(alias);
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
  assert.deepEqual(calls.at(-1)?.args, [path.join(root, "node_modules/vitest/vitest.mjs"), "run"]);
});

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

for (const [changedFile, expected] of [
  ["test/example.test.ts", []],
  ["packages/pi-base/src/index.ts", ["pi-base", "pi-consumer"]],
  ["scripts/shared.mjs", ["pi-base", "pi-consumer", "pi-unrelated"]],
] as const) {
  test(`local and CI selection cover the same groups (${changedFile})`, () => {
    for (const name of ["pi-base", "pi-consumer", "pi-unrelated"]) {
      mkdirSync(path.join(root, "packages", name, "test"), { recursive: true });
      writeFileSync(path.join(root, "packages", name, "test/example.test.ts"), "// fixture\n");
      writeFileSync(
        path.join(root, "packages", name, "package.json"),
        JSON.stringify({ name, version: "1.0.0", dependencies: name === "pi-consumer" ? { "pi-base": "*" } : {} }),
      );
    }
    git(["init", "-q"]);
    git(["add", "package.json", "test", "packages"]);
    git(["commit", "-qm", "fixture base"]);
    const base = git(["rev-parse", "HEAD"]);
    mkdirSync(path.dirname(path.join(root, changedFile)), { recursive: true });
    writeFileSync(path.join(root, changedFile), "// changed\n");
    git(["add", changedFile]);
    git(["commit", "-qm", "fixture change"]);
    assert.equal(run({ PI_EXTENSIONS_TEST_BASE: base }), 0);
    const filters =
      changedFile === "scripts/shared.mjs"
        ? []
        : [
            path.join(root, "test/example.test.ts"),
            ...expected.map((name) => path.join(root, "packages", name, "test/example.test.ts")),
          ];
    assert.deepEqual(calls.at(-1)?.args, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...filters]);
    assert.equal(calls.length, 3);

    calls.length = 0;
    const output = path.join(root, "outputs");
    assert.equal(
      run(
        { GITHUB_OUTPUT: output, PI_EXTENSIONS_BUILD_READY: "1", PI_EXTENSIONS_TEST_BASE: base },
        [],
        ["--prepare-ci"],
      ),
      0,
    );
    assert.deepEqual(
      calls.map(({ args }) => args.at(-1)),
      ["tsconfig.test.json"],
    );
    assert.equal(readFileSync(output, "utf8"), `test-root=true\npackages=${JSON.stringify(expected)}\n`);
  });
}

test("CI preparation keeps compilation failures fatal and publishes no plan", () => {
  const output = path.join(root, "outputs");
  assert.equal(run({ GITHUB_OUTPUT: output, PI_EXTENSIONS_BUILD_READY: "1" }, [{ status: 23 }], ["--prepare-ci"]), 23);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(output), false);
});

for (const [shard, directory] of [
  ["root", "test"],
  ["pi-base", "packages/pi-base/test"],
] as const) {
  test(`CI shard ${shard} only runs Vitest and leaves restored inputs intact`, () => {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, "example.test.ts"), "// fixture\n");
    const compiled = path.join(root, "node_modules/.cache/pi-extensions-test");
    mkdirSync(compiled, { recursive: true });
    writeFileSync(path.join(compiled, "fixture.js"), "// compiled\n");
    assert.equal(run({}, [{ status: 31 }], ["--ci-shard", shard]), 31);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, [path.join(root, "node_modules/vitest/vitest.mjs"), "run"]);
    assert.equal(calls[0]?.options.env.PI_EXTENSIONS_TEST_DIRECTORY, directory);
    assert.ok(existsSync(path.join(compiled, "fixture.js")));
  });
}

for (const args of [
  ["--ci-shard", "root"],
  ["--ci-shard", "pi-missing"],
  ["--ci-shard", "../root"],
  ["--prepare-ci"],
]) {
  test(`CI rejects missing artifacts, invalid shards, or missing outputs (${args.join(" ")})`, () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    assert.equal(run({}, [], args), 1);
    assert.equal(calls.length, 0);
  });
}

test("documentation-only changes skip all commands", () => {
  git(["init", "-q"]);
  git(["add", "package.json", "test/example.test.ts"]);
  git(["commit", "-qm", "fixture base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "fixture docs"]);
  assert.equal(run({ PI_EXTENSIONS_TEST_BASE: base }), 0);
  const output = path.join(root, "outputs");
  assert.equal(run({ GITHUB_OUTPUT: output, PI_EXTENSIONS_TEST_BASE: base }, [], ["--prepare-ci"]), 0);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(output, "utf8"), "test-root=false\npackages=[]\n");
});

test("CI compiles only after the separate successful check gate", () => {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.match(manifest.scripts.check, /^npm run build && /u);
  assert.equal((manifest.scripts.check.match(/npm run build/gu) ?? []).length, 1);
  const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const [before, tests = ""] = workflow.split("      - name: Select and compile tests\n");
  assert.match(before ?? "", /- name: Run checks\s+run: npm run check/u);
  assert.doesNotMatch(before ?? "", /PI_EXTENSIONS_BUILD_READY|continue-on-error/u);
  assert.match(tests, /env:\s+PI_EXTENSIONS_BUILD_READY: "1"/u);
  assert.match(tests, /run: npm test -- --prepare-ci/u);
  assert.match(tests, /run: npm test -- --ci-shard root/u);
  assert.match(tests, /run: npm test -- --ci-shard "\$TEST_PACKAGE"/u);
  assert.doesNotMatch(workflow, /continue-on-error/u);
});

test.skipIf(process.platform === "win32")("required CI check rejects failures and unplanned skips", () => {
  const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const gate = workflow.slice(workflow.indexOf("\n  ci:\n"));
  assert.match(gate, /name: ci\n {4}needs: \[check, test-root, test-package\]\n {4}if: always\(\)/u);
  const script = gate.split("        run: |\n")[1];
  assert.ok(script);
  for (const [check, root, packages, testRoot, plan, status] of [
    ["success", "success", "success", "true", '["pi-base"]', 0],
    ["success", "success", "skipped", "true", "[]", 0],
    ["success", "skipped", "skipped", "false", "[]", 0],
    ["failure", "skipped", "skipped", "", "", 1],
    ["cancelled", "skipped", "skipped", "false", "[]", 1],
    ["success", "failure", "success", "true", '["pi-base"]', 1],
    ["success", "skipped", "success", "true", '["pi-base"]', 1],
    ["success", "success", "failure", "true", '["pi-base"]', 1],
    ["success", "success", "cancelled", "true", '["pi-base"]', 1],
    ["success", "success", "skipped", "true", '["pi-base"]', 1],
    ["success", "success", "skipped", "true", "", 1],
  ] as const) {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: {
        ...process.env,
        CHECK_RESULT: check,
        ROOT_RESULT: root,
        PACKAGE_RESULT: packages,
        TEST_ROOT: testRoot,
        PACKAGES: plan,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, status, `${[check, root, packages, testRoot, plan].join(", ")}: ${result.stderr}`);
  }
});
