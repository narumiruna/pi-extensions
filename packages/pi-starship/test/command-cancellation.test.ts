import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStarshipCommand } from "../src/commands.js";
import { loadStarshipConfig } from "../src/config.js";
import { listHistory } from "../src/profile-store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const [name, packet, cancels] of [
  ["legacy Ctrl+C", "\x03", true],
  ["Kitty Ctrl+C", "\x1b[99;5u", true],
  ["modifyOtherKeys Ctrl+C", "\x1b[27;5;99~", true],
  ["Kitty key release", "\x1b[99;5:3u", false],
  ["extra modifiers", "\x1b[99;7u", false],
  ["pasted legacy control", "\x1b[200~\x03\x1b[201~", false],
  ["pasted protocol control", "\x1b[200~\x1b[99;5u\x1b[201~", false],
] as const) {
  test(`whole-command cancellation handles ${name} during native confirmation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-starship-command-cancel-"));
    const path = join(root, "pi-starship.toml");
    const original = "format = '$model'\n";
    writeFileSync(path, original);
    const ready = deferred<void>();
    const confirmed = deferred<boolean>();
    const listeners = new Set<(data: string) => unknown>();
    let dialogSignal: AbortSignal | undefined;
    const focus: { current: "dialog" | "editor" } = { current: "dialog" };
    const editorInputs: string[] = [];
    const dialogInputs: string[] = [];
    const tui = createTuiHarness({ width: 80, rows: 24 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async () => "format = '$directory'\n",
    });
    const ctx = context.ctx as ExtensionCommandContext;
    ctx.ui.onTerminalInput = (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    ctx.ui.confirm = async (_title, _message, options) => {
      dialogSignal = options?.signal;
      dialogSignal?.addEventListener(
        "abort",
        () => {
          focus.current = "editor";
          confirmed.resolve(false);
        },
        { once: true },
      );
      ready.resolve();
      return confirmed.promise;
    };
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      settingsPath: path,
      getLoaded: () => loadStarshipConfig(path),
      apply() {
        assert.fail("Cancellation must not apply settings");
      },
    });
    const running = mock.commands.get("starship")?.handler("settings", context.ctx);
    try {
      await tui.waitForOpen();
      tui.press("tui.select.confirm");
      await ready.promise;
      for (const listener of [...listeners]) assert.equal(listener(packet), undefined);
      // TUI delivers listeners before dispatching to whichever component is focused.
      // Native signal-abort handlers restore the underlying editor synchronously.
      if (focus.current === "editor") editorInputs.push(packet);
      else dialogInputs.push(packet);
      await Promise.resolve();
      assert.deepEqual(editorInputs, []);
      assert.deepEqual(dialogInputs, [packet]);
      assert.equal(dialogSignal?.aborted, cancels);
      if (!cancels) {
        confirmed.resolve(false);
        await tui.waitForOpen();
        for (const listener of [...listeners]) listener("\x03");
      }
      await running;
      assert.equal(listeners.size, 0);
      assert.equal(readFileSync(path, "utf8"), original);
      assert.deepEqual(listHistory(path), []);
    } finally {
      confirmed.resolve(false);
      tui.dispose();
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Ctrl+C during file-mutation queue admission cancels before backup or publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-queued-cancel-"));
  const path = join(root, "pi-starship.toml");
  const original = "format = '$model'\n";
  writeFileSync(path, original);
  const acquired = deferred<void>();
  const release = deferred<void>();
  const confirmation = deferred<void>();
  const blocking = withFileMutationQueue(path, async () => {
    acquired.resolve();
    await release.promise;
  });
  const listeners = new Set<(data: string) => unknown>();
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
    editor: async () => "format = '$directory'\n",
    confirm: async () => {
      confirmation.resolve();
      return true;
    },
  });
  const ctx = context.ctx as ExtensionCommandContext;
  ctx.ui.onTerminalInput = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const mock = createMockPi();
  registerStarshipCommand(mock.pi, {
    settingsPath: path,
    getLoaded: () => loadStarshipConfig(path),
    apply() {
      assert.fail("Cancelled queued work must not apply");
    },
  });
  await acquired.promise;
  const running = mock.commands.get("starship")?.handler("settings", context.ctx);
  try {
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await confirmation.promise;
    for (const listener of [...listeners]) listener("\x03");
    release.resolve();
    await blocking;
    await running;
    assert.equal(readFileSync(path, "utf8"), original);
    assert.deepEqual(listHistory(path), []);
    assert.equal(listeners.size, 0);
  } finally {
    release.resolve();
    await blocking;
    tui.dispose();
    await running;
    rmSync(root, { recursive: true, force: true });
  }
});
