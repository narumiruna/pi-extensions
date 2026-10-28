import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  type KeybindingsConfig,
  KeybindingsManager,
  Loader,
  type ScrollView,
  setKeybindings,
  type Terminal,
  type TUI,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { setBtwKeybindings } from "../src/keybindings.js";
import type { SideThreadTurn } from "../src/side-thread.js";
import { BtwAnsweringView, BtwTranscriptPager, type TranscriptPagerAction } from "../src/transcript-pager.js";

export const widths = [0, 1, 20, 40, 79, 80, 120] as const;
export const heights = [0, 1, 2, 3, 5, 10, 24] as const;
export const states = ["idle", "answered", "answering", "error", "queued", "multiline draft"] as const;
export type AppearanceState = (typeof states)[number];
export const question = "Question 中文 🙂 **bold**";
export const answer = "Answer 中文 🙂\n\n```ts\nconst value = 42;\n```";
export const model = { provider: "side-provider", id: "side-model" };
export const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters);

// Callback-owned palettes, not captures of a physical terminal's negotiated system theme.
// Distinct roles make ANSI assertions detect a wrong role, not just a changed colour.
export function appearanceTheme(appearance: "dark" | "light" | "system") {
  const base = appearance === "dark" ? "#ddeeff" : appearance === "light" ? "#112233" : "";
  return new Theme(
    {
      accent: appearance === "light" ? "#234567" : "#123456",
      border: base,
      borderAccent: base,
      borderMuted: base,
      success: base,
      error: appearance === "light" ? "#c12345" : "#b01234",
      warning: appearance === "light" ? "#c16723" : "#b05612",
      muted: appearance === "light" ? "#567891" : "#456789",
      dim: appearance === "light" ? "#789123" : "#678912",
      text: base,
      thinkingText: base,
      scrollbarTrack: appearance === "light" ? "#456781" : "#345678",
      scrollbarThumb: appearance === "light" ? "#891234" : "#789123",
      searchMatchText: base,
      userMessageText: base,
      customMessageText: base,
      customMessageLabel: base,
      toolTitle: base,
      toolOutput: base,
      mdHeading: base,
      mdLink: base,
      mdLinkUrl: base,
      mdCode: base,
      mdCodeBlock: base,
      mdCodeBlockBorder: base,
      mdQuote: base,
      mdQuoteBorder: base,
      mdHr: base,
      mdListBullet: base,
      toolDiffAdded: base,
      toolDiffRemoved: base,
      toolDiffContext: base,
      syntaxComment: base,
      syntaxKeyword: base,
      syntaxFunction: base,
      syntaxVariable: base,
      syntaxString: base,
      syntaxNumber: base,
      syntaxType: base,
      syntaxOperator: base,
      syntaxPunctuation: base,
      thinkingOff: base,
      thinkingMinimal: base,
      thinkingLow: base,
      thinkingMedium: appearance === "light" ? "#a23456" : "#912345",
      thinkingHigh: appearance === "light" ? "#b23456" : "#a12345",
      thinkingXhigh: base,
      thinkingMax: base,
      bashMode: base,
    },
    {
      selectedBg: base,
      searchMatchBg: base,
      userMessageBg: base,
      customMessageBg: base,
      toolPendingBg: base,
      toolSuccessBg: base,
      toolErrorBg: base,
    },
    "truecolor",
    {
      appearance: appearance === "light" ? "light" : "dark",
      ...(appearance === "system" ? { dim: ["dim", "muted"] } : {}),
    },
  );
}

export function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: theme.getThinkingBorderColor("medium"),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

export function keys(config: KeybindingsConfig = {}) {
  return new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.thinking.cycle": { defaultKeys: "shift+tab" } }, config);
}

export function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 0,
    api: "anthropic-messages",
    provider: "side-provider",
    model: "side-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function history(count = 1): SideThreadTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "answered",
    question: count === 1 ? question : `Question ${index} 中文 🙂`,
    answer,
    response: response(answer),
  }));
}

export class AppearanceTerminal implements Terminal {
  columns = 80;
  rows = 24;
  readonly writes: string[] = [];
  readonly kittyProtocolActive = false;
  async drainInput(): Promise<void> {}
  private input: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  stop(): void {
    this.input = undefined;
  }
  send(data: string): void {
    assert.ok(this.input);
    this.input(data);
  }
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

export interface AppearanceBox {
  component: Component;
  rect: { x: number; y: number; width: number; height: number };
  children: AppearanceBox[];
  lines?: readonly string[];
  lineOffset?: number;
  scrollView?: ScrollView;
  scrollContentLines?: readonly string[];
}
export interface AppearanceFrame {
  root: AppearanceBox;
  lines: string[];
}
export function findBox(box: AppearanceBox, predicate: (box: AppearanceBox) => boolean): AppearanceBox | undefined {
  if (predicate(box)) return box;
  for (const child of box.children) {
    const found = findBox(child, predicate);
    if (found) return found;
  }
  return undefined;
}

export function appearanceHarness(
  state: AppearanceState,
  theme = appearanceTheme("dark"),
  options: {
    native?: boolean;
    bindings?: KeybindingsManager;
    turns?: SideThreadTurn[];
    model?: { id: string; provider: string };
    draft?: string;
  } = {},
) {
  const bindings = options.bindings ?? keys();
  setKeybindings(bindings);
  const terminal = new AppearanceTerminal();
  const nativeTui = new TuiAltScreen(terminal, false);
  const regularTui = { mode: "regular", terminal, requestRender() {} } as unknown as TUI;
  const tui = options.native ? nativeTui : regularTui;
  setBtwKeybindings(tui, bindings);
  const actions: TranscriptPagerAction[] = [];
  const submitted: string[] = [];
  const levels: string[] = [];
  const turns =
    options.turns ??
    (state === "idle"
      ? []
      : state === "error"
        ? [{ kind: "error" as const, question, answer: "Failure 中文 🙂" }]
        : history());
  const thinking = {
    level: "medium" as const,
    levels: ["medium", "high"] as const,
    keybindings: bindings,
    onChange: (level: string) => levels.push(level),
  };
  const answering = state === "answering" || state === "queued";
  const view = answering
    ? new BtwAnsweringView(tui, theme, turns, "Pending 中文 🙂", () => {}, "medium", {
        model: options.model ?? model,
        keybindings: bindings,
        steering: {
          questions: state === "queued" ? ["first 中文", "second 🙂", "third", "fourth"] : [],
          onSubmit: (text) => submitted.push(text),
          thinking,
        },
      })
    : new BtwTranscriptPager(tui, theme, turns, (action) => actions.push(action), {
        model: options.model ?? model,
        keybindings: bindings,
        thinking,
        startAtBottom: true,
        initialQuestion: options.draft ?? (state === "multiline draft" ? "draft 中文 🙂\nsecond line\nthird line" : ""),
      });
  view.focused = true;
  if (answering && options.draft) view.handleInput(`\u001b[200~${options.draft}\u001b[201~`);
  if (options.native) {
    nativeTui.setLayoutRoot(view.getFullscreenLayout());
    nativeTui.setFocus(view);
    nativeTui.start();
  }
  const frame = () => {
    nativeTui.renderNow(true);
    // Test-only frame inspection, matching transcript-pager-native's native harness.
    // Production and reference components use public exports only.
    return (nativeTui as unknown as { currentLayout: AppearanceFrame }).currentLayout;
  };
  return {
    view,
    tui,
    terminal,
    actions,
    submitted,
    levels,
    turns,
    resize(width: number, height: number) {
      terminal.columns = width;
      terminal.rows = height;
    },
    frame,
    send(data: string) {
      if (options.native) {
        terminal.send(data);
        nativeTui.renderNow(true);
      } else view.handleInput(data);
    },
    clickComposer() {
      const box = findBox(frame().root, (candidate) => candidate.component instanceof Editor);
      assert.ok(box);
      const cursorRow = box.lines?.findIndex((line) => line.includes(CURSOR_MARKER)) ?? -1;
      assert.ok(cursorRow >= 0);
      const x = box.rect.x + 1;
      const y = box.rect.y + cursorRow - (box.lineOffset ?? 0) + 1;
      terminal.send(`\u001b[<0;${x};${y}M`);
      terminal.send(`\u001b[<0;${x};${y}m`);
      assert.ok(nativeTui.getFocusedComponent() instanceof Editor);
    },
    dispose() {
      view.dispose();
      if (options.native) nativeTui.stop();
    },
  };
}

// Source-derived public-component reference, NOT a native AgentSession capture.
// Installed StatusIndicator's only adapter methods are reproduced here because it is
// not a public root export. NativeEditorReference below copies the installed border
// algorithm; it does not claim to execute a real main-session CustomEditor.
export class NativeStatusReference extends Loader {
  readonly kind = "working" as const;
  renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
  }
  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }
  dispose(): void {
    this.stop();
  }
}

// Source-derived installed CustomEditor.renderTopBorder reference. CustomEditor's
// nominal core KeybindingsManager is not publicly constructible. Keep this fixture
// on public Editor rather than deep-importing or casting a fake action contract.
export class NativeEditorReference extends Editor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly status: NativeStatusReference,
  ) {
    super(tui, theme);
  }
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width <= 0) return super.renderTopBorder(width, hiddenLineCount);
    let status = this.status.renderInBorder(Math.max(1, width - 5));
    let statusWidth = visibleWidth(status);
    if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);
    const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
    const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
    const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
    const canFitOverflow = () =>
      overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;
    if (overflowLabel && !canFitOverflow()) {
      status = this.status.renderSpinnerInBorder(width);
      statusWidth = visibleWidth(status);
    }
    if (canFitOverflow()) {
      const leftBlockWidth = 3 + statusWidth + 1;
      return (
        this.borderColor("── ") +
        status +
        this.borderColor(
          ` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
        )
      );
    }
    if (width >= statusWidth + 5)
      return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
    status = this.status.renderSpinnerInBorder(width);
    statusWidth = visibleWidth(status);
    const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
    return (
      this.borderColor("─".repeat(prefixWidth)) +
      status +
      this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
    );
  }
}
