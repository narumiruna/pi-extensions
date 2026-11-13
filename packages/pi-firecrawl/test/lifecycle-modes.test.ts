import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-firecrawl-lifecycle-"));
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

test("failed old-session save restores its accepted policy before replacement startup, without stale runtime rollback", async () => {
  await fixture(async (root) => {
    writeFileSync(
      join(root, "pi-firecrawl.json"),
      JSON.stringify({ tools: capabilities, toolMode: "direct", updatedAt: 1 }),
    );
    const { default: extension } = await import("../src/firecrawl.js");
    const { saveToolMode } = await import("../src/settings.js");
    const mock = createMockPi({ activeTools: ["codemode", "other"] });
    const old = createMockContext();
    const replacement = createMockContext();
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, old.ctx);
    const started = deferred();
    const release = deferred();
    const blocker = saveToolMode("lazy", capabilities, {
      write: async () => {
        started.resolve();
        await release.promise;
        throw new Error("blocked write failed");
      },
    });
    const blockerFailure = assert.rejects(blocker, /blocked write failed/);
    await started.promise;
    const applied = deferred();
    const originalSetActive = mock.rawPi.setActiveTools.bind(mock.rawPi);
    const activeSets: string[][] = [];
    mock.rawPi.setActiveTools = (names) => {
      originalSetActive(names);
      activeSets.push([...names]);
      applied.resolve();
    };
    const edit = mock.commands.get("firecrawl")?.handler("disable", old.ctx);
    await applied.promise;
    writeFileSync(join(root, "pi-firecrawl.json"), "{");
    const restart = mock.events.get("session_start")?.[0]?.({ reason: "switch" }, replacement.ctx);
    release.resolve();
    await Promise.all([blockerFailure, edit, restart]);
    assert.deepEqual(activeSets, [
      ["codemode", "other"],
      ["codemode", "other"],
    ]);
    assert.ok(mock.tools.every((tool) => tool.exposure === "codemode"));
    assert.deepEqual(old.notifications, []);
    assert.ok(replacement.notifications.some((notice) => /settings ignored/.test(notice.message)));
  });
});

test("session replacement closes the screen but persists accepted mode changes without stale notifications", async () => {
  await fixture(async () => {
    initTheme("dark", false);
    const { default: extension } = await import("../src/firecrawl.js");
    const mock = createMockPi({ activeTools: ["codemode"] });
    const opened = deferred();
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        harness.handleInput("\r");
        opened.resolve();
        return harness.resultPromise;
      },
    });
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const command = mock.commands.get("firecrawl")?.handler("settings", ctx);
    await opened.promise;
    const replacement = createMockContext({ mode: "json", hasUI: false });
    await mock.events.get("session_start")?.[0]?.({ reason: "switch" }, replacement.ctx);
    await command;
    assert.deepEqual(notifications, []);
    assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode", "firecrawl_load", ...capabilities]);
  });
});

test("a delayed custom factory settles immediately if its session was replaced before mounting", async () => {
  await fixture(async () => {
    const { default: extension } = await import("../src/firecrawl.js");
    const mock = createMockPi({ activeTools: ["codemode"] });
    const entered = deferred();
    const mount = deferred();
    let lines: string[] = ["not mounted"];
    const { ctx } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        entered.resolve();
        await mount.promise;
        const harness = createCustomSelectorHarness(factory);
        lines = harness.render();
        return harness.resultPromise;
      },
    });
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const command = mock.commands.get("firecrawl")?.handler("settings", ctx);
    await entered.promise;
    const replacement = createMockContext();
    await mock.events.get("session_start")?.[0]?.({ reason: "switch" }, replacement.ctx);
    mount.resolve();
    await command;
    assert.deepEqual(lines, []);
  });
});

test("custom host failure disposes listeners and drains submitted saves without stale UI work", async () => {
  await fixture(async () => {
    initTheme("dark", false);
    const { default: extension } = await import("../src/firecrawl.js");
    const { currentFirecrawlSessionSignal } = await import("../src/tool-selector.js");
    const mock = createMockPi({ activeTools: ["codemode"] });
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        harness.handleInput("\r");
        throw new Error("host failed after mounting");
      },
    });
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const signal = currentFirecrawlSessionSignal(mock.pi);
    const adds = vi.spyOn(signal, "addEventListener");
    const removes = vi.spyOn(signal, "removeEventListener");
    try {
      await assert.rejects(mock.commands.get("firecrawl")?.handler("settings", ctx) as Promise<void>, /host failed/);
      const listener = adds.mock.calls.find(([type]) => type === "abort")?.[1];
      assert.ok(listener);
      assert.ok(removes.mock.calls.some(([type, callback]) => type === "abort" && callback === listener));
      assert.deepEqual(notifications, []);
      const { loadSettings } = await import("../src/settings.js");
      const settings = await loadSettings();
      assert.equal(settings.kind === "loaded" && settings.settings.toolMode, "lazy");
    } finally {
      adds.mockRestore();
      removes.mockRestore();
    }
  });
});

for (const toolMode of ["codemode", "direct"] as const) {
  test(`${toolMode} model switches do not change declarations or registration exposure`, async () => {
    await fixture(async (root) => {
      writeFileSync(join(root, "pi-firecrawl.json"), JSON.stringify({ tools: capabilities, toolMode, updatedAt: 1 }));
      const { default: extension } = await import("../src/firecrawl.js");
      const mock = createMockPi({ activeTools: ["codemode", "other"] });
      const { ctx } = createMockContext();
      extension(mock.pi);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      const before = mock.rawPi.getActiveTools();
      const definitions = mock.tools.map((tool) => ({ name: tool.name, exposure: tool.exposure }));
      for (const model of [
        undefined,
        { api: "azure-openai-responses" },
        { api: "openai-responses", compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true } },
      ]) {
        await mock.events.get("model_select")?.[0]?.({ model }, ctx);
        assert.deepEqual(mock.rawPi.getActiveTools(), before);
        assert.deepEqual(
          mock.tools.map((tool) => ({ name: tool.name, exposure: tool.exposure })),
          definitions,
        );
      }
    });
  });
}
