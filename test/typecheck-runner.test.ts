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
  npmFailure?: "build";
  compilerFailure?: "check" | "signal";
  discoveryFailure?: "staged" | "selection";
  missingNpm?: boolean;
  missingCompiler?: boolean;
  unknownWorkspace?: boolean;
  noWorkspaces?: boolean;
  checkoutPrefix?: string;
}

interface Entry {
  kind: "npm" | "selected-build" | "compiler";
  args?: string[];
  workspaceNames?: string[];
  ready?: string;
  cwd?: string;
}

const workspaceNames = ["@fixture/feature", "@fixture/app"];
const buildNames = ["@fixture/library", ...workspaceNames];
const workspaces = [
  { name: "@fixture/app", directoryName: "app's space %two%" },
  { name: "@fixture/feature", directoryName: "feature space & (one)" },
  { name: "@fixture/unselected", directoryName: "unselected" },
];

function run(options: Options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), options.checkoutPrefix ?? "pi typecheck runner-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(path.resolve("scripts/run-typechecks.mjs"), path.join(root, "scripts/run-typechecks.mjs"));
    for (const { directoryName } of workspaces) {
      mkdirSync(path.join(root, "packages", directoryName), { recursive: true });
    }
    writeFileSync(
      path.join(root, "scripts/workspace-graph.mjs"),
      "export function readWorkspaces() { return JSON.parse(process.env.TEST_WORKSPACES); }",
    );
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
      record({ kind: "npm", args: process.argv.slice(2), ready: process.env.PI_EXTENSIONS_BUILD_READY });
      if (process.env.TEST_NPM_FAILURE === "build") process.exit(9);`,
    );
    if (!options.missingCompiler) {
      const compilerDirectory = path.join(root, "node_modules", "tsc-rs");
      mkdirSync(path.join(compilerDirectory, "bin"), { recursive: true });
      writeFileSync(path.join(compilerDirectory, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(
        path.join(compilerDirectory, "bin", "tsc-rs"),
        `${trace}
        record({ kind: "compiler", args: process.argv.slice(2), cwd: process.cwd(), ready: process.env.PI_EXTENSIONS_BUILD_READY });
        if (process.env.TEST_COMPILER_FAILURE === "check") process.exit(2);
        if (process.env.TEST_COMPILER_FAILURE === "signal") process.kill(process.pid, "SIGTERM");`,
      );
    }
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
        TEST_WORKSPACES: JSON.stringify(options.noWorkspaces ? [] : workspaces),
        TEST_SELECTION: JSON.stringify({
          mode: options.mode ?? "affected",
          workspaceNames: options.unknownWorkspace ? [...workspaceNames, "@fixture/missing"] : workspaceNames,
          workspaceDirectories: ["feature", "app"],
          buildWorkspaceNames: options.emptyBuilds ? [] : buildNames,
          reason: "fixture selection",
        }),
        TEST_BUILD_STATUS: String(options.buildStatus ?? 0),
        TEST_NPM_FAILURE: options.npmFailure ?? "",
        TEST_COMPILER_FAILURE: options.compilerFailure ?? "",
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

function compilerEntries(root: string, names: string[], ready = ""): Entry[] {
  return names.map((name) => {
    const workspace = workspaces.find((workspace) => workspace.name === name);
    assert.ok(workspace);
    return {
      kind: "compiler",
      args: ["--noEmit"],
      cwd: path.join(root, "packages", workspace.directoryName),
      ready,
    };
  });
}

const allWorkspaceNames = workspaces.map(({ name }) => name);
for (const ready of [false, true]) {
  test(`tsc-rs ${ready ? "reuses ready full prerequisites" : "builds full prerequisites before checking"}`, () => {
    const { root, result, entries } = run({ staged: false, ready, discoveryFailure: "staged" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(entries, [
      ...(ready ? [] : [{ kind: "npm", args: ["run", "build"], ready: "" }]),
      ...compilerEntries(root, allWorkspaceNames, "1"),
    ]);
  });

  test(`tsc-rs ${ready ? "reuses ready affected prerequisites" : "builds selected prerequisites before checking"}`, () => {
    const { root, result, entries } = run({ ready });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(entries, [
      ...(ready ? [] : [{ kind: "selected-build", workspaceNames: buildNames }]),
      ...compilerEntries(root, workspaceNames, ready ? "1" : ""),
    ]);
  });
}

for (const checkoutPrefix of ["pi checkout with spaces-", "pi checkout's & (%PATH%) $ Ω-"]) {
  for (const staged of [false, true]) {
    test(`real ${staged ? "selected" : "full"} compiler dispatch preserves ${checkoutPrefix}`, () => {
      const { root, result, entries } = run({ checkoutPrefix, staged, ready: true });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(entries, compilerEntries(root, staged ? workspaceNames : allWorkspaceNames, "1"));
    });
  }
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
  assert.deepEqual(entries, compilerEntries(root, workspaceNames));
});

test("tsc-rs preserves full selection for staged shared inputs", () => {
  const { root, result, entries } = run({ mode: "full" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [
    { kind: "npm", args: ["run", "build"], ready: "" },
    ...compilerEntries(root, allWorkspaceNames, "1"),
  ]);
});

for (const discoveryFailure of ["staged", "selection"] as const) {
  test(`tsc-rs falls back to full checks after ${discoveryFailure} failure`, () => {
    const { root, result, entries } = run({ ready: true, discoveryFailure });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /falling back to all workspaces/u);
    assert.deepEqual(entries, compilerEntries(root, allWorkspaceNames, "1"));
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

test("tsc-rs preserves a compiler failure exit status and stops later checks", () => {
  const { root, result, entries } = run({ ready: true, compilerFailure: "check" });
  assert.equal(result.status, 2);
  assert.deepEqual(entries, compilerEntries(root, workspaceNames.slice(0, 1), "1"));
});

test("tsc-rs rejects an npm build spawn failure", () => {
  const { result, entries } = run({ staged: false, missingNpm: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/u);
  assert.deepEqual(entries, []);
});

test("tsc-rs rejects a signalled checker and stops later checks", () => {
  const { root, result, entries } = run({ ready: true, compilerFailure: "signal" });
  assert.equal(result.status, 1);
  assert.deepEqual(entries, compilerEntries(root, workspaceNames.slice(0, 1), "1"));
});

test("a missing installed compiler fails without npm or a compiler download", () => {
  const { result, entries } = run({ ready: true, missingCompiler: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MODULE_NOT_FOUND/u);
  assert.deepEqual(entries, []);
});

test("an unknown selected workspace fails before any compiler starts", () => {
  const { result, entries } = run({ ready: true, unknownWorkspace: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown typecheck workspace: @fixture\/missing/u);
  assert.deepEqual(entries, []);
});

test("a missing workspace inventory cannot pass a full check", () => {
  const { result, entries } = run({ staged: false, ready: true, noWorkspaces: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No typecheck workspaces found/u);
  assert.deepEqual(entries, []);
});
