import { createHmac, randomBytes } from "node:crypto";
import { getMarkdownTheme, type MarkdownTransformContext, type Theme, VERSION } from "@earendil-works/pi-coding-agent";
import {
  type DefaultTextStyle,
  Markdown,
  Marked,
  stripTerminalSequences,
  type TUI,
  type TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { CodeBlockCopyMode } from "./settings.js";

const parser = new Marked();
const BUTTON = "[Copy]";
const COPY_DELAY = 501;
const MARKER_OPEN = "\x1b]8;id=pi-inline-code-";
const MARKER_CLOSE = "\x1b]8;id=pi-inline-code-end;\x07";
const RESET_FG = "\x1b[39m";
const MARKER = new RegExp(
  String.raw`${MARKER_OPEN.replace("]", "\\]")}([a-f0-9]{64})-(\d+)-([cbr])-(\d+)-(\d+);\x07${RESET_FG.replace("[", "\\[")}`,
);
const SGR = "\x1b[<";
const PRIMARY = /^(0|3);(\d+);(\d+)([Mm])$/;

export function supportsCodeBlockCopy(version = VERSION): boolean {
  return version === "1.6.0" || version === "1.6.1";
}

function fullscreen(tui: TUI): TuiAltScreen | undefined {
  const viewport = tui as TuiAltScreen;
  return tui.mode === "fullscreen" &&
    typeof viewport.getScreenLines === "function" &&
    typeof viewport.hasActiveSelection === "function" &&
    typeof viewport.viewportTop === "number"
    ? viewport
    : undefined;
}

function fencedText(raw: string, text: string): string | undefined {
  if (!text.trim() || /(?![\n\t])\p{Cc}/u.test(raw)) return;
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(raw)?.[1];
  const finalLine = raw.replace(/\n$/u, "").split("\n").at(-1) ?? "";
  const closing = /^ {0,3}(`{3,}|~{3,}) *$/.exec(finalLine)?.[1];
  if (opening && closing && closing[0] === opening[0] && closing.length >= opening.length) return text;
}

function codePositions(source: string): Map<number, string> {
  const positions = new Map<number, string>();
  let cursor = 0;
  for (const token of parser.lexer(source)) {
    const start = source.indexOf(token.raw, cursor);
    if (start === -1) return new Map();
    cursor = start + token.raw.length;
    if (token.type === "code") positions.set(start, token.raw);
  }
  return positions;
}

function markedRow(id: string, index: number, kind: "c" | "b" | "r", line: string): string {
  const text = stripTerminalSequences(line);
  const left = visibleWidth(text.match(/^\s*/u)?.[0] ?? "");
  const right = visibleWidth(text.trimEnd());
  const escaped = line.replaceAll("<!--", `<${MARKER_CLOSE}!--`);
  return `<!-- -->${MARKER_OPEN}${id}-${index}-${kind}-${left}-${right};\x07${RESET_FG}${escaped}${MARKER_CLOSE}`;
}

function withoutMarker(
  line: string,
  marker: RegExpExecArray,
  foreground: { prefix: string; suffix: string },
): string | undefined {
  let before = line.slice(0, marker.index);
  let after = line.slice(marker.index + marker[0].length);
  if (!before.endsWith(foreground.prefix)) return;
  before = before.slice(0, before.length - foreground.prefix.length);
  const closeAt = after.lastIndexOf(MARKER_CLOSE);
  if (closeAt === -1 || !after.startsWith(foreground.suffix, closeAt + MARKER_CLOSE.length)) return;
  after = after.slice(0, closeAt) + after.slice(closeAt + MARKER_CLOSE.length + foreground.suffix.length);
  return before + after.replaceAll(MARKER_CLOSE, "");
}

export function createCodeBlockCopy(
  tui: TUI,
  theme: Theme,
  codeBlockIndent: string | undefined,
  write: (text: string) => Promise<void>,
  notify: (success: boolean) => void,
  supported = supportsCodeBlockCopy(),
) {
  const key = randomBytes(32);
  const sources = new Map<string, string>();
  let mode: CodeBlockCopyMode = "off";
  let generation = 0;
  let disposed = false;
  let writing = false;
  let pressed: string | undefined;
  let gesture = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  function clearGesture(): void {
    gesture++;
    pressed = undefined;
    clearTimeout(pending);
    pending = undefined;
  }

  function setMode(next: CodeBlockCopyMode): void {
    if (next === mode) return;
    mode = next;
    generation++;
    clearGesture();
    sources.clear();
    if (supported && !disposed && fullscreen(tui)) {
      tui.invalidate();
      tui.requestRender();
    }
  }

  function transform(source: string, context: MarkdownTransformContext): string {
    if (
      !supported ||
      disposed ||
      mode === "off" ||
      context.isStreaming ||
      (context.messageType !== "assistant" && context.messageType !== "user") ||
      !fullscreen(tui)
    )
      return source;
    const width = context.availableWidth;
    if (
      !(width >= 1) ||
      (mode === "button" && width < BUTTON.length) ||
      (!source.includes("```") && !source.includes("~~~"))
    )
      return source;
    const normalized = source.replace(/\r\n?/g, "\n");
    const tokens = parser.lexer(normalized);
    const expanded = normalized.includes("\t") ? codePositions(normalized.replaceAll("\t", "   ")) : undefined;
    const markdownTheme = { ...getMarkdownTheme(), codeBlockIndent };
    const color = (content: string) => theme.fg("userMessageText", content);
    const user = context.messageType === "user";
    const style: DefaultTextStyle | undefined = user
      ? {
          color,
          bgColor: (content) => theme.bg("userMessageBg", content),
        }
      : undefined;
    const foreground = user ? color("\0").split("\0") : ["", ""];
    const options = user ? { preserveOrderedListMarkers: true, preserveBackslashEscapes: true } : undefined;
    const accepted = new Map<string, string>();
    let cursor = 0;
    let expandedOffset = 0;
    let copied = 0;
    let output = "";
    let markedRows = 0;
    for (const [index, token] of tokens.entries()) {
      const start = normalized.indexOf(token.raw, cursor);
      if (start === -1) return source;
      let displayStart = start;
      if (expanded) {
        expandedOffset += 2 * (normalized.slice(cursor, start).match(/\t/g)?.length ?? 0);
        displayStart += expandedOffset;
        expandedOffset += 2 * (token.raw.match(/\t/g)?.length ?? 0);
      }
      cursor = start + token.raw.length;
      if (token.type !== "code" || (expanded && expanded.get(displayStart) !== token.raw.replaceAll("\t", "   ")))
        continue;
      const text = fencedText(token.raw, token.text);
      if (text === undefined) continue;
      const id = createHmac("sha256", key).update(`${generation}\0${start}\0${text}`).digest("hex");
      const rows = new Markdown(token.raw, 0, 0, markdownTheme).render(width);
      const stamped = rows.map((line, row) => markedRow(id, row, mode === "click" ? "c" : "r", line));
      if (mode === "button") stamped.push(markedRow(id, rows.length, "b", theme.fg("accent", BUTTON)));
      output += normalized.slice(copied, start) + stamped.join("\n");
      if (tokens[index + 1] && tokens[index + 1].type !== "space") {
        output += token.raw.endsWith("\n") ? "\n\n" : "\n";
      }
      copied = cursor;
      markedRows += stamped.length;
      accepted.set(id, text);
    }
    if (!markedRows) return source;
    output += normalized.slice(copied);
    const original = new Markdown(source, 0, 0, markdownTheme, style, options).render(width);
    const decorated = new Markdown(output, 0, 0, markdownTheme, style, options).render(width);
    let count = 0;
    let originalRow = 0;
    for (const line of decorated) {
      const marker = MARKER.exec(line);
      if (!marker) {
        if (line !== original[originalRow++]) return source;
        continue;
      }
      if (!accepted.has(marker[1])) return source;
      count++;
      const clean = withoutMarker(line, marker, { prefix: foreground[0], suffix: foreground[1] });
      if (marker[3] === "b") {
        if (clean === undefined || stripTerminalSequences(clean).trim() !== BUTTON) return source;
      } else if (clean === undefined || clean !== original[originalRow++]) return source;
    }
    if (count !== markedRows || originalRow !== original.length) return source;
    for (const [id, text] of accepted) sources.set(id, text);
    return output;
  }

  function target(x: number, y: number) {
    const viewport = fullscreen(tui);
    if (
      !viewport ||
      viewport.hasOverlay() ||
      x < 0 ||
      y < 0 ||
      x >= viewport.terminal.columns ||
      y >= viewport.terminal.rows
    )
      return;
    const line = viewport.getScreenLines()[y] ?? "";
    const match = MARKER.exec(line);
    if (!match || match[3] !== (mode === "click" ? "c" : "b")) return;
    const text = sources.get(match[1]);
    if (text === undefined) return;
    const start = visibleWidth(line.slice(0, match.index));
    if (x < start + Number(match[4]) || x >= start + Number(match[5])) return;
    return {
      text,
      viewport,
      id: `${match[1]}:${match[2]}:${x}:${y}:${viewport.terminal.columns}:${viewport.terminal.rows}:${viewport.viewportTop}`,
    };
  }

  async function copy(text: string): Promise<void> {
    if (writing || disposed) return;
    const active = generation;
    writing = true;
    let success = false;
    try {
      await write(text);
      success = true;
    } catch {
      success = false;
    } finally {
      writing = false;
    }
    if (!disposed && active === generation && fullscreen(tui)) notify(success);
  }

  function observe(input: string): void {
    if (!supported || disposed || mode === "off") return;
    const report = input.startsWith(SGR) && PRIMARY.exec(input.slice(SGR.length));
    if (!report || (report[1] === "3" && report[4] !== "m")) {
      clearGesture();
      return;
    }
    const x = Number(report[2]) - 1;
    const y = Number(report[3]) - 1;
    const current = target(x, y);
    if (report[4] === "M") {
      clearGesture();
      pressed = current?.id;
      return;
    }
    const original = pressed;
    clearGesture();
    if (!current || original !== current.id) return;
    const activate = () => {
      pending = undefined;
      const fresh = target(x, y);
      if (!disposed && fresh?.id === original && !fresh.viewport.hasActiveSelection()) void copy(current.text);
    };
    if (mode === "button") {
      const action = gesture;
      queueMicrotask(() => {
        if (gesture === action) activate();
      });
    } else {
      pending = setTimeout(activate, COPY_DELAY);
    }
  }

  return {
    setMode,
    transform,
    observe,
    clearGesture,
    dispose() {
      disposed = true;
      generation++;
      clearGesture();
      sources.clear();
    },
  };
}
