import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

export interface BuildMetadata {
  inputs?: Record<string, { imports: Array<{ path: string; kind: string; external?: boolean }> }>;
  outputs?: Record<
    string,
    {
      entryPoint?: string;
      imports?: Array<{ external?: boolean; kind?: string; path: string }>;
      inputs?: Record<string, unknown>;
    }
  >;
}

export interface RuntimeBuilder {
  buildRuntime(options?: {
    outputDirectory?: string;
    validateOutput?: (outputDirectory: string) => Promise<void>;
  }): Promise<BuildMetadata>;
  validateGeneratedFiles(outputDirectory: string): Promise<void>;
  validateEagerGraph(metadata: BuildMetadata): { eagerInputs: Set<string>; eagerOutputs: Set<string> };
  publishRuntime(
    stagingDirectory: string,
    outputDirectory: string,
    operations?: { renamePath?: typeof rename },
  ): Promise<void>;
}

interface RuntimeBuilderContractOptions {
  packageId: string;
  forbiddenEagerInputs?: readonly string[];
  forbiddenEagerExternals?: readonly string[];
  allowedEagerExternals?: readonly string[];
  matchExternalSubpaths?: boolean;
  includeDynamicExternals?: boolean;
  entries?: Record<string, string>;
}

export function registerRuntimeBuilderContract(options: RuntimeBuilderContractOptions) {
  const packageRoot = resolve(`packages/${options.packageId}`);
  const builderUrl = pathToFileURL(join(packageRoot, "scripts/build-runtime.mjs")).href;
  const forbiddenEagerInputs = options.forbiddenEagerInputs ?? [];
  const forbiddenExternals = options.forbiddenEagerExternals ?? [];
  const entries = options.entries ?? { index: "src/index.ts" };

  async function loadBuilder(): Promise<RuntimeBuilder> {
    return (await import(`${builderUrl}?test=${crypto.randomUUID()}`)) as RuntimeBuilder;
  }

  function validMetadata(): BuildMetadata {
    const outputs: NonNullable<BuildMetadata["outputs"]> = {};
    for (const [name, input] of Object.entries(entries)) {
      outputs[`dist/${name}.ts`] = { entryPoint: input, imports: [], inputs: { [input]: {} } };
    }
    const entry = requireOutput({ outputs }, "dist/index.ts");
    for (const [index, input] of forbiddenEagerInputs.entries()) {
      const path = `dist/chunks/lazy-${index}.ts`;
      entry.imports?.push({ path, kind: "dynamic-import" });
      outputs[path] = { entryPoint: input, imports: [], inputs: { [input]: {} } };
    }
    return { outputs };
  }

  test(`${options.packageId} eager graph preserves first-use boundaries and external packages`, async () => {
    const builder = await loadBuilder();
    assert.doesNotThrow(() => builder.validateEagerGraph(validMetadata()));
    for (const forbidden of forbiddenEagerInputs) {
      const metadata = validMetadata();
      requireOutput(metadata, "dist/index.ts").inputs = { [forbidden]: {} };
      assert.throws(() => builder.validateEagerGraph(metadata), /First-use implementation is eager/u);
    }
    for (const dependency of forbiddenExternals) {
      for (const kind of ["import-statement", "dynamic-import"]) {
        for (const path of [dependency, `${dependency}/leaf`, `${dependency}-other`]) {
          const metadata = validMetadata();
          requireOutput(metadata, "dist/index.ts").imports?.push({ path, kind, external: true });
          const forbidden =
            (kind !== "dynamic-import" || options.includeDynamicExternals) &&
            (path === dependency || (options.matchExternalSubpaths !== false && path === `${dependency}/leaf`));
          if (forbidden) assert.throws(() => builder.validateEagerGraph(metadata), /Eager external dependency/u);
          else assert.doesNotThrow(() => builder.validateEagerGraph(metadata));
        }
      }
    }
    for (const path of options.allowedEagerExternals ?? []) {
      const metadata = validMetadata();
      requireOutput(metadata, "dist/index.ts").imports?.push({ path, kind: "import-statement", external: true });
      assert.doesNotThrow(() => builder.validateEagerGraph(metadata));
    }
    for (const path of ["dist/index.ts", "dist/chunks/dependency.ts"]) {
      const metadata = validMetadata();
      metadata.outputs ??= {};
      metadata.outputs[path] = { ...metadata.outputs[path], inputs: { "node_modules/example/index.js": {} } };
      assert.throws(() => builder.validateEagerGraph(metadata), /Bundled package input/u);
    }
  });

  test(`${options.packageId} runtime rejects destructive output paths and symlink escapes`, async () => {
    const builder = await loadBuilder();
    const outside = await mkdtemp(join(tmpdir(), `${options.packageId}-build-outside-`));
    const linkedParent = join(packageRoot, `.${options.packageId}-build-test-link-${crypto.randomUUID()}`);
    try {
      for (const outputDirectory of [
        packageRoot,
        join(packageRoot, "src"),
        join(packageRoot, "scripts"),
        join(outside, "dist"),
      ]) {
        await assert.rejects(
          builder.buildRuntime({ outputDirectory }),
          /Runtime output directory must be inside the package root/u,
        );
      }
      for (const target of [outside, join(packageRoot, "src")]) {
        await symlink(target, linkedParent, "dir");
        await assert.rejects(
          builder.buildRuntime({ outputDirectory: join(linkedParent, "dist") }),
          /Runtime output parent must not escape the package root through a symlink/u,
        );
        await rm(linkedParent);
      }
    } finally {
      await rm(linkedParent, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test(`${options.packageId} runtime is deterministic, mapped, external, and removes stale output`, async () => {
    const builder = await loadBuilder();
    const root = await mkdtemp(join(packageRoot, `.${options.packageId}-build-test-`));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      const metadata = await builder.buildRuntime({ outputDirectory: first });
      await mkdir(join(second, "chunks"), { recursive: true });
      await writeFile(join(second, "chunks", "stale.ts"), "stale");
      await builder.buildRuntime({ outputDirectory: second });
      assert.deepEqual(await snapshotDirectory(first), await snapshotDirectory(second));
      const files = await listFiles(first);
      assert.equal(files.includes("chunks/stale.ts"), false);
      for (const name of Object.keys(entries)) {
        assert.ok(files.includes(`${name}.ts`));
        assert.ok(files.includes(`${name}.ts.map`));
      }
      assert.equal(
        files.some((path) => path.endsWith(".js")),
        false,
      );
      if (forbiddenEagerInputs.length > 0)
        assert.ok(files.some((path) => path.startsWith("chunks/") && path.endsWith(".ts")));
      for (const runtimePath of files.filter((path) => path.endsWith(".ts"))) {
        assert.match(
          await readFile(join(first, runtimePath), "utf8"),
          /^\/\/ @generated by scripts\/build-runtime\.mjs/u,
        );
        assert.ok(files.includes(`${runtimePath}.map`));
      }
      await builder.validateGeneratedFiles(first);
      const outputs = metadata.outputs ?? {};
      const externalImports = Object.values(outputs)
        .flatMap((output) => output.imports ?? [])
        .filter((imported) => !Object.hasOwn(outputs, imported.path));
      assert.ok(externalImports.length > 0, "generated extension must retain external package imports");
      for (const imported of externalImports) assert.equal(imported.external, true, imported.path);
      for (const output of Object.values(outputs)) {
        for (const input of Object.keys(output.inputs ?? {})) assert.equal(input.includes("node_modules/"), false);
      }
      assert.deepEqual((await readdir(root)).sort(), ["first", "second"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test(`${options.packageId} failed validation cleans staging and preserves the previous runtime`, async () => {
    const builder = await loadBuilder();
    const root = await mkdtemp(join(packageRoot, `.${options.packageId}-build-test-`));
    try {
      const output = join(root, "dist");
      await mkdir(output);
      await writeFile(join(output, "previous.ts"), "previous");
      await assert.rejects(
        builder.buildRuntime({
          outputDirectory: output,
          validateOutput: async () => {
            throw new Error("injected validation failure");
          },
        }),
        /injected validation failure/u,
      );
      assert.deepEqual(await listFiles(root), ["dist/previous.ts"]);
      assert.equal(await readFile(join(output, "previous.ts"), "utf8"), "previous");
      assert.deepEqual(await readdir(root), ["dist"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test(`${options.packageId} failed publication restores the previous runtime`, async () => {
    const builder = await loadBuilder();
    const root = await mkdtemp(join(packageRoot, `.${options.packageId}-build-test-`));
    try {
      const output = join(root, "dist");
      await mkdir(output);
      await writeFile(join(output, "previous.ts"), "previous");
      const staging = join(root, "staging");
      await mkdir(staging);
      await writeFile(join(staging, "next.ts"), "next");
      let renameCalls = 0;
      await assert.rejects(
        builder.publishRuntime(staging, output, {
          renamePath: async (source, destination) => {
            if (++renameCalls === 2) throw new Error("injected publication failure");
            await rename(source, destination);
          },
        }),
        /injected publication failure/u,
      );
      assert.deepEqual(await listFiles(root), ["dist/previous.ts", "staging/next.ts"]);
      assert.equal(await readFile(join(output, "previous.ts"), "utf8"), "previous");
      assert.deepEqual((await readdir(root)).sort(), ["dist", "staging"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  return { packageRoot, loadBuilder };
}

function requireOutput(metadata: BuildMetadata, path: string) {
  const output = metadata.outputs?.[path];
  assert.ok(output, `missing fixture output: ${path}`);
  return output;
}

async function snapshotDirectory(directory: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const path of await listFiles(directory)) snapshot[path] = await readFile(join(directory, path), "base64");
  return snapshot;
}

export async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, relativePath)));
    else if (entry.isFile()) files.push(relativePath.replaceAll("\\", "/"));
  }
  return files.sort();
}
