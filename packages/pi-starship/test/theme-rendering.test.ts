import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getPackageDir, Theme, type ThemeBg, type ThemeColor, type ThemeToken } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  foregroundAnsi,
  indexedColor,
  oklchColor,
  rgbColor,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { BUILT_IN_CONFIG, normalizeConfig, validateConfigDocument } from "../src/config.js";
import { parseFormat, renderFormat } from "../src/format/formatter.js";
import { parseStyle, renderChunksToAnsi } from "../src/format/style.js";
import { isThemeRole, type ThemeColors } from "../src/format/theme-colors.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";

const schema = JSON.parse(readFileSync(join(getPackageDir(), "schemas/theme.schema.json"), "utf8"));
const roles = Object.keys(schema.properties.colors.properties) as ThemeToken[];
const backgroundRoles = {
  selectedBg: true,
  searchMatchBg: true,
  userMessageBg: true,
  customMessageBg: true,
  toolPendingBg: true,
  toolSuccessBg: true,
  toolErrorBg: true,
} satisfies Record<ThemeBg, true>;

function theme(
  overrides: Partial<Record<ThemeToken, string | number>> = {},
  appearance: "light" | "dark" = "dark",
  dim: ThemeColor[] = [],
): Theme {
  const entries = roles.map((role) => [role, overrides[role] ?? "#112233"] as const);
  return new Theme(
    Object.fromEntries(entries.filter(([role]) => !Object.hasOwn(backgroundRoles, role))) as ConstructorParameters<
      typeof Theme
    >[0],
    Object.fromEntries(entries.filter(([role]) => Object.hasOwn(backgroundRoles, role))) as ConstructorParameters<
      typeof Theme
    >[1],
    "truecolor",
    { appearance, dim },
  );
}

function render(format: string, colors?: ThemeColors, trueColor = true): string {
  return renderChunksToAnsi(renderFormat(parseFormat(format), { variables: {} }), trueColor, colors);
}

function runtime(): StarshipRuntimeSnapshot {
  return {
    cwd: "/repo",
    model: { id: "model", provider: "provider" },
    thinkingLevel: "high",
    turnCount: 1,
    activeTools: new Map(),
    isStreaming: false,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2 },
    usingSubscription: false,
    gitBranch: null,
    contextUsage: { percent: 75, tokens: 75, contextWindow: 100 },
    extensionStatuses: new Map([["test", "ready"]]),
    now: new Date(2026, 0, 1, 12, 0),
  };
}

test("theme role validation matches Pi's published schema without an active theme", () => {
  for (const role of roles) {
    assert.equal(isThemeRole(role), true, role);
    assert.deepEqual(parseStyle(`pi:${role}`), { foreground: { kind: "theme", role } });
  }
  for (const role of ["unknown", "constructor", "toString", "__proto__", "thinkinghigh", "vars"]) {
    assert.equal(isThemeRole(role), false, role);
  }
});

test.each([
  [true, indexedColor(1)],
  [false, indexedColor(255)],
  [true, rgbColor(1, 2, 3)],
  [false, rgbColor(170, 187, 204)],
  [true, oklchColor(0.62, 0.1, 200)],
  [false, oklchColor(0.62, 0.1, 200)],
] as const)("theme colors use Pi ANSI conversion: trueColor=%s color=%j", (trueColor, color) => {
  const colors = { ...theme().colors, accent: color };
  const mode = trueColor ? "truecolor" : "256color";
  assert.equal(
    render("[x](fg:pi:accent bg:pi:accent)", colors, trueColor),
    `${foregroundAnsi(color, mode)}${backgroundAnsi(color, mode)}x\x1b[0m`,
  );
});

test("roles work in either slot and do not add style attributes", () => {
  const colors = theme({ accent: "#010203", selectedBg: "#040506" }).colors;
  assert.equal(
    render("[x](fg:pi:selectedBg bg:pi:accent bold italic underline)", colors),
    "\x1b[38;2;4;5;6m\x1b[48;2;1;2;3m\x1b[1;3;4mx\x1b[0m",
  );
  assert.equal(render("[x](fg:pi:accent bg:17 bold)", colors), "\x1b[38;2;1;2;3m\x1b[48;5;17;1mx\x1b[0m");
  assert.equal(render("[x](fg:red bg:pi:accent)", colors), "\x1b[48;2;1;2;3m\x1b[31mx\x1b[0m");
});

test.each(["light", "dark"] as const)("terminal defaults use Pi's concrete fallback for %s themes", (appearance) => {
  const colors = theme({ text: "", userMessageBg: "" }, appearance).colors;
  const output = render("[x](fg:pi:userMessageBg bg:pi:text)", colors);
  assert.equal(
    output,
    `${foregroundAnsi(colors.userMessageBg, "truecolor")}${backgroundAnsi(colors.text, "truecolor")}x\x1b[0m`,
  );
  assert.equal(output.includes("\x1b[39m"), false);
  assert.equal(output.includes("\x1b[49m"), false);
});

test("faint roles use Pi's concrete approximation without adding SGR dim", () => {
  const faint = theme({ muted: "#ffffff" }, "dark", ["muted"]);
  const output = render("[x](pi:muted)", faint.colors);
  assert.equal(output, `${foregroundAnsi(faint.colors.muted, "truecolor")}x\x1b[0m`);
  assert.notDeepEqual(faint.colors.muted, rgbColor(255, 255, 255));
  assert.equal(output.includes("\x1b[2m"), false);
  assert.ok(render("[x](dimmed pi:muted)", faint.colors).includes("\x1b[2m"));
});

test("previous colors retain theme references across chunks and empty groups", () => {
  const chunks = renderFormat(parseFormat("[](fg:pi:accent bg:17)[x](fg:prev_bg bg:prev_fg)[y](fg:prev_bg)"), {
    variables: {},
  });
  const first = renderChunksToAnsi(chunks, true, theme({ accent: "#010203" }).colors);
  assert.equal(first, "\x1b[48;2;1;2;3m\x1b[38;5;17mx\x1b[0m\x1b[38;2;1;2;3my\x1b[0m");
  const second = renderChunksToAnsi(chunks, true, theme({ accent: "#040506" }).colors);
  assert.ok(second.includes("\x1b[48;2;4;5;6m"));
  assert.ok(second.includes("\x1b[38;2;4;5;6m"));
  assert.equal(render("[x](fg:pi:accent fg:prev_bg)", theme({ accent: "#010203" }).colors), "\x1b[38;2;1;2;3mx\x1b[0m");
});

test("palette collisions keep fixed keys while direct palette values follow the Pi role", () => {
  const palette = { "pi:accent": "#ff0000", primary: "pi:accent", camel: "pi:selectedBg" };
  const chunks = renderFormat(parseFormat("[fixed](pi:accent)[theme](primary)[camel](camel)"), {
    variables: {},
    palette,
  });
  assert.equal(
    renderChunksToAnsi(chunks, true, theme({ accent: "#010203", selectedBg: "#040506" }).colors),
    "\x1b[38;2;255;0;0mfixed\x1b[0m\x1b[38;2;1;2;3mtheme\x1b[0m\x1b[38;2;4;5;6mcamel\x1b[0m",
  );
  assert.ok(renderChunksToAnsi(chunks, true, theme({ accent: "#070809" }).colors).includes("\x1b[38;2;7;8;9mtheme"));
});

test("plain callers can measure and inspect theme-colored output without initializing Pi's theme", () => {
  assert.equal(render("[界](pi:accent bold)"), "\x1b[1m界\x1b[0m");
  assert.equal(visibleWidth(render("[界](pi:accent)")), 2);
  const { config } = normalizeConfig({ format: "$model", model: { style: "pi:accent" } });
  assert.ok(stripVTControlCharacters(renderStatusline(config, runtime()).ansi).includes("model"));
});

test("all style sources reach the same theme-aware statusline renderer", () => {
  const { config, diagnostics } = normalizeConfig({
    format: "[R](pi:accent)$model$thinking$context$cost$git_metrics$extension_status",
    model: { format: "[M]($style)", style_rules: [{ style: "pi:accent" }] },
    thinking: { format: "[T]($style)", style_high: "pi:accent" },
    context: { format: "[C]($style)", display: [{ threshold: 0, style: "pi:accent", hidden: false }] },
    cost: { format: "[D]($style)", display: [{ threshold: 0, style: "pi:accent", hidden: false }] },
    git_metrics: { disabled: false, format: "[G]($added_style)", added_style: "pi:accent" },
    extension_status: { format: "$statuses", styles: { test: "pi:accent" } },
  });
  assert.deepEqual(diagnostics, []);
  const snapshot = { ...runtime(), gitMetrics: { added: 1, deleted: 1 } };
  const colors = theme({ accent: "#010203" }).colors;
  const rendered = renderStatusline(config, snapshot, 80, true, colors).ansi;
  const plain = stripVTControlCharacters(rendered);
  assert.equal(plain.startsWith("RMTCDG"), true, plain);
  assert.ok(plain.includes("✓"));
  assert.ok(rendered.includes("\x1b[38;2;1;2;3mRMTCDG"));
});

test("theme-colored fill and multiline layout retain visible widths", () => {
  const { config, diagnostics } = normalizeConfig({
    format: "[界](pi:accent)$fill[end](pi:selectedBg)\n$fill",
    fill: { symbol: "·", style: "bg:pi:accent" },
  });
  assert.deepEqual(diagnostics, []);
  for (const width of [0, 1, 5, 12]) {
    const rendered = renderStatusline(config, runtime(), width, false, theme().colors).ansi;
    assert.equal(visibleWidth(rendered.split("\n")[0] ?? ""), Math.max(5, width));
    assert.equal(visibleWidth(rendered.split("\n")[1] ?? ""), width);
  }
});

test.each([true, false])(
  "theme-colored previews sanitize profile text before generated ANSI: trueColor=%s",
  (trueColor) => {
    const symbol = "safe\x1bc\x1b]52;c;Y2xpcGJvYXJk\x07tail";
    const document = [
      'format = "[root](pi:accent)$brand$fill"',
      "[brand]",
      'format = "[$symbol]($style)"',
      `symbol = ${JSON.stringify(symbol)}`,
      'style = "pi:accent"',
      "[fill]",
      'symbol = "·"',
      'style = "bg:pi:selectedBg"',
    ].join("\n");
    const loaded = validateConfigDocument("/preview.toml", document);
    const before = structuredClone(loaded);
    const colors = theme({ accent: "#010203", selectedBg: "#040506" }).colors;
    const output = renderStatusline(loaded.config, runtime(), 24, trueColor, colors).ansi;
    const mode = trueColor ? "truecolor" : "256color";
    assert.ok(output.includes(foregroundAnsi(colors.accent, mode)));
    assert.ok(output.includes(backgroundAnsi(colors.selectedBg, mode)));
    assert.equal(output.includes("\x1bc"), false);
    assert.equal(output.includes("\x1b]52"), false);
    assert.equal(output.includes("Y2xpcGJvYXJk"), false);
    assert.equal(stripVTControlCharacters(output), `rootsafetail${"·".repeat(12)}`);
    assert.equal(visibleWidth(output), 24);
    assert.deepEqual(loaded, before);
    assert.equal(loaded.rawDocument, document);
  },
);

test("fixed defaults keep identical ANSI output regardless of the supplied theme", () => {
  const plain = renderStatusline(BUILT_IN_CONFIG, runtime(), 80).ansi;
  for (const colors of [theme().colors, theme({ accent: "#abcdef" }, "light").colors]) {
    assert.equal(renderStatusline(BUILT_IN_CONFIG, runtime(), 80, true, colors).ansi, plain);
  }
});
