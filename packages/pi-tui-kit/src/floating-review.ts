import type { TUI } from "@earendil-works/pi-tui";
import { safeMenuText } from "./components/rendering.js";
import { createReviewComponent, type ReviewOptions } from "./components/review.js";
import { FloatingFrame } from "./floating-frame.js";

const MIN_FLOATING_SIZE = { columns: 24, rows: 5 };

export function fitsFloatingReview({ columns, rows }: TUI["terminal"]): boolean {
  return (
    Number.isFinite(columns) &&
    Number.isFinite(rows) &&
    columns >= MIN_FLOATING_SIZE.columns &&
    rows >= MIN_FLOATING_SIZE.rows
  );
}

export function createFloatingReview(options: ReviewOptions<"review", "confirm"> & { tui: TUI }) {
  const { tui, theme } = options;
  const title = safeMenuText(options.screen.title);
  const review = createReviewComponent(options);
  const frame = new FloatingFrame({
    getTerminalSize: () => tui.terminal,
    initialBounds: ({ columns, rows }) => {
      const width = Math.max(MIN_FLOATING_SIZE.columns, Math.floor(columns * 0.9));
      const height = Math.max(MIN_FLOATING_SIZE.rows, Math.floor(rows * 0.8));
      return { col: Math.floor((columns - width) / 2), row: Math.floor((rows - height) / 2), width, height };
    },
    minSize: MIN_FLOATING_SIZE,
    requestRender: () => tui.requestRender(),
    styleBorder: (text) => theme.fg("border", text),
    styleTitle: (text) => theme.fg("accent", theme.bold(text)),
    title: () => ` ${title} `,
    focusOnDrag: true,
    body: {
      render: ({ columns, rows }) => review.render(columns, rows),
      invalidate: () => review.invalidate(),
      setFocused: (focused) => {
        if ("focused" in review) review.focused = focused;
      },
      handleInput: (data) => review.handleInput(data),
      handleMouse: (event) => review.handleMouse?.(event),
    },
  });
  return Object.assign(frame, {
    dispose: () => review.dispose?.(),
    waitForPending: () => review.waitForPending(),
  });
}
