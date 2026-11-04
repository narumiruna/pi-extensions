import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { runCustomInteraction } from "@narumitw/pi-tui-kit";
import { displayError, displayPath, exactRows, scopeFrame } from "./display.js";
import { resolveScopeTarget, type ScopeTarget } from "./paths.js";

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** Public Input editing with paste-aware screen dispatch and display-only control masking. */
export class ScopeInput {
  readonly input = new Input();
  private pasting = false;
  private pasteTail = "";
  private discardPaste = false;

  handleInput(data: string, action: (key: string) => boolean, editable = true): void {
    if (this.pasting || data.includes(PASTE_START)) {
      if (!this.pasting) this.discardPaste = !editable;
      const combined = this.pasteTail + data;
      const start = this.pasting ? 0 : combined.indexOf(PASTE_START) + PASTE_START.length;
      const end = combined.indexOf(PASTE_END, start);
      if (end < 0) {
        this.pasting = true;
        this.pasteTail = combined.slice(-5);
        if (!this.discardPaste) this.input.handleInput(data);
        return;
      }
      const consumed = end + PASTE_END.length - this.pasteTail.length;
      if (!this.discardPaste) this.input.handleInput(data.slice(0, consumed));
      this.pasting = false;
      this.discardPaste = false;
      this.pasteTail = "";
      const remaining = data.slice(consumed);
      if (remaining) this.handleInput(remaining, action, editable);
      return;
    }
    if (!action(data) && editable) this.input.handleInput(data);
  }

  render(width: number): string[] {
    return this.withDisplayValue(() => this.input.render(width));
  }

  handleMouse(event: TuiMouseEvent) {
    return this.withDisplayValue(() => this.input.handleMouse(event));
  }

  private withDisplayValue<T>(operation: () => T): T {
    const raw = this.input.getValue();
    // Native rendering and hit-testing must measure the same masked graphemes.
    // Equal UTF-16 length preserves cursor offsets; only the display value changes.
    const safe = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => "�".repeat(character.length));
    this.input.setValue(safe);
    try {
      return operation();
    } finally {
      this.input.setValue(raw);
    }
  }
}

type PathInputValue = { kind: "selected"; target: ScopeTarget } | { kind: "cancelled"; reason: "back" | "close" };

interface PathInputOptions {
  cwd: string;
  signal: AbortSignal;
  isCurrent(): boolean;
}

export function showScopePathInput(ctx: ExtensionCommandContext, options: PathInputOptions) {
  return runCustomInteraction<PathInputValue>(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    create: ({ tui, theme, keybindings, signal: ownerSignal, complete }) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ownerSignal]);
      const editor = new ScopeInput();
      let error = "";
      let pending = Promise.resolve();
      let submitting = false;
      let disposed = false;
      let closing = false;
      let focused = false;
      let inputRow: number | undefined;
      let frameWidth = 0;
      const current = () => {
        if (disposed || closing || signal.aborted) return false;
        if (options.isCurrent()) return true;
        closing = true;
        // Calling the public completion boundary with stale ownership makes
        // runCustomInteraction settle as stale and drain this component.
        complete({ kind: "cancelled", reason: "close" });
        controller.abort();
        return false;
      };
      const close = (value: PathInputValue) => {
        if (!current()) return;
        closing = true;
        complete(value);
        controller.abort();
      };
      const submit = () => {
        if (!current() || submitting) return;
        submitting = true;
        error = "";
        const draft = editor.input.getValue();
        pending = (async () => {
          try {
            const resolved = await resolveScopeTarget(draft, options.cwd, "new", signal);
            if (!current()) return;
            close({ kind: "selected", target: resolved });
          } catch (failure) {
            if (current()) error = displayError(failure);
          } finally {
            submitting = false;
            if (current()) tui.requestRender();
          }
        })();
      };
      editor.input.onSubmit = submit;
      editor.input.onEscape = () => close({ kind: "cancelled", reason: "back" });
      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          editor.input.focused = value;
        },
        render(width: number) {
          inputRow = undefined;
          frameWidth = width;
          const safeWidth = Math.max(1, width);
          const content = [
            ...editor.render(safeWidth),
            ...exactRows(`Draft: ${displayPath(editor.input.getValue())}`, safeWidth).map((line) =>
              theme.fg("muted", line),
            ),
            ...(error ? exactRows(error, safeWidth).map((line) => theme.fg("error", line)) : []),
            ...(submitting ? [theme.fg("dim", "Checking target…")] : []),
          ];
          const priorities = [0, ...(error ? [content.length - 1] : [])];
          // No key hints: public host listeners may consume configured keys before
          // component dispatch. No replacement shortcuts or fallback keys are added.
          const frame = scopeFrame(
            tui,
            theme,
            width,
            "New file",
            [
              `Cwd: ${displayPath(options.cwd)}`,
              "Use a cwd-relative or full path. Submit to review; no file content is created here.",
            ],
            content,
            priorities,
            0,
          );
          inputRow = frame.contentRows.find((row) => row.contentIndex === 0)?.frameIndex;
          return frame.lines;
        },
        handleInput(data: string) {
          if (!current()) return;
          const action = (key: string) => {
            if (matchesKey(key, "ctrl+c")) close({ kind: "cancelled", reason: "close" });
            else if (keybindings.matches(key, "tui.select.cancel")) close({ kind: "cancelled", reason: "back" });
            else return false;
            return true;
          };
          editor.handleInput(data, action, !submitting);
          tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent) {
          if (!current() || submitting || event.width !== frameWidth || event.y !== inputRow) return;
          return editor.handleMouse({ ...event, y: 0, height: 1 });
        },
        invalidate() {
          inputRow = undefined;
          editor.input.invalidate();
        },
        waitForPending: () => pending,
        dispose() {
          if (disposed) return;
          disposed = true;
          controller.abort();
        },
      };
    },
  });
}
