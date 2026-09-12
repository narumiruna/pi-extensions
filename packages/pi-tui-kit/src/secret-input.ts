import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  type Focusable,
  Key,
  type KeybindingsManager,
  matchesKey,
  Text,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { runCustomInteraction } from "./custom-interaction.js";
import { formatInteractionHints } from "./interaction-hints.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { MenuCloseReason, MenuContext } from "./types.js";

type ExtensionMode = MenuContext["mode"];

export interface RunSecretInputOptions<Context extends MenuContext = ExtensionCommandContext> {
  title: string;
  required?: boolean;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
  onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

export type RunSecretInputResult =
  | { kind: "submitted"; value: string }
  | { kind: "closed"; reason: MenuCloseReason }
  | { kind: "stale" }
  | { kind: "unsupported"; mode: ExtensionMode }
  | { kind: "error"; error: unknown };

type SecretInputValue = { kind: "submitted"; value: string } | { kind: "closed"; reason: MenuCloseReason };

/** Collect one masked secret without falling back to a plaintext dialog. */
export async function runSecretInput<Context extends MenuContext = ExtensionCommandContext>(
  ctx: Context,
  options: RunSecretInputOptions<Context>,
): Promise<RunSecretInputResult> {
  const result = await runCustomInteraction<SecretInputValue, Context>(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: options.onError,
    onUnsupportedMode: options.onUnsupportedMode,
    create: ({ tui, theme, keybindings, complete }) => {
      const title = sanitizeTerminalText(options.title);
      const ui = ctx.ui as ExtensionCommandContext["ui"];
      const heading = new Text("", 0, 0);
      const hint = new Text("", 0, 0);
      const input = new MaskedInput(keybindings);
      let inputRow = -1;
      let renderedWidth = 0;
      const interactionHint = formatInteractionHints(keybindings, [
        {
          keys: keybindings.getKeys("tui.input.submit").filter((key) => !hasControlCharacter(key)),
          label: "continue",
        },
        {
          keys: [...keybindings.getKeys("tui.select.cancel").filter((key) => !hasControlCharacter(key)), "ctrl+c"],
          label: "cancel",
        },
      ]);
      const applyTheme = () => {
        heading.setText(theme.fg("accent", theme.bold(title)));
        hint.setText(theme.fg("dim", `${interactionHint} • Input is hidden`));
      };
      const cancel = (reason: MenuCloseReason) => complete({ kind: "closed", reason });
      applyTheme();
      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render(width: number) {
          const safeWidth = Math.max(1, width);
          const headingLines = heading.render(safeWidth);
          inputRow = headingLines.length;
          renderedWidth = safeWidth;
          return [...headingLines, ...input.render(safeWidth), ...hint.render(safeWidth)].map((line) =>
            truncateToWidth(line, safeWidth),
          );
        },
        invalidate() {
          inputRow = -1;
          renderedWidth = 0;
          applyTheme();
          heading.invalidate();
          input.invalidate();
          hint.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.ctrl("c"))) cancel("close");
          else if (input.isPasting || data.includes("\u001b[200~")) input.handleInput(data);
          else if (keybindings.matches(data, "tui.select.cancel")) cancel("back");
          else if (keybindings.matches(data, "tui.input.submit")) {
            const value = input.getValue();
            if (options.required !== false && value.length === 0) {
              ui.notify(`${title} is required. Enter a value, or cancel.`, "warning");
            } else if (hasControlCharacter(value)) {
              ui.notify(
                `${title} contains control characters. Remove them or re-enter the value, then continue.`,
                "warning",
              );
            } else complete({ kind: "submitted", value });
          } else input.handleInput(data);
          tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent) {
          if (event.width !== renderedWidth || event.y !== inputRow) return undefined;
          return input.handleMouse({ ...event, y: 0, width: renderedWidth, height: 1 });
        },
        dispose() {
          inputRow = -1;
          renderedWidth = 0;
          input.clear();
        },
      } satisfies Focusable & {
        render(width: number): string[];
        invalidate(): void;
        handleInput(data: string): void;
        handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
        dispose(): void;
      };
    },
  });
  return result.kind === "completed" ? result.value : result;
}

class MaskedInput implements Focusable {
  focused = false;
  private value: string[] = [];
  private cursor = 0;
  private paste = "";
  private pasting = false;
  private renderedStart = 0;
  private renderedCount = 0;

  constructor(private readonly keybindings: KeybindingsManager) {}

  get isPasting() {
    return this.pasting;
  }

  getValue() {
    return this.value.join("");
  }

  handleInput(data: string) {
    if (data.includes("\u001b[200~")) {
      this.pasting = true;
      this.paste = "";
      data = data.replace("\u001b[200~", "");
    }
    if (this.pasting) {
      this.paste += data;
      const end = this.paste.indexOf("\u001b[201~");
      if (end < 0) return;
      const pasted = this.paste
        .slice(0, end)
        .replace(/[\r\n]/gu, "")
        .replace(/\t/gu, "    ");
      this.insert(pasted);
      const remaining = this.paste.slice(end + 6);
      this.paste = "";
      this.pasting = false;
      if (remaining) this.handleInput(remaining);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      if (this.cursor > 0) this.value.splice(--this.cursor, 1);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteCharForward")) {
      if (this.cursor < this.value.length) this.value.splice(this.cursor, 1);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) {
      this.cursor = 0;
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorLineEnd")) {
      this.cursor = this.value.length;
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteToLineStart")) {
      this.value.splice(0, this.cursor);
      this.cursor = 0;
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.deleteToLineEnd")) {
      this.value.splice(this.cursor);
      return;
    }
    const printable = decodeKittyPrintable(data) ?? data;
    if (!hasControlCharacter(printable)) this.insert(printable);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "press" || event.button !== "left") return undefined;
    const target = this.renderedStart + Math.max(0, Math.min(this.renderedCount, event.x - 2));
    this.cursor = Math.max(0, Math.min(this.value.length, target));
    return { handled: true, focus: true };
  }

  render(width: number) {
    const prompt = "> ";
    const available = width - prompt.length;
    if (available <= 0) {
      this.renderedStart = 0;
      this.renderedCount = 0;
      return [truncateToWidth(prompt, Math.max(1, width))];
    }
    const contentWidth = Math.max(0, available - 1);
    let start = 0;
    if (this.value.length > contentWidth) {
      start = Math.max(0, Math.min(this.cursor - Math.floor(contentWidth / 2), this.value.length - contentWidth));
    }
    const end = Math.min(this.value.length, start + contentWidth);
    const visibleCursor = Math.max(0, Math.min(this.cursor - start, end - start));
    const masks = Array.from({ length: end - start }, () => "•");
    const before = masks.slice(0, visibleCursor).join("");
    const atCursor = visibleCursor < masks.length ? "•" : " ";
    const after = masks.slice(visibleCursor + (visibleCursor < masks.length ? 1 : 0)).join("");
    const marker = this.focused ? CURSOR_MARKER : "";
    this.renderedStart = start;
    this.renderedCount = end - start;
    return [truncateToWidth(`${prompt}${before}${marker}\u001b[7m${atCursor}\u001b[27m${after}`, width, "")];
  }

  invalidate() {}

  clear() {
    this.value.fill("");
    this.value = [];
    this.paste = "";
    this.cursor = 0;
    this.pasting = false;
    this.renderedStart = 0;
    this.renderedCount = 0;
  }

  private insert(value: string) {
    const graphemes = [...secretGraphemeSegmenter.segment(value)].map(({ segment }) => segment);
    this.value.splice(this.cursor, 0, ...graphemes);
    this.cursor += graphemes.length;
  }
}

const secretGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}
