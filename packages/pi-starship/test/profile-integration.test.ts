import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { showPresetPicker } from "../src/command-preset-picker.js";
import { registerStarshipCommand } from "../src/commands.js";
import { type LoadedStarshipConfig, loadStarshipConfig } from "../src/config.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";
import { STARSHIP_PRESETS } from "../src/presets/catalog.js";
import { createProfile, listHistory, listProfiles } from "../src/profile-store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-profile-integration-"));
  return { root, path: join(root, "pi-starship.toml"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the main-menu profile apply adopts its own revision and preserves the previous active document", async () => {
  const { path, cleanup } = fixture();
  const previous = "# original\nformat = '$model'\nfuture = true\n";
  const next = "# work\nformat = '$directory'\n";
  writeFileSync(path, previous);
  createProfile(path, "work", next);
  let loaded = loadStarshipConfig(path);
  let revision = 0;
  const previewed: Array<string | undefined> = [];
  const mock = createMockPi();
  registerStarshipCommand(mock.pi, {
    settingsPath: path,
    getLoaded: () => loaded,
    getLoadedRevision: () => revision,
    apply(value) {
      loaded = value;
      revision += 1;
    },
    preview(value: LoadedStarshipConfig | undefined) {
      previewed.push(value?.rawDocument);
    },
    renderPreview: (value) => [value.config.format],
  });
  const tui = createTuiHarness({ width: 100, rows: 40 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom, confirm: async () => true });
  const running = mock.commands.get("starship")?.handler("", context.ctx);
  try {
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    assert.match(tui.render().join("\n"), /→ Profiles/u);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.down");
    assert.equal(previewed.at(-1), next);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /work profile preview/u);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Matches active settings/u);
    assert.equal(revision, 1);
    assert.equal(loaded.rawDocument, next);
    assert.equal(readFileSync(path, "utf8"), next);
    assert.deepEqual(
      listHistory(path).map((document) => document.rawDocument),
      [previous],
    );
    tui.press("ctrl+c");
    await running;
    assert.equal(previewed.at(-1), undefined);
    assert.equal(loaded.rawDocument, next);
  } finally {
    tui.dispose();
    await running;
    cleanup();
  }
});

test("selecting an untrusted profile cannot emit terminal controls before apply confirmation", async () => {
  const { path, cleanup } = fixture();
  createProfile(path, "untrusted", 'format = "\\u001Bc"\n');
  const snapshot: StarshipRuntimeSnapshot = {
    cwd: "/work",
    thinkingLevel: "off",
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(0),
  };
  let output: string | undefined;
  const mock = createMockPi();
  registerStarshipCommand(mock.pi, {
    settingsPath: path,
    getLoaded: () => loadStarshipConfig(path),
    apply() {
      assert.fail("Selection must not apply settings");
    },
    preview(value) {
      if (value) output = renderStatusline(value.config, snapshot, 80).ansi;
    },
  });
  const tui = createTuiHarness({ width: 100, rows: 24 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = mock.commands.get("starship")?.handler("", context.ctx);
  try {
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.down");
    assert.notEqual(output, undefined);
    assert.ok(
      Array.from(output ?? "").every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 0x1f && (code < 0x7f || code > 0x9f);
      }),
    );
    assert.equal(existsSync(path), false);
    assert.deepEqual(listHistory(path), []);
    tui.press("ctrl+c");
    await running;
  } finally {
    tui.dispose();
    await running;
    cleanup();
  }
});

test("preset Save as profile keeps the active file and history absent", async () => {
  const { path, cleanup } = fixture();
  const mock = createMockPi();
  registerStarshipCommand(mock.pi, {
    settingsPath: path,
    getLoaded: () => loadStarshipConfig(path),
    apply() {
      assert.fail("Saving a preset profile must not apply active settings");
    },
  });
  const tui = createTuiHarness({ width: 100, rows: 24 });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
    input: async () => "minimal-copy",
  });
  const running = mock.commands.get("starship")?.handler("", context.ctx);
  try {
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    assert.match(frame, /s save as profile/u);
    tui.send("s");
    await tui.waitForOpen();
    assert.equal(listProfiles(path)[0]?.rawDocument, STARSHIP_PRESETS[0]?.rawDocument);
    assert.equal(existsSync(path), false);
    assert.deepEqual(listHistory(path), []);
    tui.press("ctrl+c");
    await running;
  } finally {
    tui.dispose();
    await running;
    cleanup();
  }
});

for (const mapping of [
  { name: "default shortcut", down: ["j"], confirm: "y", shortcut: "s", expected: "save-profile" },
  {
    name: "standard navigation takes both save keys",
    down: ["s", "shift+s"],
    confirm: "y",
    shortcut: "s",
    expected: "navigate",
  },
] as const) {
  test(`preset save hint respects configured standard bindings: ${mapping.name}`, async () => {
    const keys: Record<string, readonly string[]> = {
      "tui.select.down": mapping.down,
      "tui.select.up": ["k"],
      "tui.select.confirm": [mapping.confirm],
      "tui.select.cancel": ["q"],
    };
    const keybindings: Pick<KeybindingsManager, "matches" | "getKeys"> = {
      matches: (data, action) => (keys[action] ?? []).some((key) => matchesKey(data, key as never)),
      getKeys: (action) => (keys[action] ?? []) as never[],
    };
    const tui = createTuiHarness({ width: 120, rows: 24, keybindings });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const previews: string[] = [];
    const running = showPresetPicker(context.ctx, {
      presets: STARSHIP_PRESETS,
      signal: new AbortController().signal,
      isCurrent: () => true,
      preview: (preset) => {
        previews.push(preset.id);
      },
    });
    try {
      await tui.waitForOpen();
      const frame = tui.render().join("\n");
      if (mapping.expected === "save-profile") assert.match(frame, /s save as profile/u);
      else assert.doesNotMatch(frame, /save as profile/u);
      tui.send(mapping.shortcut);
      if (mapping.expected === "save-profile") {
        const result = await running;
        assert.equal(result.kind, "save-profile");
      } else {
        assert.equal(previews.at(-1), STARSHIP_PRESETS[1]?.id);
        tui.press("ctrl+c");
        assert.equal((await running).kind, "close");
      }
    } finally {
      tui.dispose();
      await running;
    }
  });
}
