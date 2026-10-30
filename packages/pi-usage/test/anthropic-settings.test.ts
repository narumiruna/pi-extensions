import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createUsageSettingsRuntime, normalizeUsageSettings } from "../src/settings.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark", false);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function path() {
  const root = await mkdtemp(join(tmpdir(), "anthropic-usage-settings-"));
  roots.push(root);
  return join(root, "pi-usage.json");
}

for (const value of [null, "true", "false", 0, 1, [], {}]) {
  test(`Claude extra-usage preference rejects non-boolean ${JSON.stringify(value)}`, () => {
    assert.equal(normalizeUsageSettings({ anthropicExtraUsage: value }), undefined);
  });
}

test("Claude extra usage defaults Off without creating a file and preserves unknown settings on explicit save", async () => {
  const file = await path();
  const runtime = createUsageSettingsRuntime(file);
  assert.equal((await runtime.reload()).settings.anthropicExtraUsage, false);
  assert.deepEqual(await readdir(join(file, "..")), []);
  await writeFile(file, '{"future":{"keep":true},"openaiUseCodexUsage":true}');
  await runtime.reload();
  await runtime.update({ anthropicExtraUsage: true });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    future: { keep: true },
    openaiUseCodexUsage: true,
    anthropicExtraUsage: true,
  });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("Claude preference saves remain ordered through reload, publication failure, retry, and invalid-file protection", async () => {
  const file = await path();
  let fail = true;
  const runtime = createUsageSettingsRuntime({
    path: file,
    operations: {
      rename: async (...args) => {
        if (fail) throw new Error("synthetic publication failure");
        return rename(...args);
      },
    },
  });
  await runtime.reload();
  await assert.rejects(runtime.update({ anthropicExtraUsage: true }), /publication failure/);
  assert.equal(runtime.get().settings.anthropicExtraUsage, false);
  assert.deepEqual(await readdir(join(file, "..")), []);
  fail = false;
  const saved = runtime.update({ anthropicExtraUsage: true });
  const reloaded = runtime.reload();
  await saved;
  assert.equal((await reloaded).settings.anthropicExtraUsage, true);
  await Promise.all([runtime.update({ anthropicExtraUsage: false }), runtime.update({ anthropicExtraUsage: true })]);
  await runtime.flush();
  assert.equal(JSON.parse(await readFile(file, "utf8")).anthropicExtraUsage, true);
  await writeFile(file, '{"anthropicExtraUsage":"true","future":"kept"}');
  assert.equal((await runtime.reload()).kind, "invalid");
  assert.equal(runtime.get().settings.anthropicExtraUsage, false);
  await assert.rejects(runtime.update({ anthropicExtraUsage: true }), /invalid/);
  assert.equal(await readFile(file, "utf8"), '{"anthropicExtraUsage":"true","future":"kept"}');
});

for (const remapped of [false, true]) {
  test(`Claude setting saves explicit opt-in with ${remapped ? "remapped" : "default"} keys and bounded framing`, async () => {
    const runtime = createUsageSettingsRuntime(await path());
    await runtime.reload();
    const bindings = getKeybindings();
    const previous = bindings.getUserBindings();
    if (remapped)
      bindings.setUserBindings({
        "tui.select.down": "ctrl+n",
        "tui.select.confirm": "ctrl+y",
        "tui.select.cancel": "ctrl+x",
      });
    const applied: string[] = [];
    const frames: { width: number; lines: readonly string[] }[] = [];
    let description = "";
    const context = createMockContext({
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createTuiHarness({ width: 120, rows: 40, keybindings: bindings });
        let render = (_width: number): readonly string[] => [];
        const running = harness.custom(async (...args) => {
          const component = await (factory as Parameters<typeof harness.custom>[0])(...args);
          render = component.render.bind(component);
          return component;
        });
        try {
          await harness.waitForOpen();
          for (let row = 0; row < 4; row++) harness.send(remapped ? "\u000e" : "\u001b[B");
          description = stripVTControlCharacters(harness.render().join(" ")).replace(/\s+/gu, " ");
          harness.send(remapped ? "\u0019" : "\r");
          await vi.waitFor(() => assert.equal(applied.length, 1));
          for (const width of [0, 1, 12, 40, 120]) frames.push({ width, lines: render(width) });
          for (const rows of [8, 4]) {
            harness.resize({ rows });
            harness.invalidate();
            frames.push({ width: 40, lines: harness.render(40) });
          }
          harness.send("\u0003");
          return await running;
        } finally {
          harness.dispose();
        }
      },
    });
    try {
      assert.equal(
        await showUsageSettings(
          context.ctx,
          runtime,
          new AbortController().signal,
          () => true,
          (id) => applied.push(id),
        ),
        true,
      );
      assert.deepEqual(applied, ["anthropicExtraUsage"]);
      assert.equal(runtime.get().settings.anthropicExtraUsage, true);
      assert.match(description, /Claude extra usage.*Off/);
      assert.match(description, /Experimental:.*OAuth.*undocumented/);
      assert.ok(frames.every(({ width, lines }) => lines.every((line) => visibleWidth(line) <= width)));
      assert.ok(frames.some(({ lines }) => stripVTControlCharacters(lines.join("\n")).includes("Claude extra usage")));
    } finally {
      bindings.setUserBindings(previous);
      await runtime.flush();
    }
  });
}

for (const mode of ["rpc", "json", "text"] as const) {
  test(`Claude setting has no custom TUI or save in ${mode}`, async () => {
    const file = await path();
    const runtime = createUsageSettingsRuntime(file);
    const custom = vi.fn();
    const context = createMockContext({ mode, custom });
    assert.equal(
      await showUsageSettings(
        context.ctx,
        runtime,
        new AbortController().signal,
        () => true,
        () => {},
      ),
      false,
    );
    assert.equal(custom.mock.calls.length, 0);
    assert.equal(runtime.get().settings.anthropicExtraUsage, false);
    assert.deepEqual(await readdir(join(file, "..")), []);
    if (mode === "rpc") assert.ok(context.notifications[0]?.message.includes(file));
  });
}
