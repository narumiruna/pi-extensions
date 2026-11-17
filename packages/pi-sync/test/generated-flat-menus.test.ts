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
import { stopDaemon } from "@narumitw/pi-sync-daemon";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { beforeEach, describe, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { v3S3Settings } from "./helpers.js";

initTheme("dark", false);

const cases = [
  { name: "TUI Settings", choice: "Settings", mode: "tui" },
  { name: "TUI cancelled Pull", choice: "Pull from remote…", mode: "tui" },
  { name: "TUI cancelled Push", choice: "Push to remote…", mode: "tui" },
  { name: "RPC History", choice: "History", mode: "rpc" },
] as const;

describe.each(cases)("package-directory Jiti $name", ({ choice, mode }) => {
  let run: () => Promise<void>;

  beforeEach(async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), "pi-sync-flat-smoke-"));
    const agentDir = join(root, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.method ?? "GET");
      response.writeHead(404, { "Content-Type": "application/xml" });
      response.end("<Error><Code>NoSuchKey</Code></Error>");
    });
    let loaded: ReturnType<DefaultResourceLoader["getExtensions"]> | undefined;
    let activeContext: ExtensionCommandContext | undefined;
    let commandTask: Promise<void> | undefined;
    const hosts = new Set<ReturnType<typeof createTuiHarness>>();
    onTestFinished(async () => {
      try {
        for (const host of hosts) host.press("ctrl+c");
        try {
          if (activeContext)
            for (const handler of loaded?.extensions[0]?.handlers.get("session_shutdown") ?? [])
              await handler({ type: "session_shutdown", reason: "reload" }, activeContext);
        } finally {
          await commandTask?.catch(() => {});
        }
      } finally {
        try {
          await stopDaemon(agentDir);
        } finally {
          for (const host of hosts) host.dispose();
          loaded?.runtime.invalidate("flat menu package-directory smoke complete");
          if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previous;
          try {
            if (server.listening)
              await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
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
    const choices: (string | undefined)[] = [choice, undefined];
    const context = createMockContext({ hasUI: true, mode: "tui" });
    activeContext = context.ctx as ExtensionCommandContext;
    activeContext.ui.custom = (async (factory) => {
      // Separate hosts support nested manager/edit flows without probing a factory twice.
      const tui = createTuiHarness({ width: 100, rows: 28 });
      hosts.add(tui);
      try {
        const result = tui.custom(factory);
        await tui.waitForOpen();
        const frame = tui.render().join("\n");
        frames.push(frame);
        if (frame.split("\n").includes("Manage sync")) {
          const selected = choices.shift();
          if (!selected) tui.press("ctrl+c");
          else {
            for (let index = 0; index < 20; index++) {
              if (tui.render().some((line) => line.includes(`→ ${selected}`))) break;
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
        hosts.delete(tui);
      }
    }) as ExtensionCommandContext["ui"]["custom"];
    // Cold Jiti loading and session/daemon readiness belong to this fixture, not
    // to the operation's 5,000 ms test budget.
    for (const handler of extension.handlers.get("session_start") ?? [])
      await handler({ type: "session_start", reason: "startup" }, context.ctx);
    const rpc = createMockContext({ mode: "rpc", select: async () => choices.shift() });
    if (mode === "rpc") {
      activeContext = rpc.ctx as ExtensionCommandContext;
      for (const handler of extension.handlers.get("session_start") ?? [])
        await handler({ type: "session_start", reason: "new" }, rpc.ctx);
    }
    const operationContext = activeContext;
    run = async () => {
      commandTask = command.handler("", operationContext);
      await commandTask;
      assert.equal(choices.length, 0);
      if (choice === "Settings") {
        const settingsFrames = frames.filter((frame) => frame.split("\n").includes("Pi Sync Settings"));
        assert.equal(settingsFrames.length, 2);
        assert.match(settingsFrames[0] ?? "", /Included paths/u);
        assert.match(settingsFrames[0] ?? "", /Type to search/u);
        for (const frame of settingsFrames)
          assert.doesNotMatch(
            frame,
            /Sync content|Sync behavior|Storage & setups|Advanced|All settings|Pi Sync Settings ·/u,
          );
        assert.ok(frames.some((frame) => frame.includes("Show sync status") && !frame.includes("Included paths")));
      } else if (choice === "Pull from remote…") {
        assert.ok(
          frames.some((frame) => frame.includes("Checking remote changes")),
          frames.join("\n\n") + JSON.stringify(context.notifications),
        );
      } else if (choice === "Push to remote…") {
        assert.ok(frames.some((frame) => frame.includes("Preparing push preview")));
        assert.ok(frames.some((frame) => frame.includes("Push pi settings?") && frame.includes("No, cancel")));
      } else {
        assert.ok(
          rpc.notifications.some((entry) => entry.message.includes("No remote pi-sync history")),
          JSON.stringify(rpc.notifications),
        );
        assert.ok(requests.length > 0);
        for (const handler of extension.handlers.get("session_shutdown") ?? [])
          await handler({ type: "session_shutdown", reason: "quit" }, rpc.ctx);
      }
      assert.equal(await readFile(join(agentDir, "pi-sync.json"), "utf8"), bytes);
      assert.equal(
        requests.some((method) => method !== "GET"),
        false,
        JSON.stringify(requests),
      );
    };
  });

  test("preserves flat navigation, cancellation, and read-only state", async () => {
    await run();
  });
});
