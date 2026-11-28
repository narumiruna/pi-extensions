import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { prepareDiffDocument } from "./diff-document.js";
import { FloatingDiffWindow } from "./floating-diff-window.js";
import { demoHasHardCancel, HARD_CANCEL_WARNING } from "./hard-cancel.js";
import type { ShowTuiKitShowcaseOptions } from "./runtime.js";

const TITLE = "Floating diff";
const OPTIONS = Array.from({ length: 18 }, (_, index) => `option_${index + 1} = true`);
const SAMPLE = {
  before: [
    "# Synthetic settings",
    'title = "Before"',
    "preview = false",
    ...OPTIONS,
    'message = "Hello"',
    'theme = "light"',
    "",
  ].join("\n"),
  after: [
    "# Synthetic settings",
    'title = "After"',
    "preview = true",
    ...OPTIONS,
    'message = "你好 🙂 — a long line that wraps inside the window instead of being cut off"',
    'theme = "dark"',
    "",
  ].join("\n"),
};

export async function runFloatingDiffDemo(
  ctx: ExtensionCommandContext,
  options: ShowTuiKitShowcaseOptions,
): Promise<boolean> {
  const current = () => !options.signal.aborted && options.isCurrent();
  if (ctx.mode !== "tui" || !ctx.hasUI || !current()) return false;

  const reviewUrl = new URL("./components/review.js", import.meta.resolve("@narumitw/pi-tui-kit"));
  const { createReviewComponent } = (await import(reviewUrl.href)) as typeof import("../../dist/components/review.js");
  if (!current()) return false;

  const document = prepareDiffDocument(SAMPLE.before, SAMPLE.after);
  const unmounted = Promise.withResolvers<void>();
  let frame: FloatingDiffWindow | undefined;
  let overlay: OverlayHandle | undefined;
  let dispose: (() => void) | undefined;
  let checkCurrent: (() => boolean) | undefined;
  let returnToMenu = false;

  try {
    const interaction = ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        if (!current() || !demoHasHardCancel(tui, true)) {
          if (current()) {
            ctx.ui.notify(HARD_CANCEL_WARNING, "warning");
            returnToMenu = true;
          }
          done();
          return { render: () => [], invalidate() {} };
        }

        let closed = false;
        const close = (dismissed: boolean) => {
          if (closed) return;
          returnToMenu = dismissed;
          try {
            done();
          } finally {
            dispose?.();
          }
        };
        const abort = () => close(false);
        checkCurrent = () => {
          if (!current()) abort();
          return !closed;
        };
        const review = createReviewComponent({
          screen: {
            kind: "review",
            title: TITLE,
            content: document.content,
            format: { kind: document.kind },
            hint: "close",
            viewportSize: "adaptive",
          },
          tui,
          theme,
          keybindings,
          onEvent: () => close(true),
        });
        frame = new FloatingDiffWindow({
          title: TITLE,
          tui,
          theme,
          keybindings,
          isCurrent: checkCurrent,
          close: () => close(overlay?.isFocused() === true),
          body: {
            render: ({ columns, rows }) => (closed ? [] : review.render(columns, rows)),
            invalidate: () => review.invalidate(),
            handleInput: (data) => review.handleInput(data),
            handleMouse: (event) => review.handleMouse?.(event),
          },
        });
        dispose = () => {
          if (closed) return;
          closed = true;
          options.signal.removeEventListener("abort", abort);
          try {
            review.dispose?.();
          } finally {
            unmounted.resolve();
          }
        };
        options.signal.addEventListener("abort", abort, { once: true });
        checkCurrent();
        return Object.assign(frame, { dispose });
      },
      {
        overlay: true,
        overlayOptions: () => frame?.overlayOptions ?? {},
        onHandle: (handle) => {
          overlay = handle;
          checkCurrent?.();
        },
      },
    );
    await Promise.race([interaction, unmounted.promise]);
  } finally {
    dispose?.();
  }
  return returnToMenu && current();
}
