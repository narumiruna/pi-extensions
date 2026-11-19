import { resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getOsc8LinkAtColumn,
  type OverlayHandle,
  StdinBuffer,
  type TUI,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { parseLineRange, readExcerpt, renderFilePreview, resolveLinkPath } from "./filelinks.ts";
import {
  hoverLinkLine,
  renderWikiGroupPreview,
  renderWikiPreview,
  type WikiPreview,
  wikiGroupSourceLimit,
} from "./wikilinks.ts";

const HOVER_DELAY_MS = 250;
const MAX_HEIGHT = 12;
const MIN_HEIGHT = 4;

interface Point {
  row: number;
  col: number;
}

interface Hover extends Point {
  href: string;
  path?: string;
  preview?: WikiPreview;
  controller: AbortController;
}

export function createHoverPreview(
  tui: TUI,
  theme: Theme,
  cwd: string,
  checkout: string,
  findWikiPreview: (href: string) => WikiPreview | undefined,
): Component & { dispose(): void } {
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

  function linkAt({ row, col }: Point): string | undefined {
    if (!(tui instanceof TuiAltScreen)) return undefined;
    return getOsc8LinkAtColumn(hoverLinkLine(tui.getScreenLines()[row] ?? ""), col);
  }

  function stillOnLink(target: Hover): boolean {
    return linkAt(target) === target.href && findWikiPreview(target.href) === target.preview;
  }

  async function show(target: Hover): Promise<void> {
    const { preview, path, controller } = target;
    const { columns, rows } = tui.terminal;
    const below = rows - target.row - 1;
    const above = target.row;
    const placeBelow = below >= MAX_HEIGHT || below >= above;
    const width = Math.min(columns, preview ? 56 : 60);
    const height = Math.min(placeBelow ? below : above, MAX_HEIGHT);
    if (width < (preview ? 20 : 16) || height < MIN_HEIGHT) return;

    let draw: () => { width: number; lines: string[] } | undefined;
    if (preview && "sources" in preview) {
      const candidates = preview.sources.slice(0, wikiGroupSourceLimit(preview.sources.length, height));
      const excerpts = await Promise.all(
        candidates.map((source) => readExcerpt(checkout, resolve(checkout, source), controller.signal)),
      );
      draw = () => renderWikiGroupPreview(preview, excerpts, theme, width, height);
    } else {
      if (!path) return;
      const lineRange = preview ? undefined : parseLineRange(target.href);
      const excerpt = await readExcerpt(preview ? checkout : cwd, path, controller.signal, lineRange);
      if (!excerpt) return;
      draw = () =>
        preview
          ? renderWikiPreview(preview, excerpt, theme, width, height)
          : { width, lines: renderFilePreview(theme, excerpt, width, height) };
    }
    if (hover !== target || tui.hasOverlay() || !stillOnLink(target)) return;
    if (tui.terminal.columns !== columns || tui.terminal.rows !== rows) {
      hide();
      return;
    }
    const card = draw();
    if (!card) return;

    let lines = card.lines;
    viewport = { columns, rows };
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
        row: placeBelow ? target.row + 1 : target.row - lines.length,
        col: Math.min(target.col, columns - card.width),
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
    const href = linkAt(point);
    const preview = href ? findWikiPreview(href) : undefined;
    if (hover && href === hover.href && point.row === hover.row && preview === hover.preview) {
      hover.col = point.col;
      return;
    }
    hide();
    if (!href || tui.hasOverlay()) return;
    const path = preview ? ("path" in preview ? preview.path : undefined) : resolveLinkPath(cwd, href);
    if (!preview && !path) return;

    const target: Hover = { ...point, href, path, preview, controller: new AbortController() };
    hover = target;
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
