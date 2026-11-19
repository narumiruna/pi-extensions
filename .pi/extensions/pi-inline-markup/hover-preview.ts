import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getOsc8LinkAtColumn,
  type OverlayHandle,
  StdinBuffer,
  type TUI,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { readExcerpt, renderFilePreview, resolveLinkPath } from "./filelinks.ts";
import { renderWikiPreview, type WikiNote } from "./wikilinks.ts";

const HOVER_DELAY_MS = 250;
const MAX_HEIGHT = 12;
const MIN_HEIGHT = 4;

interface Point {
  row: number;
  col: number;
}

interface Hover extends Point {
  href: string;
  path: string;
  note?: WikiNote;
  controller: AbortController;
}

export function createHoverPreview(
  tui: TUI,
  theme: Theme,
  cwd: string,
  checkout: string,
  findWikiNote: (href: string) => WikiNote | undefined,
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
    return getOsc8LinkAtColumn(tui.getScreenLines()[row] ?? "", col);
  }

  function stillOnLink(target: Hover): boolean {
    return linkAt(target) === target.href && (!target.note || findWikiNote(target.href) === target.note);
  }

  async function show(target: Hover): Promise<void> {
    const { note, path, controller } = target;
    const excerpt = await readExcerpt(note ? checkout : cwd, path, controller.signal);
    if (!excerpt || hover !== target || tui.hasOverlay() || !stillOnLink(target)) return;

    const { columns, rows } = tui.terminal;
    const below = rows - target.row - 1;
    const above = target.row;
    const placeBelow = below >= MAX_HEIGHT || below >= above;
    const width = Math.min(columns, note ? 56 : 60);
    const height = Math.min(placeBelow ? below : above, MAX_HEIGHT);
    if (width < (note ? 20 : 16) || height < MIN_HEIGHT) return;

    const draw = () =>
      note
        ? renderWikiPreview(note, excerpt, theme, width, height)
        : {
            width,
            lines: renderFilePreview(theme, excerpt, width, height),
          };
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
    const note = href ? findWikiNote(href) : undefined;
    if (hover && href === hover.href && point.row === hover.row && note === hover.note) {
      hover.col = point.col;
      return;
    }
    hide();
    if (!href || tui.hasOverlay()) return;
    const path = note?.path ?? resolveLinkPath(cwd, href);
    if (!path) return;

    const target: Hover = { ...point, href, path, note, controller: new AbortController() };
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
