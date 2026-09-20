import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";

async function emit(
  handlers: ReadonlyMap<string, Array<(...args: never[]) => unknown>>,
  event: string,
  payload: object,
  ctx: ExtensionContext,
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx as never);
}

test("generated entry loads through Pi Jiti and preserves registration plus lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-typesafe-search-generated-entry-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const entrypoint = resolve("packages/pi-typesafe-search/dist/index.ts");
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
    assert.deepEqual([...(extension?.tools.keys() ?? [])], ["jev_search"]);
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    const context = createMockContext({ cwd: root });
    await emit(extension.handlers, "session_start", { reason: "startup" }, context.ctx);
    await emit(extension.handlers, "session_shutdown", { reason: "quit" }, context.ctx);
    await emit(extension.handlers, "session_shutdown", { reason: "quit" }, context.ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
