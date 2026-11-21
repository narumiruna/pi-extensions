import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createExternalLinkMarker } from "./external-link-marker.js";
import { createHoverPreview } from "./hover-preview.js";
import { renderInlineMarkup } from "./inline-markup.js";
import { loadPromptSettings, type PromptHintSettings, savePromptHint } from "./settings.js";
import { showInlineSettings } from "./settings-menu.js";
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
  prompt?: PromptHintSettings;
}

function setWikilinks(session: Session, enabled: boolean): void {
  if (enabled === Boolean(session.wiki)) return;
  session.dismissPreview();
  if (enabled) {
    session.wiki = createWikilinks(session.cwd, () => {
      session.tui.invalidate();
      session.tui.requestRender();
    });
  } else {
    session.wiki?.dispose();
    session.wiki = undefined;
  }
  session.tui.invalidate();
  session.tui.requestRender();
}

export function inlineMarkupExtension(pi: ExtensionAPI): void {
  let session: Session | undefined;
  const writes = new Set<Promise<boolean>>();

  pi.on("session_start", async (_event, { mode, cwd, ui, hasUI, sessionManager }) => {
    session?.clearWidget();
    if (mode !== "tui") return;
    const settings = new AbortController();
    const marker = createExternalLinkMarker();
    ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        const preview = createHoverPreview(tui, theme, cwd, (href) => current.wiki?.findPreview(href), marker);
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
    const snapshot = await loadPromptSettings(settings.signal);
    if (settings.signal.aborted || session?.marker !== marker) return;
    session.prompt = snapshot.prompt;
    if (snapshot.saveBlocked && hasUI) ui.notify("pi-inline: Invalid or unreadable settings were ignored.", "warning");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (session && session.owner === ctx.sessionManager) session.clearWidget();
    // The host may already have disposed the widget. Wait for writes that reached publication.
    await Promise.allSettled(writes);
  });

  async function handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (args.trim()) throw new Error("Usage: /inline (no arguments)");
    if (ctx.mode !== "tui") throw new Error("/inline is available only in the terminal UI.");
    const current = session;
    const active = current?.prompt;
    if (!current || !active || current.owner !== ctx.sessionManager || current.menu) return;
    const menu = new AbortController();
    current.menu = menu;
    const live = () => session === current && current.menu === menu && !menu.signal.aborted;
    try {
      const saved = await loadPromptSettings(menu.signal);
      if (!live()) return;
      const changed = await showInlineSettings(ctx, {
        signal: menu.signal,
        wikilinks: Boolean(current.wiki),
        setWikilinks: (enabled) => {
          if (live()) setWikilinks(current, enabled);
        },
        saved: saved.prompt,
        active,
        saveBlocked: Boolean(saved.saveBlocked),
        async save(change, signal) {
          if (!live() || signal.aborted) return false;
          const pending = savePromptHint(saved.prompt, change, signal);
          writes.add(pending);
          try {
            return await pending;
          } finally {
            writes.delete(pending);
          }
        },
      });
      if (!changed || !live()) return;
      if (changed === "saved-after-cancel") {
        ctx.ui.notify("The prompt hint was saved. Run /reload to apply it.", "info");
        return;
      }
      const reload = await ctx.ui.confirm("Reload Pi now?", "The prompt hint setting was saved.", {
        signal: menu.signal,
      });
      if (!reload || !live()) return;
      try {
        await ctx.reload();
        return;
      } catch {
        if (live())
          ctx.ui.notify("The prompt hint was saved, but Pi could not reload. Run /reload to apply it.", "error");
      }
    } finally {
      if (current.menu === menu) current.menu = undefined;
      menu.abort();
    }
  }

  pi.registerCommand("inline", { description: "Configure inline markup and the prompt hint", handler });
  pi.registerCommand("inline-markup", { description: "Open /inline (compatibility alias)", handler });

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui" || !session || session.owner !== ctx.sessionManager || !session.prompt?.enabled) return;
    event.systemPromptOptions.sections.inline_formatting = session.prompt.text;
  });

  // Pi 1.5.0 does not accept messageTypes registration options.
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (!session || (messageType !== "user" && messageType !== "assistant")) return markdown;
    const { cwd, theme, wiki, marker } = session;
    return renderInlineMarkup(markdown, cwd, theme, messageType === "user", wiki, marker);
  });
}
