import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import config from "../vitest.config.js";
import { sharedModuleTests } from "./shared-module-tests.js";

const root = path.resolve(import.meta.dirname, "..");
type Project = { extends: boolean; test: { name: string; include: string[]; exclude?: string[]; isolate?: boolean } };
const projects = config.test?.projects as Project[];

function findTests(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? findTests(target)
      : entry.name.endsWith(".test.ts")
        ? [path.relative(root, target).split(path.sep).join("/")]
        : [];
  });
}

test("every source test belongs to exactly one project and new tests default to isolation", () => {
  const isolated = projects.find((project) => project.test.name === "isolated");
  const shared = projects.find((project) => project.test.name === "shared");
  assert.ok(isolated);
  assert.ok(shared);
  assert.deepEqual(isolated.test.include, ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"]);
  assert.deepEqual(shared.test.include, [...sharedModuleTests]);
  const reviewed = new Set<string>(sharedModuleTests);
  assert.equal(reviewed.size, sharedModuleTests.length);
  const inventory = [
    ...findTests(path.join(root, "test")),
    ...readdirSync(path.join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => findTests(path.join(root, "packages", entry.name, "test"))),
  ];
  for (const file of sharedModuleTests) {
    assert.match(file, /^packages\/[^/]+\/test\/[\w/-]+\.test\.ts$/u);
    assert.ok(inventory.includes(file), `missing reviewed test: ${file}`);
  }
  for (const file of [...inventory, "packages/new-package/test/new.test.ts"]) {
    const inShared: boolean = reviewed.has(file);
    const inIsolated: boolean = !isolated.test.exclude?.includes(file);
    assert.equal(Number(inShared) + Number(inIsolated), 1, file);
  }
  assert.equal(config.test?.include, undefined, "root includes would concatenate into both projects");
  assert.equal(config.test?.exclude, undefined, "root exclusions would also exclude shared tests");
});

test("both projects inherit the same bounded fork pool and timeout safeguards", () => {
  assert.equal(projects.length, 2);
  assert.equal(config.test?.pool, "forks");
  assert.ok(Number(config.test?.maxWorkers) <= 2);
  assert.equal(config.test?.testTimeout, 5_000);
  assert.equal(config.test?.runner, "./test/vitest.runner.ts");
  assert.deepEqual(config.test?.setupFiles, ["./test/vitest.setup.ts"]);
  assert.deepEqual(config.test?.globalSetup, ["./test/vitest.global-setup.ts"]);
  for (const project of projects) {
    assert.equal(project.extends, true);
    for (const key of ["maxWorkers", "pool", "runner", "setupFiles", "globalSetup", "env", "testTimeout", "sequence"]) {
      assert.equal(key in project.test, false, `${project.test.name} must inherit ${key}`);
    }
  }
  assert.notEqual(projects[0]?.test.isolate, false);
  assert.equal(projects[1]?.test.isolate, false);
});
