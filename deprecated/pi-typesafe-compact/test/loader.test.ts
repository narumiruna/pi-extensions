import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";

test("source entrypoint loads through Pi without factory file or network side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-typesafe-compact-loader-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const entrypoint = resolve("deprecated/pi-typesafe-compact/src/index.ts");
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
    assert.ok(extension?.commands.has("typesafe-compact"));
    assert.deepEqual([...(extension?.handlers.keys() ?? [])].sort(), [
      "session_before_compact",
      "session_shutdown",
      "session_start",
    ]);
    assert.deepEqual(await readdir(agentDir), []);

    const command = extension?.commands.get("typesafe-compact");
    assert.ok(command);
    await assert.rejects(command.handler("unexpected", createMockContext({ mode: "print" }).ctx), /Usage/u);
    await assert.rejects(command.handler("", createMockContext({ mode: "json" }).ctx), /requires TUI/u);
    assert.deepEqual(await readdir(agentDir), []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
