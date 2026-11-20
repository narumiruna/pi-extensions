import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createExternalLinkMarker } from "./external-link-marker.js";
import type { ExternalPreviewRoot } from "./filelinks.js";
import { createHoverPreview } from "./hover-preview.js";
import { renderInlineMarkup } from "./inline-markup.js";
import { loadPreviewSettings } from "./preview-settings.js";
import { INLINE_FORMATTING_PROMPT } from "./prompt.js";
import { createWikilinks } from "./wikilinks.js";

const WIDGET_KEY = "pi-inline-markup.preview";

interface Session {
  cwd: string;
  theme: Theme;
  tui: TUI;
  owner: ExtensionContext["sessionManager"];
  marker: ReturnType<typeof createExternalLinkMarker>;
  clearWidget(): void;
  dismissPreview(): void;
  wiki?: ReturnType<typeof createWikilinks>;
  menu?: AbortController;
}

export function inlineMarkupExtension(pi: ExtensionAPI): void {
  let session: Session | undefined;

  pi.on("session_start", async (_event, { mode, cwd, ui, hasUI, sessionManager }) => {
    session?.clearWidget();
    if (mode !== "tui") return;
    const settings = new AbortController();
    const marker = createExternalLinkMarker();
    let roots: readonly ExternalPreviewRoot[] = [];
    ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        const preview = createHoverPreview(tui, theme, cwd, (href) => current.wiki?.findPreview(href), {
          marker,
          roots: () => roots,
        });
        const current: Session = {
          cwd,
          theme,
          tui,
          owner: sessionManager,
          marker,
          clearWidget: () => ui.setWidget(WIDGET_KEY, undefined),
          dismissPreview: preview.dismiss,
        };
        session = current;
        const widget = {
          ...preview,
          dispose() {
            if (session === current) session = undefined;
            settings.abort();
            roots = [];
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
    const snapshot = await loadPreviewSettings(settings.signal);
    if (settings.signal.aborted || session?.marker !== marker) return;
    roots = snapshot.roots;
    if (snapshot.invalid && hasUI)
      ui.notify("pi-inline: Invalid or unreadable settings. External previews are off.", "warning");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (session && ctx.mode === "tui" && session.owner === ctx.sessionManager) session.clearWidget();
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
          current.wiki = createWikilinks(current.cwd, () => {
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
    event.systemPromptOptions.sections.inline_formatting = INLINE_FORMATTING_PROMPT;
  });

  // Pi 1.5.0 does not accept messageTypes registration options.
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (!session || (messageType !== "user" && messageType !== "assistant")) return markdown;
    const { cwd, theme, wiki, marker } = session;
    return renderInlineMarkup(markdown, cwd, theme, messageType === "user", wiki, marker);
  });
}
