import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { SourceMap } from "node:module";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-statusline",
  forbiddenEagerInputs: ["src/commands.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  matchExternalSubpaths: false,
  includeDynamicExternals: true,
});

test("generated statusline registration maps back to its source", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-statusline-build-test-"));
  try {
    const output = join(root, "dist");
    await builder.buildRuntime({ outputDirectory: output });
    const entrySource = await readFile(join(output, "index.ts"), "utf8");
    const generatedLine = entrySource.split("\n").findIndex((line) => line.includes('pi.registerCommand("statusline"'));
    assert.notEqual(generatedLine, -1);
    const sourceMap = new SourceMap(JSON.parse(await readFile(join(output, "index.ts.map"), "utf8")));
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
