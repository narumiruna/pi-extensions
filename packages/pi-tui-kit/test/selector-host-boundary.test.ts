import assert from "node:assert/strict";
import { type Component, type KeybindingsConfig, matchesKey } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { plainTuiText as stripVTControlCharacters } from "../../../test/tui-text.js";
import { createMenuScreenComponent } from "../src/components/index.js";
import { runCustomInteraction } from "../src/custom-interaction.js";
import { runDocumentReview } from "../src/document-review.js";
import { runLiveChoice } from "../src/live-choice.js";
import { runThinkingSelector } from "../src/pi-selectors.js";
import { runQuestionnaire } from "../src/questionnaire.js";
import { runSecretInput } from "../src/secret-input.js";
import { runTask } from "../src/task.js";
import { createRendererHost, deferred } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

const hostActions = [
  "tui.altScreen.search",
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.lineUp",
  "tui.altScreen.lineDown",
  "tui.altScreen.previousPrompt",
  "tui.altScreen.nextPrompt",
  "tui.altScreen.top",
  "tui.altScreen.bottom",
] as const;

for (const action of hostActions) {
  test(`native fullscreen ${action} is not advertised as a selector save key`, async (t) => {
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      bindings: { [action]: "ctrl+x", "app.thinking.save": ["ctrl+x", "ctrl+s"] },
    });
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    const frame = stripVTControlCharacters(fixture.frame().join("\n"));
    assert.match(frame, /ctrl\+s set as default/u);
    assert.doesNotMatch(frame, /ctrl\+x/u);
    const inputs: string[] = [];
    const handleInput = fixture.component.handleInput?.bind(fixture.component);
    fixture.component.handleInput = (data) => {
      inputs.push(data);
      handleInput?.(data);
    };
    fixture.send("\x18");
    assert.deepEqual(inputs, []); // Proves dispatch through the earlier native listener.
    if (fixture.host.hasOverlay()) fixture.send("\x1b");
    fixture.send("\x13");
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });
}

for (const scenario of [
  {
    name: "legacy matcher collision",
    kitty: false,
    host: "tab",
    save: ["ctrl+i", "ctrl+s"],
    data: "\t",
    hidden: "ctrl+i",
  },
  {
    name: "modifier order",
    kitty: true,
    host: "ctrl+shift+x",
    save: ["shift+ctrl+x", "ctrl+s"],
    data: "\x1b[120;6u",
    hidden: "shift+ctrl+x",
  },
  { name: "matcher alias", kitty: false, host: "enter", save: ["return", "ctrl+s"], data: "\r", hidden: "enter" },
] as const) {
  test(`native host collision uses ${scenario.name} and the first usable fallback`, async (t) => {
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      kitty: scenario.kitty,
      bindings: { "tui.altScreen.lineUp": scenario.host, "app.thinking.save": [...scenario.save] } as KeybindingsConfig,
    });
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    const text = stripVTControlCharacters(fixture.frame().join("\n"));
    assert.ok(!text.includes(`${scenario.hidden} set as default`));
    assert.match(text, /ctrl\+s set as default/u);
    const before = fixture.scroll.scrollTop;
    fixture.send(scenario.data);
    assert.ok(fixture.scroll.scrollTop < before);
    fixture.send("\x13");
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} browse hints and local paging reflect native host ownership`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme());
    t.onTestFinished(() => fixture.stop());
    const running = runCustomInteraction(fixture.ctx, {
      create: ({ tui, theme, keybindings, complete }) =>
        createMenuScreenComponent({
          screen: {
            kind: "browse",
            title: "Browser",
            enableDetailSearch: true,
            items: [
              {
                id: "entry",
                label: "Entry",
                detailDocument: {
                  content: Array.from({ length: 60 }, (_, index) => `  document-${index}  `).join("\n"),
                },
              },
            ],
          },
          tui,
          theme,
          keybindings,
          onEvent: (event) => complete(event.kind),
        }),
    });
    await fixture.waitForOpen();
    fixture.send("\r");
    let text = stripVTControlCharacters(fixture.frame().join("\n"));
    assert.match(text, /document-0/u);
    assert.equal(text.includes("pageup/pagedown page"), mode === "regular");
    const before = fixture.scroll.scrollTop;
    fixture.send("\x1b[6~");
    text = stripVTControlCharacters(fixture.frame().join("\n"));
    assert.equal(text.includes("document-0 "), mode === "fullscreen");
    if (mode === "fullscreen") {
      // PageDown at the bottom is still consumed by the native transcript.
      assert.equal(fixture.scroll.scrollTop, before);
      fixture.send("\x1b[5~");
      assert.ok(fixture.scroll.scrollTop < before);
    }
    fixture.send(" ");
    fixture.send("\x1b[200~document-40\x1b[201~");
    assert.match(stripVTControlCharacters(fixture.frame().join("\n")), /document-40/u);
    fixture.send("\x1b"); // Search closes, not the browser.
    fixture.send("\x1b"); // Detail returns to the same list item.
    assert.match(stripVTControlCharacters(fixture.frame().join("\n")), /› Entry/u);
    fixture.send("\x03");
    assert.deepEqual(await running, { kind: "completed", value: "close" });
    fixture.send("\x1b[F");
    fixture.send("!");
    assert.equal(fixture.editor.getValue(), "main draft!");
    assert.equal(
      fixture.writes.some((write) => write.includes("\x1b]133;C") || write.includes("\x1b]133;D")),
      false,
    );
  });

  test(`${mode} document-local search preserves pasted spaces and Input editing`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), { bindings: { "tui.select.cancel": "ctrl+q" } });
    t.onTestFinished(() => fixture.stop());
    const running = runDocumentReview(fixture.ctx, {
      title: "Exact document",
      content: "  alpha beta  \n  alpha beta  ",
      enableSearch: true,
    });
    await fixture.waitForOpen();
    fixture.send(" "); // Only standalone Space activates local search.
    fixture.send("\x1b[200~alpha beta\x1b[201~");
    assert.match(stripVTControlCharacters(fixture.frame().join("\n")), /Find:.*alpha beta/u);
    fixture.send("\x1b[H");
    fixture.send("x");
    fixture.send("\x7f");
    assert.match(stripVTControlCharacters(fixture.frame().join("\n")), /Find:.*alpha beta/u);
    fixture.send("\x1b[F");
    fixture.send("\x1b[200~");
    fixture.send(" "); // A paste chunk must not activate, confirm, or close the screen.
    fixture.send("\x1b[201~");
    assert.match(stripVTControlCharacters(fixture.frame().join("\n")), /Find:.*alpha beta /u);
    fixture.send("\x03");
    assert.deepEqual(await running, { kind: "cancelled", reason: "close" });
  });
}

test("native fullscreen host claiming Space suppresses local-search hints", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme(), {
    bindings: { "tui.altScreen.lineUp": "space" },
  });
  t.onTestFinished(() => fixture.stop());
  const running = runDocumentReview(fixture.ctx, { title: "Review", content: "document", enableSearch: true });
  await fixture.waitForOpen();
  assert.doesNotMatch(stripVTControlCharacters(fixture.frame().join("\n")), /space search/u);
  const before = fixture.scroll.scrollTop;
  fixture.send(" ");
  assert.ok(fixture.scroll.scrollTop < before);
  assert.doesNotMatch(stripVTControlCharacters(fixture.frame().join("\n")), /Find:/u);
  fixture.send("\x03");
  assert.deepEqual(await running, { kind: "cancelled", reason: "close" });
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} native Editor keeps newline, Backspace, expanded paste and remapped submission`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      bindings: { "tui.input.submit": "ctrl+s", "tui.select.cancel": "ctrl+q" },
    });
    t.onTestFinished(() => fixture.stop());
    const running = runQuestionnaire(fixture.ctx, {
      questions: [{ id: "answer", header: "Answer", prompt: "Provide text", options: [{ label: "Small" }] }],
    });
    await fixture.waitForOpen();
    fixture.send("\x1b[B"); // Other: enter the embedded native Editor.
    fixture.send("\r");
    const pasted = `alpha beta\n${"界".repeat(1500)}`;
    fixture.send(`\x1b[200~${pasted}\x1b[201~`);
    fixture.send("x");
    fixture.send("\x7f");
    fixture.send("\x0a");
    fixture.send("tail");
    fixture.send("\x13");
    assert.deepEqual(await running, {
      kind: "submitted",
      answers: [{ questionId: "answer", answer: `${pasted}\ntail`, wasCustom: true }],
    });
    assert.equal(fixture.editor.getValue(), "main draft");
  });

  test(`${mode} pending settings rollback drains before hard-close settlement`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme());
    t.onTestFinished(() => fixture.stop());
    const gate = deferred<boolean>();
    const started = deferred<void>();
    let rolledBack = false;
    let settled = false;
    const running = runCustomInteraction(fixture.ctx, {
      create: ({ tui, theme, keybindings, complete }) =>
        createMenuScreenComponent({
          screen: {
            kind: "settings",
            title: "Settings",
            items: [{ id: "flag", label: "Flag", currentValue: "Off", values: ["Off", "On"], action: "apply" }],
          },
          tui,
          theme,
          keybindings,
          onSettingChange: async () => {
            started.resolve();
            return gate.promise;
          },
          onEvent: (event) => {
            rolledBack = stripVTControlCharacters(fixture.frame().join("\n")).includes("Off");
            complete(event.kind);
          },
        }),
    });
    void running.then(() => {
      settled = true;
    });
    await fixture.waitForOpen();
    fixture.send(" ");
    await started.promise;
    fixture.send("\x03");
    assert.equal(settled, false);
    assert.match(stripVTControlCharacters(fixture.frame().join("\n")), /On/u);
    gate.resolve(false);
    assert.deepEqual(await running, { kind: "completed", value: "close" });
    assert.equal(rolledBack, true);
    assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
  });

  for (const flow of ["live choice", "secret input", "questionnaire", "task"] as const) {
    test(`${mode} ${flow} hints omit keys consumed by the native host`, async (t) => {
      const fixture = createRendererHost(mode, rendererTheme(), {
        bindings: {
          "tui.altScreen.lineUp": "ctrl+x",
          "tui.select.confirm": ["ctrl+x", "enter"],
          "tui.select.cancel": ["ctrl+x", "ctrl+q"],
          "tui.input.submit": ["ctrl+x", "enter"],
        },
      });
      t.onTestFinished(() => fixture.stop());
      const running =
        flow === "live choice"
          ? runLiveChoice(fixture.ctx, { title: "Choice", items: [{ id: "one", label: "One" }] })
          : flow === "secret input"
            ? runSecretInput(fixture.ctx, { title: "Secret" })
            : flow === "questionnaire"
              ? runQuestionnaire(fixture.ctx, {
                  questions: [{ id: "one", header: "Question", prompt: "Choose", options: [{ label: "One" }] }],
                })
              : runTask(fixture.ctx, {
                  label: "Loading",
                  task: async ({ signal }) => {
                    await new Promise<void>((resolve) => {
                      if (signal.aborted) resolve();
                      else signal.addEventListener("abort", () => resolve(), { once: true });
                    });
                  },
                });
      await fixture.waitForOpen();
      const text = stripVTControlCharacters(fixture.frame().join("\n"));
      assert.equal(text.includes("ctrl+x"), mode === "regular");
      if (mode === "fullscreen") {
        const before = fixture.scroll.scrollTop;
        fixture.send("\x18");
        assert.ok(fixture.scroll.scrollTop < before);
      }
      fixture.send("\x11");
      assert.equal((await running).kind, flow === "task" ? "cancelled" : "closed");
      assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
    });
  }
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} focused overlays receive viewport keys, repeats, and opt-in releases through native dispatch`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      kitty: true,
      bindings: { "tui.altScreen.lineUp": "ctrl+x", "app.thinking.save": ["ctrl+x", "ctrl+s"] },
    });
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    const replacementInputs: string[] = [];
    const replacementHandleInput = fixture.component.handleInput?.bind(fixture.component);
    fixture.component.handleInput = (data) => {
      replacementInputs.push(data);
      replacementHandleInput?.(data);
    };
    const overlayInputs: string[] = [];
    const overlay: Component & { focused: boolean; wantsKeyRelease: boolean } = {
      focused: false,
      wantsKeyRelease: false,
      render: () => ["Overlay"],
      invalidate() {},
      handleInput: (data) => overlayInputs.push(data),
    };
    const handle = fixture.host.showOverlay(overlay, { width: 30 });
    const before = fixture.scroll.scrollTop;
    fixture.send("\x1b[120;5u");
    fixture.send("\x1b[120;5:3u"); // Native focus dispatch filters releases by default.
    fixture.send("\x1b[120;5:2u"); // Repeats remain actionable.
    assert.deepEqual(overlayInputs, ["\x1b[120;5u", "\x1b[120;5:2u"]);
    assert.deepEqual(replacementInputs, []);
    assert.equal(fixture.scroll.scrollTop, before);
    overlay.wantsKeyRelease = true;
    fixture.send("\x1b[120;5:3u");
    assert.deepEqual(overlayInputs, ["\x1b[120;5u", "\x1b[120;5:2u", "\x1b[120;5:3u"]);
    handle.hide(); // This is a raw native overlay handle, not ctx.ui.custom ownership.
    fixture.send("\x1b[115;5u");
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });

  test(`${mode} an unknown earlier listener can consume a valid advertised fallback`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      bindings: { "app.thinking.save": ["ctrl+ctrl+x", "ctrl+s"] } as KeybindingsConfig,
    });
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    assert.match(stripVTControlCharacters(fixture.frame().join("\n")), /ctrl\+s set as default/u);
    const received: string[] = [];
    const remove = fixture.host.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+s")) return undefined;
      received.push(data);
      return { consume: true };
    });
    let completed = false;
    void running.then(() => {
      completed = true;
    });
    fixture.send("\x13");
    await Promise.resolve();
    assert.deepEqual(received, ["\x13"]);
    assert.equal(completed, false);
    remove();
    fixture.send("\x13");
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });
}

test("native fullscreen search owns its shortcuts before custom overlay and viewport dispatch", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme(), {
    kitty: true,
    bindings: {
      "tui.altScreen.search": "ctrl+q",
      "tui.altScreen.searchNext": "ctrl+n",
      "tui.altScreen.searchPrevious": "ctrl+p",
      "tui.altScreen.searchClose": "ctrl+w",
      "tui.altScreen.lineUp": "ctrl+x",
    },
  });
  t.onTestFinished(() => fixture.stop());
  const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
  await fixture.waitForOpen();
  const inputs: string[] = [];
  const overlay: Component & { focused: boolean } = {
    focused: false,
    render: () => ["Overlay"],
    invalidate() {},
    handleInput: (data) => inputs.push(data),
  };
  const handle = fixture.host.showOverlay(overlay, { width: 30 });
  fixture.send("\x11");
  const search = fixture.host.getFocusedComponent();
  assert.ok(search);
  assert.notEqual(search, overlay);
  assert.equal(handle.isFocused(), false);
  const searchInputs: string[] = [];
  const searchHandleInput = search.handleInput?.bind(search);
  search.handleInput = (data) => {
    searchInputs.push(data);
    searchHandleInput?.(data);
  };
  fixture.send("history");
  fixture.send("\x0e"); // Next match is consumed before the native search Input.
  fixture.send("\x10"); // Previous match is consumed before the native search Input.
  assert.deepEqual(searchInputs, ["history"]);
  assert.deepEqual(inputs, []);
  const before = fixture.scroll.scrollTop;
  fixture.send("\x1b[120;5:3u");
  assert.equal(fixture.scroll.scrollTop, before); // Host consumes release without scrolling.
  fixture.send("\x1b[120;5:2u");
  assert.ok(fixture.scroll.scrollTop < before); // Native search does not defer viewport actions.
  assert.deepEqual(searchInputs, ["history"]);
  fixture.send("\x17");
  assert.equal(fixture.host.getFocusedComponent(), overlay);
  fixture.send("\x18");
  assert.deepEqual(inputs, ["\x18"]); // Ordinary focused overlays do defer viewport actions.
  handle.hide();
  fixture.send("\x13");
  assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
});

for (const claimByHost of [false, true]) {
  test(`native fullscreen listener ${claimByHost ? "precedes" : "defers to"} debug priority before focused dispatch`, async (t) => {
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      kitty: true,
      bindings: {
        "tui.altScreen.lineUp": claimByHost ? "shift+ctrl+d" : "ctrl+x",
        "app.thinking.save": ["ctrl+shift+d", "ctrl+s"],
      },
    });
    t.onTestFinished(() => fixture.stop());
    let debugCount = 0;
    fixture.host.onDebug = () => {
      debugCount++;
    };
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    const frame = stripVTControlCharacters(fixture.frame().join("\n"));
    assert.match(frame, /ctrl\+s set as default/u);
    assert.doesNotMatch(frame, /shift\+ctrl\+d set as default/u);
    const before = fixture.scroll.scrollTop;
    fixture.send("\x1b[100;6u");
    assert.equal(debugCount, claimByHost ? 0 : 1);
    assert.equal(fixture.scroll.scrollTop < before, claimByHost);
    fixture.send("\x13");
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });
}
