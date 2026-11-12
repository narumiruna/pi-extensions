import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  allocateImageId,
  type Component,
  getCapabilities,
  getCellDimensions,
  Image,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import {
  type Appearance,
  type DiagramLayout,
  LIMITS,
  Rasterizer,
  type RasterResult,
  RenderQueueFullError,
  rasterWidth,
} from "./rasterizer.js";
import type { IllustrateRecord } from "./records.js";
import type { Cols, IllustrateSettings } from "./settings.js";

export interface RenderService {
  readonly active: number;
  layout(kind: "svg" | "mermaid", source: string, signal?: AbortSignal): Promise<DiagramLayout>;
  raster(layout: DiagramLayout, appearance: Appearance, widthPx: number, signal?: AbortSignal): Promise<RasterResult>;
  dispose(): Promise<void>;
}

interface Slot {
  record: IllustrateRecord;
  imageId: number;
  generation: number;
  wanted: string;
  appearance?: Appearance;
  artifact?: RasterResult;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  invalidate?: WeakRef<() => void>;
  failure?: string;
}

const MAX_PREVIEWS = 64;
const CACHE_BYTES = 32 * 1024 * 1024;
const MAX_DISPLAY_ROWS = 4096;
export const RESIZE_DELAY_MS = 150;

export function effectiveAppearance(settings: IllustrateSettings, appearance: Appearance): Appearance {
  return settings.mermaidAppearance === "auto" ? appearance : settings.mermaidAppearance;
}

export function displayColumns(width: number, cols: Cols): number {
  const available = Math.max(0, Math.floor(width) - 2);
  return cols === "auto" ? available : Math.min(available, cols);
}

/** Session-owned work, not component-owned work: Pi does not dispose ordinary tool-row components. */
export class PreviewSession {
  readonly controller = new AbortController();
  readonly service: RenderService;
  private slots = new Map<string, Slot>();
  private widths = new Map<string, number>();
  private closed?: Promise<void>;
  private allowed?: Set<string>;

  constructor(
    readonly getSettings: () => IllustrateSettings,
    service: RenderService = new Rasterizer(),
  ) {
    this.service = service;
  }

  get active(): number {
    return this.service.active;
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get cacheBytes(): number {
    let size = 0;
    for (const slot of this.slots.values()) size += slot.artifact?.png.length ?? 0;
    return size;
  }

  noteWidth(id: string, width: number): void {
    if (this.signal.aborted || !Number.isFinite(width)) return;
    if (this.widths.size >= MAX_PREVIEWS && !this.widths.has(id))
      this.widths.delete(this.widths.keys().next().value as string);
    this.widths.set(id, Math.max(0, Math.floor(width)));
  }

  initialWidth(id: string, cols: Cols): number {
    const width = this.widths.get(id) ?? 80;
    return Math.max(1, displayColumns(width, cols)) * getCellDimensions().widthPx;
  }

  seed(id: string, record: IllustrateRecord, artifact: RasterResult, appearance: Appearance): void {
    this.allowed?.add(id);
    // A cache limit must not discard a completed tool result or its model snapshot.
    if (!this.slots.has(id) && this.slots.size >= MAX_PREVIEWS) return;
    const slot = this.slot(id, record);
    this.cancel(slot);
    slot.artifact = artifact;
    slot.appearance = appearance;
    slot.failure = undefined;
    slot.wanted = "";
    this.trimCache(id);
  }

  private slot(id: string, record: IllustrateRecord): Slot {
    const existing = this.slots.get(id);
    if (
      existing?.record.layout.svg === record.layout.svg &&
      existing.record.cols === record.cols &&
      existing.record.layout.kind === record.layout.kind &&
      existing.record.layout.width === record.layout.width &&
      existing.record.layout.height === record.layout.height
    )
      return existing;
    if (existing) this.cancel(existing);
    if (!existing && this.slots.size >= MAX_PREVIEWS)
      throw new Error("The session preview limit was reached (64 diagrams).");
    const slot: Slot = { record, imageId: allocateImageId(), generation: 0, wanted: "" };
    this.slots.set(id, slot);
    return slot;
  }

  private cancel(slot: Slot): void {
    slot.generation++;
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.controller?.abort();
    slot.controller = undefined;
  }

  release(id: string): void {
    const slot = this.slots.get(id);
    if (slot) {
      this.cancel(slot);
      slot.wanted = "";
      slot.invalidate = undefined;
    }
  }

  retain(ids: ReadonlySet<string>): void {
    this.allowed = new Set(ids);
    for (const [id, slot] of this.slots) {
      if (!ids.has(id)) {
        this.cancel(slot);
        this.slots.delete(id);
        this.widths.delete(id);
      }
    }
  }

  private trimCache(currentId: string): void {
    for (const [id, slot] of this.slots) {
      if (this.cacheBytes <= CACHE_BYTES) break;
      if (id === currentId || !slot.artifact) continue;
      slot.artifact = undefined;
      slot.failure = "Preview cache limit reached. Change its display size to request a new preview.";
    }
  }

  private request(id: string, slot: Slot, appearance: Appearance, widthPx: number): void {
    const key = `${slot.record.layout.kind === "mermaid" ? appearance : "svg"}:${widthPx}`;
    const sufficient =
      slot.artifact &&
      (slot.record.layout.kind === "svg" || slot.appearance === appearance) &&
      slot.artifact.width >= widthPx;
    if (sufficient) {
      if (slot.controller || slot.timer !== undefined) this.cancel(slot);
      slot.wanted = key;
      slot.failure = undefined;
      return;
    }
    if (slot.wanted === key) return;
    this.cancel(slot);
    slot.wanted = key;
    slot.failure = undefined;
    const generation = slot.generation;
    const run = async () => {
      slot.timer = undefined;
      if (this.signal.aborted || slot.generation !== generation) return;
      const controller = new AbortController();
      slot.controller = controller;
      const abort = () => controller.abort();
      this.signal.addEventListener("abort", abort, { once: true });
      try {
        if (this.service.active >= LIMITS.maxPending) throw new RenderQueueFullError();
        const artifact = await this.service.raster(slot.record.layout, appearance, widthPx, controller.signal);
        if (this.signal.aborted || controller.signal.aborted || slot.generation !== generation) return;
        slot.artifact = artifact;
        slot.appearance = appearance;
        this.trimCache(id);
      } catch (error) {
        if (this.signal.aborted || controller.signal.aborted || slot.generation !== generation) return;
        if (error instanceof RenderQueueFullError) {
          // Keep current demand and retry only capacity failures. cancel() owns this timer too.
          slot.timer = setTimeout(() => void run(), RESIZE_DELAY_MS);
          return;
        }
        slot.failure = sanitizeTerminalText(error instanceof Error ? error.message : "Preview rendering failed.").slice(
          0,
          300,
        );
      } finally {
        this.signal.removeEventListener("abort", abort);
        if (slot.generation === generation) {
          slot.controller = undefined;
          if (!this.signal.aborted) slot.invalidate?.deref()?.();
        }
      }
    };
    // Delayed work belongs to this session and record. The component only publishes render demand.
    const delay =
      slot.artifact && (slot.record.layout.kind === "svg" || slot.appearance === appearance) ? RESIZE_DELAY_MS : 0;
    slot.timer = setTimeout(() => void run(), delay);
  }

  draw(id: string, record: IllustrateRecord, width: number, theme: Theme, invalidate: () => void): string[] {
    if (!Number.isFinite(width) || width <= 0) {
      this.release(id);
      return [];
    }
    const line = (text: string) => truncateToWidth(theme.fg("muted", sanitizeTerminalText(text)), width);
    if (this.signal.aborted) return [line("Preview session closed.")];
    if (this.allowed && !this.allowed.has(id)) return [line("Preview is outside the active session branch.")];
    const cols = displayColumns(width, record.cols);
    if (!cols) {
      this.release(id);
      return [line("Preview needs at least 3 columns.")];
    }
    if (getCapabilities().images !== "kitty") {
      this.release(id);
      return [line("Kitty graphics are unavailable.")];
    }
    let slot: Slot;
    try {
      slot = this.slot(id, record);
    } catch (error) {
      return [line((error as Error).message)];
    }
    slot.invalidate = new WeakRef(invalidate);
    const appearance = effectiveAppearance(this.getSettings(), theme.appearance);
    const cell = getCellDimensions();
    const heightRows = Math.ceil((cols * cell.widthPx * record.layout.height) / (record.layout.width * cell.heightPx));
    if (!Number.isFinite(heightRows) || heightRows > MAX_DISPLAY_ROWS) {
      this.release(id);
      return [line("Preview exceeds the 4096-row display limit. Use fewer columns.")];
    }
    let targetWidth: number;
    try {
      targetWidth = rasterWidth(record.layout, Math.max(1, Math.ceil(cols * cell.widthPx)));
    } catch (error) {
      this.release(id);
      return [line(`Preview update failed: ${(error as Error).message}`)];
    }
    this.request(id, slot, appearance, targetWidth);
    const artifact = slot.artifact;
    const lines: string[] = [];
    if (slot.failure) lines.push(line(`Preview update failed: ${slot.failure}`));
    else if (!artifact || (record.layout.kind === "mermaid" && slot.appearance !== appearance))
      lines.push(line("Updating preview…"));
    if (!artifact) return lines.length ? lines : [line("Preparing preview…")];
    const image = new Image(
      artifact.png,
      "image/png",
      { fallbackColor: (text) => theme.fg("muted", text) },
      {
        maxWidthCells: cols,
        maxHeightCells: Math.max(1, heightRows + 1),
        imageId: slot.imageId,
      },
      { widthPx: artifact.width, heightPx: artifact.height },
    );
    return [...lines, ...image.render(width)];
  }

  component(id: string, record: IllustrateRecord, theme: Theme, invalidate: () => void): Component {
    // No timer, listener, worker, cached bitmap, or strong session-to-component reference is owned here.
    return {
      render: (width) => this.draw(id, record, width, theme, invalidate),
      invalidate() {},
    };
  }

  refresh(): void {
    for (const slot of this.slots.values()) {
      this.cancel(slot);
      slot.wanted = "";
      slot.failure = undefined;
      slot.invalidate?.deref()?.();
    }
  }

  dispose(): Promise<void> {
    if (this.closed) return this.closed;
    this.controller.abort();
    for (const slot of this.slots.values()) this.cancel(slot);
    this.slots.clear();
    this.widths.clear();
    this.closed = this.service.dispose();
    return this.closed;
  }
}
