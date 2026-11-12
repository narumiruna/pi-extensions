import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { LIMITS, Rasterizer, rasterWidth, renderError } from "../src/rasterizer.js";
import { normalizeSvg, PALETTES } from "../src/svg-normalization.mjs";

const services: Rasterizer[] = [];
function service() {
  const renderer = new Rasterizer();
  services.push(renderer);
  return renderer;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((renderer) => renderer.dispose()));
});

function pngHeader(png: string) {
  const bytes = Buffer.from(png, "base64");
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.byteLength).toBeLessThanOrEqual(LIMITS.pngBytes);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

it.each([
  ["flowchart with CJK", "flowchart LR\n A[你好] --> B[World]"],
  ["sequence", "sequenceDiagram\n Alice->>Bob: Hello"],
  ["class", "classDiagram\n A <|-- B"],
  ["state", "stateDiagram-v2\n [*] --> Ready"],
  ["ER", "erDiagram\n CUSTOMER ||--o{ ORDER : places"],
])("renders a real local Pele %s through native ESM and resvg", async (_name, source) => {
  const renderer = service();
  const layout = await renderer.layout("mermaid", source);
  expect(layout.svg).toContain("var(--_fg)");
  const geometry = { width: layout.width, height: layout.height };
  const dark = await renderer.raster(layout, "dark", 240);
  const light = await renderer.raster(layout, "light", 120);
  expect(pngHeader(dark.png)).toEqual({ width: dark.width, height: dark.height });
  expect(pngHeader(light.png)).toEqual({ width: light.width, height: light.height });
  expect(dark.width).toBe(240);
  expect(light.width).toBe(120);
  expect(Math.abs(dark.height - (240 * layout.height) / layout.width)).toBeLessThanOrEqual(1);
  expect({ width: layout.width, height: layout.height }).toEqual(geometry);
  expect(renderer.active).toBe(0);
});

it("retains raw SVG colors and styled same-document gradients/markers across appearance", async () => {
  const renderer = service();
  const source =
    '<svg width="100" height="50"><style>:root{--a:#123456} .paint{fill:var(--a)}</style><defs><linearGradient id="gradient"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><marker id="arrow" markerWidth="3" markerHeight="3"><path d="M0 0L3 1L0 3Z"/></marker></defs><rect class="paint" width="100" height="50"/><path d="M5 20H90" stroke="url(#gradient)" marker-end="url(#arrow)"/></svg>';
  const layout = await renderer.layout("svg", source);
  const dark = await renderer.raster(layout, "dark", 200);
  const light = await renderer.raster(layout, "light", 200);
  expect(dark).toEqual(light);
  expect(pngHeader(dark.png)).toEqual({ width: 200, height: 100 });
  expect(source).toContain("var(--a)");
});

it("uses both series palettes and contrasting text on explicit dark and light Pele fills", async () => {
  const renderer = service();
  const layout = await renderer.layout(
    "mermaid",
    "flowchart LR\n A[Dark] --> B[Light]\n style A fill:#000\n style B fill:#fff",
  );
  const baked = normalizeSvg(layout.svg, "mermaid", "dark").svg;
  expect(baked).toContain('fill="#000"');
  expect(baked).toContain('fill="#fff"');
  expect(baked).toContain('fill="#ffffff"');
  expect(baked).toContain('fill="#1f1f1f"');
  const pie = await renderer.layout("mermaid", 'pie\n "First":2\n "Second":3');
  const dark = normalizeSvg(pie.svg, "mermaid", "dark").svg;
  expect(dark).toContain(PALETTES.dark["--pele-series-1"]);
  expect(dark).toContain(PALETTES.dark["--pele-series-2"]);
  const first = await renderer.raster(pie, "dark", 240);
  const second = await renderer.raster(pie, "light", 240);
  expect(first.png).not.toBe(second.png);
  expect(pngHeader(first.png)).toEqual(pngHeader(second.png));
});

it("uses the native default system-font fallback for an unavailable declared font", async () => {
  const renderer = service();
  const layout = await renderer.layout(
    "svg",
    '<svg width="220" height="40"><text x="2" y="28" style="font:20px SurelyNotAnInstalledFont,sans-serif">Fallback Hello 中文</text></svg>',
  );
  const image = await renderer.raster(layout, "light", 220);
  expect(pngHeader(image.png)).toEqual({ width: 220, height: 40 });
  // Glyph coverage is host-dependent. This proves the fallback path completes, not CJK font availability.
  expect(Buffer.from(image.png, "base64").length).toBeGreaterThan(100);
});

it("disables author-supplied Mermaid hyperlinks and keeps source direction stable", async () => {
  const renderer = service();
  const source = 'flowchart LR\n A[Start] --> B[End]\n click A "https://example.invalid"';
  const layout = await renderer.layout("mermaid", source);
  expect(layout.svg).not.toContain("https://");
  expect(layout.svg).not.toContain("<a ");
  expect(layout.width).toBeGreaterThan(layout.height);
  const snapshot = layout.svg;
  await renderer.raster(layout, "dark", 80);
  expect(layout.svg).toBe(snapshot);
});

it("rejects malformed and invalid Mermaid, source, edge, layout, and pixel budgets observably", async () => {
  const renderer = service();
  await expect(renderer.layout("svg", "")).rejects.toThrow(/source/);
  await expect(renderer.layout("svg", " ".repeat(LIMITS.sourceChars + 1))).rejects.toThrow(/source/);
  await expect(renderer.layout("mermaid", "not a diagram")).rejects.toThrow();
  await expect(renderer.layout("svg", '<svg width="1" height="1"><g></svg>')).rejects.toThrow(/Malformed/);
  const edges = Array.from({ length: LIMITS.maxEdges + 1 }, (_, index) => `a${index}-->a${index + 1}`).join("\n");
  await expect(renderer.layout("mermaid", `flowchart LR\n${edges}`)).rejects.toThrow(/edge|limit/i);
  const layout = await renderer.layout(
    "svg",
    '<svg width="100" height="50"><rect width="100" height="50" fill="red"/></svg>',
  );
  await expect(renderer.raster(layout, "dark", 10_000)).rejects.toThrow(/pixel/);
  await expect(renderer.raster(layout, "dark", Number.NaN)).rejects.toThrow();
  await expect(renderer.raster({ ...layout, svg: " ".repeat(LIMITS.svgBytes + 1) }, "dark", 10)).rejects.toThrow(
    /4 MiB/,
  );
  await expect(renderer.raster({ ...layout, width: 101 }, "dark", 10)).rejects.toThrow(/geometry/);
});

it("caps target width by aspect ratio, axis, and area budgets without stretching", () => {
  expect(rasterWidth({ width: 100, height: 100 }, 10_000)).toBe(2828);
  expect(rasterWidth({ width: 100, height: 1 }, 10_000)).toBe(8192);
  expect(rasterWidth({ width: 1, height: 100 }, 10_000)).toBe(81);
  expect(rasterWidth({ width: 100, height: 50 }, 200)).toBe(200);
  expect(() => rasterWidth({ width: 0, height: 1 }, 20)).toThrow();
  expect(() => rasterWidth({ width: 1, height: 100_000 }, 10)).toThrow();
});

it("cleans up a real native worker on immediate cancellation and idempotent disposal", async () => {
  const renderer = service();
  const signal = new AbortController();
  const task = renderer.layout("mermaid", "flowchart LR\n A-->B", signal.signal);
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  signal.abort();
  await rejected;
  expect(renderer.active).toBe(0);
  const disposal = renderer.dispose();
  expect(renderer.dispose()).toBe(disposal);
  await disposal;
  await expect(renderer.layout("svg", '<svg width="1" height="1"/>')).rejects.toThrow(/disposed/);
});

it("bounds and strips terminal controls from source-derived errors", () => {
  const error = renderError(new Error(`\u001b[31mRED\u001b[0m\u0007\u009f${"x".repeat(1000)}`));
  expect(error.message).toHaveLength(400);
  expect(error.message).toMatch(/^RED {2}x/);
  expect(error.message).not.toContain("\u001b");
});

it("proves source TS → Pi Jiti → native .mjs worker with English and CJK labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "illustrate-jiti-worker-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const entry = join(root, "probe.ts");
    const module = pathToFileURL(resolve("packages/pi-illustrate/src/rasterizer.ts")).href;
    await writeFile(
      entry,
      `import {Rasterizer} from ${JSON.stringify(module)}; export default function(pi){ pi.registerCommand('raster-probe',{handler:async()=>{const renderer=new Rasterizer();try { const layout=await renderer.layout('mermaid','flowchart LR\\n A[Hello] --> B[你好]'); return await renderer.raster(layout,'dark',240); }finally {await renderer.dispose();}}});}`,
    );
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [entry],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const command = loaded.extensions[0]?.commands.get("raster-probe");
    expect(command).toBeDefined();
    const image = (await command?.handler("", {} as never)) as unknown as {
      png: string;
      width: number;
      height: number;
    };
    expect(pngHeader(image.png)).toEqual({ width: image.width, height: image.height });
    expect(image.width).toBe(240);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
