import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-btw",
  forbiddenEagerInputs: [],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated markdown loading remains lazy and abort-aware", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-btw-build-test-"));
  try {
    const output = join(root, "dist");
    await builder.buildRuntime({ outputDirectory: output });
    const entrySource = await readFile(join(output, "index.ts"), "utf8");
    assert.match(entrySource, /@narumitw\/pi-tui-kit\/markdown/u);
    assert.match(entrySource, /settleUnlessAborted\(\s*import\(MERMAID_MARKDOWN_MODULE\)/u);
    assert.doesNotMatch(entrySource, /from ["']@narumitw\/pi-tui-kit\/markdown["']/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-btw-build-test-"));
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
    assert.ok(extension?.commands.has("btw"));
    assert.equal(extension?.handlers.has("session_shutdown"), false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
