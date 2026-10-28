import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { test } from "vitest";
import {
  BUILT_IN_CONFIG,
  CONFIG_FILE_NAME,
  loadStarshipConfig,
  normalizeConfig,
  validateConfigDocument,
} from "../src/config.js";

function settingsWithStyle(style: string) {
  return {
    format: `[root](${style})$model`,
    model: {
      format: `[model](${style})[$model]($style)`,
      style,
      style_rules: [{ provider: "openai", style }, { style: "blue" }],
    },
    thinking: { style, style_high: style },
    git_metrics: { added_style: style, deleted_style: "green" },
    context: {
      display: [
        { threshold: 0, style, hidden: true },
        { threshold: 80, style: "red", hidden: false },
      ],
    },
    cost: { display: [{ threshold: 0, style, hidden: false }] },
    extension_status: { style, styles: { themed: style, fixed: "yellow" } },
  };
}

const validStyles = [
  "pi:accent",
  "fg:pi:selectedBg bg:pi:accent bold",
  "fg:pi:toolSuccessBg bg:pi:thinkingHigh italic",
  "fg:pi:muted bg:pi:customMessageBg",
  "fg:pi:text bg:pi:dim",
  "BOLD FG:BRIGHT-BLUE BG:#AABBCC",
  "fg:255 bg:0",
  "red bg:not-a-color",
  "pi:unknown none bg:pi:unknown",
  "fg:none fg:pi:unknown bg:pi:selectedbg",
];

test.each(validStyles)("all settings style fields accept %s", (style) => {
  const settings = settingsWithStyle(style);
  const { config, diagnostics } = normalizeConfig(settings);
  assert.deepEqual(diagnostics, []);
  assert.equal(config.format, settings.format);
  assert.equal(config.modules.model.format, settings.model.format);
  assert.equal(config.modules.model.style, style);
  assert.equal(config.modules.thinking.style, style);
  assert.equal(config.modules.thinking.styles.style_high, style);
  assert.equal(config.modules.git_metrics.styles.added_style, style);
  assert.equal(config.modules.git_metrics.styles.deleted_style, "green");
  assert.deepEqual(config.modules.model.styleRules, [
    { selectors: { provider: "openai" }, style },
    { selectors: {}, style: "blue" },
  ]);
  assert.deepEqual(config.modules.context.display, settings.context.display);
  assert.deepEqual(config.modules.cost.display, settings.cost.display);
  assert.equal(config.modules.extension_status.style, style);
  assert.deepEqual(config.extensionStatus.styles, settings.extension_status.styles);
});

const invalidStyles = [
  "pi:unknown",
  "fg:pi:unknown",
  "red bg:pi:unknown",
  "pi:",
  "bg:pi:",
  "fg:pi:selectedbg",
  "bg:pi:SelectedBg",
  "pi:Accent",
];

test.each(invalidStyles)("invalid reference %s uses each field's diagnostic and fallback", (style) => {
  const settings = settingsWithStyle(style);
  const { config, diagnostics } = normalizeConfig(settings);
  assert.equal(config.format, settings.format);
  assert.equal(config.modules.model.format, settings.model.format);
  assert.equal(config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
  assert.equal(config.modules.thinking.style, BUILT_IN_CONFIG.modules.thinking.style);
  assert.equal(config.modules.thinking.styles.style_high, BUILT_IN_CONFIG.modules.thinking.styles.style_high);
  assert.equal(config.modules.git_metrics.styles.added_style, BUILT_IN_CONFIG.modules.git_metrics.styles.added_style);
  assert.equal(config.modules.git_metrics.styles.deleted_style, "green");
  assert.deepEqual(config.modules.model.styleRules, [{ selectors: {}, style: "blue" }]);
  assert.deepEqual(config.modules.context.display, [{ threshold: 80, style: "red", hidden: false }]);
  assert.deepEqual(config.modules.cost.display, BUILT_IN_CONFIG.modules.cost.display);
  assert.equal(config.modules.extension_status.style, BUILT_IN_CONFIG.modules.extension_status.style);
  assert.deepEqual(config.extensionStatus.styles, { fixed: "yellow" });

  const invalidModuleMessage = `Invalid style ${JSON.stringify(style)}; using the module default`;
  const invalidLiteralMessage = `Invalid literal style ${JSON.stringify(style)}; rendered unstyled`;
  const expected = {
    format: invalidLiteralMessage,
    "model.format": invalidLiteralMessage,
    "model.style": invalidModuleMessage,
    "thinking.style": invalidModuleMessage,
    "thinking.style_high": invalidModuleMessage,
    "git_metrics.added_style": invalidModuleMessage,
    "model.style_rules.0.style": "Expected a valid Starship style string; rule ignored",
    "context.display.0.style": "Expected a valid Starship style string",
    "cost.display.0.style": "Expected a valid Starship style string",
    "cost.display": "Expected at least one valid entry; using defaults",
    "extension_status.style": invalidModuleMessage,
    "extension_status.styles.themed": "Expected a valid Starship style string; ignored",
  };
  assert.equal(diagnostics.length, Object.keys(expected).length);
  assert.ok(diagnostics.every((item) => item.severity === "warning"));
  assert.deepEqual(Object.fromEntries(diagnostics.map((item) => [item.path, item.message])), expected);
});

test("nested literal styles validate Pi references without replacing formats", () => {
  const format = "[outer [inner](bg:pi:unknown)](fg:pi:accent)";
  const { config, diagnostics } = normalizeConfig({ format, model: { format } });
  assert.equal(config.format, format);
  assert.equal(config.modules.model.format, format);
  assert.deepEqual(diagnostics, [
    { severity: "warning", path: "format", message: 'Invalid literal style "bg:pi:unknown"; rendered unstyled' },
    { severity: "warning", path: "model.format", message: 'Invalid literal style "bg:pi:unknown"; rendered unstyled' },
  ]);
});

test.each(["fg:PRIMARY bg:SECONDARY", "fg:fixed bg:indexed", "fg:pi:accent bg:hex", "fg:pi:unknown bg:pi:selectedbg"])(
  "active palettes accept theme and legacy values for %s",
  (style) => {
    const palette = {
      primary: "pi:selectedBg",
      secondary: "pi:thinkingHigh",
      fixed: "BRIGHT-BLUE",
      indexed: "245",
      hex: "#ABCDEF",
      "pi:accent": "#123456",
      "pi:unknown": "RED",
      "pi:selectedbg": "#654321",
    };
    const settings = settingsWithStyle(style);
    const { config, diagnostics } = normalizeConfig({ ...settings, palette: "mine", palettes: { mine: palette } });
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(config.palettes.mine, palette);
    assert.equal(config.modules.model.style, style);
    assert.deepEqual(config.modules.model.styleRules, [
      { selectors: { provider: "openai" }, style },
      { selectors: {}, style: "blue" },
    ]);
    assert.deepEqual(config.modules.context.display, settings.context.display);
    assert.deepEqual(config.extensionStatus.styles, settings.extension_status.styles);
  },
);

test("palette values are direct colors, not aliases, even when a key resembles a Pi reference", () => {
  const { config, diagnostics } = normalizeConfig({
    palette: "mine",
    palettes: {
      mine: {
        "pi:accent": "#123456",
        "pi:unknown": "red",
        primary: "pi:accent",
        camel: "pi:selectedBg",
        recursive: "primary",
        shadowed: "pi:unknown",
        missing: "pi:",
        wrongCase: "pi:selectedbg",
      },
    },
    model: { style: "fg:primary bg:camel" },
  });
  assert.deepEqual(config.palettes.mine, {
    "pi:accent": "#123456",
    "pi:unknown": "red",
    primary: "pi:accent",
    camel: "pi:selectedBg",
  });
  assert.equal(config.modules.model.style, "fg:primary bg:camel");
  assert.deepEqual(
    diagnostics.map((item) => item.path),
    ["palettes.mine.recursive", "palettes.mine.shadowed", "palettes.mine.missing", "palettes.mine.wrongCase"],
  );
  assert.ok(diagnostics.every((item) => item.severity === "warning" && /Palette colors/u.test(item.message)));
});

test("theme palette keys keep legacy lookup and still require an explicitly selected palette", () => {
  const palettes = { mine: { primary: "pi:selectedBg", MixedCase: "pi:accent", "pi:unknown": "green" } };
  const selected = normalizeConfig({ palette: "mine", palettes, model: { style: "PRIMARY" } });
  assert.deepEqual(selected.diagnostics, []);
  assert.equal(selected.config.modules.model.style, "PRIMARY");
  assert.deepEqual(selected.config.palettes, palettes);

  for (const settings of [
    { palette: "mine", palettes, model: { style: "MixedCase" } },
    { palettes, model: { style: "primary" } },
    { palettes, model: { style: "pi:unknown" } },
  ]) {
    const { config, diagnostics } = normalizeConfig(settings);
    assert.equal(config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
    assert.deepEqual(
      diagnostics.map((item) => item.path),
      ["model.style"],
    );
  }
});

test("theme validation preserves settings bytes and unknown fields in loaded and draft documents", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-theme-config-"));
  const path = join(root, CONFIG_FILE_NAME);
  const raw = `# Preserve comments, spacing, and unknown settings.\r
format = '[root](fg:pi:selectedBg)'\r
palette = 'mine'\r
future = { enabled = true, value = 'keep' }\r
\r
[palettes.mine]\r
primary = 'pi:thinkingHigh'\r
invalid = 'pi:selectedbg'\r
\r
[model]\r
style = 'bg:pi:unknown'\r
future_style = 'do not remove'\r
`;
  try {
    writeFileSync(path, raw);
    const originalBytes = readFileSync(path);
    const loaded = loadStarshipConfig(path);
    assert.equal(loaded.source, "user");
    assert.equal(loaded.rawDocument, raw);
    assert.deepEqual(loaded.config.palettes.mine, { primary: "pi:thinkingHigh" });
    assert.equal(loaded.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
    assert.deepEqual(loaded.diagnostics.map((item) => item.path).sort(), [
      "future",
      "model.future_style",
      "model.style",
      "palettes.mine.invalid",
    ]);
    assert.deepEqual(readFileSync(path), originalBytes);

    const draft = raw.replace("bg:pi:unknown", "fg:primary bg:pi:accent");
    const validated = validateConfigDocument(path, draft);
    assert.equal(validated.rawDocument, draft);
    assert.equal(validated.config.modules.model.style, "fg:primary bg:pi:accent");
    const parsedDraft = parse(validated.rawDocument);
    assert.deepEqual({ ...(parsedDraft.future as Record<string, unknown>) }, { enabled: true, value: "keep" });
    assert.equal((parsedDraft.model as Record<string, unknown>).future_style, "do not remove");
    assert.deepEqual(readFileSync(path), originalBytes);
    assert.deepEqual(readdirSync(root), [CONFIG_FILE_NAME]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
