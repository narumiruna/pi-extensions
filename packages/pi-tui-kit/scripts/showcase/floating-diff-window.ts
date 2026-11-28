import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKeyRepeat,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { FloatingFrame, type FloatingFrameOptions } from "@narumitw/pi-tui-kit/floating-frame";

type WindowKey = "m" | "u" | "z" | "w";

interface WindowOptions {
  title: string;
  tui: TUI;
  theme: Pick<Theme, "fg" | "bold">;
  keybindings: KeybindingsManager;
  body: FloatingFrameOptions["body"];
  isCurrent(): boolean;
  close(): void;
}

const REVIEW_BINDINGS = [
  "tui.select.cancel",
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
] as const;

function findWindowKey(candidates: readonly WindowKey[], { tui, keybindings }: WindowOptions): WindowKey | undefined {
  const host = getKeybindings();
  return candidates.find((key) =>
    [key, `\x1b[${key.charCodeAt(0)}u`].every(
      (input) =>
        !REVIEW_BINDINGS.some((binding) => keybindings.matches(input, binding)) &&
        !(tui.mode === "fullscreen" && host.matches(input, "tui.altScreen.search")),
    ),
  );
}

export class FloatingDiffWindow extends FloatingFrame {
  constructor(private readonly window: WindowOptions) {
    const { tui, theme, body } = window;
    super({
      getTerminalSize: () => tui.terminal,
      initialBounds: ({ columns, rows }) => {
        const width = Math.floor(columns * 0.9);
        const height = Math.floor(rows * 0.8);
        return { width, height, col: Math.floor((columns - width) / 2), row: Math.floor((rows - height) / 2) };
      },
      minSize: { columns: 24, rows: 5 },
      requestRender: () => tui.requestRender(),
      styleBorder: (text) => theme.fg("border", text),
      styleTitle: (text) => text,
      title: (columns) => this.renderTitle(columns),
      controls: {
        close: () => window.close(),
        enabled: (action) => tui.mode === "fullscreen" || this.keys()[action] !== undefined,
        styleButton: (text) => theme.fg("text", text),
      },
      body,
    });
  }

  override handleInput(input: string): void {
    if (!this.window.isCurrent()) return;
    const { keybindings } = this.window;
    if (matchesKey(input, "ctrl+c") || keybindings.matches(input, "tui.select.cancel")) {
      this.window.close();
      return;
    }
    const { minimize, maximize } = this.keys();
    if (REVIEW_BINDINGS.some((binding) => keybindings.matches(input, binding))) {
      super.handleInput(input);
    } else if (minimize && matchesKey(input, minimize)) {
      if (!isKeyRepeat(input)) this.toggleMinimized();
    } else if (this.mode !== "minimized" && maximize && matchesKey(input, maximize)) {
      if (!isKeyRepeat(input)) this.toggleMaximized();
    } else {
      super.handleInput(input);
    }
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.window.isCurrent()) return super.handleMouse(event);
  }

  private keys() {
    return {
      minimize: findWindowKey(["m", "u"], this.window),
      maximize: findWindowKey(["z", "w"], this.window),
    };
  }

  private renderTitle(columns: number): string {
    const { minimize, maximize } = this.keys();
    const hints =
      this.mode === "minimized"
        ? [minimize && `${minimize} restore`, "ctrl+c close"]
        : [
            minimize && `${minimize} minimize`,
            maximize && `${maximize} ${this.mode === "maximized" ? "restore size" : "maximize"}`,
          ];
    const { theme, title } = this.window;
    const heading = ` ${title}`;
    let hintText = "";
    for (const hint of hints) {
      if (!hint) continue;
      const next = `${hintText} · ${hint}`;
      if (visibleWidth(heading + next) <= columns) hintText = next;
    }
    return theme.fg("accent", theme.bold(heading)) + theme.fg("muted", hintText);
  }
}
