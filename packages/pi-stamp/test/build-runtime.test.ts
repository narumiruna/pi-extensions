import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { type BuildMetadata, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-stamp",
  forbiddenEagerInputs: ["src/menu.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  allowedEagerExternals: ["@narumitw/pi-tui-kit/terminal-text"],
});

const require = createRequire(join(packageRoot, "package.json"));

const resolvedKitRoot = require.resolve
  .paths("@narumitw/pi-tui-kit")
  ?.map((modulesRoot) => join(modulesRoot, "@narumitw", "pi-tui-kit"))
  .find((candidate) => existsSync(join(candidate, "package.json")));

assert.ok(resolvedKitRoot, "pi-stamp's resolved pi-tui-kit dependency is missing");

const forbiddenEagerInputs: readonly string[] = ["src/menu.ts"];

function validMetadata(): BuildMetadata {
  const entryImports: Array<{ external?: boolean; kind?: string; path: string }> = [
    { path: "@earendil-works/pi-coding-agent", kind: "import-statement", external: true },
    { path: "@narumitw/pi-tui-kit", kind: "dynamic-import", external: true },
  ];
  const outputs: NonNullable<BuildMetadata["outputs"]> = {
    "dist/index.ts": {
      entryPoint: "src/index.ts",
      imports: entryImports,
      inputs: { "src/index.ts": {}, "src/runtime.ts": {} },
    },
  };
  for (const [index, input] of forbiddenEagerInputs.entries()) {
    const outputPath = `dist/chunks/lazy-${index}.ts`;
    entryImports.push({ path: outputPath, kind: "dynamic-import" });
    outputs[outputPath] = { entryPoint: input, imports: [], inputs: { [input]: {} } };
  }
  return { outputs };
}

test("only the dependency-free Kit terminal-text leaf may load eagerly", async () => {
  const builder = await loadBuilder();
  for (const [specifier, allowed] of [
    ["@narumitw/pi-tui-kit/terminal-text", true],
    ["@narumitw/pi-tui-kit/terminal-document", false],
    ["@narumitw/pi-tui-kit/testing", false],
    ["@narumitw/pi-tui-kit/terminal-text/other", false],
  ] as const) {
    const metadata = validMetadata();
    requireOutput(metadata, "dist/index.ts").imports?.push({
      path: specifier,
      kind: "import-statement",
      external: true,
    });
    if (allowed) assert.doesNotThrow(() => builder.validateEagerGraph(metadata));
    else assert.throws(() => builder.validateEagerGraph(metadata), /Eager external dependency/u);
  }
  const manifest = JSON.parse(await readFile(join(resolvedKitRoot, "package.json"), "utf8"));
  const leaf = manifest.exports["./terminal-text"].import;
  assert.equal(leaf, "./dist/terminal-text.js");
  const source = await readFile(join(resolvedKitRoot, leaf), "utf8");
  assert.doesNotMatch(source, /\b(?:import\s|import\(|require\(|from\s+["'])/u);
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-stamp-build-test-"));
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
    assert.ok(extension?.commands.has("stamp"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

test("generated lazy boundary resolves Pi peers through Jiti aliases", async () => {
  const builder = await loadBuilder();
  const buildRoot = await mkdtemp(join(packageRoot, ".pi-stamp-build-test-"));
  const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-stamp-isolated-runtime-"));
  const agentDir = join(isolatedRoot, "agent");
  const output = join(buildRoot, "dist");
  const isolatedOutput = join(isolatedRoot, "dist");
  const isolatedKitRoot = join(isolatedRoot, "node_modules", "@narumitw", "pi-tui-kit");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await cp(output, isolatedOutput, { recursive: true });
    await mkdir(isolatedKitRoot, { recursive: true });
    await cp(join(resolvedKitRoot, "dist"), join(isolatedKitRoot, "dist"), {
      recursive: true,
    });
    await cp(join(resolvedKitRoot, "package.json"), join(isolatedKitRoot, "package.json"));
    await assert.rejects(access(join(isolatedRoot, "node_modules", "@earendil-works", "pi-tui")));

    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: isolatedRoot,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(isolatedOutput, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const command = loaded.extensions[0]?.commands.get("stamp");
    assert.ok(command);
    const { ctx } = createMockContext({ cwd: isolatedRoot, mode: "tui" });
    await command.handler("", ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(buildRoot, { force: true, recursive: true });
    await rm(isolatedRoot, { force: true, recursive: true });
  }
});

function requireOutput(metadata: BuildMetadata, path: string) {
  const output = metadata.outputs?.[path];
  assert.ok(output, `missing fixture output: ${path}`);
  return output;
}
