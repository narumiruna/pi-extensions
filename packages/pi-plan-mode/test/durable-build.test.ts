import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { type BuildMetadata, listFiles, type RuntimeBuilder } from "../../../test/runtime-builder-contract.js";

const packageRoot = resolve("packages/pi-plan-mode");
let builder: RuntimeBuilder & { validateDurableGraph(metadata: BuildMetadata): void };
let root: string;
let metadata: BuildMetadata;
let first: string;
let second: string;
let rejectedOutput: string;

beforeAll(async () => {
  builder = await import(pathToFileURL(join(packageRoot, "scripts/build-runtime.mjs")).href);
  root = await mkdtemp(join(packageRoot, ".pi-plan-mode-build-test-durable-"));
  first = join(root, "first");
  second = join(root, "second");
  metadata = await builder.buildRuntime({ outputDirectory: first });
  await mkdir(join(second, "chunks"), { recursive: true });
  await writeFile(join(second, "chunks/stale.ts"), "stale");
  await writeFile(join(second, "stale.js"), "stale");
  await builder.buildRuntime({ outputDirectory: second });
  rejectedOutput = join(root, "rejected");
  await mkdir(rejectedOutput);
  await writeFile(join(rejectedOutput, "previous.ts"), "previous");
  await assert.rejects(
    builder.buildRuntime({
      outputDirectory: rejectedOutput,
      validateOutput: async (stage) => {
        // Both runtimes and declarations must exist before any publication.
        for (const file of ["index.ts", "durable.js", "durable.d.ts"]) await readFile(join(stage, file));
        throw new Error("injected validation failure");
      },
    }),
    /injected validation failure/u,
  );
}, 30_000);

afterAll(async () => {
  if (root) await rm(root, { force: true, recursive: true });
});

test("both staged graphs are deterministic, mapped, exact, and remove stale output", async () => {
  const files = await listFiles(first);
  assert.deepEqual(files, await listFiles(second));
  for (const file of files)
    assert.equal(await readFile(join(first, file), "base64"), await readFile(join(second, file), "base64"), file);
  for (const file of ["index.ts", "durable.js", "durable.d.ts", "durable.js.map"]) assert.ok(files.includes(file));
  assert.equal(files.includes("chunks/stale.ts"), false);
  assert.equal(files.includes("stale.js"), false);
  assert.equal(files.includes("index.js"), false, "do not invent a package-root JavaScript entry");
  await builder.validateGeneratedFiles(first);
  const sources = JSON.parse(await readFile(join(first, "durable.js.map"), "utf8")) as { sources: string[] };
  assert.ok(sources.sources.some((source) => source.endsWith("/src/durable.ts")));
  assert.ok(
    sources.sources.every((source) => !/node_modules|\/src\/(?:state|plan-mode|extension-runtime)\.ts$/u.test(source)),
  );
  for (const output of Object.values(metadata.outputs ?? {})) {
    for (const input of Object.keys(output.inputs ?? {})) assert.equal(input.includes("node_modules/"), false);
    for (const imported of output.imports ?? []) {
      if (!Object.hasOwn(metadata.outputs ?? {}, imported.path)) assert.equal(imported.external, true);
    }
  }
});

test("failed validation preserves the complete previous output and cleans staging", async () => {
  assert.deepEqual(await listFiles(rejectedOutput), ["previous.ts"]);
  assert.equal(await readFile(join(rejectedOutput, "previous.ts"), "utf8"), "previous");
  assert.deepEqual((await readdir(root)).sort(), ["first", "rejected", "second"]);
});

test("durable graph rejects bundled packages and coding-agent graphs including lazy imports", () => {
  const valid = (): BuildMetadata => ({
    outputs: { "dist/durable.js": { entryPoint: "src/durable.ts", inputs: { "src/durable.ts": {} }, imports: [] } },
  });
  assert.doesNotThrow(() => builder.validateDurableGraph(valid()));
  for (const input of [
    "node_modules/example/index.js",
    "src/state.ts",
    "src/plan-mode.ts",
    "src/extension-runtime.ts",
  ]) {
    const graph = valid();
    const output = graph.outputs?.["dist/durable.js"];
    assert.ok(output);
    output.inputs = { [input]: {} };
    assert.throws(() => builder.validateDurableGraph(graph), /Bundled package input|Coding-agent source/u);
  }
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@narumitw/pi-tui-kit"]) {
    for (const kind of ["import-statement", "dynamic-import"]) {
      for (const path of [name, `${name}/testing`]) {
        const graph = valid();
        graph.outputs?.["dist/durable.js"]?.imports?.push({ path, kind, external: true });
        assert.throws(() => builder.validateDurableGraph(graph), /Coding-agent dependency/u);
      }
    }
  }
});

test("Jiti graph preserves all lazy UI boundaries and external package scopes", () => {
  const valid = (): BuildMetadata => ({
    outputs: { "dist/index.ts": { entryPoint: "src/index.ts", inputs: { "src/index.ts": {} }, imports: [] } },
  });
  assert.doesNotThrow(() => builder.validateEagerGraph(valid()));
  for (const name of [
    "interactive-ui",
    "active-implementation-menu",
    "plan-export-screen",
    "plan-action-menus",
    "plan-launch-menu",
    "saved-plan-menu",
    "settings-menu",
  ]) {
    const graph = valid();
    const entry = graph.outputs?.["dist/index.ts"];
    assert.ok(entry);
    entry.inputs = { [`src/${name}.ts`]: {} };
    assert.throws(() => builder.validateEagerGraph(graph), /First-use implementation is eager/u);
  }
  for (const kind of ["import-statement", "dynamic-import"]) {
    for (const path of ["@narumitw/pi-tui-kit", "@narumitw/pi-tui-kit/testing", "@narumitw/pi-tui-kit-other"]) {
      const graph = valid();
      graph.outputs?.["dist/index.ts"]?.imports?.push({ path, kind, external: true });
      if (kind === "import-statement" && path !== "@narumitw/pi-tui-kit-other") {
        assert.throws(() => builder.validateEagerGraph(graph), /Eager external dependency/u);
      } else assert.doesNotThrow(() => builder.validateEagerGraph(graph));
    }
  }
  const bundled = valid();
  const entry = bundled.outputs?.["dist/index.ts"];
  assert.ok(entry);
  entry.inputs = { "node_modules/example/index.js": {} };
  assert.throws(() => builder.validateEagerGraph(bundled), /Bundled package input/u);
});

test.each([
  ["durable.js", 'export { missing } from "./missing.js";'],
  ["durable.js", 'export const lazy = () => import("./missing.js");'],
  ["index.ts", 'export const lazy = () => import("./durable.js");'],
  ["durable.js", 'export { default } from "./index.ts";'],
  ["durable.d.ts", 'export type { Missing } from "./missing.js";'],
  ["durable.d.ts", 'export type Missing = import("./missing.js").Missing;'],
  ["durable.d.ts", 'export type { ExtensionAPI } from "@earendil-works/pi-coding-agent";'],
])("generated import validation rejects %s: %s", async (file, addition) => {
  const corrupted = await mkdtemp(join(root, "corrupted-"));
  try {
    await cp(first, corrupted, { recursive: true });
    await writeFile(join(corrupted, file), `${await readFile(join(corrupted, file), "utf8")}\n${addition}`);
    await assert.rejects(
      builder.validateGeneratedFiles(corrupted),
      /no exact runtime target|exact path|Coding-agent dependency/u,
    );
  } finally {
    await rm(corrupted, { force: true, recursive: true });
  }
});

test("build rejects unowned output paths and symlink escapes", async () => {
  const outside = await mkdtemp(join(tmpdir(), "pi-plan-mode-build-outside-"));
  const linked = join(packageRoot, `.pi-plan-mode-build-test-link-${crypto.randomUUID()}`);
  try {
    for (const outputDirectory of [
      packageRoot,
      join(packageRoot, "src"),
      join(packageRoot, "scripts"),
      join(outside, "dist"),
    ]) {
      await assert.rejects(builder.buildRuntime({ outputDirectory }), /inside the package root/u);
    }
    for (const target of [outside, join(packageRoot, "src")]) {
      await symlink(target, linked, "dir");
      await assert.rejects(builder.buildRuntime({ outputDirectory: join(linked, "dist") }), /symlink/u);
      await rm(linked);
    }
  } finally {
    await rm(linked, { force: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("failed publication restores the previous complete runtime", async () => {
  const directory = await mkdtemp(join(root, "publication-"));
  const output = join(directory, "dist");
  const stage = join(directory, "staging");
  try {
    await mkdir(output);
    await mkdir(stage);
    await writeFile(join(output, "previous.ts"), "previous");
    await writeFile(join(stage, "next.ts"), "next");
    let calls = 0;
    await assert.rejects(
      builder.publishRuntime(stage, output, {
        renamePath: async (source, destination) => {
          if (++calls === 2) throw new Error("injected publication failure");
          await rename(source, destination);
        },
      }),
      /injected publication failure/u,
    );
    assert.deepEqual(await listFiles(directory), ["dist/previous.ts", "staging/next.ts"]);
    assert.equal(await readFile(join(output, "previous.ts"), "utf8"), "previous");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
