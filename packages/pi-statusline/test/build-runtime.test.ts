import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const packageRoot = resolve("packages/pi-statusline");
const builderUrl = pathToFileURL(join(packageRoot, "scripts/build-runtime.mjs")).href;

type BuildMetadata = {
  outputs?: Record<
    string,
    {
      entryPoint?: string;
      imports?: Array<{ external?: boolean; kind?: string; path: string }>;
      inputs?: Record<string, unknown>;
    }
  >;
};

type RuntimeBuilder = {
  buildRuntime(options?: {
    outputDirectory?: string;
    validateOutput?: (outputDirectory: string) => Promise<void>;
  }): Promise<BuildMetadata>;
  validateEagerGraph(metadata: BuildMetadata): {
    eagerInputs: Set<string>;
    eagerOutputs: Set<string>;
  };
  validateGeneratedFiles(outputDirectory: string): Promise<void>;
  publishRuntime(
    stagingDirectory: string,
    outputDirectory: string,
    operations?: { renamePath?: typeof rename },
  ): Promise<void>;
};

async function loadBuilder(): Promise<RuntimeBuilder> {
  return (await import(`${builderUrl}?test=${crypto.randomUUID()}`)) as RuntimeBuilder;
}

function validMetadata(): BuildMetadata {
  return {
    outputs: {
      "dist/index.ts": {
        entryPoint: "src/index.ts",
        imports: [
          { path: "dist/chunks/eager.ts", kind: "import-statement" },
          { path: "dist/chunks/commands.ts", kind: "dynamic-import" },
          {
            path: "@earendil-works/pi-coding-agent",
            kind: "import-statement",
            external: true,
          },
        ],
        inputs: { "src/index.ts": {}, "src/statusline.ts": {} },
      },
      "dist/chunks/eager.ts": {
        imports: [],
        inputs: { "src/render.ts": {}, "src/settings.ts": {} },
      },
      "dist/chunks/commands.ts": {
        entryPoint: "src/commands.ts",
        imports: [{ path: "@narumitw/pi-tui-kit", kind: "import-statement", external: true }],
        inputs: { "src/commands.ts": {}, "src/information-profiles.ts": {} },
      },
    },
  };
}

test("eager graph validation keeps command UI lazy", async () => {
  const builder = await loadBuilder();
  assert.doesNotThrow(() => builder.validateEagerGraph(validMetadata()));
});

test("eager graph validation rejects every first-use implementation", async () => {
  const builder = await loadBuilder();
  for (const forbidden of ["src/commands.ts"]) {
    const metadata = validMetadata();
    const eagerOutput = requireOutput(metadata, "dist/chunks/eager.ts");
    const eagerInputs = eagerOutput.inputs ?? {};
    eagerOutput.inputs = eagerInputs;
    eagerInputs[forbidden] = {};
    assert.throws(
      () => builder.validateEagerGraph(metadata),
      new RegExp(`First-use implementation is eager: ${forbidden.replaceAll("/", "\\/")}`, "u"),
    );
  }
});

test("eager graph validation rejects eager TUI Kit and bundled dependencies", async () => {
  const builder = await loadBuilder();
  const eagerDependency = validMetadata();
  const eagerOutput = requireOutput(eagerDependency, "dist/chunks/eager.ts");
  const eagerImports = eagerOutput.imports ?? [];
  eagerOutput.imports = eagerImports;
  eagerImports.push({
    path: "@narumitw/pi-tui-kit",
    kind: "import-statement",
    external: true,
  });
  assert.throws(() => builder.validateEagerGraph(eagerDependency), /Eager external dependency: @narumitw\/pi-tui-kit/u);

  const bundledDependency = validMetadata();
  const commandOutput = requireOutput(bundledDependency, "dist/chunks/commands.ts");
  const commandInputs = commandOutput.inputs ?? {};
  commandOutput.inputs = commandInputs;
  commandInputs["node_modules/example/index.js"] = {};
  assert.throws(() => builder.validateEagerGraph(bundledDependency), /Bundled package input: .*node_modules\/example/u);
});

test("runtime build rejects destructive output paths", async () => {
  const builder = await loadBuilder();
  const outside = await mkdtemp(join(tmpdir(), "pi-statusline-build-outside-"));
  const linkedParent = join(packageRoot, `.pi-statusline-build-test-link-${crypto.randomUUID()}`);
  try {
    await assert.rejects(
      builder.buildRuntime({ outputDirectory: packageRoot }),
      /Runtime output directory must be inside the package root/u,
    );
    await assert.rejects(
      builder.buildRuntime({ outputDirectory: join(outside, "dist") }),
      /Runtime output directory must be inside the package root/u,
    );
    await symlink(outside, linkedParent, "dir");
    await assert.rejects(
      builder.buildRuntime({ outputDirectory: join(linkedParent, "dist") }),
      /Runtime output parent must not escape the package root through a symlink/u,
    );
  } finally {
    await rm(linkedParent, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("runtime builds are deterministic, mapped, external, and remove stale chunks", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-statusline-build-test-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    const firstMetadata = await builder.buildRuntime({ outputDirectory: first });
    await mkdir(join(second, "chunks"), { recursive: true });
    await writeFile(join(second, "chunks", "stale.ts"), "stale", "utf8");
    const secondMetadata = await builder.buildRuntime({ outputDirectory: second });

    assert.deepEqual(await snapshotDirectory(first), await snapshotDirectory(second));
    assert.equal((await listFiles(second)).includes("chunks/stale.ts"), false);
    assert.doesNotThrow(() => builder.validateEagerGraph(firstMetadata));
    assert.doesNotThrow(() => builder.validateEagerGraph(secondMetadata));

    const files = await listFiles(first);
    assert.ok(files.includes("index.ts"));
    assert.ok(files.includes("index.ts.map"));
    assert.ok(files.some((path) => path.startsWith("chunks/") && path.endsWith(".js")));
    for (const runtimePath of files.filter((path) => path.endsWith(".ts") || path.endsWith(".js"))) {
      const source = await readFile(join(first, runtimePath), "utf8");
      assert.match(source, /^\/\/ @generated by scripts\/build-runtime\.mjs/u);
      assert.doesNotMatch(source, /["']\.\.?\/[^"']+\.ts["']/u);
      assert.doesNotMatch(source, /["']\.\.?\/[^"']*src\//u);
      assert.ok(files.includes(`${runtimePath}.map`), `missing source map for ${runtimePath}`);
    }

    for (const output of Object.values(firstMetadata.outputs ?? {})) {
      for (const input of Object.keys(output.inputs ?? {})) {
        assert.equal(input.includes("node_modules/"), false, `bundled package input: ${input}`);
      }
    }

    const entrySource = await readFile(join(first, "index.ts"), "utf8");
    const generatedLine = entrySource.split("\n").findIndex((line) => line.includes('pi.registerCommand("statusline"'));
    assert.notEqual(generatedLine, -1);
    const sourceMap = new SourceMap(JSON.parse(await readFile(join(first, "index.ts.map"), "utf8")));
    const mapped = sourceMap.findEntry(generatedLine, 0);
    assert.ok("originalSource" in mapped, "expected generated entry to map to source");
    assert.match(mapped.originalSource ?? "", /src\/statusline\.ts$/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-statusline-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.ok(loaded.extensions[0]?.commands.has("statusline"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

test("failed validation and publication preserve the previous runtime", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-statusline-build-test-"));
  try {
    const output = join(root, "dist");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "previous.ts"), "previous", "utf8");
    await assert.rejects(
      builder.buildRuntime({
        outputDirectory: output,
        validateOutput: async () => {
          throw new Error("injected validation failure");
        },
      }),
      /injected validation failure/u,
    );
    assert.deepEqual(await listFiles(output), ["previous.ts"]);

    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "next.ts"), "next", "utf8");
    let renameCalls = 0;
    await assert.rejects(
      builder.publishRuntime(staging, output, {
        renamePath: async (source, destination) => {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error("injected publication failure");
          await rename(source, destination);
        },
      }),
      /injected publication failure/u,
    );
    assert.deepEqual(await listFiles(output), ["previous.ts"]);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".backup-")),
      [],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

function requireOutput(metadata: BuildMetadata, path: string) {
  const output = metadata.outputs?.[path];
  assert.ok(output, `missing fixture output: ${path}`);
  return output;
}

async function snapshotDirectory(directory: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const path of await listFiles(directory)) {
    snapshot[path] = await readFile(join(directory, path), "base64");
  }
  return snapshot;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, relativePath)));
    else if (entry.isFile()) files.push(relativePath.replaceAll("\\", "/"));
  }
  return files.sort();
}
