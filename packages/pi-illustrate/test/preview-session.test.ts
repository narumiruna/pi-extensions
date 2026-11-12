import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getCellDimensions,
  setCapabilities,
  setCellDimensions,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession, type RenderService } from "../src/preview-session.js";
import type { Appearance, DiagramLayout, RasterResult } from "../src/rasterizer.js";
import { createRecord } from "../src/records.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const layout: DiagramLayout = {
  kind: "mermaid",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>',
  width: 200,
  height: 100,
};
const record = createRecord(layout, "auto");
const image = (width: number): RasterResult => ({ png: PNG, width, height: width / 2 });
const theme = (appearance: Appearance) => ({ appearance, fg: (_role: string, text: string) => text }) as Theme;
const caps = getCapabilities();
const cells = getCellDimensions();
let owners: PreviewSession[];

function setup() {
  const service: RenderService = {
    active: 0,
    layout: vi.fn(async () => layout),
    raster: vi.fn(async (_layout, _appearance, width) => image(width)),
    dispose: vi.fn(async () => {}),
  };
  const owner = new PreviewSession(() => ({ defaultCols: "auto", mermaidAppearance: "auto" }), service);
  owners.push(owner);
  owner.seed("one", record, image(800), "dark");
  return { owner, service, invalidate: vi.fn() };
}

beforeEach(() => {
  owners = [];
  vi.useFakeTimers();
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  setCellDimensions({ widthPx: 10, heightPx: 20 });
});
afterEach(async () => {
  await Promise.all(owners.map((owner) => owner.dispose()));
  vi.useRealTimers();
  setCapabilities(caps);
  setCellDimensions(cells);
});

describe("responsive session-owned previews", () => {
  it("uses all requested columns, preserves ratio, and transmits exactly one image", () => {
    const { owner, service, invalidate } = setup();
    const lines = owner.draw("one", record, 82, theme("dark"), invalidate);
    expect(lines.join("").split("\x1b_Ga=T").length - 1).toBe(1);
    expect(lines[0]).toContain("c=80,r=20");
    expect(lines).toHaveLength(20);
    owner.draw("one", record, 42, theme("dark"), invalidate);
    expect(service.raster).not.toHaveBeenCalled();
  });

  it("debounces only resolution-deficient upscales and cancels the previous timer", async () => {
    const { owner, service, invalidate } = setup();
    owner.draw("one", record, 122, theme("dark"), invalidate);
    await vi.advanceTimersByTimeAsync(149);
    expect(service.raster).not.toHaveBeenCalled();
    owner.draw("one", record, 142, theme("dark"), invalidate);
    await vi.advanceTimersByTimeAsync(149);
    expect(service.raster).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.raster).toHaveBeenCalledTimes(1);
    expect(service.raster).toHaveBeenCalledWith(record.layout, "dark", 1400, expect.any(AbortSignal));
    expect(invalidate).toHaveBeenCalledOnce();
    owner.draw("one", record, 122, theme("dark"), invalidate);
    await vi.runAllTimersAsync();
    expect(service.raster).toHaveBeenCalledOnce();
  });

  it("caps numeric columns and observes late cell-pixel updates", async () => {
    const { owner, service, invalidate } = setup();
    const capped = createRecord(layout, 80);
    owner.seed("two", capped, image(800), "dark");
    owner.draw("two", capped, 142, theme("dark"), invalidate);
    expect(service.raster).not.toHaveBeenCalled();
    setCellDimensions({ widthPx: 20, heightPx: 40 });
    owner.draw("two", capped, 142, theme("dark"), invalidate);
    await vi.advanceTimersByTimeAsync(150);
    expect(service.raster).toHaveBeenCalledWith(capped.layout, "dark", 1600, expect.any(AbortSignal));
  });

  it("rerasterizes appearance without rerunning layout and labels the pending old bitmap", async () => {
    const { owner, service, invalidate } = setup();
    expect(owner.draw("one", record, 82, theme("light"), invalidate)[0]).toBe("Updating preview…");
    await vi.advanceTimersByTimeAsync(0);
    expect(service.raster).toHaveBeenCalledWith(record.layout, "light", 800, expect.any(AbortSignal));
    expect(service.layout).not.toHaveBeenCalled();
    expect(owner.draw("one", record, 82, theme("light"), invalidate)[0]).toContain("\x1b_G");
  });

  it("does not recolor SVG and honors explicit Mermaid appearance settings", async () => {
    const { owner, service, invalidate } = setup();
    const svgRecord = createRecord({ ...layout, kind: "svg" }, "auto");
    owner.seed("svg", svgRecord, image(800), "dark");
    owner.draw("svg", svgRecord, 82, theme("light"), invalidate);
    await vi.runAllTimersAsync();
    expect(service.raster).not.toHaveBeenCalled();
    const fixed = new PreviewSession(() => ({ defaultCols: "auto", mermaidAppearance: "dark" }), service);
    owners.push(fixed);
    fixed.seed("one", record, image(800), "dark");
    fixed.draw("one", record, 82, theme("light"), invalidate);
    await vi.runAllTimersAsync();
    expect(service.raster).not.toHaveBeenCalled();
  });

  it("aborts active work after shrinking and ignores its eventual stale result", async () => {
    const { owner, service, invalidate } = setup();
    let finish!: (result: RasterResult) => void;
    let signal!: AbortSignal;
    vi.mocked(service.raster).mockImplementation((_layout, _appearance, _width, requestSignal) => {
      signal = requestSignal as AbortSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    owner.draw("one", record, 122, theme("dark"), invalidate);
    await vi.advanceTimersByTimeAsync(150);
    owner.draw("one", record, 42, theme("dark"), invalidate);
    expect(signal.aborted).toBe(true);
    finish(image(1200));
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();
    owner.draw("one", record, 102, theme("dark"), invalidate);
    await vi.advanceTimersByTimeAsync(150);
    expect(service.raster).toHaveBeenCalledTimes(2);
  });

  it("cancels hidden demand, prevents inactive-branch resurrection, and releases work on shutdown", async () => {
    const { owner, service, invalidate } = setup();
    const component = owner.component("one", record, theme("dark"), invalidate);
    component.render(122);
    owner.release("one");
    await vi.advanceTimersByTimeAsync(200);
    expect(service.raster).not.toHaveBeenCalled();
    owner.retain(new Set());
    expect(component.render(122)).toEqual(["Preview is outside the active session branch."]);
    expect(service.raster).not.toHaveBeenCalled();
    await owner.dispose();
    await owner.dispose();
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(component.render(82)).toEqual(["Preview session closed."]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, NaN])("releases obsolete positive-width demand when width becomes %s", async (width) => {
    const { owner, service, invalidate } = setup();
    owner.draw("one", record, 122, theme("dark"), invalidate);
    expect(owner.draw("one", record, width, theme("dark"), invalidate)).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(service.raster).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains an observable sanitized failure without retrying every render", async () => {
    const { owner, service, invalidate } = setup();
    vi.mocked(service.raster).mockRejectedValue(new Error("bad\x1b[31m input"));
    owner.draw("one", record, 122, theme("dark"), invalidate);
    await vi.advanceTimersByTimeAsync(150);
    const lines = owner.draw("one", record, 122, theme("dark"), invalidate);
    expect(lines[0]).toBe("Preview update failed: bad input");
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.raster).toHaveBeenCalledOnce();
  });

  it("bounds zero/narrow/tall rendering and unsupported protocol output", async () => {
    const { owner, service, invalidate } = setup();
    expect(owner.draw("one", record, 0, theme("dark"), invalidate)).toEqual([]);
    expect(visibleWidth(owner.draw("one", record, 1, theme("dark"), invalidate).join(""))).toBeLessThanOrEqual(1);
    const tall = createRecord({ ...layout, height: 100_000, width: 1 }, "auto");
    expect(owner.draw("tall", tall, 82, theme("dark"), invalidate)[0]).toContain("display limit");
    setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
    expect(owner.draw("one", record, 82, theme("dark"), invalidate)).toEqual(["Kitty graphics are unavailable."]);
    await vi.runAllTimersAsync();
    expect(service.raster).not.toHaveBeenCalled();
  });

  it("bounds the preview cache without retaining bitmap copies on the component", () => {
    const { owner } = setup();
    const large = { ...image(800), png: "A".repeat(5 * 1024 * 1024) };
    for (let i = 0; i < 8; i++) owner.seed(`entry-${i}`, record, large, "dark");
    expect(owner.cacheBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});
