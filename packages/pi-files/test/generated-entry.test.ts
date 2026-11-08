import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";

test("declared merged runtime loads once through Pi Jiti, opens the lazy browser, and cleans up", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-generated-entry-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const tui = createTuiHarness();
  let invalidate: (() => void) | undefined;
  try {
    await mkdir(agentDir);
    const settings = {
      "pi-file-context.json": '{ "openShortcut": "f8", "future": { "keep": true } }\n',
      "pi-scope.json": '{ "showHiddenFiles": true, "future": [1, 2] }\n',
    };
    for (const [name, content] of Object.entries(settings)) await writeFile(join(agentDir, name), content);
    await writeFile(join(root, "example.ts"), "export const example = true;\n");
    initTheme("dark", false);
    const manifest = JSON.parse(await readFile(resolve("packages/pi-files/package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions, ["./dist/index.ts"]);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [resolve("packages/pi-files", manifest.pi.extensions[0])],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    invalidate = () => loaded.runtime.invalidate("generated entry test complete");
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    for (const name of ["files", "file-context", "edit-scope", "scope"]) assert.ok(extension.commands.has(name), name);
    assert.equal(extension.tools.size, 0);
    assert.ok(extension.shortcuts.has("f8"), "the retained context settings file must configure registration");
    for (const event of ["tool_call", "context_with_system", "session_start", "session_shutdown"]) {
      assert.ok(extension.handlers.has(event), `${event} must be registered at load time`);
    }

    let showBrowser: (frame: string) => void = () => {};
    const browserOpened = new Promise<string>((resolveBrowser) => {
      showBrowser = resolveBrowser;
    });
    const context = createMockContext({
      mode: "tui",
      cwd: root,
      custom: async (factory: Parameters<typeof tui.custom>[0], options: Parameters<typeof tui.custom>[1]) => {
        const running = tui.custom(factory, options);
        await tui.waitForOpen();
        const frame = tui.render().join("\n");
        if (frame.includes("File Context · files")) showBrowser(frame);
        return running;
      },
    });
    const emit = async (type: string) => {
      for (const handler of extension.handlers.get(type) ?? []) {
        await handler({ type, reason: "quit" } as never, context.ctx);
      }
    };
    let running: Promise<unknown> | undefined;
    try {
      await emit("session_shutdown");
      await emit("session_start");
      const command = extension.commands.get("file-context");
      assert.ok(command);
      running = Promise.resolve(command.handler("browse", context.ctx));
      const frame = await Promise.race([
        browserOpened,
        running.then(() => {
          throw new Error(`Browser closed before opening: ${JSON.stringify(context.notifications)}`);
        }),
      ]);
      assert.match(frame, /example\.ts/u);
      tui.press("ctrl+c");
      await running;
      assert.equal(tui.isOpen, false);
      assert.deepEqual(context.notifications, []);
    } finally {
      tui.dispose();
      await emit("session_shutdown");
      await emit("session_shutdown");
      await running?.catch(() => undefined);
    }
    for (const key of ["files", "file-context", "edit-scope"]) assert.equal(context.widgets.get(key), undefined, key);
    for (const [name, content] of Object.entries(settings)) {
      assert.equal(await readFile(join(agentDir, name), "utf8"), content, `${name} must not be migrated or rewritten`);
    }
    await assert.rejects(readFile(join(agentDir, "pi-files.json")), { code: "ENOENT" });
  } finally {
    tui.dispose();
    invalidate?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
