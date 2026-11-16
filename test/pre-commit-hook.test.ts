import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const biome = path.join(repositoryRoot, "node_modules", ".bin", "biome");
const packageFile = "packages/feature/src/index.ts";
const workflowFile = ".github/workflows/check.yml";
const originalPackage = "export const value = 1;\n";
let fixture: string;
let root: string;
let bin: string;
let snapshots: string;
let log: string;
let snapshotLog: string;

beforeEach(() => {
  fixture = mkdtempSync(path.join(os.tmpdir(), "pi-precommit-hook-"));
  root = path.join(fixture, "repository");
  bin = path.join(fixture, "bin");
  snapshots = path.join(fixture, "snapshots");
  log = path.join(fixture, "commands.log");
  snapshotLog = path.join(fixture, "snapshot.log");
  for (const directory of [root, bin, snapshots, path.join(root, "node_modules", ".bin")]) {
    mkdirSync(directory, { recursive: true });
  }
  symlinkSync(biome, path.join(root, "node_modules", ".bin", "biome"));
  git(["init", "-q"]);
  write(".gitignore", "node_modules/\n");
  write("biome.json", readFileSync(path.join(repositoryRoot, "biome.json"), "utf8"));
  write(packageFile, originalPackage);
  write(workflowFile, "# safe workflow\n");
  write(".github/workflows/other.yml", "# safe workflow\n");
  write("README.md", "# Fixture\n");
  write(
    "scripts/run-typechecks.mjs",
    'import { appendFileSync } from "node:fs";\n\nappendFileSync(process.env.PRECOMMIT_LOG, "typecheck\\n");\nprocess.exit(process.env.PRECOMMIT_FAIL_STEP === "typecheck" ? 23 : 0);\n',
  );
  copyFileSync(path.join(repositoryRoot, "scripts", "pre-commit.sh"), path.join(root, "scripts", "pre-commit.sh"));
  execFileSync(biome, ["format", "--write", "."], { cwd: root, stdio: "pipe" });
  git(["add", "."]);
  git([
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-qm",
    "fixture",
  ]);
  writeFileSync(
    path.join(bin, "npx"),
    `#!/bin/sh
set -eu
[ "$1" = biome ]
shift
printf '%s\\n' "$*" >> "$PRECOMMIT_LOG"
if [ "$*" = "\${PRECOMMIT_FAIL_STEP:-}" ]; then exit 23; fi
exec "$PRECOMMIT_BIOME" "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "uvx"),
    `#!/bin/sh
set -eu
[ "$*" = 'zizmor --pedantic .github' ]
printf '%s\\n' "$PWD" > "$PRECOMMIT_SNAPSHOT_LOG"
printf 'zizmor\\n' >> "$PRECOMMIT_LOG"
if [ "\${PRECOMMIT_FAIL_STEP:-}" = zizmor ]; then exit 23; fi
if [ -n "\${PRECOMMIT_SIGNAL:-}" ]; then kill -"$PRECOMMIT_SIGNAL" "$PPID"; exit 0; fi
if grep -R -q unsafe-workflow .github; then
  printf 'Unsafe workflow in audited snapshot\\n' >&2
  exit 1
fi
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

test("rejects unfixed staged package content and preserves manual staging", () => {
  const unfixed = "export const value=2\n";
  write(packageFile, unfixed);
  git(["add", "--", packageFile]);

  const result = runHook();

  assert.equal(result.status, 1, result.stderr);
  assert.equal(indexText(packageFile), unfixed);
  assert.equal(readFileSync(path.join(root, packageFile), "utf8"), "export const value = 2;\n");
  assert.doesNotMatch(readFileSync(log, "utf8"), /typecheck/u);
});

test("checks a staged root file even when its working copy is fixed", () => {
  const file = "test/root.test.ts";
  const unfixed = "export const value=2\n";
  write(file, unfixed);
  git(["add", "--", file]);
  write(file, "export const value = 2;\n");

  const result = runHook();

  assert.equal(result.status, 1, result.stderr);
  assert.equal(indexText(file), unfixed);
});

test("rejects indexed lint warnings even when the working configuration disables the rule", () => {
  const config = JSON.parse(readFileSync(path.join(root, "biome.json"), "utf8"));
  config.linter.rules.suspicious.noDebugger = "warn";
  write("biome.json", `${JSON.stringify(config)}\n`);
  execFileSync(biome, ["format", "--write", "biome.json"], { cwd: root, stdio: "pipe" });
  write("test/warning.test.ts", "debugger;\nexport {};\n");
  git(["add", "--", "biome.json", "test/warning.test.ts"]);
  config.linter.rules.suspicious.noDebugger = "off";
  write("biome.json", `${JSON.stringify(config)}\n`);

  const result = runHook();

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /noDebugger/u);
  assert.match(result.stderr, /warning/iu);
});

test("audits an unsafe staged workflow instead of its safe working copy", () => {
  write(workflowFile, "# unsafe-workflow\n");
  git(["add", "--", workflowFile]);
  write(workflowFile, "# safe workflow\n");

  const result = runHook();

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unsafe workflow/u);
  assert.equal(indexText(workflowFile), "# unsafe-workflow\n");
  assert.notEqual(readFileSync(snapshotLog, "utf8").trim(), root);
});

test("does not audit unsafe unstaged workflow edits or change the index", () => {
  write("README.md", "# Updated fixture\n");
  git(["add", "--", "README.md"]);
  write(workflowFile, "# unsafe-workflow\n");
  const tree = git(["write-tree"]);

  const result = runHook();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(["write-tree"]), tree);
  assert.match(readFileSync(log, "utf8"), /zizmor\ntypecheck\n/u);
});

test("fixes unstaged packages without blocking a commit that stages no packages", () => {
  write("README.md", "# Updated fixture\n");
  git(["add", "--", "README.md"]);
  write(packageFile, "export const value=3\n");
  const tree = git(["write-tree"]);

  const result = runHook();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(["write-tree"]), tree);
  assert.equal(indexText(packageFile), originalPackage);
  assert.equal(readFileSync(path.join(root, packageFile), "utf8"), "export const value = 3;\n");
});

test("preserves a valid partial stage while fixing unstaged edits in the same package file", () => {
  const staged = "export const value = 2;\n";
  write(packageFile, staged);
  git(["add", "--", packageFile]);
  write(packageFile, "export const value=3\n");

  const result = runHook();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(indexText(packageFile), staged);
  assert.equal(readFileSync(path.join(root, packageFile), "utf8"), "export const value = 3;\n");
});

test.each(["space name.ts", "line\nbreak.ts", 'quote"name.ts', "日本語.ts"])(
  "checks indexed package paths without shell parsing: %j",
  (name) => {
    const file = `packages/feature/src/${name}`;
    write(file, "export const value=2\n");
    git(["add", "--", file]);

    const result = runHook();

    assert.equal(result.status, 1, result.stderr);
    assert.equal(indexText(file), "export const value=2\n");
  },
);

test("checks a staged rename and excludes a staged workflow deletion", () => {
  const renamed = "packages/feature/src/renamed file.ts";
  git(["mv", "--", packageFile, renamed]);
  write(renamed, "export const value=3\n");
  git(["rm", "--", workflowFile]);
  write(workflowFile, "# unsafe-workflow\n");
  const tree = git(["write-tree"]);

  const result = runHook();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(["write-tree"]), tree);
  assert.equal(indexText(renamed), originalPackage);
});

test.each(["migrate --write", "check --write packages", "format --write packages", "zizmor", "typecheck"])(
  "stops on a tool failure and removes its snapshot: %s",
  (step) => {
    const result = runHook({ PRECOMMIT_FAIL_STEP: step });

    assert.equal(result.status, 23, result.stderr);
    if (step !== "typecheck") assert.doesNotMatch(readFileSync(log, "utf8"), /typecheck/u);
  },
);

test.each(["TERM", "HUP", "INT"])("removes its snapshot after a child receives %s", (signal) => {
  const result = runHook({ PRECOMMIT_SIGNAL: signal });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(readFileSync(log, "utf8"), /typecheck/u);
});

function runHook(extraEnv: Record<string, string> = {}) {
  const result = spawnSync("sh", ["scripts/pre-commit.sh"], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: snapshots,
      PRECOMMIT_BIOME: biome,
      PRECOMMIT_LOG: log,
      PRECOMMIT_SNAPSHOT_LOG: snapshotLog,
    },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(readdirSync(snapshots), []);
  return result;
}

function write(file: string, content: string) {
  const destination = path.join(root, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function indexText(file: string) {
  return git(["show", `:${file}`]);
}

function git(args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}
