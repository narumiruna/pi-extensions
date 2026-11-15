import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

test("the package retains its extension without bundled skills", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi, { extensions: ["./dist/index.ts"] });
  assert.equal(manifest.files.includes("skills"), false);
  assert.equal(existsSync(new URL("../skills/", import.meta.url)), false);
});

test("the repository exposes the Herdr extension without its former skills path", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./packages/pi-herdr/src/index.ts"));
  assert.equal(manifest.pi.skills.includes("./packages/pi-herdr/skills"), false);
});
