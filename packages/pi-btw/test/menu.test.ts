import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runBtwMenuPreservingEditor, showBtwCommandMenu } from "../src/menu.js";
import { BTW_SETTINGS_FILE } from "../src/settings.js";

initTheme("dark", false);

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

test("btw menu falls back when model availability and scope APIs are absent", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const legacyModel = { provider: "legacy", id: "side", name: "Legacy side model" } as Model<Api>;
    let allModelReads = 0;
    const legacyRegistry = ctx.modelRegistry as unknown as {
      getAll: typeof ctx.modelRegistry.getAll;
      getAvailable?: typeof ctx.modelRegistry.getAvailable;
    };
    legacyRegistry.getAll = () => {
      allModelReads += 1;
      return [legacyModel];
    };
    delete legacyRegistry.getAvailable;
    delete (ctx as Partial<{ scopedModels: ExtensionCommandContext["scopedModels"] }>).scopedModels;

    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "off",
      currentModel: legacyModel,
      availableThinkingLevels: ["off"],
    });
    await openSettings(tui);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.equal(allModelReads, 1);
    assert.match(tui.render(120).join("\n"), /side \[legacy\]/u);
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
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
    assert.match(settings, /Model\s+Same as main thread/);
    assert.match(settings, /Thinking level\s+Same as main thread/);
    tui.press("tui.select.down");
    assert.match(tui.render().join("\n"), /Currently medium/);
    assert.match(settings, /Remember thinking level changes\s+On/);
    assert.match(settings, /Copy selection automatically\s+On/);
    assert.match(settings, /Side-thread layout\s+Fullscreen/);
    tui.press("ctrl+c");

    assert.equal(await running, "closed");
    assert.equal(ctx.ui.getEditorText(), "draft");
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});

test("btw settings select and reset a model while refreshing effective thinking choices", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    const mainModel = {
      provider: "anthropic",
      id: "main",
      name: "Main model",
      reasoning: true,
    } as Model<Api>;
    const sideModel = {
      provider: "openrouter",
      id: "anthropic/side",
      name: "Side specialist",
      reasoning: false,
    } as Model<Api>;
    await writeFile(settingsPath, '{"future":{"kept":true},"thinkingLevel":"high"}\n', "utf8");
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "medium",
      currentModel: mainModel,
      availableModels: [mainModel, sideModel],
    });
    await openSettings(tui);
    assert.match(tui.render(160).join("\n"), /Model\s+Same as main thread \(main \[anthropic\]\)/u);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    const selector = tui.render(160).join("\n");
    assert.match(selector, /Pi BTW Model/u);
    assert.match(selector, /Same as main thread.*current/u);
    assert.match(selector, /anthropic\/side \[openrouter\]/u);
    tui.type("specialist");
    assert.match(tui.render(160).join("\n"), /Model Name: Side specialist/u);
    tui.press("tui.select.confirm");
    await vi.waitFor(() => assert.match(tui.render(160).join("\n"), /Pi BTW Settings/u));

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      future: { kept: true },
      thinkingLevel: "high",
      model: "openrouter/anthropic/side",
    });
    const selected = tui.render(160).join("\n");
    assert.match(selected, /Model\s+anthropic\/side \[openrouter\]/u);
    assert.match(selected, /Thinking level\s+off/u);
    assert.ok(notifications.some(({ message }) => /Pi BTW model: anthropic\/side \[openrouter\]/u.test(message)));
    assert.ok(tui.render(34).every((line) => visibleWidth(line) <= 34));

    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.type("same as main");
    tui.press("tui.select.confirm");
    await vi.waitFor(() => assert.match(tui.render(160).join("\n"), /Pi BTW Settings/u));
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      future: { kept: true },
      thinkingLevel: "high",
    });
    assert.match(tui.render(160).join("\n"), /Model\s+Same as main thread \(main \[anthropic\]\)/u);
    assert.match(tui.render(160).join("\n"), /Thinking level\s+high/u);
    tui.press("tui.select.cancel");
    await tui.waitForPending();
    await tui.waitForOpen();
    const mainMenu = tui.render(160).join("\n");
    assert.match(mainMenu, /Start side thread/u);
    assert.doesNotMatch(mainMenu, /Pi BTW Model/u);
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
    assert.equal(ctx.ui.getEditorText(), "draft");
  });
});

test("btw model settings honor scope and preserve an out-of-scope configured model on cancellation", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const outside = { provider: "outside", id: "legacy", name: "Legacy" } as Model<Api>;
    const scoped = {
      provider: "inside",
      id: "side",
      name: "Side specialist\u001b]52;c;payload\u0007\u202e",
    } as Model<Api>;
    const hidden = { provider: "hidden", id: "other", name: "Hidden" } as Model<Api>;
    const unsafe = {
      provider: "unsafe\u001b]52;c;payload\u0007",
      id: "bad\u202e-model",
      name: "Unsafe model",
    } as Model<Api>;
    const original = '{"model":"outside/legacy","future":{"kept":true}}\n';
    await writeFile(settingsPath, original, "utf8");
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      currentModel: scoped,
      availableModels: [outside, scoped, hidden, unsafe],
      scopedModels: [{ model: scoped }, { model: unsafe }],
      availableThinkingLevels: ["off", "low"],
    });
    await openSettings(tui);
    assert.match(tui.render(160).join("\n"), /Model\s+legacy \[outside\] · outside current scope/u);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    const selector = stripVTControlCharacters(tui.render(160).join("\n"));
    const outsideLine =
      selector
        .split("\n")
        .filter((line) => line.includes("legacy [outside]"))
        .at(-1) ?? "";
    assert.match(outsideLine, /outside the current model scope/i);
    assert.doesNotMatch(outsideLine, /unavailable/i);
    assert.match(selector, /side \[inside\]/u);
    assert.match(selector, /bad-model \[unsafe\].*cannot be stored/is);
    assert.doesNotMatch(selector, /hidden|payload/u);
    assert.equal(selector.includes("\u001b"), false);
    assert.equal(selector.includes("\u202e"), false);

    tui.press("tui.select.confirm");
    await vi.waitFor(() => assert.match(tui.render(160).join("\n"), /Pi BTW Settings/u));
    tui.press("tui.select.cancel");
    await tui.waitForPending();
    await tui.waitForOpen();
    const mainMenu = tui.render(160).join("\n");
    assert.match(mainMenu, /Start side thread/u);
    assert.doesNotMatch(mainMenu, /Pi BTW Model/u);

    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.type("specialist");
    const filtered = stripVTControlCharacters(tui.render(160).join("\n"));
    assert.match(filtered, /side \[inside\]/u);
    assert.match(filtered, /Model Name: Side specialist/u);
    tui.press("ctrl+c");

    assert.equal(await running, "closed");
    assert.equal(await readFile(settingsPath, "utf8"), original);
    assert.equal(ctx.ui.getEditorText(), "draft");
  });
});

test("btw model settings show an unavailable configured model without rewriting it", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const mainModel = { provider: "current", id: "main" } as Model<Api>;
    const original = '{"model":"missing/side","future":true}\n';
    await writeFile(settingsPath, original, "utf8");
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      currentModel: mainModel,
      availableModels: [mainModel],
      availableThinkingLevels: ["off", "low"],
    });
    await openSettings(tui);
    assert.match(tui.render(160).join("\n"), /Model\s+Same as main thread · missing\/side unavailable/u);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    const selector = tui.render(160).join("\n");
    assert.match(selector, /Configured: Same as main thread · missing\/side unavailable/u);
    assert.match(selector, /missing\/side.*unavailable/is);
    tui.press("tui.select.cancel");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.press("ctrl+c");

    assert.equal(await running, "closed");
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });
});

test("btw model search keeps duplicate names tied to raw model identities", async () => {
  await withMenu(async ({ settingsPath, tui, ctx }) => {
    const first = { provider: "first", id: "one", name: "Shared specialist" } as Model<Api>;
    const second = { provider: "second", id: "two", name: "Shared specialist" } as Model<Api>;
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "off",
      currentModel: first,
      availableModels: [first, second],
      availableThinkingLevels: ["off"],
    });
    await openSettings(tui);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.type("shared specialist");
    assert.match(tui.render(160).join("\n"), /one \[first\]/u);
    assert.match(tui.render(160).join("\n"), /two \[second\]/u);
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await vi.waitFor(() => assert.match(tui.render(160).join("\n"), /Pi BTW Settings/u));

    assert.equal((JSON.parse(await readFile(settingsPath, "utf8")) as { model: string }).model, "second/two");
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
  });
});

test("btw model settings reject failed saves and keep the previous selection", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    const mainModel = { provider: "current", id: "main" } as Model<Api>;
    const sideModel = { provider: "other", id: "side" } as Model<Api>;
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "off",
      currentModel: mainModel,
      availableModels: [mainModel, sideModel],
      availableThinkingLevels: ["off"],
      updateSettings: async () => {
        throw new Error("disk full\u001b]52;c;mock-terminal-payload\u0007");
      },
    });
    await openSettings(tui);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.type("other side");
    tui.press("tui.select.confirm");
    await vi.waitFor(() => assert.match(tui.render(160).join("\n"), /Pi BTW Model[\s\S]*→ side \[other\]/u));

    assert.match(tui.render(160).join("\n"), /→ side \[other\]/u);
    tui.press("tui.select.cancel");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.match(tui.render(160).join("\n"), /Model\s+Same as main thread/u);
    const failureMessage = notifications.at(-1)?.message ?? "";
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
    tui.press("tui.select.down");
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
    tui.press("tui.select.down");
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

test("btw settings save the side-thread pane placement immediately and preserve unknown fields", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    await writeFile(settingsPath, '{"future":{"kept":true}}\n', "utf8");
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
    });
    await openSettings(tui);
    tui.type("Side-thread layout");
    assert.match(tui.render().join("\n"), /Side-thread layout\s+Fullscreen/);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      future: { kept: true },
      layout: "left-pane",
    });
    assert.match(tui.render().join("\n"), /Side-thread layout\s+Side thread left/);
    assert.ok(notifications.some(({ message }) => /layout: Side thread left.*next opens/i.test(message)));
    tui.press("ctrl+c");
    assert.equal(await running, "closed");
  });
});

test("btw layout settings reject failed saves and restore fullscreen", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
      updateSettings: async () => {
        throw new Error("disk full");
      },
    });
    await openSettings(tui);
    tui.type("Side-thread layout");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.match(tui.render().join("\n"), /Side-thread layout\s+Fullscreen/);
    assert.ok(notifications.some(({ message }) => /previous value remains active.*disk full/i.test(message)));
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
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
    tui.press("tui.select.down");
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

test("disposing btw model settings aborts and drains an in-flight save without notification", async () => {
  await withMenu(async ({ settingsPath, tui, ctx, notifications }) => {
    let started!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const mainModel = { provider: "current", id: "main" } as Model<Api>;
    const sideModel = { provider: "other", id: "side" } as Model<Api>;
    const running = showBtwCommandMenu(ctx, {
      settingsPath,
      currentThinkingLevel: "low",
      currentModel: mainModel,
      availableModels: [mainModel, sideModel],
      availableThinkingLevels: ["off", "low", "medium"],
      updateSettings: async (_patch, { signal }) => {
        started();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await openSettings(tui);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.type("other side");
    tui.press("tui.select.confirm");
    await saveStarted;
    tui.dispose();

    assert.equal(await running, "closed");
    assert.deepEqual(notifications, []);
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});
