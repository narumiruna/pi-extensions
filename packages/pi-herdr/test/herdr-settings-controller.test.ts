import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createHerdrSettingsController } from "../src/herdr-settings-controller.js";

import { updateHerdrSettings } from "../src/settings.js";

initTheme("dark", false);

async function setup(mode: "tui" | "rpc" = "tui") {
  const root = await mkdtemp(join(tmpdir(), "herdr-menu-"));
  const settingsPath = join(root, "pi-herdr.json");
  const mock = createMockPi();
  const observer = { start: vi.fn(), shutdown: vi.fn(async () => {}) };
  const controller = createHerdrSettingsController(mock.pi, observer, { settingsPath });
  const context = createMockContext({ mode, hasUI: true });
  await controller.start(context.ctx);
  const command = mock.commands.get("herdr");
  assert.ok(command);
  return {
    ...context,
    ctx: context.ctx as ExtensionCommandContext,
    controller,
    observer,
    command,
    settingsPath,
    async close() {
      await controller.shutdown(context.ctx);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("RPC toggles persist in order without starting a widget and reload the saved value", async () => {
  const h = await setup("rpc");
  try {
    const rpc = createRpcHarness([
      { kind: "select", response: "Agent widget: On" },
      { kind: "select", response: "Agent widget: Off" },
      { kind: "select", response: "Agent widget: On" },
      { kind: "select", response: "Status" },
      { kind: "select", response: "Back" },
      { kind: "select", response: "Help" },
      { kind: "select", response: "Back" },
      { kind: "select", response: "Close" },
    ]);
    await h.command.handler("", { ...h.ctx, ui: { ...h.ctx.ui, ...rpc.ui } });
    rpc.assertConsumed();
    assert.deepEqual(JSON.parse(await readFile(h.settingsPath, "utf8")), { widget: false });
    assert.equal(h.observer.start.mock.calls.length, 0);
    await h.controller.start({ ...h.ctx, mode: "tui" });
    assert.equal(h.observer.start.mock.calls.length, 0);
  } finally {
    await h.close();
  }
});

test("TUI switches the observer immediately and cancellation leaves saved settings intact", async () => {
  const h = await setup();
  const tui = createTuiHarness({ width: 80, rows: 24 });
  try {
    const running = h.command.handler("", { ...h.ctx, ui: { ...h.ctx.ui, custom: tui.custom } });
    await tui.waitForOpen();
    assert.match(stripVTControlCharacters(tui.render().join("\n")), /Agent widget: On/u);
    tui.press("tui.select.confirm");
    await vi.waitFor(async () => assert.equal(JSON.parse(await readFile(h.settingsPath, "utf8")).widget, false));
    assert.equal(h.observer.shutdown.mock.calls.length, 1);
    await tui.waitForOpen();
    tui.press("ctrl+c");
    await running;
    assert.equal(JSON.parse(await readFile(h.settingsPath, "utf8")).widget, false);
  } finally {
    await h.close();
  }
});

test("invalid files block saving, restore the observer, and warn without exposing file contents", async () => {
  const h = await setup();
  try {
    await writeFile(h.settingsPath, '{"widget":"secret"}');
    const rpc = createRpcHarness([
      { kind: "select", response: "Agent widget: On" },
      { kind: "select", response: "Close" },
    ]);
    await h.command.handler("", { ...h.ctx, mode: "rpc", ui: { ...h.ctx.ui, ...rpc.ui } });
    rpc.assertConsumed();
    assert.equal(h.observer.start.mock.calls.length, 2);
    assert.equal(await readFile(h.settingsPath, "utf8"), '{"widget":"secret"}');
    assert.match(h.notifications[0]?.message ?? "", /previous widget setting was restored/u);
    await h.controller.start(h.ctx);
    assert.match(h.notifications.at(-1)?.message ?? "", /ignored invalid/u);
  } finally {
    await h.close();
  }
});

test("session replacement closes an open menu and stale commands cannot mutate settings", async () => {
  const h = await setup();
  const tui = createTuiHarness({ width: 80, rows: 24 });
  try {
    const running = h.command.handler("", { ...h.ctx, ui: { ...h.ctx.ui, custom: tui.custom } });
    await tui.waitForOpen();
    const next = createMockContext({ mode: "tui", hasUI: true });
    await h.controller.start(next.ctx);
    await running;
    assert.equal(h.observer.shutdown.mock.calls.length, 1);
    await h.command.handler("", h.ctx);
    await assert.rejects(readFile(h.settingsPath), { code: "ENOENT" });
    await h.controller.shutdown(h.ctx);
    assert.equal(h.observer.shutdown.mock.calls.length, 1);
    await h.controller.shutdown(next.ctx);
  } finally {
    await h.close();
  }
});

test("replacement waits for pending writes and ignores an older settings load", async () => {
  const h = await setup();
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const write = updateHerdrSettings(
    { widget: false },
    {
      settingsPath: h.settingsPath,
      beforeRename: async () => {
        ready();
        await gate;
      },
    },
  );
  try {
    await reached;
    const staleStart = h.controller.start(h.ctx);
    const next = createMockContext({ mode: "tui", hasUI: true });
    const currentStart = h.controller.start(next.ctx);
    release();
    await Promise.all([write, staleStart, currentStart]);
    assert.equal(h.observer.start.mock.calls.length, 1, "neither start may use the pre-write value");
    await h.controller.shutdown(next.ctx);
  } finally {
    release();
    await write;
    await h.close();
  }
});

test("disposing the menu without choosing an action does not create settings", async () => {
  const h = await setup();
  const tui = createTuiHarness({ width: 80, rows: 24 });
  try {
    const running = h.command.handler("", { ...h.ctx, ui: { ...h.ctx.ui, custom: tui.custom } });
    await tui.waitForOpen();
    tui.dispose();
    await running;
    await assert.rejects(readFile(h.settingsPath), { code: "ENOENT" });
  } finally {
    await h.close();
  }
});

test("arguments and headless modes are rejected before opening UI", async () => {
  const h = await setup();
  try {
    await assert.rejects(async () => {
      await h.command.handler("on", h.ctx);
    }, /does not accept arguments/u);
    for (const mode of ["print", "json"] as const) {
      await assert.rejects(async () => {
        await h.command.handler("", { ...h.ctx, mode, hasUI: false });
      }, /requires TUI or RPC/u);
    }
  } finally {
    await h.close();
  }
});
