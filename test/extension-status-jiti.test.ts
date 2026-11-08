import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createEventBus,
  DefaultResourceLoader,
  type RegisteredCommand,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "./support.js";

for (const packages of [["sync"], ["statusline"], ["sync", "statusline"]]) {
  test(`package-directory Jiti entries preserve standalone loading and lazy help: ${packages.join(" + ")}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-extension-status-jiti-"));
    const agentDir = join(root, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let loaded: ReturnType<DefaultResourceLoader["getExtensions"]> | undefined;
    const context = createMockContext({ mode: "rpc", cwd: root });
    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.inMemory({}),
        eventBus: createEventBus(),
        additionalExtensionPaths: packages.map((name) => resolve(`packages/pi-${name}`)),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, packages.length);
      // Supply the one core action used by Statusline's session_start hook.
      loaded.runtime.getThinkingLevel = () => "off";
      for (const extension of loaded.extensions) {
        assert.ok(extension.resolvedPath.endsWith("/dist/index.ts"), extension.resolvedPath);
        for (const handler of extension.handlers.get("session_start") ?? []) {
          await handler({ type: "session_start", reason: "startup" }, context.ctx);
        }
      }
      for (const name of packages) {
        const command: RegisteredCommand | undefined = loaded.extensions
          .find((extension) => extension.commands.has(name))
          ?.commands.get(name);
        assert.ok(command, `missing /${name}`);
        const before = context.notifications.length;
        await command.handler("help", context.ctx);
        const messages = context.notifications
          .slice(before)
          .map((entry) => entry.message)
          .join("\n");
        assert.match(messages, name === "sync" ? /Usage: \/sync <command>/u : /\/statusline help/u);
      }
      assert.equal(context.footer, undefined, "RPC does not create a TUI footer");
    } finally {
      try {
        for (const extension of [...(loaded?.extensions ?? [])].reverse()) {
          for (const handler of extension.handlers.get("session_shutdown") ?? []) {
            await handler({ type: "session_shutdown", reason: "reload" }, context.ctx);
          }
        }
      } finally {
        try {
          loaded?.runtime.invalidate("extension status Jiti integration complete");
        } finally {
          if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previous;
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  });
}
