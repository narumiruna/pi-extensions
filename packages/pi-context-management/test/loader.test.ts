import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { CONTEXT_MANAGEMENT_TOOL_NAMES } from "../src/context-tools.js";

test("generated entrypoint loads through Pi's Jiti resource loader and exercises the lazy menu boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-management-loader-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const entrypoint = resolve("packages/pi-context-management/dist/index.ts");
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [entrypoint],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("context-management"));
    assert.deepEqual([...(extension?.tools.keys() ?? [])], [...CONTEXT_MANAGEMENT_TOOL_NAMES]);
    assert.deepEqual(
      [...(extension?.tools.values() ?? [])].map((tool) => tool.sourceInfo.path),
      Array.from({ length: CONTEXT_MANAGEMENT_TOOL_NAMES.length }, () => entrypoint),
    );
    for (const event of [
      "session_start",
      "session_before_compact",
      "context",
      "session_tree",
      "session_compact",
      "session_compact_failed",
      "agent_start",
      "agent_end",
      "turn_start",
      "agent_settled",
      "session_shutdown",
    ]) {
      assert.ok(extension?.handlers.has(event), `missing ${event} handler`);
    }
    const command = extension?.commands.get("context-management");
    assert.ok(command);
    await assert.rejects(
      command.handler("", createMockContext({ mode: "print", hasUI: false }).ctx),
      /requires TUI or RPC UI support/,
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
