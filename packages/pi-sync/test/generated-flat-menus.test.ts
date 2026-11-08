import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionCommandContext,
  initTheme,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { v3S3Settings } from "./helpers.js";

initTheme("dark", false);

test("package-directory Jiti smoke exercises flat Settings, manager, cancelled Pull/Push, and History", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-flat-smoke-"));
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.method ?? "GET");
    response.writeHead(404, { "Content-Type": "application/xml" });
    response.end("<Error><Code>NoSuchKey</Code></Error>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let loaded: ReturnType<DefaultResourceLoader["getExtensions"]> | undefined;
  try {
    await mkdir(agentDir);
    const settings = v3S3Settings();
    settings.storageConnections.r2.endpoint = `http://127.0.0.1:${address.port}`;
    const bytes = JSON.stringify(settings);
    await writeFile(join(agentDir, "pi-sync.json"), bytes, { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [resolve("packages/pi-sync")],
    });
    await loader.reload();
    loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    const command = extension.commands.get("sync");
    assert.ok(command);
    const frames: string[] = [];
    const choices: (string | undefined)[] = ["Settings", "Pull from remote…", "Push to remote…", undefined];
    const context = createMockContext({ hasUI: true, mode: "tui" });
    (context.ctx as ExtensionCommandContext).ui.custom = (async (factory) => {
      // Separate hosts support nested manager/edit flows without probing a factory twice.
      const tui = createTuiHarness({ width: 100, rows: 28 });
      try {
        const result = tui.custom(factory);
        await tui.waitForOpen();
        const frame = tui.render().join("\n");
        frames.push(frame);
        if (frame.split("\n").includes("Manage sync")) {
          const choice = choices.shift();
          if (!choice) tui.press("ctrl+c");
          else {
            for (let index = 0; index < 20; index++) {
              if (tui.render().some((line) => line.includes(`→ ${choice}`))) break;
              tui.press("tui.select.down");
            }
            tui.press("tui.select.confirm");
          }
        } else if (frame.split("\n").includes("Pi Sync Settings")) {
          tui.send("\u001b[200~Show sync status\u001b[201~");
          frames.push(tui.render().join("\n"));
          tui.press("ctrl+c");
        } else if (frame.includes("Preparing push preview")) {
          // Let the loader reach the generated directional-review boundary; its
          // separate custom host below cancels before publication.
        } else {
          // Cancel Pull preparation or the actual Push review; traffic is loopback.
          tui.press("ctrl+c");
        }
        return await result;
      } finally {
        tui.dispose();
      }
    }) as ExtensionCommandContext["ui"]["custom"];
    for (const handler of extension.handlers.get("session_start") ?? [])
      await handler({ type: "session_start", reason: "startup" }, context.ctx);
    await command.handler("", context.ctx);
    assert.equal(choices.length, 0);
    const settingsFrames = frames.filter((frame) => frame.split("\n").includes("Pi Sync Settings"));
    assert.equal(settingsFrames.length, 2);
    assert.match(settingsFrames[0] ?? "", /Included paths/u);
    assert.match(settingsFrames[0] ?? "", /Type to search/u);
    for (const frame of settingsFrames)
      assert.doesNotMatch(
        frame,
        /Sync content|Sync behavior|Storage & setups|Advanced|All settings|Pi Sync Settings ·/u,
      );
    assert.ok(
      frames.some((frame) => frame.includes("Checking remote changes")),
      frames.join("\n\n") + JSON.stringify(context.notifications),
    );
    assert.ok(frames.some((frame) => frame.includes("Preparing push preview")));
    assert.ok(frames.some((frame) => frame.includes("Push pi settings?") && frame.includes("No, cancel")));
    assert.ok(frames.some((frame) => frame.includes("Show sync status") && !frame.includes("Included paths")));
    assert.equal(await readFile(join(agentDir, "pi-sync.json"), "utf8"), bytes);

    const rpcChoices = ["History", undefined];
    const rpc = createMockContext({ mode: "rpc", select: async () => rpcChoices.shift() });
    await command.handler("", rpc.ctx);
    assert.equal(rpcChoices.length, 0);
    assert.ok(
      rpc.notifications.some((entry) => entry.message.includes("No remote pi-sync history")),
      JSON.stringify(rpc.notifications),
    );
    assert.ok(requests.length > 0);
    assert.equal(
      requests.some((method) => method !== "GET"),
      false,
      JSON.stringify(requests),
    );
    for (const handler of extension.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown", reason: "quit" }, rpc.ctx);
  } finally {
    loaded?.runtime.invalidate("flat menu package-directory smoke complete");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    await rm(root, { recursive: true, force: true });
  }
});
