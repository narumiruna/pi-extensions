import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { FormatSyntaxError, formatVariables, parseFormat, renderFormat } from "../src/format/formatter.js";
import { isValidStyle, renderChunksToAnsi } from "../src/format/style.js";

function stripAnsi(value: string): string {
  const escapeSequence = String.fromCharCode(27);
  return value.replace(new RegExp(`${escapeSequence}\\[[0-9;]*m`, "gu"), "");
}

function render(
  format: string,
  variables: Record<string, string> = {},
  styleVariables: Record<string, string> = {},
  palette: Record<string, string> = {},
) {
  return renderChunksToAnsi(
    renderFormat(parseFormat(format), {
      variables,
      styleVariables,
      palette,
    }),
  );
}

test("formatter parses variables, scoped variables, literals, and escapes", () => {
  const ast = parseFormat(`left $model \${env:PWD} \\\\ \\[\\]\\(\\)\\$`);
  assert.deepEqual([...formatVariables(ast)].sort(), ["env:PWD", "model"]);
  assert.equal(
    renderChunksToAnsi(
      renderFormat(ast, {
        variables: { model: "opus", "env:PWD": "/repo" },
      }),
    ),
    "left opus /repo \\ []()$",
  );
});

test("formatter supports nested text groups and style variables", () => {
  const output = render("outer [middle [inner](blue)]($style)", {}, { style: "red bold" });
  assert.match(output, /outer /);
  assert.ok(output.includes("\u001b[31;1mmiddle "));
  assert.ok(output.includes("\u001b[34minner"));
  assert.equal(stripAnsi(output), "outer middle inner");
});

test("module-owned styles take precedence over outer text-group styles", () => {
  const ast = parseFormat("[$model](red)");
  const output = renderChunksToAnsi(
    renderFormat(ast, {
      variables: {
        model: [{ text: "styled", style: { foreground: { kind: "named", name: "green" } } }],
      },
    }),
  );
  assert.ok(output.includes("\u001b[32mstyled"));
  assert.ok(!output.includes("\u001b[31mstyled"));
});

test("conditional groups render only when at least one nested variable is non-empty", () => {
  assert.equal(render("before (@$value) after", { value: "x" }), "before @x after");
  assert.equal(render("before (@$value) after", { value: "" }), "before  after");
  assert.equal(render("($one ($two))", { one: "", two: "yes" }), " yes");
});

test("formatter leaves unknown variables empty and reports referenced names", () => {
  const ast = parseFormat("$known$unknown$toString");
  assert.deepEqual([...formatVariables(ast)], ["known", "unknown", "toString"]);
  assert.equal(renderChunksToAnsi(renderFormat(ast, { variables: { known: "ok" } })), "ok");
});

test("formatter rejects unescaped functional characters and incomplete variables", () => {
  for (const format of ["[", "$ ", "text (", "[text]red", "${broken"]) {
    assert.throws(() => parseFormat(format), FormatSyntaxError, format);
  }
});

test("styles support named, ANSI, RGB, modifiers, none, and palettes", () => {
  const output = render(
    "[a](bold fg:accent bg:17)[b](#010203 underline)[c](none)",
    {},
    {},
    { accent: "bright-purple" },
  );
  assert.ok(output.includes("\u001b[95;48;5;17;1ma"));
  assert.ok(output.includes("\u001b[38;2;1;2;3;4mb"));
  assert.ok(output.endsWith("c"));
  assert.ok(render("[x](bold fg:red bg:none)").includes("\u001b[31;1mx"));
});

test("RGB styles fall back to ANSI-256 when true color is disabled", () => {
  const output = renderChunksToAnsi(
    renderFormat(parseFormat("[status](fg:#010203 bg:#a3aed2 bold)"), { variables: {} }),
    false,
  );

  assert.equal(output.includes("38;2"), false);
  assert.equal(output.includes("48;2"), false);
  assert.ok(output.includes("\u001b[38;5;16;48;5;146;1mstatus"));
  assert.equal(stripAnsi(output), "status");
});

test("none and fg:none override the complete style expression", () => {
  for (const style of [
    "none fg:red bg:green bold",
    "fg:red none bg:green bold",
    "fg:red bg:green bold none",
    "fg:none bg:black bold",
    "bg:black bold fg:none",
    "not-a-color none",
  ]) {
    assert.equal(render(`[x](${style})`), "x", style);
    assert.equal(isValidStyle(style), true, style);
  }
});

test("background resets and color ordering match Starship", () => {
  assert.ok(render("[x](fg:red bg:green bold bg:none)").includes("\u001b[31;1mx"));
  assert.ok(render("[x](fg:red bg:green bg:not-a-color)").includes("\u001b[31mx"));
  assert.ok(render("[x](bg:bold fg:red)").includes("\u001b[31;1mx"));
  const ordered = render("[x](bg:120 bg:125 bg:127 fg:127 122 125)");
  assert.ok(ordered.includes("\u001b[38;5;125;48;5;127mx"));
  assert.equal(render("[x](fg:not-a-color)"), "x");
});

test("prev_fg and prev_bg override absolute fallbacks only when a previous style exists", () => {
  const output = render("[a](fg:#112233 bg:17)[b](bold fg:black fg:prev_bg bg:green bg:prev_fg underline)");
  assert.ok(output.includes("\u001b[38;2;17;34;51;48;5;17ma"));
  assert.ok(output.includes("\u001b[38;5;17;48;2;17;34;51;1;4mb"));

  const fallback = render("[b](bold fg:black fg:prev_bg bg:green bg:prev_fg underline)");
  assert.ok(fallback.includes("\u001b[30;42;1;4mb"));
});

test("empty styled groups propagate previous colors", () => {
  const output = render("[](bg:#9a348e)[x](bg:prev_bg)");
  assert.ok(output.includes("\u001b[48;2;154;52;142mx"));
});

test("selected palettes override named colors without recursive aliases", () => {
  const selected = { blue: "17", accent: "#010203", recursive: "accent" };
  assert.ok(render("[a](blue)[b](accent)", {}, {}, selected).includes("\u001b[38;5;17ma"));
  assert.ok(render("[a](blue)[b](accent)", {}, {}, selected).includes("\u001b[38;2;1;2;3mb"));
  assert.equal(render("[x](recursive)", {}, {}, selected), "x");
});

test("formatter preserves OSC-8 hyperlinks and visible width", () => {
  const link = "\x1b]8;;https://example.test/pr/1\x07#1\x1b]8;;\x07";
  const output = renderChunksToAnsi(renderFormat(parseFormat("[$pr](blue)"), { variables: { pr: link } }));
  assert.ok(output.includes(link));
  assert.equal(visibleWidth(output), 2);
});
