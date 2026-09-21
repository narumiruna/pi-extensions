import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, vi } from "vitest";

const EXTENSION_ENTRY = resolve(process.cwd(), "packages/pi-notes/src/index.ts");

test("direct source entrypoint loads through Pi and remains valid across reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-notes-load-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    vi.resetModules();
    const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [EXTENSION_ENTRY],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.equal(loader.getExtensions().extensions[0]?.commands.has("notes"), true);

    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions[0]?.commands.has("notes"), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
