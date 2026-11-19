import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { renderFileLinks } from "./filelinks.ts";
import { createHoverPreview } from "./hover-preview.ts";
import { createWikilinks } from "./wikilinks.ts";

const WIDGET_KEY = "pi-inline-markup.preview";

export default function inlineMarkupExtension(pi: ExtensionAPI): void {
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  let session: { cwd: string; theme: Theme; wiki: ReturnType<typeof createWikilinks> } | undefined;

  pi.on("session_start", (_event, { mode, cwd, ui }) => {
    if (mode !== "tui") return;
    ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        const wiki = createWikilinks(checkout, () => {
          tui.invalidate();
          tui.requestRender();
        });
        const preview = createHoverPreview(tui, theme, cwd, checkout, wiki.findPreview);
        const current = { cwd, theme, wiki };
        session = current;
        const widget = {
          ...preview,
          dispose() {
            if (session === current) session = undefined;
            preview.dispose();
            wiki.dispose();
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

  // Pi 1.5.0 does not accept messageTypes registration options.
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (!session || (messageType !== "user" && messageType !== "assistant")) return markdown;
    const { cwd, theme, wiki } = session;
    return wiki.render(renderFileLinks(markdown, cwd, theme), theme, messageType === "user");
  });
}
