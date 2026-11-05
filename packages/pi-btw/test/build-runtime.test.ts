import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  type BuildMetadata,
  listFiles,
  registerRuntimeBuilderContract,
} from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-btw",
  forbiddenEagerInputs: [
    "src/bring-to-main.ts",
    "src/fullscreen-ui.ts",
    "src/fullscreen-renderer.ts",
    "src/workspace-layout.ts",
    "src/transcript-pager.ts",
    "src/menu.ts",
    "src/main-tree-picker.ts",
    "src/import-main-updates.ts",
  ],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated markdown loading remains lazy and abort-aware", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-btw-build-test-"));
  try {
    const output = join(root, "dist");
    const metadata = await builder.buildRuntime({ outputDirectory: output });
    assertSourceStartupBoundary(metadata);
    const entrySource = (
      await Promise.all(
        (
          await listFiles(output)
        )
          .filter((file) => file.endsWith(".ts"))
          .map((file) => readFile(join(output, file), "utf8")),
      )
    ).join("\n");
    assert.match(entrySource, /@narumitw\/pi-tui-kit\/markdown/u);
    assert.match(entrySource, /settleUnlessAborted\(\s*import\(MERMAID_MARKDOWN_MODULE\)/u);
    assert.doesNotMatch(entrySource, /from ["']@narumitw\/pi-tui-kit\/markdown["']/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

function assertSourceStartupBoundary(metadata: BuildMetadata) {
  assert.ok(metadata.inputs?.["src/index.ts"], "source entry must be present in build metadata");
  const eager = new Set<string>();
  const visit = (file: string) => {
    if (eager.has(file)) return;
    eager.add(file);
    for (const imported of metadata.inputs?.[file]?.imports ?? []) {
      if (!imported.external && imported.kind !== "dynamic-import") visit(imported.path);
    }
  };
  visit("src/index.ts");
  for (const source of [
    "src/bring-to-main.ts",
    "src/fullscreen-ui.ts",
    "src/fullscreen-renderer.ts",
    "src/workspace-layout.ts",
    "src/transcript-pager.ts",
    "src/menu.ts",
    "src/main-tree-picker.ts",
    "src/import-main-updates.ts",
  ])
    assert.equal(eager.has(source), false, `${source} became a source startup dependency`);
}

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
    assert.equal(extension?.handlers.has("session_shutdown"), true);
    loaded.runtime.getThinkingLevel = () => "off";
    let menus = 0;
    const context = createMockContext({
      mode: "tui",
      custom: async () => {
        menus++;
        return undefined;
      },
    });
    try {
      for (const handler of extension.handlers.get("session_start") ?? []) {
        await handler({ type: "session_start", reason: "startup" }, context.ctx);
      }
      await extension.commands.get("btw")?.handler("", context.ctx);
      assert.equal(menus, 1, "generated default command crosses the lazy menu boundary");
    } finally {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown", reason: "reload" }, context.ctx);
      }
      loaded.runtime.invalidate("generated Btw smoke complete");
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
