import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-codex-compact",
  forbiddenEagerInputs: ["src/settings-menu.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-codex-compact-build-test-"));
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
    assert.ok(extension?.commands.has("codex-compact"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

test("managed package layouts load the settings menu without physical Pi peers", async () => {
  const builder = await loadBuilder();
  const buildRoot = await mkdtemp(join(packageRoot, ".pi-codex-compact-build-test-"));
  const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-codex-compact-isolated-"));
  const agentDir = join(isolatedRoot, "agent");
  const output = join(buildRoot, "dist");
  const tuiKitRoot = resolve(fileURLToPath(import.meta.resolve("@narumitw/pi-tui-kit")), "../..");
  const isolatedTuiKitRoot = join(isolatedRoot, "node_modules", "@narumitw", "pi-tui-kit");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await cp(output, join(isolatedRoot, "dist"), { recursive: true });
    await cp(join(packageRoot, "package.json"), join(isolatedRoot, "package.json"));
    await mkdir(isolatedTuiKitRoot, { recursive: true });
    await cp(join(tuiKitRoot, "package.json"), join(isolatedTuiKitRoot, "package.json"));
    await cp(join(tuiKitRoot, "dist"), join(isolatedTuiKitRoot, "dist"), { recursive: true });
    await assert.rejects(access(join(isolatedRoot, "node_modules", "@earendil-works", "pi-tui")));
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: isolatedRoot,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(isolatedRoot, "dist", "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    const command = extension?.commands.get("codex-compact");
    assert.ok(command);
    const { ctx } = createMockContext({ cwd: isolatedRoot, mode: "tui" });
    await assert.doesNotReject(() => command.handler("", ctx));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(buildRoot, { force: true, recursive: true });
    await rm(isolatedRoot, { force: true, recursive: true });
  }
});
