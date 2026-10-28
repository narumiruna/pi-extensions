import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStarshipCommand } from "../src/commands.js";
import { loadStarshipConfig } from "../src/config.js";
import { archiveConfigDocument, createProfile, listHistory, readProfile } from "../src/profile-store.js";

const ACTIVE = "format = 'active'\n";
const CANDIDATE = "format = 'candidate'\n";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(remapped = false, editor?: ExtensionCommandContext["ui"]["editor"]) {
  const root = mkdtempSync(join(tmpdir(), "starship-preview-cleanup-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, ACTIVE);
  const loaded = loadStarshipConfig(path);
  const keys: Record<string, string[]> = {
    "tui.select.up": ["k"],
    "tui.select.down": ["j"],
    "tui.select.confirm": ["y"],
    "tui.select.cancel": ["q"],
  };
  const keybindings: Pick<KeybindingsManager, "matches" | "getKeys"> = {
    matches: (data, action) => (keys[action] ?? []).some((key) => matchesKey(data, key as never)),
    getKeys: (action) => (keys[action] ?? []) as never[],
  };
  const tui = createTuiHarness({ width: 100, rows: 35, keybindings: remapped ? keybindings : undefined });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom, ...(editor ? { editor } : {}) });
  const ctx = context.ctx as ExtensionCommandContext;
  const observers = new Set<TerminalInputHandler>();
  ctx.ui.onTerminalInput = (observer) => {
    observers.add(observer);
    return () => {
      observers.delete(observer);
    };
  };
  let generation = 0;
  let controller = new AbortController();
  let displayed = ACTIVE;
  let clears = 0;
  const mock = createMockPi();
  registerStarshipCommand(mock.pi, {
    settingsPath: path,
    getLoaded: () => loaded,
    getLoadedRevision: () => 0,
    getMenuOwner() {
      const expected = generation;
      const signal = controller.signal;
      return { signal, isCurrent: () => generation === expected && !signal.aborted };
    },
    apply() {
      assert.fail("Preview cleanup must not apply settings");
    },
    preview(next) {
      if (!next) clears += 1;
      displayed = next?.rawDocument ?? ACTIVE;
    },
  });
  const command = mock.commands.get("starship");
  assert.ok(command);
  return {
    path,
    tui,
    ctx,
    observers,
    command,
    get displayed() {
      return displayed;
    },
    get clears() {
      return clears;
    },
    start: () => Promise.resolve(command.handler("", ctx)),
    press(action: "down" | "confirm") {
      tui.send(remapped ? (action === "down" ? "j" : "y") : action === "down" ? "\x1b[B" : "\r");
    },
    dispatch(data: string) {
      // Pi calls extension listeners before the focused component sees the same packet.
      for (const observer of [...observers]) assert.equal(observer(data), undefined);
      if (tui.isOpen) tui.send(data);
    },
    replaceSession() {
      generation += 1;
      displayed = ACTIVE;
      controller.abort();
      controller = new AbortController();
    },
    cleanup() {
      controller.abort();
      tui.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function openCandidate(f: ReturnType<typeof fixture>, kind: "profile" | "history", actions = false) {
  await f.tui.waitForOpen();
  if (kind === "profile") {
    f.press("down");
    f.press("down");
    f.press("confirm");
    await f.tui.waitForOpen();
    f.press("down");
  } else {
    for (let index = 0; index < 3; index += 1) f.press("down");
    f.press("confirm");
    await f.tui.waitForOpen();
    for (let index = 0; index < 3; index += 1) f.press("down");
    f.press("confirm");
    await f.tui.waitForOpen();
  }
  assert.equal(f.displayed, CANDIDATE);
  if (actions) {
    f.press("confirm");
    await f.tui.waitForOpen();
  }
}

for (const kind of ["profile", "history"] as const) {
  for (const actions of [false, true]) {
    for (const remapped of [false, true]) {
      test(`raw Ctrl+C restores ${kind} preview from ${actions ? "actions" : "browser"} with ${remapped ? "remapped" : "default"} bindings`, async () => {
        const f = fixture(remapped);
        if (kind === "profile") createProfile(f.path, "Preview", CANDIDATE);
        else archiveConfigDocument(f.path, CANDIDATE);
        const historyBefore = listHistory(f.path).map((entry) => entry.name);
        const running = f.start();
        try {
          await openCandidate(f, kind, actions);
          f.dispatch("\x03");
          await running;
          assert.equal(f.displayed, ACTIVE);
          assert.equal(f.observers.size, 0);
          assert.equal(readFileSync(f.path, "utf8"), ACTIVE);
          assert.deepEqual(
            listHistory(f.path).map((entry) => entry.name),
            historyBefore,
          );
        } finally {
          f.cleanup();
          await running;
        }
      });
    }
  }
}

test("hard cancellation clears a profile preview while its native editor still drains", async () => {
  const ready = deferred<void>();
  const editor = deferred<string | undefined>();
  const f = fixture(false, async () => {
    ready.resolve();
    return editor.promise;
  });
  createProfile(f.path, "Preview", CANDIDATE);
  const running = f.start();
  try {
    await openCandidate(f, "profile", true);
    f.press("down");
    f.press("down");
    f.press("confirm");
    await ready.promise;
    f.dispatch("\x03");
    await Promise.resolve();
    assert.equal(f.displayed, ACTIVE);
    assert.equal(f.observers.size, 0);
    editor.resolve("format = 'must-not-save'\n");
    await running;
    assert.equal(readFileSync(f.path, "utf8"), ACTIVE);
    assert.equal(readProfile(f.path, "Preview").rawDocument, CANDIDATE);
  } finally {
    editor.resolve(undefined);
    f.cleanup();
    await running;
  }
});

for (const previous of ["preset", "profile"] as const) {
  test(`a late ${previous} editor cannot clear a replacement session's profile preview`, async () => {
    const ready = deferred<void>();
    const editor = deferred<string | undefined>();
    const f = fixture(false, async () => {
      ready.resolve();
      return editor.promise;
    });
    createProfile(f.path, "Preview", CANDIDATE);
    const oldCommand = f.start();
    let newCommand: Promise<unknown> | undefined;
    try {
      if (previous === "preset") {
        await f.tui.waitForOpen();
        f.press("down");
        f.press("confirm");
        await f.tui.waitForOpen();
        f.tui.send("e");
      } else {
        await openCandidate(f, "profile", true);
        f.press("down");
        f.press("down");
        f.press("confirm");
      }
      await ready.promise;
      f.replaceSession();
      newCommand = f.start();
      await openCandidate(f, "profile");
      const clearsBefore = f.clears;
      editor.resolve(undefined);
      await oldCommand;
      assert.equal(f.displayed, CANDIDATE);
      assert.equal(f.clears, clearsBefore);
      assert.equal(f.observers.size, 1);
      f.dispatch("\x03");
      await newCommand;
      assert.equal(f.displayed, ACTIVE);
    } finally {
      editor.resolve(undefined);
      f.cleanup();
      await oldCommand;
      await newCommand;
    }
  });
}
