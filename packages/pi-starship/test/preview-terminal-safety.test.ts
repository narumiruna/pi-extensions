import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { BUILT_IN_CONFIG, normalizeConfig, validateConfigDocument } from "../src/config.js";
import { parseFormat, renderFormat } from "../src/format/formatter.js";
import { renderChunksToAnsi, type StyledChunk } from "../src/format/style.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";
import { buildGithubPrSnapshot } from "../src/runtime/github-pr.js";

const ESC = "\u001b";
const BEL = "\u0007";
const FILL = "${" + "fill}";
const ST = `${ESC}\\`;
const LINK = `${ESC}]8;;https://github.com/o/r/pull/123${BEL}#123${ESC}]8;;${BEL}`;
const ATTACKS = [
  ["reset", `${ESC}c`],
  ["cursor", `${ESC}[2J`],
  ["clipboard", `${ESC}]52;c;Y2xpcGJvYXJk${BEL}`],
  ["title", `${ESC}]0;hostile-title${ST}`],
  ["C1 clipboard", "\u009d52;c;Y2xpcGJvYXJk\u009c"],
  ["C1 cursor", "\u009b2J"],
  ["DCS", `${ESC}Pprivate-data${ST}`],
  ["SOS", `${ESC}Xprivate-data${ST}`],
  ["PM", `${ESC}^private-data${ST}`],
  ["APC", `${ESC}_private-data${ST}`],
  ["C1 strings", "\u0090private\u009c\u0098private\u009c\u009eprivate\u009c\u009fprivate\u009c"],
  ["unterminated OSC", `${ESC}]52;c;Y2xpcGJvYXJk`],
  ["interrupted sequence", `${ESC}[${ESC}]52;c;Y2xpcGJvYXJk${BEL}`],
  ["raw styles", `${ESC}[31mred${ESC}[0m`],
  ["raw hyperlink", LINK],
  ["C0", "\u0000\u0007\b\t\u000b\f\r\u001f"],
  ["C1", "\u007f\u0080\u0085\u0091\u009c"],
] as const;

function runtime(overrides: Partial<StarshipRuntimeSnapshot> = {}): StarshipRuntimeSnapshot {
  return {
    cwd: "/work/repo",
    thinkingLevel: "off",
    turnCount: 1,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(0),
    ...overrides,
  };
}

function literal(value: string): string {
  return value.replace(/[[\]()\\$]/gu, "\\$&");
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function assertSafe(value: string, hyperlinks: readonly string[] = []): void {
  let plain = value;
  for (const link of hyperlinks) plain = plain.replaceAll(link, "link");
  const terminator = `(?:${BEL}|${ESC}\\\\)`;
  plain = plain.replace(
    new RegExp(`${ESC}\\]8;;([^${BEL}${ESC}]+)${terminator}([^${ESC}]*)${ESC}\\]8;;${terminator}`, "gu"),
    (_match, url: string, label: string) => {
      const parsed = new URL(url);
      assert.ok(parsed.protocol === "http:" || parsed.protocol === "https:");
      assert.equal(parsed.username, "");
      assert.equal(parsed.password, "");
      assert.ok(url.length <= 4_096);
      for (const character of url) {
        const code = character.codePointAt(0) ?? 0;
        assert.ok(code > 0x1f && (code < 0x7f || code > 0x9f));
      }
      return label;
    },
  );
  plain = plain.replace(new RegExp(`${ESC}\\[[0-9]+(?:;[0-9]+)*m`, "gu"), "");
  for (const character of plain) {
    const code = character.codePointAt(0) ?? 0;
    assert.ok(code === 0x0a || (code > 0x1f && (code < 0x7f || code > 0x9f)), JSON.stringify(value));
  }
}

for (const [name, attack] of ATTACKS) {
  test(`profile preview sanitizes ${name} in root/module literals, symbols, and fill`, () => {
    const formats = [
      { root: `[a${literal(attack)}b](bold red)`, module: "$symbol", symbol: "safe" },
      { root: "$brand", module: `[a${literal(attack)}b](bold red)`, symbol: "safe" },
      { root: "$brand", module: "[$symbol](bold red)", symbol: `a${attack}b` },
      { root: `L${FILL}R`, module: "$symbol", symbol: `a${attack}b`, fill: true },
      { root: `L${FILL}R`, module: `[a${literal(attack)}b](bold red)`, symbol: "safe", fill: true },
    ];
    for (const item of formats) {
      const document = [
        `format = ${tomlString(item.root)}`,
        `[${item.fill ? "fill" : "brand"}]`,
        `format = ${tomlString(item.module)}`,
        `symbol = ${tomlString(item.symbol)}`,
        'style = "bold red"',
        "# Preserve this exact document, including unknown settings.",
        'future_field = "unchanged"',
      ].join("\n");
      const loaded = validateConfigDocument("/preview.toml", document);
      const before = structuredClone(loaded);
      const snapshot = runtime();
      const snapshotBefore = structuredClone(snapshot);
      const rendered = renderStatusline(loaded.config, snapshot, 24);
      assertSafe(rendered.ansi);
      for (const chunk of rendered.chunks) assertSafe(chunk.text);
      for (const chunks of Object.values(rendered.modules)) for (const chunk of chunks) assertSafe(chunk.text);
      assert.deepEqual(loaded, before);
      assert.deepEqual(snapshot, snapshotBefore);
      assert.equal(loaded.rawDocument, document);
      assert.ok(!rendered.ansi.includes("Y2xpcGJvYXJk"));
    }
  });

  test(`profile preview sanitizes ${name} in options and transformed runtime values`, () => {
    const { config, diagnostics } = normalizeConfig({
      format:
        "$directory|$git_branch|$git_commit|$conda|$model|$provider|$activity|$extension_status|$nodejs|$git_worktree",
      directory: {
        format: "$path",
        truncation_length: 1,
        truncation_symbol: `${attack}>`,
        home_symbol: `${attack}~`,
        substitutions: { repo: `${attack}friendly` },
      },
      git_branch: {
        format: "$branch/$remote_name/$remote_branch",
        truncation_length: 2,
        truncation_symbol: `${attack}…`,
      },
      git_commit: { format: "$hash$tag", commit_hash_length: 7 },
      conda: { format: "$environment", truncation_length: 1 },
      model: {
        format: "[$model]($style)",
        truncation_length: 2,
        truncation_symbol: `${attack}…`,
        model_aliases: { raw: `${attack}friendly` },
      },
      provider: { format: "$provider", provider_aliases: { raw: `${attack}provider` } },
      activity: { format: "$text", symbol: `${attack}!` },
      extension_status: {
        format: "$statuses",
        separator: `${attack}/`,
        icons: { goal: `${attack}!` },
        styles: { goal: "bold green" },
      },
      nodejs: { format: "$version" },
      git_worktree: { format: "$name/$path" },
    });
    assert.equal(diagnostics.filter((item) => item.severity === "error").length, 0);
    const snapshot = runtime({
      cwd: `/home/user/${attack}repo/deep`,
      homeDir: "/home/user",
      gitBranch: `${attack}feature`,
      gitBranchDetails: {
        name: `${attack}feature`,
        remoteName: `${attack}origin`,
        remoteBranch: `${attack}main`,
        detached: false,
      },
      gitCommit: { hash: `${attack}0123456789`, tag: `${attack}v1`, detached: false },
      model: { provider: "raw", id: "raw" },
      activeTools: new Map([[`${attack}read`, 1]]),
      gitWorktree: { name: `${attack}linked`, path: `/work/${attack}linked` },
      workspace: { modules: { conda: { environment: `/env/${attack}work` }, nodejs: { version: `${attack}v22` } } },
      extensionStatuses: new Map([
        ["goal", `${attack}goal: ready (local)`],
        ["other", `${attack}busy`],
      ]),
    });
    const before = structuredClone({ config, snapshot });
    const rendered = renderStatusline(config, snapshot, 400);
    assertSafe(rendered.ansi);
    assert.ok(!rendered.ansi.includes("Y2xpcGJvYXJk"));
    assert.deepEqual({ config, snapshot }, before);
  });
}

test("all remaining runtime display branches strip controls before formatting", () => {
  const { config } = normalizeConfig({
    format: "$activity|$thinking|$git_state|$github_pr|$extension_status|$model|$provider",
    activity: { format: "$state/$tool/$kind/$title/$text" },
    thinking: { format: "$level" },
    git_state: { format: "$state" },
    github_pr: { format: "$number/$link/$state/$checks/$review/$status" },
    extension_status: { format: "$statuses" },
    model: { format: "$model", shorten_model: true, truncation_length: 3 },
    provider: { format: "$provider" },
  });
  for (const [, attack] of ATTACKS) {
    const base = runtime({
      model: { id: `${attack}claude-friendly-latest`, provider: `${attack}custom` },
      thinkingLevel: `${attack}high`,
      gitState: { state: `${attack}MERGING` },
      githubPr: { number: `${attack}123`, link: attack, state: "open", checks: attack, review: attack, status: attack },
      extensionStatuses: new Map([["other", `${attack}busy`]]),
    });
    const variants = [
      { ...base, uiPrompt: { kind: "select" as const, title: `${attack}Choose` } },
      { ...base, activeTools: new Map([[`${attack}read`, 1]]) },
      { ...base, isStreaming: true },
      { ...base, lastCompletedTool: `${attack}read` },
      base,
    ];
    for (const snapshot of variants) {
      const before = structuredClone(snapshot);
      const rendered = renderStatusline(config, snapshot);
      assertSafe(rendered.ansi);
      assert.deepEqual(snapshot, before);
    }
  }
});

test("sanitization precedes path/grapheme truncation and fill width measurement", () => {
  const { config } = normalizeConfig({
    format: `$git_branch|$git_commit|$conda|$directory${FILL}R`,
    git_branch: { format: "$branch", truncation_length: 2, truncation_symbol: `${ESC}]52;c;secret${BEL}…` },
    git_commit: { format: "$hash", commit_hash_length: 4 },
    conda: { format: "$environment", truncation_length: 1 },
    directory: { format: "$path", truncation_length: 1, substitutions: { repo: `${ESC}]0;fake/path${BEL}safe` } },
    fill: { symbol: `${ESC}c·`, style: "bold blue" },
  });
  const snapshot = runtime({
    cwd: "/work/repo",
    gitBranch: `${ESC}]0;fake/branch${BEL}feature`,
    gitCommit: { hash: `${ESC}[31m0123456789`, detached: false },
    workspace: { modules: { conda: { environment: `/env/${ESC}]0;fake/path${BEL}work` } } },
  });
  const rendered = renderStatusline(config, snapshot, 28);
  assert.equal(stripVTControlCharacters(rendered.ansi), `fe…|0123|work|safe${"·".repeat(9)}R`);
  assert.equal(visibleWidth(rendered.ansi), 28);
  assert.ok(rendered.ansi.includes(`${ESC}[34;1m`));
  assertSafe(rendered.ansi);
});

test("plain strings, chunk values, fill patterns, and final ANSI rendering all reject raw controls", () => {
  const hostile = `${ESC}]52;c;secret${BEL}${ESC}c${LINK}`;
  const chunk: StyledChunk = { text: hostile, style: { bold: true } };
  const variables = { raw: hostile, chunks: [chunk], fill: [{ type: "fill" as const, pattern: [chunk] }] };
  const before = structuredClone(variables);
  const chunks = renderFormat(parseFormat("[$raw$chunks$fill](red)"), { variables });
  for (const item of chunks) {
    for (const part of "type" in item ? item.pattern : [item]) assertSafe(part.text);
  }
  assertSafe(renderChunksToAnsi(chunks));
  assertSafe(renderChunksToAnsi([chunk]));
  assert.deepEqual(variables, before);
});

test("generated GitHub links, supported config links, nested styles, and newlines survive", () => {
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, hyperlinks: true });
  try {
    const githubPr = buildGithubPrSnapshot({
      number: 123,
      isDraft: false,
      url: "https://github.com/o/r/pull/123",
      state: "OPEN",
      statusCheckRollup: [],
    });
    assert.ok(githubPr);
    assert.equal(githubPr.link, LINK);
    const { config } = normalizeConfig({
      format: `[$github_pr](red)${FILL}R\n[$brand](green)${FILL}Z`,
      github_pr: { format: "[($link)](bold blue)" },
      brand: { format: "$symbol", symbol: LINK },
      fill: { symbol: "·", style: "purple" },
    });
    const rendered = renderStatusline(config, runtime({ githubPr }), 12);
    assertSafe(rendered.ansi, [LINK]);
    assert.equal(rendered.ansi.split(LINK).length - 1, 2);
    assert.ok(rendered.ansi.includes(`${ESC}[34;1m${LINK}`));
    assert.equal(stripVTControlCharacters(rendered.ansi), "#123·······R\n#123·······Z");
    assert.deepEqual(rendered.ansi.split("\n").map(visibleWidth), [12, 12]);
    assert.equal(rendered.modules.github_pr[0]?.text, LINK);
    const narrow = renderStatusline(config, runtime({ githubPr }), 0);
    assertSafe(narrow.ansi, [LINK]);
  } finally {
    setCapabilities(capabilities);
  }
});

test("unsafe URLs and incomplete link envelopes cannot produce OSC 8", () => {
  const { config } = normalizeConfig({ format: "$github_pr", github_pr: { format: "$link" } });
  const unsafeLinks = [
    `${ESC}]8;;javascript:alert(1)${BEL}#123${ESC}]8;;${BEL}`,
    `${ESC}]8;;https://user:password@example.test${BEL}#123${ESC}]8;;${BEL}`,
    `${ESC}]8;;https://example.test/${ESC}c${BEL}#123${ESC}]8;;${BEL}`,
    `${ESC}]8;;https://example.test/${"x".repeat(4_096)}${BEL}#123${ESC}]8;;${BEL}`,
    `${ESC}]8;;https://example.test${BEL}#123`,
  ];
  for (const link of unsafeLinks) {
    const rendered = renderStatusline(
      config,
      runtime({ githubPr: { number: "123", link, state: "open", checks: "", review: "", status: "" } }),
    );
    assertSafe(rendered.ansi);
    assert.ok(!rendered.ansi.includes(`${ESC}]8;`));
  }
});

test("safe BEL/ST hyperlink envelopes are reconstructed with sanitized labels", () => {
  for (const terminator of [BEL, ST]) {
    for (const [, attack] of ATTACKS) {
      const raw = `${ESC}]8;;https://example.test/pr/1${terminator}#1${attack}${ESC}]8;;${terminator}`;
      const rendered = renderChunksToAnsi(renderFormat(parseFormat("[$link](blue)"), { variables: { link: raw } }));
      assertSafe(rendered);
      assert.ok(!rendered.includes("Y2xpcGJvYXJk"));
    }
    const raw = `${ESC}]8;;https://example.test/pr/1${terminator}#1${ESC}]8;;${terminator}`;
    assert.equal(renderChunksToAnsi([{ text: raw }]), raw);
  }
});

test("raw alias/status identities and style selectors remain unchanged", () => {
  const id = `raw${ESC}c`;
  const provider = `provider${ESC}c`;
  const key = `status${ESC}c`;
  const { config } = normalizeConfig({
    format: "$model|$provider|$extension_status",
    model: {
      format: "[$model]($style)",
      model_aliases: { [id]: `${ESC}cfriendly` },
      style_rules: [{ model: id, provider, style: "blue" }],
    },
    provider: { format: "$provider", provider_aliases: { [provider]: "alias" } },
    extension_status: { icons: { [key]: "!" }, styles: { [key]: "green" } },
  });
  const rendered = renderStatusline(
    config,
    runtime({ model: { id, provider }, extensionStatuses: new Map([[key, "busy"]]) }),
  );
  assert.equal(stripVTControlCharacters(rendered.ansi), "friendly|alias|! busy");
  assert.ok(rendered.ansi.includes(`${ESC}[34mfriendly`));
  assert.ok(rendered.ansi.includes(`${ESC}[32m! busy`));
  assertSafe(rendered.ansi);
});

test("format and symbol line feeds are preserved without retaining tabs or carriage returns", () => {
  const config = structuredClone(BUILT_IN_CONFIG);
  config.format = "first\n[$brand](red)\nlast";
  config.formatAst = parseFormat(config.format);
  config.modules.brand.symbol = "second\nthird\tend\r\nfourth";
  config.modules.brand.formatAst = parseFormat("$symbol");
  const rendered = renderStatusline(config, runtime());
  assert.equal(stripVTControlCharacters(rendered.ansi), "first\nsecond\nthird end\nfourth\nlast");
  assertSafe(rendered.ansi);
});
