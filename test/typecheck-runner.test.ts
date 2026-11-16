import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

interface Options {
  staged?: boolean;
  ready?: boolean;
  mode?: "affected" | "full" | "skip";
  emptyBuilds?: boolean;
  buildStatus?: number;
  npmFailure?: "build" | "check" | "signal";
  discoveryFailure?: "staged" | "selection";
  missingNpm?: boolean;
}

interface Entry {
  kind: "npm" | "selected-build";
  args?: string[];
  workspaceNames?: string[];
  ready?: string;
}

const workspaceNames = ["@fixture/feature", "@fixture/app"];
const buildNames = ["@fixture/library", ...workspaceNames];

function run(options: Options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi typecheck runner-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(path.resolve("scripts/run-typechecks.mjs"), path.join(root, "scripts/run-typechecks.mjs"));
    writeFileSync(
      path.join(root, "scripts/select-staged-typechecks.mjs"),
      `export function stagedFiles() {
        if (process.env.TEST_DISCOVERY_FAILURE === "staged") throw new Error("staged discovery failed");
        return ["packages/feature/src/index.ts"];
      }
      export function selectStagedTypechecks() {
        if (process.env.TEST_DISCOVERY_FAILURE === "selection") throw new Error("selection failed");
        return JSON.parse(process.env.TEST_SELECTION);
      }`,
    );
    const trace = `import { appendFileSync } from "node:fs";
      function record(entry) { appendFileSync(process.env.TEST_TRACE, JSON.stringify(entry) + "\\n"); }`;
    writeFileSync(
      path.join(root, "scripts/run-builds.mjs"),
      `${trace}
      export function runBuilds({ workspaceNames }) {
        record({ kind: "selected-build", workspaceNames });
        return Number(process.env.TEST_BUILD_STATUS);
      }`,
    );
    const npm = path.join(root, "npm.mjs");
    writeFileSync(
      npm,
      `${trace}
      const args = process.argv.slice(2);
      record({ kind: "npm", args, ready: process.env.PI_EXTENSIONS_BUILD_READY });
      const build = args[0] === "run" && args[1] === "build";
      if (build && process.env.TEST_NPM_FAILURE === "build") process.exit(9);
      if (!build && process.env.TEST_NPM_FAILURE === "check") process.exit(2);
      if (!build && process.env.TEST_NPM_FAILURE === "signal") process.kill(process.pid, "SIGTERM");`,
    );
    const tracePath = path.join(root, "trace.jsonl");
    const args = ["scripts/run-typechecks.mjs"];
    if (options.staged !== false) args.push("--staged");
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_execpath: options.missingNpm ? "" : npm,
        ...(options.missingNpm ? { PATH: "" } : {}),
        PI_EXTENSIONS_BUILD_READY: options.ready ? "1" : "",
        TEST_TRACE: tracePath,
        TEST_SELECTION: JSON.stringify({
          mode: options.mode ?? "affected",
          workspaceNames,
          workspaceDirectories: ["feature", "app"],
          buildWorkspaceNames: options.emptyBuilds ? [] : buildNames,
          reason: "fixture selection",
        }),
        TEST_BUILD_STATUS: String(options.buildStatus ?? 0),
        TEST_NPM_FAILURE: options.npmFailure ?? "",
        TEST_DISCOVERY_FAILURE: options.discoveryFailure ?? "",
      },
    });
    const entries: Entry[] = existsSync(tracePath)
      ? readFileSync(tracePath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Entry)
      : [];
    return { root, result, entries };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function checkArgs(root: string, selected = false) {
  const workspaces = selected ? workspaceNames.flatMap((name) => ["--workspace", name]) : ["--workspaces"];
  return [
    ...workspaces,
    "exec",
    "--",
    path.join(root, "node_modules/.bin", process.platform === "win32" ? "tsc-rs.cmd" : "tsc-rs"),
    "--noEmit",
  ];
}

for (const ready of [false, true]) {
  test(`tsc-rs ${ready ? "reuses ready full prerequisites" : "builds full prerequisites before checking"}`, () => {
    const { root, result, entries } = run({ staged: false, ready, discoveryFailure: "staged" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      entries.map(({ args }) => args),
      [...(ready ? [] : [["run", "build"]]), checkArgs(root)],
    );
    assert.equal(entries.at(-1)?.ready, "1");
  });

  test(`tsc-rs ${ready ? "reuses ready affected prerequisites" : "builds selected prerequisites before checking"}`, () => {
    const { root, result, entries } = run({ ready });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(entries, [
      ...(ready ? [] : [{ kind: "selected-build", workspaceNames: buildNames }]),
      { kind: "npm", args: checkArgs(root, true), ready: ready ? "1" : "" },
    ]);
  });
}

test("tsc-rs skips documentation-only staged changes", () => {
  const { result, entries } = run({ mode: "skip" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, []);
  assert.match(result.stdout, /Skipping workspace typechecks/u);
});

test("tsc-rs checks affected workspaces without unnecessary builds", () => {
  const { root, result, entries } = run({ emptyBuilds: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [{ kind: "npm", args: checkArgs(root, true), ready: "" }]);
});

test("tsc-rs preserves full selection for staged shared inputs", () => {
  const { root, result, entries } = run({ mode: "full" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    entries.map(({ args }) => args),
    [["run", "build"], checkArgs(root)],
  );
});

for (const discoveryFailure of ["staged", "selection"] as const) {
  test(`tsc-rs falls back to full checks after ${discoveryFailure} failure`, () => {
    const { root, result, entries } = run({ ready: true, discoveryFailure });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /falling back to all workspaces/u);
    assert.deepEqual(entries, [{ kind: "npm", args: checkArgs(root), ready: "1" }]);
  });
}

test("tsc-rs stops after a selected prerequisite fails", () => {
  const { result, entries } = run({ buildStatus: 7 });
  assert.equal(result.status, 7);
  assert.deepEqual(entries, [{ kind: "selected-build", workspaceNames: buildNames }]);
});

test("tsc-rs stops after a full prerequisite build fails", () => {
  const { result, entries } = run({ staged: false, npmFailure: "build" });
  assert.equal(result.status, 9);
  assert.deepEqual(entries, [{ kind: "npm", args: ["run", "build"], ready: "" }]);
});

test("tsc-rs preserves a compiler failure exit status", () => {
  const { result } = run({ ready: true, npmFailure: "check" });
  assert.equal(result.status, 2);
});

test("tsc-rs rejects an npm spawn failure", () => {
  const { result, entries } = run({ ready: true, missingNpm: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/u);
  assert.deepEqual(entries, []);
});

test("tsc-rs rejects a signalled checker", () => {
  const { result } = run({ ready: true, npmFailure: "signal" });
  assert.equal(result.status, 1);
});
