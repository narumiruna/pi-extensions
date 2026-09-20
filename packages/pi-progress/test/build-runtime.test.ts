import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-progress",
  forbiddenEagerInputs: [],
  forbiddenEagerExternals: [],
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-progress-build-test-"));
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
    assert.deepEqual([...(extension?.tools.keys() ?? [])], ["update_progress"]);
    assert.equal(extension?.commands.size, 0);
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("context"));
    assert.ok(extension?.handlers.has("session_tree"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    const widgets: Array<{ key: string; content: unknown }> = [];
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const sessionManager = { getBranch: () => [] };
    const ctx = {
      mode: "tui",
      hasUI: true,
      sessionManager,
      ui: {
        setWidget(key: string, content: unknown) {
          widgets.push({ key, content });
        },
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
      },
    } as unknown as ExtensionContext;
    await emit(extension.handlers, "session_start", ctx);
    assert.deepEqual(widgets.at(-1), { key: "progress", content: undefined });
    assert.deepEqual(notifications, []);

    const tool = extension.tools.get("update_progress");
    assert.ok(tool);
    const updated = await tool.definition.execute(
      "generated-progress",
      { steps: [{ text: "Verify generated runtime", status: "in_progress" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(updated.details, {
      version: 4,
      steps: [{ text: "Verify generated runtime", status: "in_progress" }],
    });
    assert.equal(typeof widgets.at(-1)?.content, "function");
    const cleared = await tool.definition.execute("generated-progress-clear", { steps: [] }, undefined, undefined, ctx);
    assert.deepEqual(cleared.details, { version: 4, steps: [] });
    assert.deepEqual(widgets.at(-1), { key: "progress", content: undefined });

    await emit(extension.handlers, "session_shutdown", ctx);
    assert.deepEqual(widgets.at(-1), { key: "progress", content: undefined });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

async function emit(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
  event: string,
  ctx: ExtensionContext,
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
}
