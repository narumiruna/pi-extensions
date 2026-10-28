import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type DocumentCopyAction,
  defineMenu,
  EditorStatusWidget,
  hardWrapTerminalDocument,
  runDocumentReview,
  runMenu,
} from "@narumitw/pi-tui-kit";
import type { ShowTuiKitShowcaseOptions } from "./runtime.js";

const WIDGET_KEY = "tui-kit-showcase:copy-capture";
export const SYNTHETIC_COPY_SOURCE = 'demo = "α"\r\n\tkeep = true  \r\n# \u202e\u2028\u001b[31m\n';
export const SYNTHETIC_COPY_SECOND_SOURCE = 'second = true\n\tindent = "demo"  \n';

/** ASCII JSON preserves every UTF-16 code unit without executing hidden controls. */
export function escapedCaptureSource(source: string): string {
  return JSON.stringify(source).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function captureWidgetLines(source: string | undefined, itemId: string | undefined, width: number): string[] {
  if (!Number.isFinite(width) || width < 1) return [];
  if (source === undefined) return ["NO OS clipboard. First capture fails intentionally; repeat to retry."];
  const rows = hardWrapTerminalDocument(escapedCaptureSource(source), width);
  const clipped = rows.length > 4;
  return [
    clipped
      ? "! CLIPPED: NO OS clipboard; widen terminal to inspect the complete JSON string."
      : "NO OS clipboard. Complete exact JSON string below; decode to restore source.",
    `Captured ${itemId === undefined ? "review" : escapedCaptureSource(itemId)}; source can include controls hidden by preview.`,
    ...rows.slice(0, 4),
  ];
}

/** An explicitly fake sink shared by standard review, browse, and standalone review. */
export async function runCopyCaptureShowcase(
  ctx: ExtensionCommandContext,
  options: ShowTuiKitShowcaseOptions,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI || options.signal.aborted || !options.isCurrent()) return;
  let captured: string | undefined;
  let capturedItemId: string | undefined;
  let attempts = 0;
  let disposed = false;
  let pendingStandalone = false;
  const state = { acknowledgements: 0 };
  const publish = () => {
    if (disposed || options.signal.aborted || !options.isCurrent()) return;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) =>
        new EditorStatusWidget({
          theme,
          renderBody: (width) =>
            captureWidgetLines(captured, capturedItemId, width).map((line, index) =>
              theme.fg(index < 2 ? "muted" : "text", line),
            ),
        }),
    );
  };
  const clear = () => {
    if (disposed) return;
    disposed = true;
    captured = undefined;
    capturedItemId = undefined;
    // Only clear this interaction's key. Reentry drains this owner before another
    // capture owner starts; Pi can already have invalidated a replaced context.
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* The replaced host owns its display reset. */
    }
  };
  const copy: DocumentCopyAction = {
    label: "Capture full source (memory only)",
    async onCopy({ content, itemId, signal }) {
      if (disposed || signal.aborted || !options.isCurrent()) return;
      attempts += 1;
      if (attempts === 1) throw new Error("Expected synthetic capture failure.");
      await Promise.resolve();
      if (disposed || signal.aborted || options.signal.aborted || !options.isCurrent()) return;
      captured = content;
      capturedItemId = itemId;
      publish();
    },
  };
  const menu = defineMenu<typeof state, "main" | "review" | "browse", "acknowledge" | "standalone">({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "In-memory copy capture — NO OS clipboard",
        lines: [
          "Synthetic source only. First capture intentionally fails; repeat to retry.",
          "Inspect exact ASCII JSON above the open document. Raw source can contain controls hidden by the preview.",
        ],
        items: [
          { id: "review", label: "Standard review capture", to: "review" },
          { id: "browse", label: "Browse-detail capture", to: "browse" },
          { id: "standalone", label: "Standalone document-review capture", action: "standalone" },
          { id: "close", label: "Back to showcase", close: true },
        ],
        hint: "close",
      }),
      review: () => ({
        kind: "review",
        title: "Synthetic standard review — memory capture only",
        lines: [
          `Acknowledgements: ${state.acknowledgements}. Capture does not confirm or close.`,
          "First capture fails; repeat to retry. No OS clipboard.",
        ],
        content: SYNTHETIC_COPY_SOURCE,
        enableSearch: true,
        copy,
        confirm: { id: "ack", label: "Acknowledge demo", action: "acknowledge" },
        hint: "back",
      }),
      browse: () => ({
        kind: "browse",
        title: "Synthetic browse — memory capture only",
        lines: ["Open a document, capture, and inspect ASCII JSON above without closing it."],
        enableDetailSearch: true,
        items: [
          { id: "raw-a", label: "Raw synthetic source A", detailDocument: { content: SYNTHETIC_COPY_SOURCE, copy } },
          {
            id: "raw-b",
            label: "Raw synthetic source B",
            detailDocument: { content: SYNTHETIC_COPY_SECOND_SOURCE, copy },
          },
        ],
        hint: "back",
      }),
    },
    actions: {
      acknowledge: () => {
        state.acknowledgements += 1;
        return { kind: "stay" };
      },
      standalone: () => {
        pendingStandalone = true;
        return { kind: "close" };
      },
    },
  });
  options.signal.addEventListener("abort", clear, { once: true });
  try {
    publish();
    while (!disposed && !options.signal.aborted && options.isCurrent()) {
      pendingStandalone = false;
      const result = await runMenu(ctx, menu, { getState: () => state, ...options });
      if (
        disposed ||
        options.signal.aborted ||
        !options.isCurrent() ||
        !pendingStandalone ||
        result.kind !== "closed" ||
        result.reason !== "close"
      )
        return;
      await runDocumentReview(ctx, {
        title: "Synthetic standalone review — memory capture only",
        lines: ["First capture fails; repeat to retry. No OS clipboard. Inspect exact ASCII JSON above."],
        content: SYNTHETIC_COPY_SOURCE,
        copy,
        enableSearch: true,
        ...options,
      });
      if (options.signal.aborted || !options.isCurrent()) return;
    }
  } finally {
    options.signal.removeEventListener("abort", clear);
    clear();
  }
}
