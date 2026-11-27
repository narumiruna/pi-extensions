import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createCodeBlockCopy, supportsCodeBlockCopy } from "./code-block-copy.js";
import { createLinkMarker } from "./external-link-marker.js";
import { createHoverPreview } from "./hover-preview.js";
import { renderInlineMarkup } from "./inline-markup.js";
import {
  type CodeBlockCopyButtonPosition,
  type CodeBlockCopyMode,
  DEFAULT_CODE_BLOCK_COPY_BUTTON_POSITION,
  loadPromptSettings,
  type PromptHintSettings,
  saveCodeBlockCopyButtonPosition,
  saveCodeBlockCopyMode,
  savePromptHint,
} from "./settings.js";
import { showInlineSettings } from "./settings-menu.js";
import { createWikilinks } from "./wikilinks.js";

const WIDGET_KEY = "pi-inline-markup.preview";

interface Session {
  cwd: string;
  theme: Theme;
  tui: TUI;
  owner: ExtensionContext["sessionManager"];
  marker: ReturnType<typeof createLinkMarker>;
  copy: ReturnType<typeof createCodeBlockCopy>;
  codeBlockCopyMode: CodeBlockCopyMode;
  codeBlockCopyButtonPosition: CodeBlockCopyButtonPosition;
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
    const marker = createLinkMarker();
    const indent = pi.getSettings?.().markdown?.codeBlockIndent;
    let dispose: (() => void) | undefined;
    try {
      ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          const copy = createCodeBlockCopy(tui, theme, indent, copyToClipboard, (success) => {
            if (hasUI && session === current) {
              ui.notify(success ? "Code copied" : "Could not copy the code block.", success ? "info" : "error");
            }
          });
          const preview = createHoverPreview(tui, theme, cwd, (href) => current.wiki?.findPreview(href), marker, copy);
          const current: Session = {
            cwd,
            theme,
            tui,
            owner: sessionManager,
            marker,
            copy,
            codeBlockCopyMode: "off",
            codeBlockCopyButtonPosition: DEFAULT_CODE_BLOCK_COPY_BUTTON_POSITION,
            clearWidget: () => ui.setWidget(WIDGET_KEY, undefined),
            dismissPreview: preview.dismiss,
          };
          session = current;
          dispose = () => {
            if (settings.signal.aborted) return;
            if (session === current) session = undefined;
            settings.abort();
            current.menu?.abort();
            marker.clear();
            copy.dispose();
            preview.dispose();
            current.wiki?.dispose();
            current.wiki = undefined;
          };
          // Restored messages may have rendered before Pi started the extension.
          tui.invalidate();
          return { ...preview, dispose };
        },
        { placement: "belowEditor" },
      );
      const snapshot = await loadPromptSettings(settings.signal);
      if (settings.signal.aborted || session?.marker !== marker) return;
      session.prompt = snapshot.prompt;
      session.codeBlockCopyMode = snapshot.codeBlockCopyMode;
      session.codeBlockCopyButtonPosition = snapshot.codeBlockCopyButtonPosition;
      session.copy.setButtonPosition(snapshot.codeBlockCopyButtonPosition);
      session.copy.setMode(snapshot.codeBlockCopyMode);
      if (snapshot.saveBlocked && hasUI)
        ui.notify("pi-inline: Invalid or unreadable settings were ignored.", "warning");
    } catch (error) {
      if (session?.marker === marker) {
        const { clearWidget } = session;
        dispose?.();
        clearWidget();
      }
      throw error;
    }
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
    async function applyCopySetting(signal: AbortSignal, save: () => Promise<boolean>, apply: () => void) {
      if (!live() || signal.aborted) return false;
      const pending = save();
      writes.add(pending);
      try {
        const committed = await pending;
        if (session !== current || (!committed && signal.aborted)) return false;
        apply();
        return true;
      } finally {
        writes.delete(pending);
      }
    }
    try {
      const saved = await loadPromptSettings(menu.signal);
      if (!live()) return;
      let savedCopyMode = saved.codeBlockCopyMode;
      let savedButtonPosition = saved.codeBlockCopyButtonPosition;
      const changed = await showInlineSettings(ctx, {
        signal: menu.signal,
        wikilinks: Boolean(current.wiki),
        setWikilinks: (enabled) => {
          if (live()) setWikilinks(current, enabled);
        },
        saved: saved.prompt,
        active,
        saveBlocked: Boolean(saved.saveBlocked),
        codeBlockCopyMode: current.codeBlockCopyMode,
        codeBlockCopyButtonPosition: current.codeBlockCopyButtonPosition,
        canCopyCodeBlocks: supportsCodeBlockCopy(),
        saveCodeBlockCopyMode: (mode, signal) =>
          applyCopySetting(
            signal,
            () => saveCodeBlockCopyMode(savedCopyMode, mode, signal),
            () => {
              savedCopyMode = mode;
              current.codeBlockCopyMode = mode;
              current.copy.setMode(mode);
            },
          ),
        saveCodeBlockCopyButtonPosition: (position, signal) =>
          applyCopySetting(
            signal,
            () => saveCodeBlockCopyButtonPosition(savedButtonPosition, position, signal),
            () => {
              savedButtonPosition = position;
              current.codeBlockCopyButtonPosition = position;
              current.copy.setButtonPosition(position);
            },
          ),
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

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui" || !session || session.owner !== ctx.sessionManager || !session.prompt?.enabled) return;
    event.systemPromptOptions.sections.inline_formatting = session.prompt.text;
  });

  // Pi 1.5.0 does not accept messageTypes registration options.
  pi.registerMarkdownTransformer((markdown, context) => {
    const { messageType } = context;
    if (!session || (messageType !== "user" && messageType !== "assistant")) return markdown;
    const { cwd, theme, wiki, marker, copy } = session;
    const decorated = renderInlineMarkup(markdown, cwd, theme, messageType === "user", wiki, marker);
    return copy.transform(decorated, context);
  });
}
