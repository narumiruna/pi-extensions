import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

const root = resolve(import.meta.dirname, "..");
interface CheckCommand {
  command: string;
  env: Record<string, string>;
}
const { runChecks } = (await import(pathToFileURL(resolve("scripts/run-checks.mjs")).href)) as {
  runChecks(options: {
    execute: (commands: CheckCommand[], options: unknown) => { result: Promise<unknown> };
  }): Promise<number>;
};

test("checks execute all validators and typechecks without running tests or rebuilding", async () => {
  const commands: CheckCommand[] = [];
  assert.equal(
    await runChecks({
      execute: (selected) => {
        commands.push(...selected);
        return { result: Promise.resolve() };
      },
    }),
    0,
  );
  assert.deepEqual(commands.map(({ command }) => command).sort(), [
    "npm:check:biome",
    "npm:check:boundaries",
    "npm:check:dependencies",
    "npm:typecheck",
  ]);
  assert.ok(commands.every(({ env }) => env.PI_EXTENSIONS_BUILD_READY === "1"));
});

test("a failing validator fails the aggregate check", async () => {
  assert.equal(await runChecks({ execute: () => ({ result: Promise.reject(new Error("validator failed")) }) }), 1);
});

test("check and test remain separate root commands", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.match(manifest.scripts?.check ?? "", /run-checks\.mjs/u);
  assert.match(manifest.scripts?.test ?? "", /run-tests\.mjs/u);
  assert.doesNotMatch(manifest.scripts?.check ?? "", /npm (?:run )?test/u);
});
