import { parse, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getOsc8LinkAtColumn,
  type OverlayHandle,
  StdinBuffer,
  type TUI,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import type { createLinkMarker } from "./external-link-marker.js";
import { classifyLinkPath, parseLineRange, readExcerpt, renderFilePreview } from "./filelinks.js";
import { prepareImagePreview, previewImageMime } from "./image-preview.js";
import {
  hoverLinkLine,
  renderWikiGroupPreview,
  renderWikiPreview,
  type WikiPreview,
  wikiGroupSourceLimit,
} from "./wikilinks.js";

const HOVER_DELAY_MS = 250;
const MAX_HEIGHT = 12;
const MIN_HEIGHT = 4;

interface Point {
  row: number;
  col: number;
}

type LinkMarker = ReturnType<typeof createLinkMarker>;

interface PreviewLink {
  href: string;
  path?: string;
  external: boolean;
  file?: NonNullable<ReturnType<LinkMarker["findFile"]>>;
  preview?: WikiPreview;
}

interface Hover extends Point, PreviewLink {
  controller: AbortController;
}

function sameLink(a: PreviewLink, b: PreviewLink | undefined): boolean {
  return b !== undefined && a.href === b.href && a.file === b.file && a.preview === b.preview;
}

export function createHoverPreview(
  tui: TUI,
  theme: Theme,
  cwd: string,
  findWikiPreview: (href: string) => WikiPreview | undefined,
  marker: LinkMarker,
): Component & { dismiss(): void; dispose(): void } {
  let hover: Hover | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let overlay: OverlayHandle | undefined;
  let viewport: { columns: number; rows: number } | undefined;
  let disposed = false;

  function hide(): void {
    clearTimeout(timer);
    hover?.controller.abort();
    hover = undefined;
    overlay?.hide();
    overlay = undefined;
    viewport = undefined;
  }

  function screenLine(row: number): string {
    return tui instanceof TuiAltScreen ? (tui.getScreenLines()[row] ?? "") : "";
  }

  function linkAt({ row, col }: Point): PreviewLink | undefined {
    const line = screenLine(row);
    const href = getOsc8LinkAtColumn(hoverLinkLine(line), col);
    if (!href) return undefined;
    const file = marker.findFile(line, col, href);
    if (file === null) return undefined;
    const preview = file ? undefined : findWikiPreview(href);
    const local = file ?? (preview ? undefined : classifyLinkPath(cwd, href));
    if (!preview && !local) return undefined;
    const external = local?.kind === "external";
    if (external && (previewImageMime(local.path) || (!file && !marker.matchesExternal(line, col, href))))
      return undefined;
    return { href, file, preview, external, path: preview && "path" in preview ? preview.path : local?.path };
  }

  function stillOnLink(target: Hover): boolean {
    return sameLink(target, linkAt(target));
  }

  async function show(target: Hover): Promise<void> {
    const { preview, path, controller, external } = target;
    if (hover !== target) return;
    if (
      !viewport ||
      viewport.columns !== tui.terminal.columns ||
      viewport.rows !== tui.terminal.rows ||
      tui.hasOverlay() ||
      !stillOnLink(target)
    ) {
      hide();
      return;
    }
    const { columns, rows } = tui.terminal;
    const below = rows - target.row - 1;
    const above = target.row;
    const imageMime = !external && !preview && path ? previewImageMime(path) : undefined;
    const placeBelow = below >= above || (!imageMime && below >= MAX_HEIGHT);
    const availableRows = placeBelow ? below : above;
    const width = imageMime ? columns : Math.min(columns, preview ? 56 : 60);
    const height = imageMime ? availableRows : Math.min(availableRows, MAX_HEIGHT);
    if (width < (imageMime ? 2 : preview ? 20 : 16) || height < (imageMime ? 1 : MIN_HEIGHT)) return;

    // The image moves its terminal cursor to an absolute column, so use the
    // same column for rendering and placement even if the pointer moves.
    let imageColumn: number | undefined;
    let draw: () => { width: number; lines: string[] } | undefined;
    if (path && imageMime) {
      const image = await prepareImagePreview(cwd, path, imageMime, width, height, controller.signal);
      if (!image) return;
      const column = Math.min(target.col, columns - image.width);
      imageColumn = column;
      draw = () => ({ width: image.width, lines: image.render(column) });
    } else if (preview && "sources" in preview) {
      const candidates = preview.sources.slice(0, wikiGroupSourceLimit(preview.sources.length, height));
      const excerpts = await Promise.all(
        candidates.map((source) => readExcerpt(cwd, resolve(cwd, source), controller.signal)),
      );
      draw = () => renderWikiGroupPreview(preview, excerpts, theme, width, height);
    } else {
      if (!path) return;
      const lineRange = preview ? undefined : parseLineRange(target.file?.originalHref ?? target.href);
      const excerpt = await readExcerpt(external ? parse(path).root : cwd, path, controller.signal, lineRange);
      if (!excerpt) return;
      draw = () =>
        preview
          ? renderWikiPreview(excerpt, theme, width, height)
          : { width, lines: renderFilePreview(theme, excerpt, width, height) };
    }
    if (hover !== target) return;
    if (tui.hasOverlay() || !stillOnLink(target) || tui.terminal.columns !== columns || tui.terminal.rows !== rows) {
      hide();
      return;
    }
    const card = draw();
    if (!card?.lines.length) return;

    let lines = card.lines;
    overlay = tui.showOverlay(
      {
        render: () => lines,
        invalidate() {
          lines = draw()?.lines ?? [];
        },
      },
      {
        nonCapturing: true,
        width: card.width,
        ...(placeBelow ? { row: target.row + 1 } : { anchor: "bottom-left", margin: { bottom: rows - target.row } }),
        col: imageColumn ?? Math.min(target.col, columns - card.width),
        visible: (w, h) => w === columns && h === rows,
      },
    );
  }

  function observe(data: string): void {
    // SGR motion reports with no mouse button pressed. Ignore drag reports.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR starts with ESC.
    const move = /^\x1b\[<35;(\d+);(\d+)M$/.exec(data);
    if (!move) {
      if (hover) hide();
      return;
    }

    const point = { row: Number(move[2]) - 1, col: Number(move[1]) - 1 };
    if (point.col < 0 || point.col >= tui.terminal.columns || point.row < 0 || point.row >= tui.terminal.rows) {
      hide();
      return;
    }
    const link = linkAt(point);
    if (hover && point.row === hover.row && sameLink(hover, link)) {
      hover.col = point.col;
      return;
    }
    hide();
    if (!link || tui.hasOverlay()) return;

    const target: Hover = { ...point, ...link, controller: new AbortController() };
    hover = target;
    viewport = { columns: tui.terminal.columns, rows: tui.terminal.rows };
    timer = setTimeout(() => void show(target), HOVER_DELAY_MS);
  }

  // Pi consumes mouse reports before extension input listeners. Observe stdin
  // without replacing Pi's handler, taking focus, or changing terminal modes.
  const input = new StdinBuffer();
  input.on("data", observe);
  input.on("paste", hide);
  const onData = (data: string | Buffer) => {
    if (!disposed && process.stdin.isRaw && tui instanceof TuiAltScreen) input.process(data);
  };
  process.stdin.on("data", onData);

  return {
    dismiss: hide,
    render(): string[] {
      if (hover && viewport) {
        const current = hover;
        const size = viewport;
        // The screen buffer changes after the widget has rendered.
        queueMicrotask(() => {
          if (hover !== current || viewport !== size) return;
          const { columns, rows } = tui.terminal;
          if (columns !== size.columns || rows !== size.rows || !stillOnLink(current)) hide();
        });
      }
      return [];
    },
    invalidate() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      process.stdin.off("data", onData);
      input.destroy();
      hide();
    },
  };
}
