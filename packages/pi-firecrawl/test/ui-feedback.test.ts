import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  isKittyProtocolActive,
  KeybindingsManager,
  SettingsList,
  setKeybindings,
  setKittyProtocolActive,
  type TUI,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";

const capabilities = [
  "firecrawl_scrape",
  "firecrawl_crawl",
  "firecrawl_crawl_status",
  "firecrawl_map",
  "firecrawl_search",
] as const;
async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-firecrawl-feedback-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
  initTheme("dark", false);
  try {
    await run(root);
  } finally {
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const field of ["mode", "capability"] as const) {
  for (const boundary of ["write", "rename"] as const) {
    for (const close of ["escape", "ctrl+c", "kitty ctrl+c", "dispose"] as const) {
      test(`${field} ${boundary} failure remains observable after ${close}, without disposed renders`, async () => {
        await fixture(async (root) => {
          const file = join(root, "pi-firecrawl.json");
          const original = JSON.stringify({
            toolMode: "codemode",
            tools: capabilities,
            updatedAt: 1,
            future: { kept: true },
          });
          writeFileSync(file, original);
          const settings = await import("../src/settings.js");
          const started = deferred();
          const release = deferred();
          const failure = async () => {
            started.resolve();
            await release.promise;
            throw new Error(`${boundary} failure`);
          };
          if (field === "mode") {
            const save = settings.saveToolMode;
            vi.spyOn(settings, "saveToolMode").mockImplementation((mode, tools) =>
              save(mode, tools, { [boundary]: failure }),
            );
          } else {
            const save = settings.saveSettings;
            vi.spyOn(settings, "saveSettings").mockImplementation((value) => save(value, { [boundary]: failure }));
          }
          const { default: extension } = await import("../src/firecrawl.js");
          const mock = createMockPi({ activeTools: ["codemode"] });
          let closed = false;
          let staleRenders = 0;
          const { ctx, notifications } = createMockContext({
            mode: "tui",
            hasUI: true,
            custom: async (factory: unknown) => {
              const wrapped = (tui: TUI, ...args: unknown[]) =>
                (factory as (...args: unknown[]) => unknown)(
                  {
                    ...tui,
                    requestRender() {
                      if (closed) staleRenders++;
                    },
                  },
                  ...args,
                );
              const harness = createCustomSelectorHarness(wrapped);
              if (field === "capability") harness.handleInput("\x1b[B");
              harness.handleInput("\r");
              await started.promise;
              if (close !== "dispose")
                harness.handleInput({ escape: "\x1b", "ctrl+c": "\x03", "kitty ctrl+c": "\x1b[99;5u" }[close]);
              closed = true;
              harness.dispose();
              release.resolve();
              return close === "dispose" ? undefined : harness.resultPromise;
            },
          });
          extension(mock.pi);
          await mock.events.get("session_start")?.[0]?.({}, ctx);
          await mock.commands.get("firecrawl")?.handler("settings", ctx);
          assert.equal(readFileSync(file, "utf8"), original);
          assert.equal(notifications.length, 1);
          assert.match(notifications[0].message, new RegExp(`save failed.*${boundary} failure`));
          assert.equal(notifications[0].level, "warning");
          assert.equal(staleRenders, 0);
          assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode"]);
          assert.ok(mock.tools.every((tool) => tool.exposure === "codemode"));
        });
      });
    }
  }
}

function mouse(y: number, type: TuiMouseEvent["type"] = "click", extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type,
    button: "left",
    x: 3,
    y,
    screenX: 3,
    screenY: y,
    width: 100,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  };
}

test("mouse press/click/wheel use the painted list bounds before, during, and after saving", async () => {
  await fixture(async (root) => {
    const { default: extension } = await import("../src/firecrawl.js");
    const mock = createMockPi({ activeTools: ["codemode"] });
    const results: unknown[] = [];
    let lines: string[] = [];
    let staleResult: unknown = "not checked";
    const { ctx } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        let component!: Component;
        const wrapped = (...args: unknown[]) => {
          component = (factory as (...args: unknown[]) => Component)(...args);
          return component;
        };
        const harness = createCustomSelectorHarness(wrapped);
        harness.render();
        results.push(
          component.handleMouse?.(mouse(0)),
          component.handleMouse?.(mouse(1, "wheel", { wheelDelta: 1 })),
          component.handleMouse?.(mouse(99)),
        );
        results.push(component.handleMouse?.(mouse(3, "press")));
        results.push(component.handleMouse?.(mouse(3)));
        // Pending changed synchronously, but the header has not been repainted yet.
        results.push(component.handleMouse?.(mouse(3)));
        lines = harness.render().map(stripVTControlCharacters);
        results.push(component.handleMouse?.(mouse(2))); // Painted "Saving changes" line, not a list row.
        results.push(component.handleMouse?.(mouse(5))); // Crawl row after the three painted headers.
        results.push(component.handleMouse?.(mouse(5, "wheel", { wheelDelta: 1 })));
        results.push(
          component.handleMouse?.(mouse(5, "move")),
          component.handleMouse?.(mouse(5, "click", { button: "right" })),
        );
        await harness.waitForPending();
        lines.push(...harness.render().map(stripVTControlCharacters));
        harness.handleInput("\x03");
        harness.dispose();
        staleResult = component.handleMouse?.(mouse(3));
        return harness.resultPromise;
      },
    });
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    await mock.commands.get("firecrawl")?.handler("settings", ctx);
    assert.deepEqual(results.slice(0, 3), [undefined, undefined, undefined]);
    assert.deepEqual(results[3], { handled: true, focus: true });
    assert.deepEqual(results.slice(4, 6), [{ handled: true }, { handled: true }]);
    assert.equal(results[6], undefined);
    assert.deepEqual(results[7], { handled: true });
    assert.deepEqual(results[8], { handled: true, render: true });
    assert.deepEqual(results.slice(9), [undefined, undefined]);
    assert.equal(staleResult, undefined);
    assert.ok(lines.includes("Saving changes…"));
    assert.ok(lines.some((line) => line.startsWith("→ firecrawl_crawl_status")));
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "pi-firecrawl.json"), "utf8")).tools,
      capabilities.filter((name) => name !== "firecrawl_crawl"),
    );
  });
});

const hintCases = [
  {
    name: "modifyOtherKeys disambiguation",
    config: { "tui.select.up": "tab", "tui.select.confirm": ["ctrl+i", "ctrl+x"] },
    extended: false,
    modifyOther: true,
    expected: "ctrl+i/space change",
    input: "\x1b[27;5;105~",
  },
  {
    name: "functional modifier",
    config: { "tui.select.confirm": "ctrl+up" },
    extended: false,
    expected: "ctrl+↑/space change",
    input: "\x1b[1;5A",
  },
  {
    name: "unsupported modified function fallback",
    config: { "tui.select.confirm": ["ctrl+f1", "f1"] },
    extended: false,
    expected: "f1/space change",
    input: "\x1bOP",
  },
  { name: "defaults", config: {}, extended: false, expected: "enter/space change", input: "\r" },
  {
    name: "remapped",
    config: { "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+x", "tui.select.cancel": "ctrl+q" },
    extended: false,
    expected: "ctrl+x/space change",
    input: "\x18",
  },
  {
    name: "aliases",
    config: { "tui.select.confirm": "RETURN", "tui.select.cancel": "esc" },
    extended: false,
    expected: "enter/space change",
    input: "\r",
  },
  {
    name: "modifier order",
    config: { "tui.select.confirm": "shift+ctrl+x" },
    extended: true,
    expected: "shift+ctrl+x/space change",
    input: "\x1b[120;6u",
  },
  {
    name: "reverse modifier order",
    config: { "tui.select.confirm": "ctrl+shift+x" },
    extended: true,
    expected: "ctrl+shift+x/space change",
    input: "\x1b[120;6u",
  },
  {
    name: "legacy collision",
    config: { "tui.select.up": "tab", "tui.select.confirm": ["ctrl+i", "ctrl+x"] },
    extended: false,
    expected: "ctrl+x/space change",
    input: "\x18",
  },
  {
    name: "Kitty disambiguation",
    config: { "tui.select.up": "tab", "tui.select.confirm": ["ctrl+i", "ctrl+x"] },
    extended: true,
    expected: "ctrl+i/space change",
    input: "\x1b[105;5u",
  },
  {
    name: "invalid and hard-cancel fallback",
    config: { "tui.select.confirm": ["invalid-key", "ctrl+c", "ctrl+x"] },
    extended: false,
    expected: "ctrl+x/space change",
    input: "\x18",
  },
  {
    name: "legacy unusable shifted-letter fallback",
    config: { "tui.select.confirm": ["ctrl+shift+x", "ctrl+x"] },
    extended: false,
    expected: "ctrl+x/space change",
    input: "\x18",
  },
  {
    name: "Pi rejects unknown modifier names and uses the first valid fallback",
    config: { "tui.select.confirm": ["unknown+x", "ctrl+x"] },
    extended: false,
    expected: "ctrl+x/space change",
    input: "\x18",
  },
] as const;
for (const entry of hintCases) {
  test(`effective hints and actual SettingsList dispatch: ${entry.name}`, async () => {
    const previousKitty = isKittyProtocolActive();
    const previousKeys = getKeybindings();
    setKittyProtocolActive(entry.extended);
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, entry.config as never);
    setKeybindings(keys);
    try {
      const { settingsKeyHints } = await import("../src/settings-key-hints.js");
      const hint = settingsKeyHints(keys, {
        terminal: {
          kittyProtocolActive: entry.extended,
          modifyOtherKeysActive: "modifyOther" in entry && entry.modifyOther,
        },
      } as unknown as TUI);
      assert.ok(hint.includes(entry.expected), hint);
      assert.ok(hint.includes("ctrl+c close"), hint);
      assert.ok(!hint.includes("invalid-key"));
      assert.ok(!hint.includes("unknown+"));
      if (entry.name === "remapped") {
        assert.ok(hint.includes("ctrl+n down"));
        assert.ok(hint.includes("ctrl+q/ctrl+c close"));
      }
      let changed = false;
      const list = new SettingsList(
        [{ id: "mode", label: "Mode", currentValue: "a", values: ["a", "b"] }],
        1,
        { label: (s) => s, value: (s) => s, description: (s) => s, hint: (s) => s, cursor: "→ " },
        () => {
          changed = true;
        },
        () => {},
      );
      list.handleInput(entry.input);
      assert.equal(changed, true);
    } finally {
      setKittyProtocolActive(previousKitty);
      setKeybindings(previousKeys);
    }
  });
}

test("codemode setup documents additive defaultTools rather than an extension-excluding CLI allowlist", () => {
  const readme = readFileSync("packages/pi-firecrawl/README.md", "utf8");
  assert.ok(readme.includes('"defaultTools": ["+codemode"]'));
  assert.ok(!readme.includes("pi --tools read,bash,edit,write,codemode"));
  assert.ok(readme.includes("allowlist for extension tools too"));
});
