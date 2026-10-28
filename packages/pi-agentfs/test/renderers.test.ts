import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { stripVTControlCharacters } from "node:util";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { virtualRenderers } from "../src/renderers.js";
import { createWorkspaceTools } from "../src/tools.js";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as Theme;
function context(args: unknown): ToolRenderContext {
  return {
    args,
    toolCallId: "id",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/host/cwd",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
it.each(["read", "write", "edit", "bash"])(
  "renders %s without terminal injection, host links, or speculative file reads",
  (name) => {
    const hostRead = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Host read forbidden"));
    const hostAccess = vi.spyOn(fs, "access").mockRejectedValue(new Error("Host access forbidden"));
    syncBuiltinESMExports();
    const raw = "/notes/測試/\u001b]52;c;c2VjcmV0\u0007\u001b[2Jname\nline.txt";
    const args = { path: raw, command: `cat '${raw}'`, content: raw, edits: [{ oldText: raw, newText: raw }] };
    const tool = createWorkspaceTools(() => {
      throw new Error("Rendering must not open a workspace");
    }).find((tool) => tool.name === name);
    if (!tool?.renderCall || !tool.renderResult) throw new Error("Missing safe renderer");
    const renderContext = context(args);
    const call = tool.renderCall(args, theme, renderContext);
    for (const width of [0, 1, 8, 80, 200]) {
      for (const line of call.render(width)) {
        expect(line).not.toContain("\u001b");
        expect(line).not.toContain("file://");
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    for (const expanded of [true, false]) {
      const result = tool.renderResult(
        { content: [{ type: "text", text: raw }], details: { diff: raw } },
        { expanded, isPartial: false },
        theme,
        renderContext,
      );
      for (const width of [0, 1, 8, 80]) {
        const lines = result.render(width);
        if (width === 0) expect(lines).toEqual([]);
        expect(lines.join("\n")).toBe(stripVTControlCharacters(lines.join("\n")));
        expect(lines.join("\n")).not.toContain("file://");
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(args.path).toBe(raw);
    expect(args.content).toBe(raw);
    expect(hostRead).not.toHaveBeenCalled();
    expect(hostAccess).not.toHaveBeenCalled();
  },
);

const exactPreviews = [
  {
    label: "boundary spaces",
    text: "    alpha    beta    gamma",
    width: 10,
    rows: ["    alpha ", "   beta   ", " gamma"],
  },
  { label: "whitespace only", text: "     ", width: 2, rows: ["  ", "  ", " "] },
  { label: "trailing spaces", text: "a  ", width: 2, rows: ["a ", " "] },
  { label: "blank lines", text: "\n\n", width: 10, rows: ["", "", ""] },
  { label: "mixed lines", text: "  alpha  \n\n beta \n", width: 10, rows: ["  alpha  ", "", " beta ", ""] },
  { label: "completed diff", text: "-1   old  \n+1    new   ", width: 8, rows: ["-1   old", "  ", "+1    ne", "w   "] },
  { label: "Unicode graphemes", text: "a測b🙂c e\u0301", width: 4, rows: ["a測b", "🙂c ", "e\u0301"] },
  { label: "tabs", text: "a\t b", width: 4, rows: ["a   ", " b"] },
  { label: "terminal controls", text: "\u001b[31m  a  \u001b[0m\n   ", width: 4, rows: ["  a ", " ", "   "] },
];

for (const name of ["read", "write", "edit", "bash"]) {
  it.each(exactPreviews)(`${name} preserves exact result rows for $label`, ({ text, width, rows }) => {
    const renderer = virtualRenderers(name);
    if (!renderer.renderResult) throw new Error("Missing result renderer");
    for (const expanded of [false, true]) {
      for (const isError of [false, true]) {
        const renderContext = { ...context({}), isError };
        const result = { content: [{ type: "text" as const, text }], details: { diff: text } };
        const before = structuredClone(result);
        const component = renderer.renderResult(result, { expanded, isPartial: false }, theme, renderContext);
        expect(component.render(width)).toEqual(rows);
        expect(result).toEqual(before);
        for (const row of component.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it(`${name} preserves literal spaces in call arguments`, () => {
    const renderer = virtualRenderers(name);
    if (!renderer.renderCall) throw new Error("Missing call renderer");
    const value = "    alpha    beta    gamma  ";
    const args = { path: value, command: value };
    const component = renderer.renderCall(args, theme, context(args));
    const rows = component.render(10);
    expect(rows.join("")).toBe(`${name} ${value}`);
    expect(args.path).toBe(value);
    expect(args.command).toBe(value);
  });
}

it("keeps padding outside exact content and recomputes rows after resize and invalidation", () => {
  const renderer = virtualRenderers("read");
  if (!renderer.renderResult) throw new Error("Missing result renderer");
  const text = "    alpha    beta    gamma  ";
  const result = { content: [{ type: "text" as const, text }], details: undefined };
  const component = renderer.renderResult(result, { expanded: true, isPartial: false }, theme, {
    ...context({}),
    outputPad: 2,
  });
  for (const width of [10, 20, 10]) {
    const rows = component.render(width);
    expect(rows.map((row) => row.slice(2, -2)).join("")).toBe(text);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  }
  component.invalidate();
  expect(
    component
      .render(10)
      .map((row) => row.slice(2, -2))
      .join(""),
  ).toBe(text);
  expect(component.render(0)).toEqual([]);
  expect(component.render(1).every((row) => visibleWidth(row) <= 1)).toBe(true);
});

it("styles each wrapped row after sanitizing it and reapplies the current theme after invalidation", () => {
  const renderer = virtualRenderers("edit");
  if (!renderer.renderResult) throw new Error("Missing result renderer");
  let color = "\u001b[31m";
  const fg = vi.fn((_role: string, text: string) => `${color}${text}\u001b[0m`);
  const liveTheme = { fg: (role: string, text: string) => fg(role, text), bold: (text: string) => text } as Theme;
  const result = { content: [], details: { diff: "  abc  def  " } };
  const component = renderer.renderResult(result, { expanded: true, isPartial: false }, liveTheme, context({}));
  const first = component.render(5);
  expect(first.map(stripVTControlCharacters)).toEqual(["  abc", "  def", "  "]);
  expect(first.every((row) => row.startsWith("\u001b[31m"))).toBe(true);
  expect(fg.mock.calls.every(([role]) => role === "toolOutput")).toBe(true);
  color = "\u001b[32m";
  component.invalidate();
  const second = component.render(5);
  expect(second.map(stripVTControlCharacters)).toEqual(first.map(stripVTControlCharacters));
  expect(second.every((row) => row.startsWith("\u001b[32m"))).toBe(true);
});

it("replaces one grapheme that cannot fit without dropping the rest of the row", () => {
  const renderer = virtualRenderers("read");
  if (!renderer.renderResult) throw new Error("Missing result renderer");
  const text = "測🙂e\u0301 ";
  const result = { content: [{ type: "text" as const, text }], details: undefined };
  const component = renderer.renderResult(result, { expanded: true, isPartial: false }, theme, context({}));
  expect(component.render(1)).toEqual(["?", "?", "e\u0301", " "]);
  expect(result.content[0].text).toBe(text);
});
