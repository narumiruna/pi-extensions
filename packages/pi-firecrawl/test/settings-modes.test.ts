import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-firecrawl-modes-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const capabilities = [
  "firecrawl_scrape",
  "firecrawl_crawl",
  "firecrawl_crawl_status",
  "firecrawl_map",
  "firecrawl_search",
] as const;
const nativeModel = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-5.4",
  compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
};
const document = (root: string) => JSON.parse(readFileSync(join(root, "pi-firecrawl.json"), "utf8"));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("mode validation accepts old files with codemode default and rejects invalid recognized fields", async () => {
  await fixture(async () => {
    const { normalizeFirecrawlSettings } = await import("../src/settings.js");
    for (const mode of [undefined, "codemode", "lazy", "direct"]) {
      assert.deepEqual(
        normalizeFirecrawlSettings({ tools: [capabilities[4], capabilities[0]], updatedAt: 1, toolMode: mode }),
        {
          tools: [capabilities[0], capabilities[4]],
          toolMode: mode ?? "codemode",
          updatedAt: 1,
        },
      );
    }
    for (const mode of [null, false, 1, "eager", "CODEMODE", [], {}]) {
      assert.equal(normalizeFirecrawlSettings({ tools: [], updatedAt: 1, toolMode: mode }), undefined);
    }
    assert.equal(normalizeFirecrawlSettings([]), undefined);
  });
});

test("missing settings load has no filesystem side effects; mode save creates only explicit settings", async () => {
  await fixture(async (root) => {
    process.env.PI_CODING_AGENT_DIR = join(root, "missing");
    const { loadSettings, saveToolMode } = await import("../src/settings.js");
    assert.deepEqual(await loadSettings(), { kind: "missing" });
    assert.equal(existsSync(join(root, "missing")), false);
    await saveToolMode("direct", [capabilities[0]]);
    const saved = document(join(root, "missing"));
    assert.equal(saved.toolMode, "direct");
    assert.deepEqual(saved.tools, [capabilities[0]]);
  });
});

test("field-scoped interleaved saves preserve pending mode, latest tools, unknown fields and read ordering", async () => {
  await fixture(async (root) => {
    const { saveSettings, saveToolMode, loadSettings } = await import("../src/settings.js");
    writeFileSync(
      join(root, "pi-firecrawl.json"),
      JSON.stringify({ tools: [...capabilities], updatedAt: 1, future: { kept: true } }),
    );
    const started = deferred();
    const release = deferred();
    const modeSave = saveToolMode("lazy", capabilities, {
      write: async (file, data) => {
        writeFileSync(file, data);
        started.resolve();
        await release.promise;
      },
    });
    await started.promise;
    const toolSave = saveSettings({ tools: [capabilities[4]], updatedAt: 2 });
    let readDone = false;
    const read = loadSettings().then((value) => {
      readDone = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(readDone, false);
    release.resolve();
    await Promise.all([modeSave, toolSave]);
    const loaded = await read;
    assert.equal(loaded.kind, "loaded");
    assert.deepEqual(document(root), {
      tools: [capabilities[4]],
      toolMode: "lazy",
      updatedAt: 2,
      future: { kept: true },
    });
    await Promise.all([saveSettings({ tools: [], updatedAt: 3 }), saveToolMode("direct", capabilities)]);
    assert.equal(document(root).toolMode, "direct");
    assert.deepEqual(document(root).tools, []);
  });
});

test("mode saves block malformed/invalid files and recover after atomic publication failure", async () => {
  await fixture(async (root) => {
    const { saveToolMode, loadSettings } = await import("../src/settings.js");
    for (const invalid of ["{", JSON.stringify({ tools: [], updatedAt: 1, toolMode: "bad" })]) {
      writeFileSync(join(root, "pi-firecrawl.json"), invalid);
      assert.equal((await loadSettings()).kind, "invalid");
      await assert.rejects(saveToolMode("lazy", capabilities), /repair/);
      assert.equal(readFileSync(join(root, "pi-firecrawl.json"), "utf8"), invalid);
    }
    const previous = JSON.stringify({ tools: [capabilities[0]], updatedAt: 1, future: true });
    writeFileSync(join(root, "pi-firecrawl.json"), previous);
    await assert.rejects(
      saveToolMode("lazy", capabilities, {
        rename: async () => {
          throw new Error("disk failure");
        },
      }),
      /disk failure/,
    );
    assert.equal(readFileSync(join(root, "pi-firecrawl.json"), "utf8"), previous);
    assert.deepEqual(readdirSync(root), ["pi-firecrawl.json"]);
    await saveToolMode("direct", capabilities);
    assert.equal(document(root).toolMode, "direct");
    assert.equal(document(root).future, true);
    assert.deepEqual(document(root).tools, [capabilities[0]]);
  });
});

for (const mode of ["codemode", "lazy", "direct"] as const) {
  test(`${mode} enforces availability and failed-save rollback without changing unrelated tool order`, async () => {
    await fixture(async (root) => {
      writeFileSync(
        join(root, "pi-firecrawl.json"),
        JSON.stringify({ tools: [...capabilities], toolMode: mode, updatedAt: 1 }),
      );
      const { default: extension } = await import("../src/firecrawl.js");
      const mock = createMockPi({ activeTools: ["other-a", "codemode", "other-b"] });
      const { ctx } = createMockContext({ model: nativeModel });
      extension(mock.pi);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      const before = mock.rawPi.getActiveTools();
      writeFileSync(join(root, "pi-firecrawl.json"), "{");
      await mock.commands.get("firecrawl")?.handler("disable", ctx);
      assert.deepEqual(mock.rawPi.getActiveTools(), before);
      assert.equal(
        mock.tools.find((tool) => tool.name === capabilities[0])?.exposure,
        mode === "codemode" ? "codemode" : "direct",
      );
      writeFileSync(
        join(root, "pi-firecrawl.json"),
        JSON.stringify({ tools: [...capabilities], toolMode: mode, updatedAt: 1 }),
      );
      await mock.commands.get("firecrawl")?.handler("disable", ctx);
      assert.ok(
        mock.tools
          .filter((tool) => capabilities.includes(tool.name as never))
          .every((tool) => tool.exposure === "hidden"),
      );
      await mock.commands.get("firecrawl")?.handler("enable", ctx);
      assert.deepEqual(
        mock.rawPi.getActiveTools().filter((name) => !name.startsWith("firecrawl_")),
        ["other-a", "codemode", "other-b"],
      );
      assert.equal(
        mock.tools.find((tool) => tool.name === "firecrawl_load")?.exposure,
        mode === "lazy" ? "direct" : undefined,
      );
    });
  });
}

test("saved mode is pending, availability saves preserve it, startup applies it and hides a previous loader", async () => {
  await fixture(async (root) => {
    writeFileSync(
      join(root, "pi-firecrawl.json"),
      JSON.stringify({ tools: [...capabilities], toolMode: "lazy", updatedAt: 1 }),
    );
    const { default: extension } = await import("../src/firecrawl.js");
    const { setFirecrawlToolMode, buildStatusMessage } = await import("../src/tool-selector.js");
    const mock = createMockPi({ activeTools: ["codemode"] });
    const { ctx } = createMockContext({ model: nativeModel });
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const before = mock.rawPi.getActiveTools();
    assert.equal(await setFirecrawlToolMode(mock.pi, ctx, "direct"), true);
    assert.deepEqual(mock.rawPi.getActiveTools(), before);
    await mock.commands.get("firecrawl")?.handler("disable", ctx);
    assert.equal(document(root).toolMode, "direct");
    assert.match(
      await buildStatusMessage(mock.pi),
      /Running tool mode: lazy\nSaved tool mode: direct\nTool mode change pending/,
    );
    await mock.events.get("session_start")?.[0]?.({ reason: "reload" }, ctx);
    assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode"]);
    assert.equal(mock.tools.find((tool) => tool.name === "firecrawl_load")?.exposure, "hidden");
  });
});

test("replacement and shutdown wait for accepted saves and never receive stale rollback or notifications", async () => {
  await fixture(async (root) => {
    const { default: extension } = await import("../src/firecrawl.js");
    const { saveToolMode } = await import("../src/settings.js");
    const mock = createMockPi({ activeTools: ["codemode", "other"] });
    const old = createMockContext();
    const replacement = createMockContext();
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, old.ctx);
    const started = deferred();
    const release = deferred();
    const blocker = saveToolMode("direct", capabilities, {
      write: async (file, data) => {
        writeFileSync(file, data);
        started.resolve();
        await release.promise;
      },
    });
    await started.promise;
    const applied = deferred();
    const setActive = mock.rawPi.setActiveTools.bind(mock.rawPi);
    mock.rawPi.setActiveTools = (names) => {
      setActive(names);
      applied.resolve();
    };
    const edit = mock.commands.get("firecrawl")?.handler("disable", old.ctx);
    await applied.promise;
    const restart = mock.events.get("session_start")?.[0]?.({ reason: "switch" }, replacement.ctx);
    release.resolve();
    await Promise.all([blocker, edit, restart]);
    assert.deepEqual(document(root).tools, []);
    assert.equal(document(root).toolMode, "direct");
    assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode", "other"]);
    assert.deepEqual(old.notifications, []);
    await mock.events.get("session_shutdown")?.[0]?.({}, replacement.ctx);
  });
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`settings route has observable ${mode} behavior without custom TUI`, async () => {
    await fixture(async (root) => {
      const { default: extension, parseCommand, commandCompletions } = await import("../src/firecrawl.js");
      const mock = createMockPi();
      const { ctx, notifications } = createMockContext({
        mode,
        hasUI: mode === "rpc",
        custom: () => {
          throw new Error("must not enter custom UI");
        },
      });
      extension(mock.pi);
      const invoke = (args: string) => mock.commands.get("firecrawl")?.handler(args, ctx) as Promise<void>;
      assert.equal(parseCommand("settings"), "settings");
      assert.equal(parseCommand("settings extra"), "unknown");
      assert.ok(commandCompletions("sett")?.some((item) => item.value === "settings"));
      if (mode === "rpc") {
        await invoke("settings");
        assert.ok(notifications[0]?.message.includes(join(root, "pi-firecrawl.json")));
      } else await assert.rejects(invoke("settings"), /requires TUI or RPC/);
    });
  });
}

for (const binding of [
  undefined,
  { "tui.select.confirm": "ctrl+x", "tui.select.down": "ctrl+n", "tui.select.cancel": "ctrl+q" },
] as const) {
  test(`SettingsList persists edits, keeps selection, and respects ${binding ? "remapped" : "default"} keys`, async () => {
    await fixture(async (root) => {
      initTheme("dark", false);
      const previousKeys = getKeybindings();
      setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, binding));
      try {
        const { default: extension } = await import("../src/firecrawl.js");
        const mock = createMockPi({ activeTools: ["codemode"] });
        let lines: string[] = [];
        let widthSafe = false;
        const { ctx } = createMockContext({
          mode: "tui",
          hasUI: true,
          custom: async (factory: unknown) => {
            const keys = getKeybindings();
            const harness = createCustomSelectorHarness(factory, 100, {
              matches: (data, action) => keys.matches(data, action as never),
              getKeys: (action) => keys.getKeys(action as never),
            });
            widthSafe = [0, 1, 4, 20, 80].every((width) =>
              harness.render(width).every((line) => visibleWidth(line) <= width),
            );
            harness.handleInput(binding ? "\x18" : "\r");
            harness.handleInput(binding ? "\x0e" : "\x1b[B");
            harness.handleInput(binding ? "\x18" : " ");
            await harness.waitForPending();
            lines = harness.render();
            harness.handleInput(binding ? "\x11" : "\x1b");
            return harness.resultPromise;
          },
        });
        extension(mock.pi);
        await mock.events.get("session_start")?.[0]?.({}, ctx);
        await mock.commands.get("firecrawl")?.handler("settings", ctx);
        assert.equal(widthSafe, true);
        assert.ok(lines.some((line) => line.includes(binding ? "ctrl+n down" : "↓ down")));
        assert.ok(lines.some((line) => line.includes(binding ? "ctrl+x/space change" : "enter/space change")));
        assert.ok(lines.some((line) => line.includes(binding ? "ctrl+q/ctrl+c close" : "esc/ctrl+c close")));
        assert.equal(document(root).toolMode, "lazy");
        assert.deepEqual(document(root).tools, capabilities.slice(1));
        assert.ok(lines.some((line) => line.includes("/reload required")));
        assert.ok(
          lines
            .map(stripVTControlCharacters)
            .some((line) => /^→ firecrawl_scrape/.test(line) && line.includes("disabled")),
        );
        assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode"]);
      } finally {
        setKeybindings(previousKeys);
      }
    });
  });
}

test("settings UI failure restores displayed values and Ctrl+C/disposal release UI ownership", async () => {
  await fixture(async (root) => {
    initTheme("dark", false);
    const { default: extension } = await import("../src/firecrawl.js");
    const mock = createMockPi({ activeTools: ["codemode"] });
    writeFileSync(join(root, "pi-firecrawl.json"), "{");
    let lines: string[] = [];
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        harness.handleInput("\r");
        await harness.waitForPending();
        lines = harness.render();
        harness.handleInput("\r");
        harness.handleInput("\x03");
        harness.dispose();
        await harness.waitForPending();
        return harness.resultPromise;
      },
    });
    extension(mock.pi);
    await mock.commands.get("firecrawl")?.handler("settings", ctx);
    assert.ok(lines.some((line) => line.includes("Tool mode") && line.includes("codemode")));
    assert.equal(readFileSync(join(root, "pi-firecrawl.json"), "utf8"), "{");
    assert.equal(notifications.filter((entry) => /save failed/.test(entry.message)).length, 2);
  });
});

for (const cancelInput of ["\x03", "\x1b[99;5u"]) {
  test(`hard cancellation drains accepted settings changes with remapped cancellation (${JSON.stringify(cancelInput)})`, async () => {
    await fixture(async (root) => {
      initTheme("dark", false);
      const previousKeys = getKeybindings();
      setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+q" }));
      try {
        const { default: extension } = await import("../src/firecrawl.js");
        const mock = createMockPi({ activeTools: ["codemode"] });
        let rendersAfterClose = 0;
        const { ctx, notifications } = createMockContext({
          mode: "tui",
          hasUI: true,
          custom: async (factory: unknown) => {
            let closed = false;
            const wrapped = (tui: { requestRender(): void }, ...args: unknown[]) =>
              (factory as (...args: unknown[]) => unknown)(
                {
                  ...tui,
                  requestRender() {
                    if (closed) rendersAfterClose += 1;
                  },
                },
                ...args,
              );
            const harness = createCustomSelectorHarness(wrapped);
            harness.handleInput("\r");
            harness.handleInput("\x1b[B");
            harness.handleInput(" ");
            harness.handleInput(cancelInput);
            closed = true;
            harness.dispose();
            return harness.resultPromise;
          },
        });
        extension(mock.pi);
        await mock.events.get("session_start")?.[0]?.({}, ctx);
        await mock.commands.get("firecrawl")?.handler("settings", ctx);
        assert.equal(document(root).toolMode, "lazy");
        assert.deepEqual(document(root).tools, capabilities.slice(1));
        assert.equal(rendersAfterClose, 0);
        assert.deepEqual(notifications, []);
      } finally {
        setKeybindings(previousKeys);
      }
    });
  });
}

test("partially failed registration refresh restores exposure, active tools, and the previous document", async () => {
  await fixture(async (root) => {
    const initial = JSON.stringify({ tools: [...capabilities], toolMode: "direct", updatedAt: 1 });
    writeFileSync(join(root, "pi-firecrawl.json"), initial);
    const { default: extension } = await import("../src/firecrawl.js");
    const mock = createMockPi({ activeTools: ["other-a", "other-b"] });
    const { ctx, notifications } = createMockContext();
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const before = mock.rawPi.getActiveTools();
    const register = mock.rawPi.registerTool.bind(mock.rawPi);
    let failed = false;
    mock.rawPi.registerTool = (tool) => {
      register(tool);
      if (!failed && (tool as { exposure?: string }).exposure === "hidden") {
        failed = true;
        throw new Error("refresh failed after replacement");
      }
    };
    await mock.commands.get("firecrawl")?.handler("disable", ctx);
    assert.equal(failed, true);
    assert.deepEqual(mock.rawPi.getActiveTools(), before);
    assert.ok(mock.tools.every((tool) => tool.exposure === "direct"));
    assert.equal(readFileSync(join(root, "pi-firecrawl.json"), "utf8"), initial);
    assert.match(notifications.at(-1)?.message ?? "", /refresh failed after replacement/);
  });
});

test("independent headless sessions with the same no-op UI do not invalidate one another", async () => {
  await fixture(async () => {
    const { default: extension } = await import("../src/firecrawl.js");
    const { currentFirecrawlSessionSignal, currentFirecrawlSessionGeneration } = await import(
      "../src/tool-selector.js"
    );
    const first = createMockPi({ activeTools: ["codemode"] });
    const second = createMockPi({ activeTools: ["codemode"] });
    const firstContext = createMockContext({ mode: "json", hasUI: false });
    const secondContext = createMockContext({ mode: "json", hasUI: false });
    const sharedUiContext = {
      ...(secondContext.ctx as ExtensionContext),
      ui: (firstContext.ctx as ExtensionContext).ui,
    };
    extension(first.pi);
    extension(second.pi);
    await first.events.get("session_start")?.[0]?.({}, firstContext.ctx);
    const signal = currentFirecrawlSessionSignal(first.pi);
    const generation = currentFirecrawlSessionGeneration(first.pi);
    await second.events.get("session_start")?.[0]?.({}, sharedUiContext);
    await second.events.get("session_shutdown")?.[0]?.({}, sharedUiContext);
    assert.equal(signal.aborted, false);
    assert.equal(currentFirecrawlSessionGeneration(first.pi), generation);
    await first.commands.get("firecrawl")?.handler("disable", firstContext.ctx);
    assert.equal(first.tools.find((tool) => tool.name === capabilities[0])?.exposure, "hidden");
    assert.equal(second.tools.find((tool) => tool.name === capabilities[0])?.exposure, "codemode");
    await first.events.get("session_shutdown")?.[0]?.({}, firstContext.ctx);
  });
});

test("codemode availability preserves allowed explicit declarations and restores them after a failed save", async () => {
  await fixture(async (root) => {
    const { default: extension } = await import("../src/firecrawl.js");
    const { setSelectedFirecrawlTools } = await import("../src/tool-selector.js");
    const mock = createMockPi({ activeTools: ["codemode", "other"] });
    const { ctx } = createMockContext();
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    mock.rawPi.setActiveTools(["codemode", capabilities[0], "other"]);
    assert.equal(await setSelectedFirecrawlTools(mock.pi, ctx, capabilities.slice(0, 4)), true);
    assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode", capabilities[0], "other"]);
    writeFileSync(join(root, "pi-firecrawl.json"), "{");
    assert.equal(await setSelectedFirecrawlTools(mock.pi, ctx, []), false);
    assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode", capabilities[0], "other"]);
    assert.equal(mock.tools.find((tool) => tool.name === capabilities[0])?.exposure, "codemode");
  });
});
