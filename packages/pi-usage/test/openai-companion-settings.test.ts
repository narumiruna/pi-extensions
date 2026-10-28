import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark");

for (const obsolete of [undefined, true, false, null, "true", 1, []]) {
  test(`obsolete companion setting ${JSON.stringify(obsolete)} is ignored and preserved without rewriting on read`, async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-companion-setting-"));
    const path = join(root, "pi-usage.json");
    const document = {
      unrelated: { preserved: true },
      ...(obsolete === undefined ? {} : { openaiCompanionUsage: obsolete }),
    };
    const original = JSON.stringify(document);
    await writeFile(path, original);
    const runtime = createUsageSettingsRuntime(path);
    try {
      assert.equal((await runtime.reload()).kind, "loaded");
      assert.equal(Object.hasOwn(runtime.get().settings, "openaiCompanionUsage"), false);
      assert.equal(runtime.get().settings.openaiUseCodexUsage, false);
      assert.equal(await readFile(path, "utf8"), original);
      await runtime.update({ codexFastMode: true });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...document, codexFastMode: true });
    } finally {
      await runtime.flush();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Settings shows default-off companion usage without a nested confirmation and saves in one screen", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-companion-ui-"));
  const runtime = createUsageSettingsRuntime(join(root, "pi-usage.json"));
  await runtime.reload();
  const confirm = vi.fn(async () => true);
  let rendered = "";
  let screenCount = 0;
  let applied = 0;
  const controller = new AbortController();
  const context = createMockContext({
    mode: "tui",
    custom: async (factory: unknown) => {
      screenCount++;
      const harness = createTuiHarness({ width: 100, keybindings: getKeybindings() });
      const running = harness.custom(factory as Parameters<typeof harness.custom>[0]);
      await harness.waitForOpen();
      try {
        rendered = harness.render().join("\n");
        harness.send("\r");
        await vi.waitFor(() => assert.equal(runtime.get().settings.codexFastMode, true));
        harness.send("\u0003");
        return await running;
      } finally {
        harness.dispose();
      }
    },
  });
  Object.assign((context.ctx as ExtensionCommandContext).ui, { confirm });
  try {
    assert.equal(
      await showUsageSettings(
        context.ctx,
        runtime,
        controller.signal,
        () => true,
        () => {
          applied++;
        },
      ),
      true,
    );
    assert.match(rendered, /Codex Fast mode/);
    assert.match(rendered, /Use Codex login for OpenAI usage/);
    assert.equal(runtime.get().settings.openaiUseCodexUsage, false);
    assert.equal(screenCount, 1);
    assert.equal(confirm.mock.calls.length, 0);
    assert.equal(applied, 1);
  } finally {
    controller.abort();
    await runtime.flush();
    await rm(root, { recursive: true, force: true });
  }
});

for (const remapped of [false, true]) {
  test(`companion row saves explicit opt-in with ${remapped ? "remapped" : "default"} keys and bounded framing`, async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-companion-row-"));
    const runtime = createUsageSettingsRuntime(join(root, "pi-usage.json"));
    const bindings = getKeybindings();
    const previous = bindings.getUserBindings();
    if (remapped)
      bindings.setUserBindings({
        "tui.select.down": "ctrl+n",
        "tui.select.confirm": "ctrl+y",
        "tui.select.cancel": "ctrl+x",
      });
    const applied: string[] = [];
    const frames: (readonly string[])[] = [];
    const compactFrames: (readonly string[])[] = [];
    let description = "";
    const controller = new AbortController();
    const context = createMockContext({
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createTuiHarness({ width: 100, rows: 30, keybindings: getKeybindings() });
        let renderAtWidth: (width: number) => readonly string[] = () => [];
        const running = harness.custom(async (...args) => {
          const component = await (factory as Parameters<typeof harness.custom>[0])(...args);
          renderAtWidth = component.render.bind(component);
          return component;
        });
        await harness.waitForOpen();
        try {
          for (let row = 0; row < 3; row++) harness.send(remapped ? "\u000e" : "\u001b[B");
          description = stripVTControlCharacters(harness.render().join(" ")).replace(/\s+/g, " ");
          frames.push(harness.render());
          harness.send(remapped ? "\u0019" : "\r");
          await vi.waitFor(() => assert.equal(applied.length, 1));
          for (const width of [0, 1, 12, 30]) frames.push(renderAtWidth(width));
          for (const rows of [8, 4]) {
            harness.resize({ rows });
            harness.invalidate();
            compactFrames.push(harness.render(40));
          }
          harness.send("\u0003");
          return await running;
        } finally {
          harness.dispose();
        }
      },
    });
    try {
      await showUsageSettings(
        context.ctx,
        runtime,
        controller.signal,
        () => true,
        (id) => applied.push(id),
      );
      assert.deepEqual(applied, ["openaiUseCodexUsage"]);
      assert.equal(runtime.get().settings.openaiUseCodexUsage, true);
      assert.match(description, /same ChatGPT account and workspace/);
      assert.match(description, /undocumented ChatGPT endpoints/);
      assert.match(description, /identity is not verified/);
      assert.equal(stripVTControlCharacters(frames[0]?.[0] ?? ""), "─".repeat(100));
      for (const [i, budget] of [5, 1].entries()) {
        const frame = compactFrames[i] ?? [];
        assert.ok(frame.length <= budget);
        assert.ok(frame.some((line) => stripVTControlCharacters(line).includes("Use Codex login")));
        assert.ok(frame.every((line) => visibleWidth(line) <= 40));
      }
      for (const [i, width] of [0, 1, 12, 30].entries())
        assert.ok(frames[i + 1]?.every((line) => visibleWidth(line) <= width));
    } finally {
      controller.abort();
      bindings.setUserBindings(previous);
      await runtime.flush();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("companion saves preserve unknown fields, serialize reload, and recover from publication failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-companion-save-"));
  const path = join(root, "pi-usage.json");
  let fail = false;
  const runtime = createUsageSettingsRuntime({
    path,
    operations: {
      rename: async (from, to) => {
        if (fail) throw new Error("publication rejected");
        await rename(from, to);
      },
    },
  });
  try {
    assert.equal((await runtime.reload()).settings.openaiUseCodexUsage, false);
    assert.deepEqual(await readdir(root), []);
    await writeFile(path, JSON.stringify({ openaiCompanionUsage: true, future: { keep: true } }));
    await runtime.reload();
    const saved = runtime.update({ openaiUseCodexUsage: true });
    const reloaded = runtime.reload();
    await saved;
    assert.equal((await reloaded).settings.openaiUseCodexUsage, true);
    fail = true;
    await assert.rejects(runtime.update({ openaiUseCodexUsage: false }), /publication rejected/);
    assert.equal(runtime.get().settings.openaiUseCodexUsage, true);
    assert.equal(JSON.parse(await readFile(path, "utf8")).openaiUseCodexUsage, true);
    fail = false;
    await runtime.update({ openaiUseCodexUsage: false });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      openaiCompanionUsage: true,
      future: { keep: true },
      openaiUseCodexUsage: false,
    });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    await writeFile(path, '{"openaiUseCodexUsage":"true"}');
    assert.equal((await runtime.reload()).kind, "invalid");
    assert.equal(runtime.get().settings.openaiUseCodexUsage, false);
    await assert.rejects(runtime.update({ openaiUseCodexUsage: true }), /Cannot overwrite an invalid/);
    assert.equal(await readFile(path, "utf8"), '{"openaiUseCodexUsage":"true"}');
  } finally {
    await runtime.flush();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`companion Settings never enters custom TUI in ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-companion-mode-"));
    const runtime = createUsageSettingsRuntime(join(root, "pi-usage.json"));
    const custom = vi.fn();
    const context = createMockContext({ mode, hasUI: mode === "rpc", custom });
    try {
      assert.equal(
        await showUsageSettings(
          context.ctx,
          runtime,
          new AbortController().signal,
          () => true,
          () => undefined,
        ),
        false,
      );
      assert.equal(custom.mock.calls.length, 0);
      if (mode === "rpc") assert.match(context.notifications[0]?.message ?? "", /Edit settings manually/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
