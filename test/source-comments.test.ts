import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vitest";

const script = resolve("scripts/check-source-comments.mjs");
const baseline = "scripts/source-comments-baseline.txt";
const src = "packages/pilot/src";
const example = `${src}/example.ts`;

function key(path: string, comment: string): string {
  return `${JSON.stringify(path)}\t${createHash("sha256").update(comment).digest("hex")}\n`;
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-source-comments-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const write = (path: string, source: string) => {
    const absolute = join(cwd, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  };
  git("init", "--quiet");
  const commit = () => {
    git("add", "--", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "--message",
      "test fixture",
    );
    return git("rev-parse", "HEAD").trim();
  };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
    });
    assert.ifError(result.error ?? null);
    return result;
  };
  return [{ cwd, write, commit, run }, () => rmSync(cwd, { recursive: true, force: true })] as const;
}

test("inventories actual source comments and counts only lines that can disappear", () => {
  const [{ run, write }, dispose] = fixture();
  try {
    write(
      `${src}/view.tsx`,
      [
        'const url = "https://example.test";',
        "const regex = /https?:\\/\\//;",
        `const template = \`/* text */ \${/* real */ 0}\`;`,
        'const view = <div title="/* attribute */">// JSX text{/* JSX comment */}</div>;',
        "/** Real line",
        " * with details */",
      ].join("\n"),
    );
    write(`${src}/theme.css`, 'a { content: "/* not a comment */"; color: red /* same line */; }\n/* one line */\n');
    write(`${src}/tool.cjs`, "#!/usr/bin/env node\nmodule.exports = 1; // CommonJS\n");
    write("packages/pilot/test/unscoped.ts", "// not scanned\n");
    write("deprecated/pilot/src/unscoped.ts", "// not scanned\n");
    write(".gitignore", "ignored.ts\n");
    write(`${src}/ignored.ts`, "// not scanned\n");
    const result = run("--list", src);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [
      `${src}/theme.css:1:48 "/* same line */"`,
      `${src}/theme.css:2:1 "/* one line */"`,
      `${src}/tool.cjs:2:21 "// CommonJS"`,
      `${src}/view.tsx:3:32 "/* real */"`,
      `${src}/view.tsx:4:55 "/* JSX comment */"`,
      `${src}/view.tsx:5:1 "/** Real line\\n * with details */"`,
    ]);
    assert.match(result.stderr, /6 comments on 3 removable lines/u);
    assert.match(run("--list", `${src}/theme.css`).stderr, /2 comments on 1 removable lines/u);
  } finally {
    dispose();
  }
});

test("allows line shifts, rejects rewrites and duplicate or moved comments, and only prunes removals", () => {
  const [{ cwd, run, write, commit }, dispose] = fixture();
  try {
    const existing = key(example, "// existing");
    write(baseline, existing);
    write(example, "// existing\nconst value = 1;\n");
    commit();

    write(example, "\n// existing\nconst value = 1;\n");
    assert.equal(run().status, 0);

    write(example, "// existing\n// existing\nconst value = 1;\n");
    const duplicate = run("--prune");
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /example\.ts:2:1/u);

    write(example, "// rewritten\nconst value = 1;\n");
    assert.match(run().stderr, /example\.ts:1:1/u);
    assert.equal(readFileSync(join(cwd, baseline), "utf8"), existing);

    const moved = `${src}/moved.ts`;
    write(moved, "// existing\n");
    rmSync(join(cwd, example));
    assert.match(run().stderr, /moved\.ts:1:1/u);

    rmSync(join(cwd, moved));
    assert.match(run().stderr, /baseline is out of date/u);
    assert.equal(run("--prune").status, 0);
    assert.equal(readFileSync(join(cwd, baseline), "utf8"), "");
    assert.equal(run().status, 0);
    commit();

    write(example, "// new\n");
    write(baseline, key(example, "// new"));
    assert.match(run().stderr, /baseline cannot grow/u);
  } finally {
    dispose();
  }
});
