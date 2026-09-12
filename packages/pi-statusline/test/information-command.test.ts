import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import { registerStatuslineCommand } from "../src/commands.js";
import { loadStatuslineSettings, settingsFilePath } from "../src/settings.js";

function informationChoice(
  getInputs: () => readonly string[],
  inspect?: (lines: string[]) => void,
  inspectNarrow?: (lines: string[]) => void,
) {
  return async (factory: unknown) => {
    const harness = createCustomSelectorHarness(factory, 100);
    const lines = harness.render();
    if (lines.join("\n").includes("Information level")) {
      inspect?.(lines);
      inspectNarrow?.(harness.render(20));
      for (const input of getInputs()) harness.handleInput(input);
    } else {
      harness.handleInput("tui.select.down");
      harness.handleInput("tui.select.confirm");
    }
    return harness.result;
  };
}

test("information picker previews exact contents and atomically applies a curated profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, `${JSON.stringify({ segments: ["model"], future: true })}\n`);
  try {
    const mock = createMockPi();
    let loaded = loadStatuslineSettings(path);
    let applied = 0;
    registerStatuslineCommand(mock.pi, {
      settingsPath: path,
      getLoaded: () => loaded,
      apply(next) {
        loaded = next;
        applied += 1;
      },
    });
    let pickerText = "";
    let narrowLines: string[] = [];
    const context = createMockContext({
      mode: "tui",
      custom: informationChoice(
        () => ["tui.select.confirm"],
        (lines) => {
          pickerText = lines.join("\n");
        },
        (lines) => {
          narrowLines = lines;
        },
      ),
    });

    await mock.commands.get("statusline")?.handler("", context.ctx);

    assert.match(pickerText, /Information level/u);
    assert.match(pickerText, /Current profile: custom/u);
    for (const label of ["Minimal", "Balanced", "Detailed"]) {
      assert.match(pickerText, new RegExp(label, "u"));
    }
    assert.match(pickerText, /Segments: model · thinking · cwd · branch · tools · context · time/u);
    assert.ok(narrowLines.length > 0);
    assert.ok(narrowLines.every((line) => visibleWidth(line) <= 20));
    assert.deepEqual(loaded.config.segments, ["model", "thinking", "cwd", "branch", "tools", "context", "time"]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      segments: ["model", "thinking", "cwd", "branch", "tools", "context", "time"],
      future: true,
    });
    assert.equal(applied, 1);
    assert.match(context.notifications.at(-1)?.message ?? "", /Information level applied: balanced/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("information picker cancellation and save failure leave custom settings unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-statusline-command-"));
  const path = settingsFilePath(root);
  const original = `${JSON.stringify({ segments: ["model"], future: true })}\n`;
  writeFileSync(path, original);
  try {
    const mock = createMockPi();
    const loaded = loadStatuslineSettings(path);
    let applied = 0;
    let pickerInputs = ["tui.select.cancel"];
    registerStatuslineCommand(mock.pi, {
      settingsPath: path,
      getLoaded: () => loaded,
      apply() {
        applied += 1;
      },
      save() {
        throw new Error("disk full");
      },
    });
    const context = createMockContext({
      mode: "tui",
      custom: informationChoice(() => pickerInputs),
    });

    await mock.commands.get("statusline")?.handler("", context.ctx);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(applied, 0);

    pickerInputs = ["tui.select.confirm"];
    await mock.commands.get("statusline")?.handler("", context.ctx);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(applied, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*disk full/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Advanced provides a shallow Back path to the refreshed main menu", async () => {
  const mock = createMockPi();
  registerStatuslineCommand(mock.pi, {
    settingsPath: "/tmp/missing-pi-statusline-advanced.json",
    getLoaded: () => loadStatuslineSettings("/tmp/missing-pi-statusline-advanced.json"),
    apply() {},
  });
  const titles: string[] = [];
  let call = 0;
  const context = createMockContext({
    mode: "tui",
    select: async (title: string) => {
      titles.push(title);
      call += 1;
      if (call === 1) return "Advanced";
      if (call === 2) return "Back";
      return undefined;
    },
  });

  await mock.commands.get("statusline")?.handler("", context.ctx);

  assert.deepEqual(
    titles.map((title) => title.split("\n").find((line) => line.trim() && !/^─+$/u.test(line.trim())) ?? title),
    ["pi-statusline", "pi-statusline — Advanced", "pi-statusline"],
  );
});
