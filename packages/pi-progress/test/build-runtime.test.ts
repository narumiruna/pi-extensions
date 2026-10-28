import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionCommandContext,
  type ExtensionContext,
  ExtensionRunner,
  initTheme,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

initTheme("dark");

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
    assert.deepEqual([...(extension?.commands.keys() ?? [])], ["progress"]);
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
      isIdle: () => true,
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

    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sessionManager as never, {} as never);
    runner.setUIContext(ctx.ui, "tui");
    const tool = extension.tools.get("update_progress");
    assert.ok(tool);
    assert.equal(
      tool.definition.promptSnippet,
      "Show users what has been done, what is happening now, and what is planned next",
    );
    assert.match(tool.definition.description, /empty steps array only to intentionally clear/u);
    assert.ok(
      tool.definition.promptGuidelines?.includes(
        "Progress reporting does not prescribe the workflow or require tool calls before work or replies.",
      ),
    );
    const updated = await tool.definition.execute(
      "generated-progress",
      { steps: [{ text: "Verify generated runtime — waiting for approval", status: "blocked" }] },
      undefined,
      undefined,
      runner.createToolContext("generated-progress", undefined),
    );
    assert.deepEqual(updated.details, {
      version: 5,
      steps: [{ text: "Verify generated runtime — waiting for approval", status: "blocked" }],
    });
    assert.equal(typeof widgets.at(-1)?.content, "function");
    const command = extension.commands.get("progress");
    assert.ok(command);
    // Exercise the emitted menu's lazy import through Pi's Jiti-loaded runtime.
    const choices = ["Status", "Back", "Settings", "Close"];
    const dialogs: { title: string; options: string[] }[] = [];
    const rpcCtx = {
      ...ctx,
      mode: "rpc",
      ui: {
        ...ctx.ui,
        select: async (title: string, options: string[]) => {
          dialogs.push({ title, options });
          return choices.shift();
        },
      },
    } as unknown as ExtensionCommandContext;
    await command.handler("", rpcCtx);
    assert.equal(choices.length, 0);
    assert.equal(dialogs.length, 4);
    assert.match(dialogs[1]?.title ?? "", /Progress Status/u);
    assert.ok(notifications.some(({ message }) => /Edit settings manually:/u.test(message)));
    const screen = createTuiHarness({ width: 80 });
    Object.assign(ctx.ui, { custom: screen.custom });
    const settingsCommand = command.handler("settings", ctx as ExtensionCommandContext);
    await screen.waitForOpen();
    const settingsFrame = screen.render();
    for (let index = 0; index < 3; index++) screen.press("tui.select.down");
    screen.press("tui.select.confirm");
    screen.type("25");
    const itemLimitFrame = screen.render();
    screen.press("ctrl+c");
    await settingsCommand;
    screen.dispose();
    assert.equal(settingsFrame[0], "─".repeat(80));
    assert.equal(settingsFrame.at(-1), "─".repeat(80));
    assert.match(itemLimitFrame.join("\n"), /Visible item limit/u);
    assert.match(itemLimitFrame.join("\n"), /> 25/u);
    await command.handler("clear", ctx as ExtensionCommandContext);
    assert.deepEqual(widgets.at(-1), { key: "progress", content: undefined });
    assert.deepEqual(notifications.at(-1), {
      message: "Progress widget cleared. Saved progress is unchanged.",
      type: "info",
    });
    const cleared = await tool.definition.execute(
      "generated-progress-clear",
      { steps: [] },
      undefined,
      undefined,
      runner.createToolContext("generated-progress-clear", undefined),
    );
    assert.deepEqual(cleared.details, { version: 5, steps: [] });
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
