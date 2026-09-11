import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runBtwMenuPreservingEditor, showBtwCommandMenu } from "../src/menu.js";
import { BTW_SETTINGS_FILE } from "../src/settings.js";

async function withMenu(
  run: (host: {
    settingsPath: string;
    tui: ReturnType<typeof createTuiHarness>;
    ctx: ExtensionCommandContext;
    notifications: ReturnType<typeof createMockContext>["notifications"];
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-btw-menu-test-"));
  const tui = createTuiHarness({
    width: 80,
    rows: 24,
    keybindings: new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.thinking.cycle": { defaultKeys: "shift+tab" },
    }) as never,
  });
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
    editorText: "draft",
  });
  try {
    await run({
      settingsPath: join(directory, BTW_SETTINGS_FILE),
      tui,
      ctx: mock.ctx,
      notifications: mock.notifications,
    });
  } finally {
    tui.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test("editor preservation finishes safely after its session context is replaced", async () => {
  let stale = false;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      getEditorText() {
        if (stale) throw new Error("Extension context is no longer active");
        return "draft";
      },
      setEditorText() {
        assert.fail("a replacement editor must not receive a stale draft");
      },
      custom: async (factory: (...args: never[]) => unknown) => {
        let result: unknown;
        factory(
          {} as never,
          {} as never,
          {} as never,
          ((value: unknown) => {
            result = value;
          }) as never,
        );
        return result;
      },
    },
  } as never;

  const result = await runBtwMenuPreservingEditor(ctx, async (menuContext) => {
    const ui = menuContext.ui as ExtensionCommandContext["ui"];
    await ui.custom((_tui, _theme, _keybindings, done) => {
      stale = true;
      done("completed");
      return { render: () => [], invalidate() {} };
    });
    return { kind: "closed", reason: "close" };
  });

  assert.deepEqual(result, { kind: "closed", reason: "close" });
});

test("btw no-argument menu selects Start side thread first and preserves the editor", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low", "medium", "high"],
    });
    await tui.waitForOpen();
    const rendered = tui.render(140).join("\n");
    assert.match(rendered, /Pi BTW/);
    assert.match(rendered, /→ Start side thread/);
    assert.match(rendered, /Start from main thread tree…/);
    assert.match(rendered, /without switching the main branch/);
    assert.doesNotMatch(rendered, /Resume side thread/);
    assert.match(rendered, /Settings/);
    tui.press("tui.select.confirm");

    assert.equal(await running, "start");
    assert.equal(ctx.ui.getEditorText(), "draft");
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});

test("btw menu returns the main-thread tree action without changing settings or the editor", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    let settingsReads = 0;
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low"],
      readSettings: async () => {
        settingsReads += 1;
        return { kind: "missing" };
      },
    });
    await tui.waitForOpen();
    tui.press("tui.select.down");
    assert.match(tui.render().join("\n"), /→ Start from main thread tree…/);
    ctx.ui.setEditorText("newer draft");
    tui.press("tui.select.confirm");

    assert.equal(await running, "tree");
    assert.equal(settingsReads, 1);
    assert.equal(ctx.ui.getEditorText(), "newer draft");
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});

test("btw menu selects an in-memory side thread through a Kit choice screen", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low", "medium", "high"],
      resumeThreads: [
        { id: "newer", title: "Second side topic", questionCount: 3 },
        { id: "older", title: "First side topic", questionCount: 1 },
      ],
    });
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /→ Start side thread/);
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    assert.match(tui.render().join("\n"), /→ Resume side thread/);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const choices = tui.render().join("\n");
    assert.ok(choices.indexOf("Second side topic") < choices.indexOf("First side topic"));
    assert.match(choices, /Second side topic\s+3 questions/);
    assert.match(choices, /First side topic\s+1 question/);
    tui.type("missing");
    assert.match(tui.render().join("\n"), /No matching choices/u);
    for (let index = 0; index < 7; index += 1) tui.send("\u007f");
    tui.type("first");
    const filtered = tui.render().join("\n");
    assert.match(filtered, /→ First side topic/u);
    assert.doesNotMatch(filtered, /Second side topic/u);
    assert.ok(tui.resize({ width: 32 }).every((line) => visibleWidth(line) <= 32));
    tui.press("tui.select.confirm");

    assert.deepEqual(await running, { kind: "resume", threadId: "older" });
    assert.equal(ctx.ui.getEditorText(), "draft");
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});

test("btw Resume search keeps duplicate titles tied to raw thread ids", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low"],
      resumeThreads: [
        { id: "newer", title: "Repeated question", questionCount: 3 },
        { id: "older", title: "Repeated question", questionCount: 1 },
      ],
    });
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.type("1 question");
    const filtered = tui.render().join("\n");
    assert.match(filtered, /→ Repeated question\s+1 question/u);
    assert.doesNotMatch(filtered, /3 questions/u);
    tui.press("tui.select.confirm");

    assert.deepEqual(await running, { kind: "resume", threadId: "older" });
    assert.equal(ctx.ui.getEditorText(), "draft");
  });
});

test("btw Resume choice returns to the main menu with Back and closes with Ctrl+C", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low"],
      resumeThreads: [{ id: "thread", title: "Side topic", questionCount: 1 }],
    });
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /→ Resume side thread/);
    tui.press("ctrl+c");

    assert.equal(await running, "closed");
    assert.equal(ctx.ui.getEditorText(), "draft");
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});

test.each([
  ["exit", "Exit shortcut", "ctrl+q", "Ctrl+Q"],
  ["cycleThinkingLevel", "Cycle thinking level shortcut", "f6", "F6"],
  ["bringToMain", "Bring to main shortcut", "f7", "F7"],
])("BTW Settings edits and resets %s without changing the main draft", async (action, label, key, display) => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low"],
    });
    await openSettings(tui);
    tui.type(label);
    tui.press("tui.select.confirm");
    await vi.waitFor(() => assert.match(tui.render().join("\n"), /Edit key combination/));
    tui.press("tui.select.confirm");
    await vi.waitFor(() => assert.match(tui.render().join("\n"), /Type a key name/));
    tui.type(key);
    tui.press("tui.input.submit");
    await vi.waitFor(() => assert.ok(tui.render().join("\n").includes(`Custom (${display})`)));
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).keybindings[action], key);
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await vi.waitFor(() => assert.match(tui.render().join("\n"), /Pi BTW Settings/));
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {});
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
    assert.equal(ctx.ui.getEditorText(), "draft");
  });
});

test.each(["invalid", "cancel", "failed-save", "dispose", "concurrent"])(
  "shortcut editing handles %s without publishing a changed binding",
  async (scenario) => {
    await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
      await writeFile(settingsPath, '{"keybindings":{"exit":"f6"},"future":true}');
      let started = false;
      let aborted = false;
      const running = showBtwCommandMenu(ctx, {
        settingsPath,
        currentThinkingLevel: "low",
        availableThinkingLevels: ["off", "low"],
        ...(scenario === "failed-save" || scenario === "dispose"
          ? {
              updateSettings: async (_patch: unknown, options: { signal?: AbortSignal }) => {
                started = true;
                if (scenario === "failed-save") throw new Error("disk unavailable");
                await new Promise<void>((resolve) =>
                  options.signal?.addEventListener(
                    "abort",
                    () => {
                      aborted = true;
                      resolve();
                    },
                    { once: true },
                  ),
                );
                throw new Error("disposed");
              },
            }
          : {}),
      });
      await openSettings(tui);
      tui.type("Exit shortcut");
      tui.press("tui.select.confirm");
      await vi.waitFor(() => assert.match(tui.render().join("\n"), /Edit key combination/));
      tui.press("tui.select.confirm");
      await vi.waitFor(() => assert.match(tui.render().join("\n"), /Type a key name/));
      tui.type(scenario === "invalid" ? "ctrl+i" : "ctrl+q");
      if (scenario === "cancel") {
        tui.press("tui.select.cancel");
        await vi.waitFor(() => assert.match(tui.render().join("\n"), /Custom \(F6\)/));
      } else {
        if (scenario === "concurrent")
          await writeFile(
            settingsPath,
            JSON.stringify({
              keybindings: { exit: "f6", cycleThinkingLevel: "ctrl+q" },
              future: true,
            }),
          );
        tui.press("tui.input.submit");
        if (scenario === "dispose") {
          await vi.waitFor(() => assert.equal(started, true));
          tui.dispose();
        } else {
          await vi.waitFor(() => assert.ok(notifications.some((notice) => notice.level === "error")));
        }
      }
      if (scenario !== "dispose") tui.press("ctrl+c");
      assert.equal(await running, "closed");
      assert.equal(aborted, scenario === "dispose");
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        keybindings: {
          exit: "f6",
          ...(scenario === "concurrent" ? { cycleThinkingLevel: "ctrl+q" } : {}),
        },
        future: true,
      });
    });
  },
);

test("Settings distinguishes a conflicting saved shortcut from its effective fallback", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    await writeFile(settingsPath, '{"keybindings":{"exit":"ctrl+b"}}');
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low"],
    });
    await openSettings(tui);
    tui.type("Exit shortcut");
    assert.match(tui.render(160).join("\n"), /Fallback \(Ctrl\+C; saved Ctrl\+B\)/);
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      keybindings: { exit: "ctrl+b" },
    });
  });
});

async function openSettings(tui: ReturnType<typeof createTuiHarness>): Promise<void> {
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  assert.match(tui.render().join("\n"), /→ Settings/);
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();
}

test("disposing the idle btw menu closes without writing or changing the editor", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low"],
    });
    await tui.waitForOpen();
    tui.dispose();

    assert.equal(await running, "closed");
    assert.equal(ctx.ui.getEditorText(), "draft");
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});

test("btw menu opens Pi-style thinking settings and cancellation is read-only", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
    });
    await openSettings(tui);
    const settings = tui.render().join("\n");
    assert.match(settings, /Pi BTW Settings/);
    assert.match(settings, /Thinking level\s+Same as main thread/);
    assert.match(settings, /Currently medium/);
    assert.match(settings, /Remember thinking level changes\s+On/);
    assert.match(settings, /Copy selection automatically\s+On/);
    tui.press("ctrl+c");

    assert.equal(await running, "closed");
    assert.equal(ctx.ui.getEditorText(), "draft");
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});

test("btw settings can choose Same as main thread and clear a fixed thinking level", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    await writeFile(
      settingsPath,
      '{"model":"test/side","future":{"kept":true},"thinkingLevel":"high","rememberThinkingLevelChanges":false}\n',
      "utf8",
    );
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
    });
    await openSettings(tui);
    assert.match(tui.render().join("\n"), /Thinking level\s+high/);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    const saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved, {
      model: "test/side",
      future: { kept: true },
      rememberThinkingLevelChanges: false,
    });
    assert.match(tui.render().join("\n"), /Thinking level\s+Same as main thread/);
    assert.ok(notifications.some(({ message }) => /thinking level: Same as main thread/i.test(message)));
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
  });
});

test("btw settings save thinking and remembering immediately while preserving unknown fields", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    await writeFile(settingsPath, '{"model":"test/side","future":{"kept":true},"thinkingLevel":"medium"}\n', "utf8");
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
    });
    await openSettings(tui);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    let saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved, {
      model: "test/side",
      future: { kept: true },
      thinkingLevel: "high",
    });
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.rememberThinkingLevelChanges, false);
    assert.equal(saved.thinkingLevel, "high");
    assert.ok(notifications.some(({ message }) => /thinking level: high/i.test(message)));
    assert.ok(notifications.some(({ message }) => /changes: Off/i.test(message)));
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
  });
});

test("btw settings save automatic selection copying immediately and preserve unknown fields", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    await writeFile(settingsPath, '{"future":{"kept":true}}\n', "utf8");
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
    });
    await openSettings(tui);
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    assert.match(tui.render().join("\n"), /Copy selection automatically\s+On/);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      future: { kept: true },
      fullscreenCopyOnSelect: false,
    });
    assert.match(tui.render().join("\n"), /Copy selection automatically\s+Off/);
    assert.ok(notifications.some(({ message }) => /automatically: Off/i.test(message)));
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
  });
});

test("btw settings reject failed saves and restore the prior displayed value", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
      updateSettings: async () => {
        throw new Error("disk full\u001b]52;c;mock-terminal-payload\u0007");
      },
    });
    await openSettings(tui);
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    const narrow = tui.render(32);
    assert.ok(narrow.every((line) => visibleWidth(line) <= 32));
    assert.match(tui.render(80).join("\n"), /Copy selection automatically\s+On/);
    const failureMessage = notifications[0]?.message ?? "";
    assert.match(failureMessage, /previous value remains active.*disk full/i);
    assert.equal(
      [...failureMessage].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || (code >= 127 && code <= 159);
      }),
      false,
    );
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
  });
});

test("btw settings retain a completed save when its notification context is stale", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    await writeFile(settingsPath, '{"thinkingLevel":"low"}\n', "utf8");
    ctx.ui.notify = () => {
      throw new Error("Extension context is no longer active");
    };
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low", "medium"],
    });
    await openSettings(tui);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.equal(
      (JSON.parse(await readFile(settingsPath, "utf8")) as { thinkingLevel: string }).thinkingLevel,
      "medium",
    );
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
  });
});

test("btw menu exposes malformed settings as read-only", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    await writeFile(settingsPath, "{broken", "utf8");
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low"],
    });
    await openSettings(tui);
    assert.match(tui.render().join("\n"), /Read only/);
    assert.match(tui.render(240).join("\n"), /Fix .*pi-btw\.json before saving/);
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
    assert.equal(await readFile(settingsPath, "utf8"), "{broken");
  });
});

test("disposing btw settings aborts and drains an in-flight save without notification", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    let started!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      availableThinkingLevels: ["off", "low", "medium"],
      updateSettings: async (_patch, { signal }) => {
        started();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await openSettings(tui);
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await saveStarted;
    tui.dispose();

    assert.equal(await running, "closed");
    assert.deepEqual(notifications, []);
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});
