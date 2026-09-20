import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";

const packageRoot = resolve("packages/pi-langfuse");
const builderUrl = pathToFileURL(join(packageRoot, "scripts/build-runtime.mjs")).href;
const forbiddenEagerInputs: readonly string[] = ["src/runtime.ts"];
const execFileAsync = promisify(execFile);

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
  const entryImports: Array<{ external?: boolean; kind?: string; path: string }> = [
    { path: "@earendil-works/pi-coding-agent", kind: "import-statement", external: true },
    { path: "@narumitw/pi-tui-kit", kind: "dynamic-import", external: true },
  ];
  const outputs: NonNullable<BuildMetadata["outputs"]> = {
    "dist/index.ts": {
      entryPoint: "src/index.ts",
      imports: entryImports,
      inputs: { "src/index.ts": {}, "src/langfuse.ts": {} },
    },
  };
  for (const [index, input] of forbiddenEagerInputs.entries()) {
    const outputPath = `dist/chunks/lazy-${index}.ts`;
    entryImports.push({ path: outputPath, kind: "dynamic-import" });
    outputs[outputPath] = { entryPoint: input, imports: [], inputs: { [input]: {} } };
  }
  return { outputs };
}

test("eager graph validation preserves first-use boundaries and external packages", async () => {
  const builder = await loadBuilder();
  assert.doesNotThrow(() => builder.validateEagerGraph(validMetadata()));

  for (const forbidden of forbiddenEagerInputs) {
    const metadata = validMetadata();
    const entry = requireOutput(metadata, "dist/index.ts");
    entry.inputs = { ...(entry.inputs ?? {}), [forbidden]: {} };
    assert.throws(
      () => builder.validateEagerGraph(metadata),
      new RegExp(`First-use implementation is eager: ${forbidden.replaceAll("/", "\\/")}`, "u"),
    );
  }

  const eagerDependency = validMetadata();
  const entry = requireOutput(eagerDependency, "dist/index.ts");
  entry.imports = [
    ...(entry.imports ?? []),
    { path: "@narumitw/pi-tui-kit", kind: "import-statement", external: true },
  ];
  assert.throws(() => builder.validateEagerGraph(eagerDependency), /Eager external dependency: @narumitw\/pi-tui-kit/u);

  const bundledDependency = validMetadata();
  requireOutput(bundledDependency, "dist/index.ts").inputs = {
    "node_modules/example/index.js": {},
  };
  assert.throws(() => builder.validateEagerGraph(bundledDependency), /Bundled package input: .*node_modules\/example/u);
});

test("runtime build rejects destructive output paths and symlink escapes", async () => {
  const builder = await loadBuilder();
  const outside = await mkdtemp(join(tmpdir(), "pi-langfuse-build-outside-"));
  const linkedParent = join(packageRoot, `.pi-langfuse-build-test-link-${crypto.randomUUID()}`);
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

test("runtime builds are deterministic, mapped, external, and remove stale output", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    const firstMetadata = await builder.buildRuntime({ outputDirectory: first });
    await mkdir(join(second, "chunks"), { recursive: true });
    await writeFile(join(second, "chunks", "stale.ts"), "stale", "utf8");
    await builder.buildRuntime({ outputDirectory: second });

    assert.deepEqual(await snapshotDirectory(first), await snapshotDirectory(second));
    assert.equal((await listFiles(second)).includes("chunks/stale.ts"), false);
    const files = await listFiles(first);
    assert.ok(files.includes("index.js"));
    assert.ok(files.includes("index.js.map"));
    assert.ok(files.includes("index.ts"));
    assert.ok(files.includes("index.ts.map"));
    assert.ok(files.includes("index.d.ts"));
    assert.equal(
      files.some((path) => path.startsWith("chunks/") && path.endsWith(".ts")),
      forbiddenEagerInputs.length > 0,
    );
    assert.ok(files.some((path) => path.startsWith("library-chunks/") && path.endsWith(".js")));
    for (const runtimePath of files.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))) {
      const source = await readFile(join(first, runtimePath), "utf8");
      assert.match(source, /^\/\/ @generated by scripts\/build-runtime\.mjs/u);
      assert.doesNotMatch(source, /["']\.\.?\/[^"']+\.js["']/u);
      assert.doesNotMatch(source, /["']\.\.?\/[^"']*src\//u);
      assert.ok(files.includes(`${runtimePath}.map`), `missing map for ${runtimePath}`);
    }
    for (const libraryPath of files.filter((path) => path.endsWith(".js"))) {
      const source = await readFile(join(first, libraryPath), "utf8");
      assert.match(source, /^\/\/ @generated by scripts\/build-runtime\.mjs/u);
      assert.doesNotMatch(source, /["']\.\.?\/[^"']+\.ts["']/u);
      assert.doesNotMatch(source, /["']\.\.?\/[^"']*src\//u);
      assert.ok(files.includes(`${libraryPath}.map`), `missing map for ${libraryPath}`);
    }
    for (const output of Object.values(firstMetadata.outputs ?? {})) {
      for (const input of Object.keys(output.inputs ?? {})) {
        assert.equal(input.includes("node_modules/"), false, `bundled package input: ${input}`);
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated JavaScript root exposes the host API without eagerly loading production runtime", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
  try {
    const output = join(root, "dist");
    await builder.buildRuntime({ outputDirectory: output });
    const entrySource = await readFile(join(output, "index.js"), "utf8");
    assert.doesNotMatch(entrySource, /@langfuse\/otel/u);

    const module = await import(`${pathToFileURL(join(output, "index.js")).href}?test=${crypto.randomUUID()}`);
    assert.equal(typeof module.default, "function");
    assert.equal(typeof module.createLangfuseRuntime, "function");
    assert.equal(typeof module.createPiLangfuseSession, "function");
    await assert.rejects(module.createLangfuseRuntime({ env: false }), /publicKey is required/u);
    assert.match(await readFile(join(output, "index.d.ts"), "utf8"), /createPiLangfuseSession/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated host controller remains registered across resource reloads", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const module = await import(`${pathToFileURL(join(output, "index.js")).href}?test=${crypto.randomUUID()}`);
    const tracing = module.createPiLangfuseSession({
      closed: false,
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      extensionFactories: [{ name: "langfuse", factory: tracing.extension }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    for (let reload = 0; reload < 2; reload += 1) {
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

test("generated package copies share runtime session capabilities", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
  try {
    const firstOutput = join(root, "first");
    const secondOutput = join(root, "second");
    await builder.buildRuntime({ outputDirectory: firstOutput });
    await cp(firstOutput, secondOutput, { recursive: true });
    const script = join(root, "cross-copy.mjs");
    await writeFile(
      script,
      `const first = await import(${JSON.stringify(pathToFileURL(join(firstOutput, "index.js")).href)});
const second = await import(${JSON.stringify(pathToFileURL(join(secondOutput, "index.js")).href)});
const options = { config: { publicKey: "pk-copy", secretKey: "sk-copy", baseUrl: "https://example.test" }, env: false };
const firstRuntime = await first.createLangfuseRuntime(options);
const secondRuntime = await second.createLangfuseRuntime(options);
const tracing = second.createPiLangfuseSession(secondRuntime, { sessionId: "copy-session" });
const handlers = new Map();
tracing.extension({ on: (event, handler) => handlers.set(event, handler) });
await handlers.get("session_start")({}, {
  cwd: "/workspace",
  mode: "rpc",
  sessionManager: { getSessionId: () => "pi-session", getLeafId: () => undefined },
  getContextUsage: () => undefined,
});
await tracing.flush();
console.log(JSON.stringify({ sameRuntime: firstRuntime === secondRuntime, active: tracing.active }));
await tracing.dispose();
await firstRuntime.shutdown();
`,
      "utf8",
    );

    const { stdout } = await execFileAsync(process.execPath, [script], { cwd: packageRoot, timeout: 4_000 });
    assert.deepEqual(JSON.parse(stdout), { sameRuntime: true, active: true });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
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
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("langfuse"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));
    const command = extension?.commands.get("langfuse");
    assert.ok(command);
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      select: async () => "Show setup and privacy help",
    });
    await command?.handler("", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /Langfuse setup and privacy/u);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

test("failed validation and publication preserve the previous runtime", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
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
      (await readdir(root)).filter((entry) => entry.includes(".backup-")),
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
