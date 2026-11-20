import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createHoverPreview } from "./hover-preview.ts";
import { renderInlineMarkup } from "./inline-markup.ts";
import { createWikilinks } from "./wikilinks.ts";

const WIDGET_KEY = "pi-inline-markup.preview";

interface Session {
  cwd: string;
  theme: Theme;
  tui: TUI;
  dismissPreview(): void;
  wiki?: ReturnType<typeof createWikilinks>;
  menu?: AbortController;
}

export default function inlineMarkupExtension(pi: ExtensionAPI): void {
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  let session: Session | undefined;

  pi.on("session_start", (_event, { mode, cwd, ui }) => {
    if (mode !== "tui") return;
    ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        const preview = createHoverPreview(tui, theme, cwd, checkout, (href) => current.wiki?.findPreview(href));
        const current: Session = { cwd, theme, tui, dismissPreview: preview.dismiss };
        session = current;
        const widget = {
          ...preview,
          dispose() {
            if (session === current) session = undefined;
            current.menu?.abort();
            preview.dispose();
            current.wiki?.dispose();
            current.wiki = undefined;
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

  pi.registerCommand("inline-markup", {
    description: "Turn wikilinks on or off for this session",
    async handler(args, ctx) {
      if (args.trim()) throw new Error("Usage: /inline-markup (no arguments)");
      if (ctx.mode !== "tui") throw new Error("/inline-markup is available only in the terminal UI.");
      const current = session;
      if (!current || current.menu) return;
      const menu = new AbortController();
      current.menu = menu;
      try {
        const choice = await ctx.ui.select(`Wikilinks: ${current.wiki ? "On" : "Off"} (this session)`, ["On", "Off"], {
          signal: menu.signal,
        });
        if (session !== current || menu.signal.aborted || (choice !== "On" && choice !== "Off")) return;
        if ((choice === "On") === Boolean(current.wiki)) return;

        current.dismissPreview();
        if (choice === "On") {
          current.wiki = createWikilinks(checkout, () => {
            current.tui.invalidate();
            current.tui.requestRender();
          });
        } else {
          current.wiki?.dispose();
          current.wiki = undefined;
        }
        current.tui.invalidate();
        current.tui.requestRender();
      } finally {
        current.menu = undefined;
      }
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui" || !session) return;
    event.systemPromptOptions.sections.pi_inline_markup =
      "Cite files with Markdown links (#L12-L20 for line ranges); [[label]] is decorative unless wikilinks are enabled, and [[[label](./path)]] styles a link as a badge.";
  });

  // Pi 1.5.0 does not accept messageTypes registration options.
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (!session || (messageType !== "user" && messageType !== "assistant")) return markdown;
    const { cwd, theme, wiki } = session;
    return renderInlineMarkup(markdown, cwd, theme, messageType === "user", wiki);
  });
}
