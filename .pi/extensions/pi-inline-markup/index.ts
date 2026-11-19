import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createHoverPreview } from "./hover-preview.ts";
import { renderInlineMarkup } from "./inline-markup.ts";

const WIDGET_KEY = "pi-inline-markup.preview";

export default function inlineMarkupExtension(pi: ExtensionAPI): void {
  let session: { cwd: string; theme: Theme } | undefined;

  pi.on("session_start", (_event, { mode, cwd, ui }) => {
    if (mode !== "tui") return;
    ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        const preview = createHoverPreview(tui, theme, cwd);
        const current = { cwd, theme };
        session = current;
        const widget = {
          ...preview,
          dispose() {
            if (session === current) session = undefined;
            preview.dispose();
          },
        };
        try {
          // Restored messages may have rendered before Pi started the extension.
          tui.invalidate();
          return widget;
        } catch (error) {
          widget.dispose();
          throw error;
        }
      },
      { placement: "belowEditor" },
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui" || !session) return;
    event.systemPromptOptions.sections.pi_inline_markup =
      "Cite files with Markdown links (#L12-L20 for line ranges); [[label]] is decorative, and [[[label](./path)]] styles a link as a badge.";
  });

  // Pi 1.5.0 does not accept messageTypes registration options.
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (!session || (messageType !== "user" && messageType !== "assistant")) return markdown;
    const { cwd, theme } = session;
    return renderInlineMarkup(markdown, cwd, theme, messageType === "user");
  });
}
