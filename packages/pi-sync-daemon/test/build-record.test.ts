import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const scripts = resolve("packages/pi-sync-daemon/scripts");
const buildRecordModule = pathToFileURL(join(scripts, "build-record.mjs")).href;

test("daemon build rejects an edit after the compiler emits", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-sync-build-input-race-"));
  const root = join(fixture, "packages/pi-sync-daemon");
  const compiler = join(fixture, "node_modules/typescript/bin/tsc.mjs");
  try {
    for (const path of ["scripts", "src"]) await mkdir(join(root, path), { recursive: true });
    await mkdir(dirname(compiler), { recursive: true });
    await writeFile(
      join(fixture, "node_modules/typescript/package.json"),
      JSON.stringify({
        name: "typescript",
        type: "module",
        bin: { tsc: "./bin/tsc.mjs" },
        exports: { "./package.json": "./package.json" },
      }),
    );
    for (const file of ["build.mjs", "build-record.mjs"])
      await copyFile(join(scripts, file), join(root, "scripts", file));
    for (const file of ["../../tsconfig.json", "package.json", "tsconfig.json", "tsconfig.build.json"])
      await writeFile(join(root, file), "{}");
    await writeFile(join(root, "src/index.ts"), 'export const value = "before";\n');
    // Simulate a successful compiler, then an editor save before it returns to the build script.
    await writeFile(
      compiler,
      `import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.deepEqual(process.argv.slice(2), ['-p', 'tsconfig.build.json']);
fs.mkdirSync('dist');
fs.writeFileSync('dist/index.js', fs.readFileSync('src/index.ts'));
fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\\n');
fs.writeFileSync('src/index.ts', 'export const value = "after";\\n');
`,
    );
    const result = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], { encoding: "utf8" });
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
    assert.deepEqual([...files.keys()], ["index.js", "index.js.map", "build-id.json"]);
    const id = files.get("build-id.json")?.toString();
    assert.match(JSON.parse(id ?? "null"), /^[a-f0-9]{64}$/u);
    await writeFile(join(root, "dist/build-id.json"), '"wrong"');
    await assert.rejects(readDaemonBuild(root), /Mismatched daemon build identifier/u);
    await writeFile(join(root, "dist/build-id.json"), id ?? "");
    for (const path of [...inputs, ...outputs]) {
      await writeFile(join(root, path), "changed");
      await assert.rejects(readDaemonBuild(root), /Stale or mismatched workspace daemon build/u);
      await writeFile(join(root, path), path);
    }
    await writeFile(join(root, "dist/index.js.map"), "different source map");
    await recordDaemonBuild(root, await captureDaemonInputs(root));
    assert.equal((await readDaemonBuild(root)).files.get("build-id.json")?.toString(), id);
    await writeFile(join(root, "dist/index.js"), "different executable");
    await recordDaemonBuild(root, await captureDaemonInputs(root));
    const next = await readDaemonBuild(root);
    assert.notEqual(next.files.get("build-id.json")?.toString(), id);
    assert.equal(next.manifest, manifest);
    await writeFile(join(root, "dist/stale.js"), "stale");
    await assert.rejects(readDaemonBuild(root), /Stale or mismatched workspace daemon build/u);
    await rm(join(root, "dist/stale.js"));
    await rm(join(root, "dist/index.js"));
    await assert.rejects(readDaemonBuild(root), /Stale or mismatched workspace daemon build/u);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
