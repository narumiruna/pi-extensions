import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    assert.ok(extension?.handlers.has("session_compact"));
    assert.ok(extension?.handlers.has("agent_before_settle"));
    assert.ok(extension?.handlers.has("agent_settled"));
    assert.ok(extension?.handlers.has("session_shutdown"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

test.each([
  {
    layout: "installed",
    tuiKitRoot: resolve(fileURLToPath(import.meta.resolve("@narumitw/pi-tui-kit")), "../.."),
  },
  { layout: "workspace", tuiKitRoot: resolve("packages/pi-tui-kit") },
])("managed package layouts load the settings menu without physical Pi peers ($layout Kit)", async ({ tuiKitRoot }) => {
  const builder = await loadBuilder();
  const buildRoot = await mkdtemp(join(packageRoot, ".pi-codex-compact-build-test-"));
  const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-codex-compact-isolated-"));
  const agentDir = join(isolatedRoot, "agent");
  const output = join(buildRoot, "dist");
  const isolatedTuiKitRoot = join(isolatedRoot, "node_modules", "@narumitw", "pi-tui-kit");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await cp(output, join(isolatedRoot, "dist"), { recursive: true });
    await cp(join(packageRoot, "package.json"), join(isolatedRoot, "package.json"));
    await mkdir(isolatedTuiKitRoot, { recursive: true });
    const kitManifestPath = join(tuiKitRoot, "package.json");
    await cp(kitManifestPath, join(isolatedTuiKitRoot, "package.json"));
    await cp(join(tuiKitRoot, "dist"), join(isolatedTuiKitRoot, "dist"), { recursive: true });
    const kitManifest = JSON.parse(await readFile(kitManifestPath, "utf8"));
    const kitRequire = createRequire(kitManifestPath);
    // Copy declared runtime dependencies from Kit's own install scope, not its Pi peers.
    for (const dependency of Object.keys(kitManifest.dependencies ?? {})) {
      const dependencyRoot = kitRequire.resolve
        .paths(dependency)
        ?.map((modulesRoot) => join(modulesRoot, dependency))
        .find((candidate) => existsSync(join(candidate, "package.json")));
      assert.ok(dependencyRoot, `Missing installed Kit dependency: ${dependency}`);
      const destination = join(isolatedRoot, "node_modules", dependency);
      await mkdir(dirname(destination), { recursive: true });
      await cp(dependencyRoot, destination, { recursive: true });
    }
    for (const peer of Object.keys(kitManifest.peerDependencies ?? {})) {
      await assert.rejects(access(join(isolatedRoot, "node_modules", peer)));
    }
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
