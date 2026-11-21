import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const scripts = resolve("packages/pi-sync-daemon/scripts");
const buildRecordModule = pathToFileURL(join(scripts, "build-record.mjs")).href;

test.skipIf(process.platform === "win32")("daemon build rejects an edit after the compiler emits", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-sync-build-input-race-"));
  const root = join(fixture, "packages/pi-sync-daemon");
  const bin = join(fixture, "bin");
  try {
    for (const path of ["scripts", "src"]) await mkdir(join(root, path), { recursive: true });
    await mkdir(bin);
    for (const file of ["build.mjs", "build-record.mjs"])
      await copyFile(join(scripts, file), join(root, "scripts", file));
    for (const file of ["../../tsconfig.json", "package.json", "tsconfig.json", "tsconfig.build.json"])
      await writeFile(join(root, file), "{}");
    await writeFile(join(root, "src/index.ts"), 'export const value = "before";\n');
    // Simulate a successful compiler, then an editor save before it returns to the build script.
    await writeFile(
      join(bin, "npm"),
      `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(process.argv.slice(2), ['exec', '--', 'tsc', '-p', 'tsconfig.build.json']);
fs.mkdirSync('dist');
fs.writeFileSync('dist/index.js', fs.readFileSync('src/index.ts'));
fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\\n');
fs.writeFileSync('src/index.ts', 'export const value = "after";\\n');
`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: [bin, process.env.PATH].join(delimiter) },
    });
    assert.ifError(result.error);
    assert.match(await readFile(join(root, "dist/index.js"), "utf8"), /before/u);
    assert.match(await readFile(join(root, "src/index.ts"), "utf8"), /after/u);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Daemon build inputs changed during compilation/u);
    const { readDaemonBuild } = await import(buildRecordModule);
    await assert.rejects(readDaemonBuild(root), /Missing workspace daemon build record/u);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("daemon build record checks local output against the selected source and version", async () => {
  const { captureDaemonInputs, readDaemonBuild, recordDaemonBuild } = await import(buildRecordModule);
  const fixture = await mkdtemp(join(tmpdir(), "pi-sync-build-record-"));
  const root = join(fixture, "packages/pi-sync-daemon");
  try {
    await Promise.all([mkdir(join(root, "src"), { recursive: true }), mkdir(join(root, "dist"), { recursive: true })]);
    const inputs = ["../../tsconfig.json", "tsconfig.json", "tsconfig.build.json", "package.json", "src/index.ts"];
    const outputs = ["dist/index.js", "dist/index.js.map"];
    for (const path of [...inputs, ...outputs]) await writeFile(join(root, path), path);
    await assert.rejects(readDaemonBuild(root), /Missing workspace daemon build record/u);
    await recordDaemonBuild(root, await captureDaemonInputs(root));
    const { manifest, files } = await readDaemonBuild(root);
    assert.equal(manifest, await readFile(join(root, "package.json"), "utf8"));
    assert.deepEqual([...files.keys()], ["index.js", "index.js.map"]);
    for (const path of [...inputs, ...outputs]) {
      await writeFile(join(root, path), "changed");
      await assert.rejects(readDaemonBuild(root), /Stale or mismatched workspace daemon build/u);
      await writeFile(join(root, path), path);
    }
    await writeFile(join(root, "dist/stale.js"), "stale");
    await assert.rejects(readDaemonBuild(root), /Stale or mismatched workspace daemon build/u);
    await rm(join(root, "dist/stale.js"));
    await rm(join(root, "dist/index.js"));
    await assert.rejects(readDaemonBuild(root), /Stale or mismatched workspace daemon build/u);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
