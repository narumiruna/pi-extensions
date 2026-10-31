import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type ModuleName, type StarshipConfig, validateConfigDocument } from "../src/config.js";
import { parseColor, renderChunksToAnsi } from "../src/format/style.js";
import { reachableModuleRequirements, renderStatusline } from "../src/modules/render.js";
import type { GitStatusSnapshot, StarshipRuntimeSnapshot } from "../src/modules/types.js";
import { wrapFormattedStatusline } from "../src/pi-starship.js";
import { getStarshipPreset, STARSHIP_PRESETS, type StarshipPreset } from "../src/presets/catalog.js";

const WIDTHS = [0, 1, 2, 8, 20, 40, 80, 120, 160] as const;
const COLOR_MODES = [true, false] as const;
const PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
const LOCAL_MODULES = new Set<string>([
  "brand",
  "model",
  "thinking",
  "directory",
  "git_branch",
  "git_status",
  "git_state",
  "activity",
  "context",
  "tokens",
  "time",
  "fill",
  "extension_status",
]);

// These are layout traits, not copies of preset documents or ANSI snapshots.
const PROMOTED = [
  { id: "pastel-powerline", requiresNerdFont: true, rows: [/^.*.*$/u] },
  { id: "gruvbox-rainbow", requiresNerdFont: true, rows: [/^.*.*$/u, /idle.*↑.*↓.*ctx/u] },
  { id: "tokyo-night", requiresNerdFont: true, rows: [/^░▒▓.*.*$/u] },
  { id: "lualine-bubbles", requiresNerdFont: true, rows: [/^.*.*.*\s*$/u] },
  { id: "lualine-evil", requiresNerdFont: false, rows: [/^▊ .* ▊$/u] },
  { id: "lualine-slanted-gaps", requiresNerdFont: true, rows: [/.*.*ctx/u] },
  { id: "catppuccin-tmux", requiresNerdFont: true, rows: [/^.*git.*ai.*think.*idle.*ctx.*time.*$/u] },
  { id: "dracula-tmux", requiresNerdFont: false, rows: [/π.*git:feature.*idle.*sonnet.*ctx/u] },
  { id: "powerlevel10k-lean", requiresNerdFont: false, rows: [/repo.*on feature.*ctx/u, /^❯ .*sonnet.*idle.*↑.*↓/u] },
  { id: "oh-my-posh-atomic", requiresNerdFont: true, rows: [/^╭─.*.*.*ctx/u, /^╰─❯ .*.*.*↑.*↓/u] },
] as const satisfies readonly {
  id: StarshipPreset["id"];
  requiresNerdFont: boolean;
  rows: readonly RegExp[];
}[];

const CLEAN_GIT: GitStatusSnapshot = {
  upToDate: true,
  ahead: 0,
  behind: 0,
  stashed: 0,
  conflicted: 0,
  deleted: 0,
  renamed: 0,
  modified: 0,
  staged: 0,
  typechanged: 0,
  untracked: 0,
  worktreeAdded: 0,
  worktreeDeleted: 0,
  worktreeModified: 0,
  worktreeTypechanged: 0,
  indexAdded: 0,
  indexDeleted: 0,
  indexModified: 0,
  indexTypechanged: 0,
};
const DIRTY_GIT: GitStatusSnapshot = {
  ...CLEAN_GIT,
  upToDate: false,
  ahead: 2,
  behind: 1,
  conflicted: 1,
  modified: 4,
  staged: 3,
  untracked: 5,
  worktreeModified: 4,
  indexAdded: 3,
};
const NO_GIT: Partial<StarshipRuntimeSnapshot> = {
  gitRoot: undefined,
  gitBranch: null,
  gitBranchDetails: undefined,
  gitStatus: undefined,
  gitState: undefined,
};
const STATUSES = new Map([
  ["starship", "own footer"],
  ["empty", "  \t  "],
  ["vendor.example/channel", "healthy"],
  ["external:worker", "watching files"],
  ["third", "not displayed"],
]);
const HOSTILE = [
  "\u001bc\u001b[2J\u001b[31mred\u001b[0m",
  "\u001b]52;c;clipboard-payload\u0007",
  "\u001b]0;terminal-title\u001b\\",
  "\u001bPprivate-payload\u001b\\",
  "\u009d52;c;c1-payload\u009c\u009b2J",
  "\u0000\u0007\b\t\r\u001f\u007f\u0085",
].join("");
const LONG_TEXT = `${HOSTILE}${"cafe\u0301界👩‍💻-".repeat(32)}${HOSTILE}`;

function runtime(overrides: Partial<StarshipRuntimeSnapshot> = {}): StarshipRuntimeSnapshot {
  return {
    cwd: "/work/repo",
    homeDir: "/home/test",
    gitRoot: "/work/repo",
    model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    thinkingLevel: "high",
    turnCount: 7,
    activeTools: new Map(),
    isStreaming: false,
    contextUsage: { percent: 0, tokens: 0, contextWindow: 200_000 },
    tokenTotals: { input: 12_500, output: 3_200, cacheRead: 4_000, cacheWrite: 100, cost: 0.25 },
    usingSubscription: false,
    gitBranch: "feature",
    gitBranchDetails: { name: "feature", remoteName: "origin", remoteBranch: "main", detached: false },
    gitStatus: { ...CLEAN_GIT },
    extensionStatuses: new Map(),
    // Local construction also fixes the displayed clock on hosts in other time zones.
    now: new Date(2026, 0, 2, 9, 5),
    ...overrides,
  };
}

interface RenderFixture {
  name: string;
  overrides: Partial<StarshipRuntimeSnapshot>;
}

const FIXTURES: readonly RenderFixture[] = [
  { name: "idle, clean Git, zero context", overrides: {} },
  {
    name: "active tools, dirty diverged Git, rebase progress",
    overrides: {
      activeTools: new Map([
        ["read", 2],
        ["bash", 1],
      ]),
      isStreaming: true,
      lastCompletedTool: "write",
      gitStatus: DIRTY_GIT,
      gitState: { state: "REBASING", progressCurrent: 3, progressTotal: 7 },
    },
  },
  {
    name: "streaming with low context",
    overrides: { isStreaming: true, lastCompletedTool: "read", contextUsage: { percent: 29.9 } },
  },
  {
    name: "UI waiting over active and streaming work",
    overrides: {
      uiPrompt: { kind: "select", title: "Choose a profile" },
      activeTools: new Map([["read", 1]]),
      isStreaming: true,
      contextUsage: { percent: 60 },
    },
  },
  {
    name: "completed tool with high context",
    overrides: { lastCompletedTool: "write", contextUsage: { percent: 80 } },
  },
  { name: "missing model", overrides: { model: undefined } },
  { name: "missing Git", overrides: NO_GIT },
  { name: "missing context", overrides: { contextUsage: undefined } },
  { name: "missing all optional data", overrides: { ...NO_GIT, model: undefined, contextUsage: undefined } },
  {
    name: "combining, wide, and emoji graphemes",
    overrides: {
      cwd: "/work/cafe\u0301/設計/👩‍💻",
      gitRoot: undefined,
      model: { provider: "local", id: "cafe\u0301-界-👩‍💻" },
      gitBranch: "feat/e\u0301-界",
      gitBranchDetails: { name: "feat/e\u0301-界", detached: false },
      activeTools: new Map([["re\u0301ad界", 2]]),
      extensionStatuses: new Map([["unicode", "cafe\u0301 界 👩‍💻"]]),
    },
  },
  {
    name: "oversized Indic grapheme",
    overrides: { cwd: `/work/${"क्".repeat(41)}क`, gitRoot: undefined },
  },
  {
    name: "long hostile model, paths, branch, tools, and statuses",
    overrides: {
      cwd: `/work/${LONG_TEXT}/${LONG_TEXT}`,
      homeDir: `/home/${HOSTILE}test`,
      gitRoot: undefined,
      model: { provider: `${HOSTILE}local`, id: `claude-${LONG_TEXT}-latest` },
      gitBranch: LONG_TEXT,
      gitBranchDetails: { name: LONG_TEXT, remoteName: LONG_TEXT, remoteBranch: LONG_TEXT, detached: false },
      gitState: { state: `${HOSTILE}MERGING` },
      gitStatus: DIRTY_GIT,
      activeTools: new Map([[LONG_TEXT, 2]]),
      extensionStatuses: new Map([
        ["vendor.example/channel", LONG_TEXT],
        ["external:worker", LONG_TEXT],
      ]),
    },
  },
  { name: "long hostile UI title", overrides: { uiPrompt: { kind: "input", title: LONG_TEXT } } },
  { name: "long hostile completed tool", overrides: { lastCompletedTool: LONG_TEXT } },
  { name: "neutral third-party statuses with overflow", overrides: { extensionStatuses: STATUSES } },
];

function configFor(preset: StarshipPreset): StarshipConfig {
  const loaded = validateConfigDocument(`/presets/${preset.id}.toml`, preset.rawDocument);
  assert.deepEqual(loaded.diagnostics, [], preset.id);
  return loaded.config;
}

function moduleText(rendered: ReturnType<typeof renderStatusline>, name: ModuleName): string {
  return rendered.modules[name].map((chunk) => chunk.text).join("");
}

function nativeAnsiRuns(ansi: string): Array<{ codes: string; text: string }> {
  const esc = String.fromCharCode(27);
  const pattern = new RegExp(`${esc}\\[([0-9;]+)m([^${esc}]*)${esc}\\[0m`, "gu");
  const runs = [...ansi.matchAll(pattern)].map((match) => ({ codes: match[1] ?? "", text: match[2] ?? "" }));
  assert.equal(runs.map((run) => run.text).join(""), stripVTControlCharacters(ansi));
  return runs;
}

function assertTerminalSafe(ansi: string, label: string): void {
  // Only native SGR and logical newlines are needed by these local presets.
  const text = ansi.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    assert.ok(code === 0x0a || (code > 0x1f && (code < 0x7f || code > 0x9f)), label);
  }
  assert.equal(text, stripVTControlCharacters(ansi), label);
  assert.doesNotMatch(text, /clipboard-payload|terminal-title|private-payload|c1-payload/u, label);
}

// Include the retained presets so the same native safety contract covers the whole catalog.
// A separate test per preset/fixture keeps each test within the normal timeout.
for (const preset of STARSHIP_PRESETS) {
  test.each(FIXTURES)(`${preset.id}: $name renders deterministically within wrapped widths`, ({ overrides, name }) => {
    const config = configFor(preset);
    const snapshot = runtime(overrides);
    const before = structuredClone({ config, snapshot });
    for (const width of WIDTHS) {
      const layouts = COLOR_MODES.map((trueColor) => {
        const label = `${preset.id}/${name}/${width}/${trueColor ? "truecolor" : "256color"}`;
        const rendered = renderStatusline(config, snapshot, width, trueColor);
        assert.deepEqual(renderStatusline(config, snapshot, width, trueColor), rendered, label);
        assertTerminalSafe(rendered.ansi, label);
        if (!preset.requiresNerdFont) assert.doesNotMatch(rendered.ansi, PRIVATE_USE, label);

        // Fixed segments may exceed width; the shared footer wrapper owns the final row bounds.
        const lines = wrapFormattedStatusline(rendered.ansi, width);
        assert.deepEqual(wrapFormattedStatusline(rendered.ansi, width), lines, label);
        if (width === 0) assert.deepEqual(lines, [], label);
        else assert.ok(lines.length > 0, label);
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= width, `${label}: ${visibleWidth(line)} cells`);
          assertTerminalSafe(line, label);
        }
        return {
          text: stripVTControlCharacters(rendered.ansi),
          rows: lines.map(stripVTControlCharacters),
          chunks: rendered.chunks,
        };
      });
      assert.deepEqual(layouts[0], layouts[1], `${preset.id}/${name}/${width}: color must not change layout`);
    }
    assert.deepEqual({ config, snapshot }, before, `${preset.id}/${name}: rendering must not mutate inputs`);
  });
}

test("catppuccin-tmux: one primary row separates workspace and session details", () => {
  const config = configFor(getStarshipPreset("catppuccin-tmux"));
  assert.equal(config.palette, "catppuccin_mocha");
  for (const width of [160, 240]) {
    for (const trueColor of COLOR_MODES) {
      const rendered = renderStatusline(config, runtime(), width, trueColor);
      const rows = stripVTControlCharacters(rendered.ansi).split("\n");
      assert.equal(rows.length, 1);
      const row = rows[0] ?? "";
      assert.equal(visibleWidth(row), width);
      let end = 0;
      for (const name of [
        "brand",
        "directory",
        "git_branch",
        "model",
        "thinking",
        "activity",
        "context",
        "time",
      ] as const) {
        const text = moduleText(rendered, name);
        assert.ok(text.trim(), name);
        const start = row.indexOf(text, end);
        assert.ok(start >= end, `${name}: preserve workspace/session order`);
        if (name === "model") assert.ok(start > end + 1, "fill separates workspace and session groups");
        end = start + text.length;
      }
      assert.equal(end, row.length, "the clock closes the right-aligned session group");
      const statuses = renderStatusline(config, runtime({ extensionStatuses: STATUSES }), width, trueColor);
      assert.deepEqual(stripVTControlCharacters(statuses.ansi).split("\n"), [row, "healthy · watching files"]);
    }
  }
});

for (const layout of PROMOTED) {
  const preset = getStarshipPreset(layout.id);

  test(`${preset.id}: native layout retains its characteristic rows and edges`, () => {
    assert.equal(preset.requiresNerdFont, layout.requiresNerdFont);
    const config = configFor(preset);
    const requirements = reachableModuleRequirements(config);
    for (const name of requirements.keys()) assert.ok(LOCAL_MODULES.has(name), `${preset.id}: ${name}`);
    for (const name of ["model", "directory", "git_branch", "git_status", "context", "extension_status"] as const) {
      assert.ok(requirements.has(name), `${preset.id}: ${name}`);
    }
    for (const trueColor of COLOR_MODES) {
      const rendered = renderStatusline(config, runtime(), 160, trueColor);
      const rows = stripVTControlCharacters(rendered.ansi).split("\n");
      assert.equal(rows.length, layout.rows.length, preset.id);
      for (const [index, pattern] of layout.rows.entries()) assert.match(rows[index] ?? "", pattern, preset.id);
      assert.deepEqual(wrapFormattedStatusline(rendered.ansi, 160).map(stripVTControlCharacters), rows, preset.id);
      if (preset.id === "powerlevel10k-lean") {
        assert.ok(rendered.chunks.every((chunk) => chunk.style?.background === undefined));
      }
      if (preset.id === "dracula-tmux") {
        assert.doesNotMatch(rows[0] ?? "", /[╭╰]/u);
        assert.ok(rendered.chunks.filter((chunk) => chunk.text.trim()).every((chunk) => chunk.style?.background));
      }
    }
  });

  test(`${preset.id}: clean Git has no status decoration, while dirty Git remains visible`, () => {
    const config = configFor(preset);
    const disabled = structuredClone(config);
    disabled.modules.git_status.disabled = true;
    for (const trueColor of COLOR_MODES) {
      const snapshot = runtime();
      const clean = renderStatusline(config, snapshot, 160, trueColor);
      assert.deepEqual(clean.modules.git_status, []);
      assert.equal(clean.ansi, renderStatusline(disabled, snapshot, 160, trueColor).ansi);
      assert.doesNotMatch(stripVTControlCharacters(clean.ansi), /!0|\+0|\?0|⇡0|⇣0|\(\s*\)|\[\s*\]/u);
      const dirty = renderStatusline(config, runtime({ gitStatus: DIRTY_GIT }), 160, trueColor);
      assert.notEqual(moduleText(dirty, "git_status").trim(), "");
      assert.ok(stripVTControlCharacters(dirty.ansi).includes(moduleText(dirty, "git_status")));
    }
  });

  test(`${preset.id}: missing model, Git, and context leave no optional labels`, () => {
    const config = configFor(preset);
    const cases = [
      { overrides: { model: undefined }, modules: ["model"], forbidden: /sonnet|◆|\b(?:ai|model)\b/u },
      { overrides: NO_GIT, modules: ["git_branch", "git_status", "git_state"], forbidden: /feature||\b(?:git|on)\b/u },
      { overrides: { contextUsage: undefined }, modules: ["context"], forbidden: /\bctx\b/u },
      {
        overrides: { ...NO_GIT, model: undefined, contextUsage: undefined },
        modules: ["model", "git_branch", "git_status", "git_state", "context"],
        forbidden: /sonnet|feature|◆||\b(?:ai|model|git|on|ctx)\b/u,
      },
    ] satisfies { overrides: Partial<StarshipRuntimeSnapshot>; modules: ModuleName[]; forbidden: RegExp }[];
    for (const item of cases) {
      for (const trueColor of COLOR_MODES) {
        const rendered = renderStatusline(config, runtime(item.overrides), 160, trueColor);
        for (const name of item.modules) assert.deepEqual(rendered.modules[name], [], `${preset.id}: ${name}`);
        assert.doesNotMatch(stripVTControlCharacters(rendered.ansi), item.forbidden, preset.id);
      }
    }
  });

  test(`${preset.id}: context is visible from zero and hides unavailable percentages`, () => {
    const config = configFor(preset);
    assert.ok(config.modules.context.display.some((entry) => entry.threshold === 0 && !entry.hidden));
    for (const percent of [
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      0.1,
      29.9,
      30,
      59.9,
      60,
      79.9,
      80,
      100,
    ]) {
      for (const trueColor of COLOR_MODES) {
        const rendered = renderStatusline(config, runtime({ contextUsage: { percent } }), 160, trueColor);
        const text = moduleText(rendered, "context");
        if (typeof percent === "number" && Number.isFinite(percent) && percent >= 0) {
          assert.ok(text.includes(`${percent.toFixed(1)}%`), `${preset.id}: ${percent}`);
          assert.match(stripVTControlCharacters(rendered.ansi), /\bctx\b/u);
        } else {
          assert.equal(text, "", `${preset.id}: ${percent}`);
          assert.doesNotMatch(stripVTControlCharacters(rendered.ansi), /\bctx\b/u);
        }
      }
    }
  });

  test(`${preset.id}: optional status row retains neutral third-party text and limits it to two statuses`, () => {
    const config = configFor(preset);
    assert.equal(config.extensionStatus.maxStatuses, 2);
    for (const trueColor of COLOR_MODES) {
      const baseline = renderStatusline(config, runtime(), 160, trueColor);
      for (const extensionStatuses of [
        new Map<string, string>(),
        new Map([
          ["starship", "own footer"],
          ["blank", " \t "],
        ]),
      ]) {
        assert.equal(renderStatusline(config, runtime({ extensionStatuses }), 160, trueColor).ansi, baseline.ansi);
      }
      const rendered = renderStatusline(config, runtime({ extensionStatuses: STATUSES }), 160, trueColor);
      const rows = stripVTControlCharacters(rendered.ansi).split("\n");
      assert.equal(rows.length, layout.rows.length + 1);
      assert.deepEqual(rows.slice(0, -1), stripVTControlCharacters(baseline.ansi).split("\n"));
      assert.equal(rows.at(-1), "healthy · watching files");
      assert.equal(moduleText(rendered, "extension_status"), "healthy · watching files");
      assert.doesNotMatch(stripVTControlCharacters(rendered.ansi), /own footer|not displayed|🔌/u);
    }
  });
}

test.each(["pastel-powerline", "gruvbox-rainbow", "tokyo-night"] as const)(
  "%s: refreshed model labels shorten dates and bound long model IDs without changing the payload",
  (id) => {
    const config = configFor(getStarshipPreset(id));
    const snapshot = runtime();
    const before = structuredClone(snapshot);
    const short = renderStatusline(config, snapshot, 160);
    assert.match(moduleText(short, "model"), /sonnet-4/u);
    assert.doesNotMatch(moduleText(short, "model"), /claude-|20250514/u);
    assert.deepEqual(snapshot, before);

    const model = { provider: "local", id: `claude-${"a".repeat(30)}${"z".repeat(30)}-latest` };
    const longSnapshot = runtime({ model });
    const longBefore = structuredClone(longSnapshot);
    const text = moduleText(renderStatusline(config, longSnapshot, 160), "model");
    assert.match(text, /a+…z+/u);
    assert.doesNotMatch(text, /claude-|-latest/u);
    assert.ok(visibleWidth(text) < 60, id);
    assert.deepEqual(longSnapshot, longBefore);
  },
);

test.each([true, false])("lualine-evil: first-row chunks and ANSI retain the dark surface with fill=%s", (fill) => {
  const config = configFor(getStarshipPreset("lualine-evil"));
  config.modules.fill.disabled = !fill;
  const background = { kind: "rgb", red: 32, green: 35, blue: 40 } as const;
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "custom"]) {
    for (const percent of [0, 59.9, 60, 79.9, 80, 100]) {
      for (const trueColor of COLOR_MODES) {
        const label = `${thinkingLevel}/${percent}/${trueColor}/fill=${fill}`;
        const rendered = renderStatusline(
          config,
          runtime({ thinkingLevel, contextUsage: { percent }, gitStatus: DIRTY_GIT, extensionStatuses: STATUSES }),
          160,
          trueColor,
        );
        const rowEnd = rendered.chunks.findIndex((chunk) => chunk.text === "\n");
        assert.ok(rowEnd > 0, label);
        const firstRow = rendered.chunks.slice(0, rowEnd);
        assert.equal(firstRow.filter((chunk) => chunk.text.includes("▊")).length, 2, label);
        for (const chunk of firstRow) assert.deepEqual(chunk.style?.background, background, `${label}/${chunk.text}`);
        for (const name of [
          "brand",
          "model",
          "thinking",
          "activity",
          "directory",
          "git_branch",
          "git_status",
          "context",
        ] as const) {
          assert.ok(moduleText(rendered, name).trim(), `${label}/${name}`);
        }
        const [firstAnsiRow = "", statusAnsiRow = ""] = rendered.ansi.split("\n");
        assert.equal(visibleWidth(firstAnsiRow) === 160, fill, label);
        for (const run of nativeAnsiRuns(firstAnsiRow)) {
          assert.ok(run.codes.includes(trueColor ? "48;2;32;35;40" : "48;5;59"), `${label}/${run.text}`);
        }
        assert.equal(stripVTControlCharacters(statusAnsiRow), "healthy · watching files", label);
        assert.ok(
          rendered.modules.extension_status.every((chunk) => chunk.style?.background === undefined),
          label,
        );
        assert.ok(
          nativeAnsiRuns(statusAnsiRow).every((run) => !run.codes.includes("48;")),
          label,
        );
      }
    }
  }
});

test.each(["dracula-tmux", "lualine-slanted-gaps"] as const)(
  "%s: explicit block and edge backgrounds do not rely on root style merging",
  (id) => {
    const config = configFor(getStarshipPreset(id));
    for (const fill of [true, false]) {
      config.modules.fill.disabled = !fill;
      for (const trueColor of COLOR_MODES) {
        const rendered = renderStatusline(
          config,
          runtime({ gitStatus: DIRTY_GIT, extensionStatuses: STATUSES }),
          160,
          trueColor,
        );
        const rowEnd = rendered.chunks.findIndex((chunk) => chunk.text === "\n");
        assert.ok(rowEnd > 0, id);
        for (const chunk of rendered.chunks.slice(0, rowEnd)) assert.ok(chunk.style?.background, `${id}/${chunk.text}`);
        for (const run of nativeAnsiRuns(rendered.ansi.split("\n")[0] ?? "")) {
          assert.ok(run.codes.includes("48;"), `${id}/${run.text}`);
        }
        assert.ok(
          rendered.modules.extension_status.every((chunk) => chunk.style?.background === undefined),
          id,
        );
      }
    }
  },
);

const PRESENCE_STATES = ["present", "missing", "disabled"] as const;
test.each(
  PRESENCE_STATES.flatMap((modelPresence) =>
    PRESENCE_STATES.map((thinkingPresence) => ({ modelPresence, thinkingPresence })),
  ),
)(
  "tokyo-night: $modelPresence model and $thinkingPresence thinking share one block transition",
  ({ modelPresence, thinkingPresence }) => {
    const config = configFor(getStarshipPreset("tokyo-night"));
    config.modules.model.disabled = modelPresence === "disabled";
    config.modules.thinking.disabled = thinkingPresence === "disabled";
    const hasModel = modelPresence === "present";
    const hasThinking = thinkingPresence === "present";
    for (const withGit of [true, false]) {
      const snapshot = runtime(withGit ? { gitStatus: DIRTY_GIT } : NO_GIT);
      if (modelPresence === "missing") snapshot.model = undefined;
      if (thinkingPresence === "missing") snapshot.thinkingLevel = "";
      const blocks = [
        "#a3aed2",
        "#769ff0",
        ...(withGit ? ["#394260"] : []),
        ...(hasModel || hasThinking ? ["#212736"] : []),
        "#1d2230",
      ];
      const expectedSeams = blocks.map((foreground, index) => ({ foreground, background: blocks[index + 1] }));
      for (const trueColor of COLOR_MODES) {
        const label = `${modelPresence}/${thinkingPresence}/Git=${withGit}/${trueColor}`;
        const rendered = renderStatusline(config, snapshot, 160, trueColor);
        assert.equal(rendered.modules.model.length > 0, hasModel, label);
        assert.equal(rendered.modules.thinking.length > 0, hasThinking, label);
        assert.doesNotMatch(moduleText(rendered, "model"), //u, label);
        const seams = rendered.chunks.filter((chunk) => chunk.text === "");
        assert.deepEqual(
          seams.map((chunk) => chunk.style),
          expectedSeams.map(({ background }) => ({
            foregroundPrevious: "background",
            ...(background ? { background: parseColor(background) } : {}),
          })),
          label,
        );
        const ansiSeams = nativeAnsiRuns(rendered.ansi).flatMap((run) =>
          [...run.text.matchAll(//gu)].map(() => run.codes),
        );
        const expectedCodes = expectedSeams.map(
          ({ foreground, background }) =>
            nativeAnsiRuns(
              renderChunksToAnsi(
                [
                  {
                    text: "",
                    style: {
                      foreground: parseColor(foreground),
                      background: background ? parseColor(background) : undefined,
                    },
                  },
                ],
                trueColor,
              ),
            )[0]?.codes,
        );
        assert.deepEqual(ansiSeams, expectedCodes, `${label}: resolved seam foregrounds and backgrounds`);
      }
    }
  },
);

test.each(["jetpack", "pure-preset"] as const)("%s: Git progress separators appear only with progress values", (id) => {
  const config = configFor(getStarshipPreset(id));
  for (const trueColor of COLOR_MODES) {
    for (const state of ["MERGING", "REVERTING", "CHERRY-PICKING", "BISECTING", "REBASING", "AM", "AM/REBASE"]) {
      const rendered = renderStatusline(config, runtime({ gitState: { state } }), 160, trueColor);
      const text = moduleText(rendered, "git_state");
      assert.equal(text, id === "jetpack" ? `⎪${state}⎥` : `${state} `, `${id}/${state}/${trueColor}`);
      assert.ok(stripVTControlCharacters(rendered.ansi).includes(text), id);
    }
    const progress = renderStatusline(
      config,
      runtime({ gitState: { state: "REBASING", progressCurrent: 3, progressTotal: 7 } }),
      160,
      trueColor,
    );
    assert.equal(moduleText(progress, "git_state"), id === "jetpack" ? "⎪REBASING 3/7⎥" : "REBASING 3/7 ", id);
    assert.deepEqual(renderStatusline(config, runtime(), 160, trueColor).modules.git_state, [], id);
  }
});

test("lualine-evil: context warning boundaries change style without hiding available data", () => {
  const config = configFor(getStarshipPreset("lualine-evil"));
  const styles = [0, 59.9, 60, 79.9, 80, 100].map((percent) => {
    const rendered = renderStatusline(config, runtime({ contextUsage: { percent } }), 160);
    assert.ok(moduleText(rendered, "context").includes(`${percent.toFixed(1)}%`));
    return rendered.modules.context.find((chunk) => chunk.text.includes("ctx"))?.style;
  });
  assert.ok(styles.every((style) => style !== undefined));
  assert.deepEqual(styles[0], styles[1]);
  assert.deepEqual(styles[2], styles[3]);
  assert.deepEqual(styles[4], styles[5]);
  assert.notDeepEqual(styles[1], styles[2]);
  assert.notDeepEqual(styles[3], styles[4]);
});

test.each([
  ["pastel-powerline", ""],
  ["gruvbox-rainbow", ""],
  ["tokyo-night", ""],
  ["oh-my-posh-atomic", ""],
] as const)("%s: a status-only Git segment retains its shared transition", (id, separator) => {
  // Git status requires a runtime branch, but branch presentation can be hidden independently.
  const cases: Array<{
    name: string;
    configure(config: StarshipConfig): void;
    overrides?: Partial<StarshipRuntimeSnapshot>;
  }> = [
    {
      name: "disabled",
      configure: (config) => {
        config.modules.git_branch.disabled = true;
      },
    },
    {
      name: "ignored",
      configure: (config) => {
        config.modules.git_branch.options.ignore_branches = ["feature"];
      },
    },
    {
      name: "detached",
      configure: (config) => {
        config.modules.git_branch.options.only_attached = true;
      },
      overrides: { gitBranchDetails: { name: "feature", detached: true } },
    },
    {
      name: "bare",
      configure: (config) => {
        config.modules.git_branch.options.ignore_bare_repo = true;
      },
      overrides: { gitBranchDetails: { name: "feature", detached: false, bare: true } },
    },
    {
      name: "missing display label",
      configure: () => {},
      overrides: { gitBranchDetails: { name: "", detached: false } },
    },
  ];
  for (const item of cases) {
    const config = configFor(getStarshipPreset(id));
    item.configure(config);
    const snapshot = runtime({ gitStatus: DIRTY_GIT, ...item.overrides });
    for (const trueColor of COLOR_MODES) {
      const rendered = renderStatusline(config, snapshot, 160, trueColor);
      const label = `${id}/${item.name}`;
      assert.deepEqual(rendered.modules.git_branch, [], label);
      const status = moduleText(rendered, "git_status");
      assert.ok(status.trim(), label);
      assert.ok(stripVTControlCharacters(rendered.ansi).includes(`${separator}${status}`), label);
    }
  }
});

test.each([
  ["pastel-powerline", ""],
  ["tokyo-night", ""],
] as const)("%s: the shared context/clock transition follows whichever value is available", (id, separator) => {
  const config = configFor(getStarshipPreset(id));
  for (const trueColor of COLOR_MODES) {
    const clockOnly = renderStatusline(config, runtime({ contextUsage: undefined }), 160, trueColor);
    const clock = moduleText(clockOnly, "time");
    assert.ok(clock.trim());
    const clockText = stripVTControlCharacters(clockOnly.ansi);
    assert.ok(clockText.includes(`${separator}${clock}`), id);
    assert.doesNotMatch(clockText, /\\bctx\\b/u);

    const noClock = structuredClone(config);
    noClock.modules.time.disabled = true;
    const contextOnly = renderStatusline(noClock, runtime(), 160, trueColor);
    const context = moduleText(contextOnly, "context");
    assert.ok(context.trim());
    assert.ok(stripVTControlCharacters(contextOnly.ansi).includes(`${separator}${context}`), id);
    assert.deepEqual(contextOnly.modules.time, []);

    const neither = renderStatusline(noClock, runtime({ contextUsage: undefined }), 160, trueColor);
    const neitherText = stripVTControlCharacters(neither.ansi);
    assert.deepEqual(neither.modules.context, []);
    assert.deepEqual(neither.modules.time, []);
    assert.equal(neitherText.split(separator).length, clockText.split(separator).length - 1, id);
  }
});
