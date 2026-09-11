import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const boundaryScript = resolve("scripts/check-extension-boundaries.mjs");

test("extension boundary validator accepts the direct source entrypoint", async () => {
  const fixture = await createFixture({ entrypoint: "./src/index.ts" });
  try {
    const result = runBoundaryCheck(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 active extensions/u);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("extension boundary validator accepts a complete build-backed dist entrypoint", async () => {
  const fixture = await createFixture({ entrypoint: "./dist/index.ts" });
  try {
    const result = runBoundaryCheck(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 active extensions/u);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("extension boundary validator requires every active package in the root manifest", async () => {
  const fixture = await createFixture({ entrypoint: "./src/index.ts", rootExtensions: [] });
  try {
    const result = runBoundaryCheck(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must list every active package entrypoint/u);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("extension boundary validator rejects unsupported and incomplete dist entrypoints", async () => {
  const fixtureCases: Array<{ name: string; options: FixtureOptions; expected: RegExp }> = [
    {
      name: "unsupported path",
      options: { entrypoint: "./extension.ts" },
      expected: /pi\.extensions must be/u,
    },
    {
      name: "missing dist files entry",
      options: { entrypoint: "./dist/index.ts", files: ["src"] },
      expected: /must publish dist/u,
    },
    {
      name: "missing build script",
      options: { entrypoint: "./dist/index.ts", scripts: { prepack: "npm run build" } },
      expected: /must define a build script/u,
    },
    {
      name: "missing prepack script",
      options: { entrypoint: "./dist/index.ts", scripts: { build: "node build.mjs" } },
      expected: /prepack must run the package build/u,
    },
  ];
  for (const fixtureCase of fixtureCases) {
    const fixture = await createFixture(fixtureCase.options);
    try {
      const result = runBoundaryCheck(fixture);
      assert.notEqual(result.status, 0, `${fixtureCase.name} unexpectedly passed`);
      assert.match(result.stderr, fixtureCase.expected, fixtureCase.name);
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  }
});

interface FixtureOptions {
  entrypoint: string;
  files?: readonly string[];
  rootExtensions?: readonly string[];
  scripts?: Readonly<Record<string, string>>;
}

async function createFixture(options: FixtureOptions) {
  const root = await mkdtemp(join(tmpdir(), "pi-extension-boundaries-"));
  const packageDirectory = join(root, "packages", "pi-fixture");
  await mkdir(join(packageDirectory, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "fixture-root",
      private: true,
      pi: {
        extensions: options.rootExtensions ?? ["./packages/pi-fixture/src/index.ts"],
      },
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
      include: ["packages/**/*.ts"],
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({
      name: "@narumitw/pi-fixture",
      type: "module",
      files: options.files ?? ["src", "dist"],
      pi: { extensions: [options.entrypoint] },
      scripts: options.scripts ?? {
        build: "node scripts/build-runtime.mjs",
        prepack: "npm run build",
      },
    })}\n`,
    "utf8",
  );
  await writeFile(join(packageDirectory, "src", "index.ts"), 'export { default } from "./extension.js";\n', "utf8");
  await writeFile(join(packageDirectory, "src", "extension.ts"), "export default function fixture() {}\n", "utf8");
  return root;
}

function runBoundaryCheck(cwd: string) {
  return spawnSync(process.execPath, [boundaryScript], {
    cwd,
    encoding: "utf8",
  });
}
