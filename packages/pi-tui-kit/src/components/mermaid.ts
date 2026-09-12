import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Token, Tokens } from "@earendil-works/pi-tui";
import * as PiTui from "@earendil-works/pi-tui";
import type { MermaidArt, Span } from "grok-mermaid";
import { sanitizeTerminalText } from "../terminal-text.js";
import type { MenuScreen, ReviewFormat } from "../types.js";
import { sanitizeDocumentText } from "./document-sanitization.js";

type MermaidRender = typeof import("grok-mermaid")["render"];
type MermaidTheme = Pick<Theme, "fg" | "bold">;

let renderMermaid: MermaidRender | undefined;
let loadPromise: Promise<void> | undefined;
let loadFailed = false;

export function supportsRichMarkdown() {
  return typeof PiTui.renderLatex === "function" && typeof PiTui.Marked === "function";
}

export function prepareMermaidRenderer(): Promise<void> | undefined {
  if (!supportsRichMarkdown() || renderMermaid || loadFailed) return undefined;
  loadPromise ??= import("grok-mermaid")
    .then((module) => {
      renderMermaid = module.render;
    })
    .catch(() => {
      loadFailed = true;
    });
  return loadPromise;
}

export function prepareMenuScreenRendering<ScreenId extends string, ActionId extends string>(
  screen: MenuScreen<ScreenId, ActionId>,
): Promise<void> | undefined {
  if (screen.kind === "review") {
    return documentNeedsMermaid(screen.content, screen.format) ? prepareMermaidRenderer() : undefined;
  }
  if (screen.kind === "browse") {
    return screen.items.some((item) => documentNeedsMermaid(item.detailDocument?.content, item.detailDocument?.format))
      ? prepareMermaidRenderer()
      : undefined;
  }
  return undefined;
}

export function mermaidMarkdownTransform(theme: MermaidTheme) {
  if (!renderMermaid || !supportsRichMarkdown()) return undefined;
  const markdownParser = new PiTui.Marked();
  return (markdown: string, availableWidth: number) =>
    markdownParser
      .lexer(markdown)
      .map((token) => renderToken(token, availableWidth, theme))
      .join("");
}

function documentNeedsMermaid(content: string | undefined, format: ReviewFormat | undefined) {
  if (
    format?.kind !== "markdown" ||
    format.renderMermaid === false ||
    content === undefined ||
    !supportsRichMarkdown()
  ) {
    return false;
  }
  const markdown = sanitizeDocumentText(content);
  if (!/(?:^|\n)[\t ]{0,3}(?:`{3,}|~{3,})[\t ]*mermaid(?:[\t \n]|$)/iu.test(markdown)) {
    return false;
  }
  return new PiTui.Marked().lexer(markdown).some(isMermaid);
}

function renderToken(token: Token, availableWidth: number, theme: MermaidTheme) {
  if (!isMermaid(token) || !renderMermaid) return token.raw;
  let art: MermaidArt | null;
  try {
    art = renderMermaid(token.text);
  } catch {
    return token.raw;
  }
  if (!art || art.width > Math.max(1, availableWidth)) return token.raw;
  if (art.warnings.length > 0) return warningFallback(token.raw, art.warnings, theme);
  return `${themedLines(art, theme).map(codeSpan).join("  \n")}\n`;
}

function isMermaid(token: Token): token is Tokens.Code {
  return token.type === "code" && token.lang?.trim().split(/\s+/u, 1)[0]?.toLowerCase() === "mermaid";
}

function warningFallback(raw: string, warnings: readonly string[], theme: MermaidTheme) {
  const suffix = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : "";
  const warning = sanitizeTerminalText(`Mermaid diagram not rendered: ${warnings[0] ?? "incomplete source"}${suffix}`);
  return `${raw}\n${codeSpan(theme.fg("warning", warning))}  \n`;
}

function themedLines(art: MermaidArt, theme: MermaidTheme) {
  return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}

function styleSpan(span: Span, theme: MermaidTheme) {
  switch (span.cls) {
    case "border":
      return theme.fg("borderMuted", span.text);
    case "text":
      return theme.fg("text", span.text);
    case "edge":
      return theme.fg("accent", span.text);
    case "edgeLabel":
      return theme.fg("muted", span.text);
    case "title":
      return theme.fg("accent", theme.bold(span.text));
    case "none":
      return span.text;
  }
}

function codeSpan(line: string) {
  const content = line || "\u00a0";
  const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(longestBacktickRun + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}
