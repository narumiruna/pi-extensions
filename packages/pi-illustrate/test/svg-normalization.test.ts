import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { normalizeSvg, PALETTES } from "../src/svg-normalization.mjs";

const svg = (body: string, attributes = 'width="100" height="50"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
const bake = (source: string) => normalizeSvg(source, "svg", "dark").svg;

describe("static SVG normalization", () => {
  it("retains raw input and raw colors across appearance changes", () => {
    const source = svg('<rect width="100" height="50" fill="#123456"/>');
    expect(bake(source)).toBe(normalizeSvg(source, "svg", "light").svg);
    expect(source).toContain('fill="#123456"');
    expect(normalizeSvg(source, "svg").svg).toContain('viewBox="0 0 100 50"');
  });

  it("resolves scoped, inherited variables, nested fallbacks, and declaration-scope dependencies", () => {
    const source =
      svg(`<style>:root{--base:#123456;--alias:var(--base)} .paint {fill:var(--missing,var(--alias, red))} g > .local {--base:#abcdef;fill:var(--base)}</style>
      <g><rect id="inherited" class="paint"/><rect id="local" class="paint local"/>
      <g style="--base:blue"><rect id="alias" class="paint"/></g></g>`);
    const result = bake(source);
    expect(result).toContain('id="inherited" class="paint" fill="#123456"');
    expect(result).toContain('id="local" class="paint local" fill="#abcdef"');
    expect(result).toContain('id="alias" class="paint" fill="#123456"');
    expect(result).not.toContain("var(");
    expect(result).not.toContain("<style");
  });

  it("honors specificity, important, source order, inherited fill, and adjacent selectors", () => {
    const result = bake(
      svg(
        '<style>rect{fill:red} .a{fill:blue} #x{fill:green!important} .a + rect{stroke:yellow} .a{fill:purple}</style><g fill="orange"><rect id="x" class="a" style="fill:black"/><rect id="next"/><circle/></g>',
      ),
    );
    expect(result).toContain('id="x" class="a" fill="green"');
    expect(result).toContain('id="next" fill="red" stroke="yellow"');
    expect(result).toContain('<g fill="orange">');
  });

  it("rejects variable cycles, including internal fallback dependencies, and reports missing values", () => {
    expect(() => bake(svg('<g style="--a:var(--b);--b:var(--a)"><rect fill="var(--a, red)"/></g>'))).toThrow(/Cyclic/);
    expect(() => bake(svg('<g style="--a:var(--b,red);--b:var(--a,blue);fill:var(--a,green)"/>'))).toThrow(/Cyclic/);
    expect(() => bake(svg('<rect fill="var(--missing)"/>'))).toThrow(/Unresolved/);
  });

  it("rejects oversized selector specificity rather than changing the CSS cascade", () => {
    expect(() =>
      bake(svg(`<style>#x{fill:red}${".a".repeat(100)}{fill:blue}</style><rect id="x" class="a"/>`)),
    ).toThrow(/specificity/);
  });

  it("font shorthand resets inherited styles and weights", () => {
    const result = bake(
      svg(
        '<g font-weight="bold" font-style="italic" font-variant="small-caps" font-stretch="expanded"><text style="font:16px sans-serif">Normal</text></g>',
      ),
    );
    expect(result).toContain(
      '<text font-style="normal" font-weight="normal" font-variant="normal" font-stretch="normal" font-size="16px"',
    );
  });

  it("expands CSS font shorthand and variable font families to explicit resvg attributes", () => {
    const result = bake(
      svg(
        '<g style="--font:DefinitelyMissing, sans-serif;font:italic bold 16px sans-serif;font-family:var(--font)"><text x="2" y="20">Hello 中文</text></g>',
      ),
    );
    expect(result).toContain('font-size="16px"');
    expect(result).toContain('font-family="DefinitelyMissing,sans-serif"');
    expect(result).toContain('font-style="italic"');
    expect(result).toContain('font-weight="bold"');
  });

  it("keeps gradients, markers, clipping and same-document href references", () => {
    const source =
      svg(`<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
      <linearGradient id="copy" href="#g"/><marker id="m" markerWidth="3" markerHeight="3"><path d="M0 0L3 1L0 3Z"/></marker>
      <clipPath id="c"><rect width="90" height="40"/></clipPath><path id="p" d="M0 0H20"/></defs>
      <rect width="100" height="50" fill="url(#copy)" clip-path="url(#c)"/><path d="M0 10H50" marker-end="url(#m)"/><use href="#p"/>`);
    expect(bake(source)).toContain('fill="url(#copy)"');
    expect(bake(source)).toContain('href="#p"');
  });

  it.each([
    '<defs><rect id="shape" width="10" height="10" fill="var(--c,red)"/></defs><use href="#shape" style="--c:blue"/>',
    '<style>#shape{fill:var(--c,red)}</style><defs><rect id="shape" width="10" height="10"/></defs><g style="--c:blue"><use href="#shape"/></g>',
    '<defs><rect id="shape" width="10" height="10" fill="var(--c,red)"/><g id="nested"><use href="#shape"/></g></defs><use href="#nested" style="--c:blue"/>',
  ])("rejects instance-sensitive CSS variables in use graphs: %s", (body) => {
    expect(() => bake(svg(body))).toThrow(/variables with SVG use/);
  });

  it("preserves currentColor inheritance through nested static use instances", () => {
    const result = bake(
      svg(
        '<defs><rect id="shape" width="10" height="10" fill="currentColor"/><g id="nested"><use href="#shape"/></g></defs><g color="blue"><use href="#nested"/></g>',
      ),
    );
    const native = new Resvg(result, { font: { loadSystemFonts: false }, logLevel: "off" }).toString();
    expect(native).toContain('fill="#0000ff"');
    expect(native).not.toContain('fill="#000000"');
  });

  it("bakes Pele contrast inks and series palettes without losing scoped overrides", () => {
    const source = svg(
      '<g style="--pele-series-1:#abcdef"><rect fill="var(--pele-series-1)"/><text fill="var(--pele-fg-on-dark)">X</text></g><rect fill="var(--pele-series-2)"/>',
    );
    const dark = normalizeSvg(source, "mermaid", "dark").svg;
    expect(dark).toContain('fill="#abcdef"');
    expect(dark).toContain(`fill="${PALETTES.dark["--pele-series-2"]}"`);
    expect(dark).toContain('fill="#ffffff"');
    expect(normalizeSvg(source, "mermaid").svg).toContain("var(--pele-series-1)");
  });

  it("bakes sRGB color-mix and nested pixel min without native CSS fallback", () => {
    const result = bake(
      svg(
        '<rect style="--radius:4px;--ink:#000000;fill:color-mix(in srgb,var(--ink) 25%,#ffffff);rx:min(var(--radius),2px)"/>',
      ),
    );
    expect(result).toContain('fill="rgba(191,191,191,1)"');
    expect(result).toContain('rx="2px"');
  });

  it.each([
    ["viewBox", '<svg viewBox="0 0 12 8"/>', 12, 8],
    ["absolute units", '<svg width="1in" height="36pt"/>', 96, 48],
    ["single dimension", '<svg width="60" viewBox="0 0 12 8"/>', 60, 40],
  ])("derives explicit geometry: %s", (_name, source, width, height) => {
    expect(normalizeSvg(String(source), "svg")).toMatchObject({ width, height });
  });
});

describe("SVG rejects unsupported or unsafe input without repairing it", () => {
  it.each([
    ["script", svg("<script>alert(1)</script>")],
    ["event", svg('<rect onLoad="evil()"/>')],
    ["DOCTYPE", '<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg width="1" height="1"/>'],
    ["entity", '<!DOCTYPE svg [<!ENTITY x SYSTEM "https://evil">]><svg width="1" height="1">&x;</svg>'],
    ["unknown entity", svg("<text>&unknown;</text>")],
    ["foreignObject", svg("<foreignObject><div/></foreignObject>")],
    ["HTML", svg('<div xmlns="http://www.w3.org/1999/xhtml"/>')],
    ["namespace", svg('<g xmlns:evil="https://evil"/>')],
    ["attribute namespace", svg('<g xmlns:xlink="http://www.w3.org/1999/xlink" xlink:title="bad"/>')],
    ["href case", svg('<use HREF="#x"/>')],
    ["external href", svg('<use href="https://evil/x.svg#x"/>')],
    ["file href", svg('<use href="file:///etc/passwd"/>')],
    ["xlink href", svg('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://evil"/>')],
    ["base", svg('<g xml:base="file:///etc/"/>')],
    ["image", svg('<image href="data:image/png;base64,AAAA"/>')],
    ["stylesheet PI", '<?xml-stylesheet href="https://evil"?><svg width="1" height="1"/>'],
    ["CSS import", svg('<style>@import "https://evil";</style>')],
    ["CSS escaped import", svg('<style>@im\\70ort "https://evil";</style>')],
    ["CSS font-face", svg("<style>@font-face{font-family:evil;src:url(file:///etc/passwd)}</style>")],
    ["CSS external URL", svg('<rect style="fill:url(https://evil)"/>')],
    ["CSS escaped URL", svg("<rect style=\"fill:u\\72l('https://evil')\"/>")],
    ["CSS escaped URL value", svg('<rect fill="url(\\68ttps://evil)"/>')],
    ["CSS unused external variable", svg('<g style="--unused:url(file:///etc/passwd)"/>')],
    ["CSS external fallback", svg('<g style="--a:red;fill:var(--a,url(https://evil))"/>')],
    ["CSS unknown property", svg('<rect style="background:red"/>')],
    ["CSS unknown function", svg('<rect fill="light-dark(white,black)"/>')],
    ["CSS browser selector", svg("<style>rect:hover{fill:red}</style>")],
    ["CSS nested rule", svg("<style>g{rect{fill:red}}</style>")],
    ["CSS invalid color", svg('<rect fill="no-such-color"/>')],
    ["CSS unset fallback", svg('<g fill="red"><rect fill="unset"/></g>')],
    ["CSS escaped unset fallback", svg('<g fill="red"><rect fill="u\\\\6eset"/></g>')],
    ["CSS browser display", svg('<g style="display:contents"/>')],
    ["CSS mixed-case variable cycle", svg('<g style="--a:VAr(--b,red);--b:var(--a,blue);fill:var(--a,green)"/>')],
    ["CSS unsupported text transform", svg('<text style="text-transform:uppercase">a</text>')],
    ["malformed", '<svg width="1" height="1"><g></svg>'],
    ["multiple roots", '<svg width="1" height="1"/><svg/>'],
    ["missing geometry", "<svg/>"],
    ["zero width", '<svg width="0" height="1"/>'],
    ["negative", '<svg width="-1" height="1"/>'],
    ["NaN", '<svg width="NaN" height="1"/>'],
    ["nonfinite", '<svg width="1e999" height="1"/>'],
    ["huge", '<svg width="100001" height="1"/>'],
    ["zero viewBox", '<svg viewBox="0 0 0 1"/>'],
    ["huge viewBox", '<svg viewBox="0 0 1e100 1"/>'],
    ["percent geometry", '<svg width="100%" height="50%" viewBox="0 0 1 1"/>'],
    ["dangling reference", svg('<use href="#missing"/>')],
    ["CSS dangling reference", svg('<rect fill="url(#missing)"/>')],
    [
      "reference cycle",
      svg('<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>'),
    ],
    ["duplicate ID", svg('<g id="a"/><g id="a"/>')],
    ["animation", svg('<rect><animate attributeName="x"/></rect>')],
  ])("rejects %s", (_name, source) => {
    const unchanged = source;
    expect(() => normalizeSvg(source, "svg")).toThrow();
    expect(source).toBe(unchanged);
  });

  it("bounds source bytes, elements, CSS rules, depth and reference expansion", () => {
    expect(() => bake(svg(" ".repeat(4 * 1024 * 1024)))).toThrow(/4 MiB/);
    expect(() => bake(svg("<g>".repeat(130) + "</g>".repeat(130)))).toThrow(/nesting/);
    expect(() => bake(svg("<g/>".repeat(20_001)))).toThrow(/element/);
    expect(() => bake(svg(`<style>${"rect{fill:red}".repeat(1_001)}</style>`))).toThrow(/rule/);
    const defs = Array.from(
      { length: 16 },
      (_, i) => `<g id="g${i}">${i ? `<use href="#g${i - 1}"/><use href="#g${i - 1}"/>` : "<rect/>"}</g>`,
    ).join("");
    expect(() => bake(svg(`<defs>${defs}</defs><use href="#g15"/>`))).toThrow(/expansion/);
  });
});
