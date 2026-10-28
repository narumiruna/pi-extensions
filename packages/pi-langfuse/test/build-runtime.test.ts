import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getLangfuseTracerProvider, setLangfuseTracerProvider } from "@langfuse/tracing";
import { afterAll, beforeAll, test } from "vitest";
import { listFiles } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";

const packageRoot = resolve("packages/pi-langfuse");
const builderUrl = pathToFileURL(join(packageRoot, "scripts/build-runtime.mjs")).href;
const forbiddenEagerInputs: readonly string[] = ["src/runtime.ts"];

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

type BuildFixture = Readonly<{ root: string; output: string; metadata: BuildMetadata }>;
let buildFixture: BuildFixture | undefined;
let fixtureOwner: ReturnType<typeof createBuildFixture> | undefined;

function createBuildFixture(build: (output: string, signal: AbortSignal) => Promise<BuildMetadata>) {
  const controller = new AbortController();
  let root: string | undefined;
  // Retain the task immediately: Vitest does not cancel a timed-out beforeAll continuation.
  const ready = (async () => {
    root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
    try {
      controller.signal.throwIfAborted();
      const output = join(root, "dist");
      const metadata = await build(output, controller.signal);
      controller.signal.throwIfAborted();
      // Never import or modify this graph; runtime consumers receive full copies.
      return freezeFixture({ root, output, metadata });
    } catch (error) {
      await rm(root, { force: true, recursive: true });
      throw error;
    }
  })();
  // Keep rejection observed even when setup has already timed out.
  void ready.catch(() => {});
  return {
    ready,
    async dispose() {
      controller.abort(new Error("Build fixture disposed"));
      // The builder has no cancellation API. Drain it before removing its output.
      await ready.catch(() => {});
      if (root) await rm(root, { force: true, recursive: true });
    },
  };
}

beforeAll(async () => {
  fixtureOwner = createBuildFixture(async (output, signal) => {
    const builder = await loadBuilder();
    signal.throwIfAborted();
    return builder.buildRuntime({ outputDirectory: output });
  });
  buildFixture = await fixtureOwner.ready;
});

afterAll(async () => {
  await fixtureOwner?.dispose();
  buildFixture = undefined;
});

function requireBuildFixture() {
  assert.ok(buildFixture, "runtime build fixture is not ready");
  return buildFixture;
}

function freezeFixture<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object") freezeFixture(nested);
  }
  return Object.freeze(value);
}

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

test("fixture disposal drains pending setup and prevents late publication", async ({ onTestFinished }) => {
  let release!: () => void;
  let entered!: () => void;
  let outputPath = "";
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const owner = createBuildFixture(async (output) => {
    outputPath = output;
    entered();
    await gate;
    return {};
  });
  onTestFinished(async () => {
    release();
    await owner.dispose();
  });
  await started;
  const outcome = owner.ready.then(
    () => "published",
    () => "cancelled",
  );
  let drained = false;
  const disposal = owner.dispose().then(() => {
    drained = true;
  });
  try {
    await Promise.resolve();
    assert.equal(drained, false);
  } finally {
    release();
    await disposal;
  }
  assert.equal(await outcome, "cancelled");
  await assert.rejects(readdir(join(outputPath, "..")), { code: "ENOENT" });
});

test("fixture setup failure removes partial output and remains disposable", async ({ onTestFinished }) => {
  let outputPath = "";
  const owner = createBuildFixture(async (output) => {
    outputPath = output;
    await mkdir(output);
    await writeFile(join(output, "partial.ts"), "partial");
    throw new Error("injected fixture setup failure");
  });
  onTestFinished(() => owner.dispose());
  await assert.rejects(owner.ready, /injected fixture setup failure/u);
  await owner.dispose();
  await assert.rejects(readdir(join(outputPath, "..")), { code: "ENOENT" });
});

test("completed fixture disposal is idempotent", async ({ onTestFinished }) => {
  const owner = createBuildFixture(async (output) => {
    await mkdir(output);
    return {};
  });
  onTestFinished(() => owner.dispose());
  const value = await owner.ready;
  assert.equal(Object.isFrozen(value), true);
  await owner.dispose();
  await owner.dispose();
  await assert.rejects(readdir(value.root), { code: "ENOENT" });
});

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
    const { output: first, metadata: firstMetadata } = requireBuildFixture();
    const second = join(root, "second");
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
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
  try {
    const output = join(root, "dist");
    await cp(requireBuildFixture().output, output, { recursive: true });
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
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tracing: { dispose(): Promise<void> } | undefined;
  try {
    await cp(requireBuildFixture().output, output, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const module = await import(`${pathToFileURL(join(output, "index.js")).href}?test=${crypto.randomUUID()}`);
    const controller = module.createPiLangfuseSession({
      closed: false,
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    tracing = controller;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      extensionFactories: [{ name: "langfuse", factory: controller.extension }],
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
    try {
      await tracing?.dispose();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("generated package copies share runtime session capabilities", async () => {
  let runtime: { shutdown(): Promise<void> } | undefined;
  let tracing: { dispose(): Promise<void> } | undefined;
  const runtimeSlots = ["v1", "v2"].map((version) => {
    const key = Symbol.for(`@narumitw/pi-langfuse/runtime/${version}`);
    return { key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) };
  });
  const previousProvider = getLangfuseTracerProvider();
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
  try {
    // Own a fresh runtime without closing any runtime inherited from another test.
    for (const { key } of runtimeSlots) Reflect.deleteProperty(globalThis, key);
    const firstOutput = join(root, "first");
    const secondOutput = join(root, "second");
    await cp(requireBuildFixture().output, firstOutput, { recursive: true });
    await cp(requireBuildFixture().output, secondOutput, { recursive: true });
    // Distinct emitted modules in one process exercise the shared runtime contract
    // directly, without making child startup or stdout a second test protocol.
    const first = await import(pathToFileURL(join(firstOutput, "index.js")).href);
    const second = await import(pathToFileURL(join(secondOutput, "index.js")).href);
    assert.notEqual(first, second, "the copies must have independent emitted module identities");
    const options = {
      config: { publicKey: "pk-copy", secretKey: "sk-copy", baseUrl: "https://example.test" },
      env: false,
    };
    const firstRuntime = await first.createLangfuseRuntime(options);
    runtime = firstRuntime;
    const secondRuntime = await second.createLangfuseRuntime(options);
    assert.equal(firstRuntime, secondRuntime);
    const controller = second.createPiLangfuseSession(secondRuntime, { sessionId: "copy-session" });
    tracing = controller;
    const handlers = new Map();
    controller.extension({ on: (event: string, handler: unknown) => handlers.set(event, handler) });
    await handlers.get("session_start")(
      {},
      {
        cwd: "/workspace",
        mode: "rpc",
        sessionManager: { getSessionId: () => "pi-session", getLeafId: () => undefined },
        getContextUsage: () => undefined,
      },
    );
    await controller.flush();
    assert.equal(controller.active, true);
  } finally {
    try {
      await tracing?.dispose();
    } finally {
      try {
        await runtime?.shutdown();
      } finally {
        try {
          for (const { key, descriptor } of runtimeSlots) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
          }
        } finally {
          try {
            setLangfuseTracerProvider(previousProvider);
          } finally {
            await rm(root, { force: true, recursive: true });
          }
        }
      }
    }
  }
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const root = await mkdtemp(join(packageRoot, ".pi-langfuse-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await cp(requireBuildFixture().output, output, { recursive: true });
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
