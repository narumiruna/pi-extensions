import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
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

test("generated entry loads through Pi Jiti and exercises lifecycle plus the lazy menu", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-generated-entry-"));
  const agentDir = join(root, "agent");
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    herdr: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
    socket: process.env.HERDR_SOCKET_PATH,
  };
  try {
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "pane-generated";
    process.env.HERDR_SOCKET_PATH = join(root, "unused.sock");
    const entrypoint = resolve("packages/pi-herdr/dist/index.ts");
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
    assert.ok(extension?.commands.has("herdr"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    const rpc = createRpcHarness([{ kind: "select", response: "Close" }]);
    const context = createMockContext({ mode: "rpc", hasUI: true, cwd: root });
    const baseCtx = context.ctx as unknown as ExtensionContext;
    const ctx = { ...baseCtx, ui: { ...baseCtx.ui, ...rpc.ui } } as ExtensionContext;
    await emit(extension.handlers, "session_start", { reason: "startup" }, ctx);
    await extension.commands.get("herdr")?.handler("", ctx as never);
    rpc.assertConsumed();
    await emit(extension.handlers, "session_shutdown", { reason: "quit" }, ctx);
  } finally {
    restoreEnvironment("PI_CODING_AGENT_DIR", previous.agentDir);
    restoreEnvironment("HERDR_ENV", previous.herdr);
    restoreEnvironment("HERDR_PANE_ID", previous.pane);
    restoreEnvironment("HERDR_SOCKET_PATH", previous.socket);
    await rm(root, { recursive: true, force: true });
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
