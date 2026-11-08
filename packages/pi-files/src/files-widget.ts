import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { FileQuote } from "./file-context.js";
import { displayPath } from "./scope/display.js";
import type { ScopeView } from "./scope/menu.js";

/** One owned widget; context summaries never replace an active restriction. */
export function publishFilesWidget(ctx: ExtensionContext, quotes: readonly FileQuote[], scope?: ScopeView): void {
  if (!ctx.hasUI) return;
  if (!quotes.length && (!scope || scope.state === "inactive")) {
    ctx.ui.setWidget("files", undefined);
    return;
  }
  const totalBytes = quotes.reduce((total, quote) => total + Buffer.byteLength(quote.text, "utf8"), 0);
  const lines: Array<{ role: "accent" | "muted" | "error"; text: string }> = [];
  if (scope && scope.state !== "inactive") {
    lines.push({
      role: scope.state === "blocked" ? "error" : "accent",
      text: `${scope.state === "blocked" ? "Edit Scope unavailable · edits blocked" : `Editing limited to ${scope.targets.length} file${scope.targets.length === 1 ? "" : "s"}`} · /files off`,
    });
    lines.push({
      role: "muted",
      text: `${scope.targets
        .slice(0, 2)
        .map((target) => displayPath(target.path))
        .join(" · ")}${scope.targets.length > 2 ? " · …" : ""}`,
    });
  }
  if (quotes.length) {
    lines.push({
      role: "accent",
      text: `Next prompt context · ${quotes.length} ${quotes.length === 1 ? "snippet" : "snippets"} · ~${Math.max(1, Math.ceil(totalBytes / 4))} tokens · /file-context to review`,
    });
    lines.push(
      ...quotes.map((quote, index) => ({
        role: "muted" as const,
        text: `${index + 1}. ${sanitizeTerminalText(escapeControls(quote.path))} · lines ${quote.startLine}-${quote.endLine} · ~${Math.max(1, Math.ceil(Buffer.byteLength(quote.text, "utf8") / 4))} tokens`,
      })),
    );
  }
  const render = (theme: Pick<Theme, "fg">) => lines.map((line) => theme.fg(line.role, line.text));
  if (ctx.mode !== "tui") {
    ctx.ui.setWidget("files", render(ctx.ui.theme));
    return;
  }
  ctx.ui.setWidget(
    "files",
    (_tui, theme) =>
      new EditorStatusWidget({
        theme,
        renderBody: (width) =>
          width === 0 ? lines.map(() => "") : render(theme).flatMap((line) => wrapTextWithAnsi(line, width)),
      }),
  );
}
function escapeControls(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) ? `\\x${code.toString(16).padStart(2, "0")}` : character;
    })
    .join("");
}
