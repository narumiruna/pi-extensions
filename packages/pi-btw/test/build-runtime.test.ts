import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { FullscreenTerminal } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import {
  type BuildMetadata,
  listFiles,
  registerRuntimeBuilderContract,
} from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";
import { appearanceTheme } from "./native-appearance-support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-btw",
  forbiddenEagerInputs: [
    "src/bring-to-main.ts",
    "src/floating-frame.ts",
    "src/floating-ui.ts",
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
    "src/floating-frame.ts",
    "src/floating-ui.ts",
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

      await writeFile(join(agentDir, "pi-btw.json"), '{"layout":"floating"}\n');
      const parent = new TuiMainScreen(new FullscreenTerminal());
      const model = { id: "smoke", provider: "fixture" };
      const theme = appearanceTheme("dark");
      let mountedInNativeOverlay = false;
      type Custom = ExtensionCommandContext["ui"]["custom"];
      const custom: Custom = async (factory, options) => {
        const result = Promise.withResolvers<unknown>();
        const host = await factory(parent, theme, getKeybindings() as Parameters<typeof factory>[2], result.resolve);
        const opts = options?.overlayOptions;
        const overlay = parent.showOverlay(host, typeof opts === "function" ? opts() : opts);
        try {
          options?.onHandle?.(overlay);
          mountedInNativeOverlay = options?.overlay === true && overlay.isFocused();
          host.handleInput?.("\u0003");
          return result.promise as never;
        } finally {
          overlay.hide();
          host.dispose?.();
        }
      };
      const floating = createMockContext({
        mode: "tui",
        custom,
        model,
        modelRegistry: { getAvailable: () => [model] },
        sessionManager: (context.ctx as ExtensionCommandContext).sessionManager,
      });
      await extension.commands.get("btw")?.handler("do not send", floating.ctx);
      assert.equal(mountedInNativeOverlay, true, "generated direct command opens the lazy floating window");
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
