import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const buildRecordModule = pathToFileURL(resolve("packages/pi-sync-daemon/scripts/build-record.mjs")).href;

test("daemon build record checks local output against the selected source and version", async () => {
  const { readDaemonBuild, recordDaemonBuild } = await import(buildRecordModule);
  const fixture = await mkdtemp(join(tmpdir(), "pi-sync-build-record-"));
  const root = join(fixture, "packages/pi-sync-daemon");
  try {
    await Promise.all([mkdir(join(root, "src"), { recursive: true }), mkdir(join(root, "dist"), { recursive: true })]);
    const inputs = ["../../tsconfig.json", "tsconfig.json", "tsconfig.build.json", "package.json", "src/index.ts"];
    const outputs = ["dist/index.js", "dist/index.js.map"];
    for (const path of [...inputs, ...outputs]) await writeFile(join(root, path), path);
    await assert.rejects(readDaemonBuild(root), /Missing workspace daemon build record/u);
    await recordDaemonBuild(root);
    assert.deepEqual([...(await readDaemonBuild(root)).keys()], ["index.js", "index.js.map"]);
    for (const path of ["package.json", "src/index.ts", "dist/index.js", "dist/index.js.map"]) {
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
