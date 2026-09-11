import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createPiChatExtension } from "../src/pi-chat.js";

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

async function fixture(run: (settingsPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-startup-imports-"));
  try {
    await run(join(root, "pi-chat.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Chat menu code loads only on demand and caches a successful import", async () => {
  await fixture(async (settingsPath) => {
    const mock = createMockPi();
    let loads = 0;
    let shows = 0;
    let transportCreates = 0;
    let directoryCreates = 0;
    let viewLoads = 0;
    let widgetLoads = 0;
    createPiChatExtension({
      settingsPath,
      loadChatMenu: async () => {
        loads += 1;
        return {
          showChatMenu: async () => {
            shows += 1;
          },
        };
      },
      createTransport: async () => {
        transportCreates += 1;
        throw new Error("unexpected transport creation");
      },
      createDirectory: async () => {
        directoryCreates += 1;
        throw new Error("unexpected directory creation");
      },
      loadChatView: async () => {
        viewLoads += 1;
        return import("../src/chat-view.js");
      },
      loadChatWidget: async () => {
        widgetLoads += 1;
        return import("../src/widget.js");
      },
    })(mock.pi);
    const context = createMockContext({ mode: "tui" });
    await emit(mock, "session_start", { reason: "startup" }, context.ctx);
    assert.equal(loads, 0);
    assert.equal(transportCreates, 0);
    assert.equal(directoryCreates, 0);
    assert.equal(viewLoads, 0);
    assert.equal(widgetLoads, 0);

    const command = mock.commands.get("chat");
    assert.ok(command);
    await command.handler("not-an-invite", context.ctx);
    assert.equal(loads, 0);
    assert.equal(transportCreates, 0);
    assert.equal(directoryCreates, 0);
    assert.equal(viewLoads, 0);
    assert.equal(widgetLoads, 0);
    await command.handler("", context.ctx);
    await command.handler("", context.ctx);
    assert.equal(loads, 1);
    assert.equal(shows, 2);
    assert.equal(transportCreates, 0);
    assert.equal(directoryCreates, 0);
    assert.equal(viewLoads, 0);
    assert.equal(widgetLoads, 0);
  });
});

test("Chat menu loading retries after failure and stale loads open no UI", async () => {
  await fixture(async (settingsPath) => {
    const mock = createMockPi();
    let loads = 0;
    let shows = 0;
    let releaseLoad: (() => void) | undefined;
    createPiChatExtension({
      settingsPath,
      loadChatMenu: async () => {
        loads += 1;
        if (loads === 1) throw new Error("temporary Chat menu load failure");
        if (loads === 2) {
          await new Promise<void>((resolve) => {
            releaseLoad = resolve;
          });
        }
        return {
          showChatMenu: async () => {
            shows += 1;
          },
        };
      },
    })(mock.pi);
    const first = createMockContext({ mode: "tui" });
    await emit(mock, "session_start", { reason: "startup" }, first.ctx);
    const command = mock.commands.get("chat");
    assert.ok(command);

    await assert.rejects(async () => command.handler("", first.ctx), /temporary Chat menu load failure/u);
    const pending = command.handler("", first.ctx);
    await Promise.resolve();
    const replacement = createMockContext({ mode: "tui" });
    await emit(mock, "session_start", { reason: "new" }, replacement.ctx);
    releaseLoad?.();
    await pending;
    assert.equal(loads, 2);
    assert.equal(shows, 0);

    await command.handler("", replacement.ctx);
    assert.equal(loads, 2);
    assert.equal(shows, 1);
  });
});
