import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  type MarkdownTransformer,
  type Theme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  type Focusable,
  isKeyRelease,
  type Keybindings,
  type KeybindingsManager,
  renderFakeCursor,
  ScrollView,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  type BtwDisplayModel,
  BtwWorkingIndicator,
  type BtwWorkspaceFocus,
  renderConversationFooter,
  renderWorkingBorder,
} from "./conversation-chrome.js";
import {
  BtwPasteGuard,
  type BtwShortcuts,
  btwKeyHasReachableInput,
  getBtwHostInputBlockers,
  getBtwKeybindings,
  getBtwShortcuts,
  normalizeBtwKey,
} from "./keybindings.js";
import type { BtwThinkingLevel, SideTranscriptItem } from "./side-thread.js";
import { formatKeyLabel, sanitizeSingleLine } from "./text.js";
import type { BtwFullscreenLayoutComponent } from "./workspace-layout.js";

const MAX_STEERING_DISPLAY_LINES = 3;
const OSC133_MARKERS = ["\u001b]133;A\u0007", "\u001b]133;B\u0007", "\u001b]133;C\u0007"];
// Pi renders a spacer above the custom component and a two-line built-in footer below it.
const RESERVED_APP_LINES = 3;

// Native mouse focus can land directly on this Editor. Route keyboard input
// through its logical BTW owner without replacing native mouse/cursor handling.
class BtwComposer extends Editor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly dispatch: (data: string) => void,
    private readonly loader?: BtwWorkingIndicator,
  ) {
    super(tui, theme);
  }
  override handleInput(data: string): void {
    this.dispatch(data);
  }
  handleEditorInput(data: string): void {
    super.handleInput(data);
  }
  override render(width: number): string[] {
    if (width <= 0) return [];
    // Core word wrapping cannot fit a two-cell grapheme into layoutWidth=1.
    // Measure at least two text cells, then clip only the display boundary.
    return super.render(Math.max(3, width)).map((line) => {
      // A wide grapheme cannot fit a one-cell dock. Keep its cursor cell usable.
      if (width <= 2 && line.includes(CURSOR_MARKER))
        return CURSOR_MARKER + renderFakeCursor(" ") + " ".repeat(width - 1);
      return truncateToWidth(line, width, "");
    });
  }
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (!this.loader) return super.renderTopBorder(width, hiddenLineCount);
    return (
      renderWorkingBorder(width, hiddenLineCount, this.borderColor, this.loader) ??
      super.renderTopBorder(width, hiddenLineCount)
    );
  }
}

const VIEWPORT_ACTIONS = [
  "tui.altScreen.search",
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.lineUp",
  "tui.altScreen.lineDown",
  "tui.altScreen.previousPrompt",
  "tui.altScreen.nextPrompt",
  "tui.altScreen.top",
  "tui.altScreen.bottom",
] as const;
// Editor's actual order before submit, with no autocomplete provider installed.
const BEFORE_SUBMIT = [
  "tui.input.copy",
  "tui.editor.undo",
  "tui.input.tab",
  "tui.editor.deleteToLineEnd",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.historyPrevious",
  "tui.editor.historyNext",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
  "tui.input.newLine",
] as const;

function usableKeys(keybindings: KeybindingsManager, action: keyof Keybindings, blockers: readonly string[]): string[] {
  return keybindings.getKeys(action).flatMap((candidate) => {
    const key = normalizeBtwKey(candidate);
    return key && btwKeyHasReachableInput(key, blockers) ? [key] : [];
  });
}

function submitHint(tui: TUI, keybindings: KeybindingsManager, verb: string): string {
  const earlier =
    tui.mode === "fullscreen" ? VIEWPORT_ACTIONS : (["tui.altScreen.pageUp", "tui.altScreen.pageDown"] as const);
  const blockers = [
    ...getBtwHostInputBlockers(tui),
    "ctrl+c",
    "shift+backspace",
    "shift+delete",
    ...[...earlier, ...BEFORE_SUBMIT].flatMap((id) => keybindings.getKeys(id)),
  ];
  const key = usableKeys(keybindings, "tui.input.submit", blockers)[0];
  return key ? `${formatKeyLabel(key)} ${verb}` : "";
}

function pagingHint(tui: TUI, keybindings: KeybindingsManager): string {
  const actions = ["tui.altScreen.pageUp", "tui.altScreen.pageDown"] as const;
  const labels = actions.flatMap((action) => {
    const earlier =
      tui.mode === "fullscreen"
        ? VIEWPORT_ACTIONS.slice(0, VIEWPORT_ACTIONS.indexOf(action))
        : action === "tui.altScreen.pageDown"
          ? (["tui.altScreen.pageUp"] as const)
          : [];
    const blockers = [...getBtwHostInputBlockers(tui), "ctrl+c", ...earlier.flatMap((id) => keybindings.getKeys(id))];
    const key = usableKeys(keybindings, action, blockers)[0];
    return key
      ? [
          formatKeyLabel(key)
            .replace(/Pageup$/u, "PgUp")
            .replace(/Pagedown$/u, "PgDn"),
        ]
      : [];
  });
  return labels.length ? `${labels.join("/")} history` : "";
}

function handleFallbackPaging(
  data: string,
  tui: TUI,
  keybindings: KeybindingsManager,
  scrollView: ScrollView,
): boolean {
  // The native renderer already dispatched these before the focused component.
  if (tui.mode === "fullscreen" || isKeyRelease(data)) return false;
  for (const [action, direction] of [
    ["tui.altScreen.pageUp", -1],
    ["tui.altScreen.pageDown", 1],
  ] as const) {
    if (keybindings.matches(data, action)) {
      scrollView.scrollBy(direction * Math.max(1, scrollView.viewportHeight - 4));
      return true;
    }
  }
  return false;
}

function fittingHint(width: number, variants: readonly string[]): string {
  return variants.find((hint) => visibleWidth(hint) <= Math.max(0, width)) ?? "";
}

function compactHints(parts: readonly string[]): string {
  return parts.filter(Boolean).join(" • ");
}

function releaseScrollbar(scrollView: ScrollView): void {
  scrollView.setScrollbarActive(false);
  // setScrollbar owns cancellation of its private native hide timer.
  scrollView.setScrollbar("hidden");
}

function thinkingBorder(theme: Theme, level: BtwThinkingLevel | undefined, text: string): string {
  return level && theme.getThinkingBorderColor
    ? theme.getThinkingBorderColor(level)(text)
    : theme.fg("borderMuted", text);
}

// A temporary fit after manual scrolling must not silently resume following new output.
class PreservingScrollView extends ScrollView {
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const preserveManualPosition = !this.isFollowingEnd;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (preserveManualPosition && this.isFollowingEnd) {
      this.scrollTo(this.scrollTop, { disableFollow: true });
    }
  }
}

export type TranscriptPagerAction =
  | { kind: "submit"; question: string }
  | { kind: "bringToMain"; questionDraft: string }
  | { kind: "importMainUpdates"; questionDraft: string }
  | { kind: "close" };

export interface BtwThinkingControl {
  level: BtwThinkingLevel;
  levels: readonly BtwThinkingLevel[];
  keybindings: KeybindingsManager;
  onChange: (level: BtwThinkingLevel) => void;
}

export interface BtwAnsweringViewOptions {
  model?: BtwDisplayModel;
  keybindings?: KeybindingsManager;
  markdownTransformers?: readonly MarkdownTransformer[];
  steering?: {
    questions: readonly string[];
    onSubmit: (question: string) => void;
    thinking?: BtwThinkingControl;
  };
}

export class BtwTranscriptPager implements BtwFullscreenLayoutComponent, Focusable {
  private workspaceFocus: BtwWorkspaceFocus | undefined;
  private get keybindings(): KeybindingsManager {
    return getBtwKeybindings(this.tui, this.options.keybindings ?? this.options.thinking?.keybindings);
  }
  setWorkspaceFocus(pane: "side" | "main", shortcutLabel: string | undefined): void {
    this.workspaceFocus = { pane, shortcutLabel: shortcutLabel ? sanitizeSingleLine(shortcutLabel) : undefined };
    this.tui.requestRender();
  }
  private readonly shortcuts: BtwShortcuts;
  private readonly pasteGuard = new BtwPasteGuard();
  private readonly transcriptComponents: Component[];
  private readonly editor: BtwComposer;
  private readonly canBringToMain: boolean;
  private readonly scrollView: ScrollView;
  private readonly layoutRoot: VStack;
  private lastContentLineCount = 0;
  private warning: string | undefined;
  private finished = false;
  private isFocused = false;
  private thinkingLevel: BtwThinkingLevel | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    turns: readonly SideTranscriptItem[],
    private readonly onAction: (action: TranscriptPagerAction) => void,
    private readonly options: {
      model?: BtwDisplayModel;
      keybindings?: KeybindingsManager;
      mainUpdates?: () => boolean;
      startAtBottom?: boolean;
      initialQuestion?: string;
      markdownTransformers?: readonly MarkdownTransformer[];
      thinking?: BtwThinkingControl;
    } = {},
  ) {
    this.shortcuts = getBtwShortcuts(tui, this.keybindings);
    this.transcriptComponents = buildTranscriptComponents(turns, this.theme, undefined, options.markdownTransformers);
    this.canBringToMain = turns.some((turn) => turn.kind === "answered");
    this.thinkingLevel = options.thinking?.level;
    const editorTheme: EditorTheme = {
      borderColor: (text) => thinkingBorder(this.theme, this.thinkingLevel, text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new BtwComposer(this.tui, editorTheme, (data) => this.handleInput(data));
    if (options.initialQuestion) this.editor.setText(options.initialQuestion);
    this.editor.onChange = () => {
      this.warning = undefined;
    };
    this.editor.onSubmit = (text) => {
      const question = text.trim();
      if (!question) {
        this.warning = "Question cannot be empty";
        return;
      }
      this.finished = true;
      this.onAction({ kind: "submit", question });
    };
    const transcript = this.createTranscriptComponent();
    this.scrollView = new PreservingScrollView(transcript, {
      follow: "end",
      primary: true,
      scrollbar: "auto",
      scrollbarTrackStyle: (text) => this.theme.fg("scrollbarTrack", text),
      scrollbarThumbStyle: (text) => this.theme.fg("scrollbarThumb", text),
    });
    if (!options.startAtBottom) this.scrollView.scrollTo(0, { disableFollow: true });
    const dock = new VStack([
      { component: this.editor, basis: "auto", shrink: 1, minSize: 1 },
      { component: this.createFooterComponent(), basis: "auto", shrink: 1, minSize: 0 },
    ]);
    this.layoutRoot = new VStack([
      { component: this.scrollView, basis: 0, grow: 1, minSize: 0 },
      { component: dock, basis: "auto", shrink: 1, minSize: 1 },
    ]);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.editor.focused = value;
  }

  getFullscreenLayout(): Component {
    return this.layoutRoot;
  }

  getPrimaryScrollView(): ScrollView {
    return this.scrollView;
  }

  render(width: number): string[] {
    if (width <= 0 || this.tui.terminal.rows <= 0) return [];
    const safeWidth = Math.max(1, width);
    const editorLines = this.editor.render(safeWidth);
    const availableRows = Math.max(1, this.tui.terminal.rows - RESERVED_APP_LINES);
    const contentLines = renderTranscriptLines(this.transcriptComponents, safeWidth);
    this.lastContentLineCount = contentLines.length;
    const viewportHeight = Math.max(0, availableRows - editorLines.length - this.renderFooter(safeWidth).length);
    this.scrollView.updateLayout(contentLines.length, viewportHeight, () => this.tui.requestRender());

    return fitComposerLayout(
      contentLines.slice(this.scrollView.scrollTop, this.scrollView.scrollTop + viewportHeight),
      this.renderFooter(safeWidth),
      editorLines,
      availableRows,
    ).map((line) => truncateToWidth(line, safeWidth));
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.pasteGuard.consume(data)) {
      this.editor.handleEditorInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.shortcuts.matches(data, "exit")) {
      this.finished = true;
      this.onAction({ kind: "close" });
      return;
    }
    if (this.options.mainUpdates && this.shortcuts.matches(data, "importMainUpdates")) {
      this.finished = true;
      this.onAction({ kind: "importMainUpdates", questionDraft: this.editor.getExpandedText() });
      return;
    }
    if (this.canBringToMain && this.shortcuts.matches(data, "bringToMain")) {
      this.finished = true;
      this.onAction({ kind: "bringToMain", questionDraft: this.editor.getExpandedText() });
      return;
    }
    const thinking = this.options.thinking;
    if (thinking && thinking.levels.length > 1 && this.shortcuts.matches(data, "cycleThinkingLevel")) {
      const currentIndex = thinking.levels.indexOf(this.thinkingLevel ?? thinking.level);
      const nextLevel = thinking.levels[(currentIndex + 1) % thinking.levels.length];
      if (nextLevel) {
        this.thinkingLevel = nextLevel;
        thinking.onChange(nextLevel);
        this.warning = undefined;
        this.tui.requestRender();
      }
      return;
    }
    if (!handleFallbackPaging(data, this.tui, this.keybindings, this.scrollView)) {
      this.editor.handleEditorInput(data);
    }
    if (!this.finished) this.tui.requestRender();
  }

  invalidate(): void {
    this.layoutRoot.invalidate();
  }

  dispose(): void {
    releaseScrollbar(this.scrollView);
    if (this.finished) return;
    this.finished = true;
    this.onAction({ kind: "close" });
  }

  private renderFooter(width: number): string[] {
    return renderConversationFooter(width, this.theme, {
      model: this.options.model,
      thinkingLevel: this.thinkingLevel,
      focus: this.workspaceFocus,
      hint: this.renderHints(width),
      warning: this.warning !== undefined,
    });
  }

  private renderHints(width: number): string {
    const exit = this.shortcuts.label("exit");
    const bring = this.canBringToMain && this.shortcuts.keys.bringToMain.length > 0;
    const bringKey = this.shortcuts.label("bringToMain");
    if (this.warning) return fittingHint(width, [`${this.warning} • ${exit} exit`, `Empty • ${exit}`, exit]);
    const thinking = this.options.thinking;
    const cycle =
      thinking && thinking.levels.length > 1 && this.shortcuts.keys.cycleThinkingLevel.length
        ? `${this.shortcuts.label("cycleThinkingLevel")} thinking`
        : "";
    const importKey =
      this.options.mainUpdates && this.shortcuts.keys.importMainUpdates.length
        ? this.shortcuts.label("importMainUpdates")
        : "";
    const newMainUpdates = importKey ? this.options.mainUpdates?.() : false;
    const importHint = importKey ? `${importKey} import main${newMainUpdates ? " (new)" : ""}` : "";
    const compactImportHint = importKey ? `${importKey} import${newMainUpdates ? " (new)" : ""}` : "";
    const submit = submitHint(this.tui, this.keybindings, "send");
    const history = this.getMaxScrollOffset() > 0 ? pagingHint(this.tui, this.keybindings) : "";
    const switchPane = this.workspaceFocus?.shortcutLabel ? `${this.workspaceFocus.shortcutLabel} switch` : "";
    const submitKey = submit.split(" ")[0] ?? "";
    return fittingHint(width, [
      compactHints([
        submit,
        bring ? `${bringKey} bring to main` : "",
        `${exit} exit`,
        cycle,
        history,
        switchPane,
        importHint,
      ]),
      ...(compactImportHint
        ? [
            compactHints([submit, bring ? bringKey : "", exit, cycle, history, switchPane, compactImportHint]),
            compactHints([submitKey, exit, compactImportHint]),
          ]
        : []),
      compactHints([submit, bring ? bringKey : "", exit, cycle, history, switchPane]),
      compactHints([submitKey, bring ? bringKey : "", exit, cycle, history.replace(/ history$/u, ""), switchPane]),
      compactHints([submitKey, bring ? bringKey : "", exit, history.replace(/ history$/u, "")]),
      compactHints([submitKey, bring ? bringKey : "", exit]),
      compactHints([submitKey, exit]),
      exit,
    ]);
  }

  private createTranscriptComponent(): Component {
    return {
      render: (width) => {
        const lines = renderTranscriptLines(this.transcriptComponents, width, true);
        this.lastContentLineCount = lines.length;
        return lines;
      },
      invalidate: () => {
        for (const component of this.transcriptComponents) component.invalidate();
      },
    };
  }

  private createFooterComponent(): Component {
    return {
      render: (width) => this.renderFooter(width),
      invalidate() {},
    };
  }

  private getMaxScrollOffset(): number {
    return Math.max(0, this.lastContentLineCount - this.scrollView.viewportHeight);
  }
}

export class BtwAnsweringView implements BtwFullscreenLayoutComponent, Focusable {
  private workspaceFocus: BtwWorkspaceFocus | undefined;
  private get keybindings(): KeybindingsManager {
    return getBtwKeybindings(this.tui, this.options.keybindings ?? this.options.steering?.thinking?.keybindings);
  }
  setWorkspaceFocus(pane: "side" | "main", shortcutLabel: string | undefined): void {
    this.workspaceFocus = { pane, shortcutLabel: shortcutLabel ? sanitizeSingleLine(shortcutLabel) : undefined };
    this.tui.requestRender();
  }
  private readonly shortcuts: BtwShortcuts;
  private readonly pasteGuard = new BtwPasteGuard();
  private readonly transcriptComponents: Component[];
  private readonly loader: BtwWorkingIndicator;
  private readonly editor: BtwComposer | undefined;
  private readonly controller = new AbortController();
  private readonly scrollView: ScrollView;
  private readonly layoutRoot: VStack;
  private lastContentLineCount = 0;
  private warning: string | undefined;
  private finished = false;
  private isFocused = false;
  private thinkingLevel: BtwThinkingLevel | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    turns: readonly SideTranscriptItem[],
    pendingQuestion: string,
    private readonly onCancel: () => void,
    thinkingLevel?: BtwThinkingLevel,
    private readonly options: BtwAnsweringViewOptions = {},
  ) {
    this.shortcuts = getBtwShortcuts(tui, this.keybindings);
    this.transcriptComponents = buildTranscriptComponents(
      turns,
      this.theme,
      pendingQuestion,
      options.markdownTransformers,
    );
    this.thinkingLevel = options.steering?.thinking?.level ?? thinkingLevel;
    this.loader = new BtwWorkingIndicator(
      this.tui,
      (text) => this.theme.fg("accent", text),
      (text) => this.theme.fg("muted", text),
      "Answering…",
    );
    if (options.steering) {
      const editorTheme: EditorTheme = {
        borderColor: (text) => thinkingBorder(this.theme, this.thinkingLevel, text),
        selectList: {
          selectedPrefix: (text) => this.theme.fg("accent", text),
          selectedText: (text) => this.theme.fg("accent", text),
          description: (text) => this.theme.fg("muted", text),
          scrollInfo: (text) => this.theme.fg("dim", text),
          noMatch: (text) => this.theme.fg("warning", text),
        },
      };
      this.editor = new BtwComposer(this.tui, editorTheme, (data) => this.handleInput(data), this.loader);
      this.editor.onChange = () => {
        this.warning = undefined;
      };
      this.editor.onSubmit = (text) => {
        const question = text.trim();
        if (!question) {
          this.warning = "Question cannot be empty";
          return;
        }
        options.steering?.onSubmit(question);
        this.warning = undefined;
      };
    }
    const transcript = this.createTranscriptComponent();
    this.scrollView = new PreservingScrollView(transcript, {
      follow: "end",
      primary: true,
      scrollbar: "auto",
      scrollbarTrackStyle: (text) => this.theme.fg("scrollbarTrack", text),
      scrollbarThumbStyle: (text) => this.theme.fg("scrollbarThumb", text),
    });
    const dock = new VStack([
      {
        component: this.createSteeringComponent(),
        basis: "auto",
        shrink: 1,
        minSize: 0,
        maxSize: MAX_STEERING_DISPLAY_LINES,
      },
      { component: this.editor ?? this.createWorkingComponent(), basis: "auto", shrink: 1, minSize: 1 },
      { component: this.createFooterComponent(), basis: "auto", shrink: 1, minSize: 0 },
    ]);
    this.layoutRoot = new VStack([
      { component: this.scrollView, basis: 0, grow: 1, minSize: 0 },
      { component: dock, basis: "auto", shrink: 1, minSize: 1 },
    ]);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    if (this.editor) this.editor.focused = value;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  getFullscreenLayout(): Component {
    return this.layoutRoot;
  }

  getPrimaryScrollView(): ScrollView {
    return this.scrollView;
  }

  render(width: number): string[] {
    if (width <= 0 || this.tui.terminal.rows <= 0) return [];
    const safeWidth = Math.max(1, width);
    const availableRows = Math.max(1, this.tui.terminal.rows - RESERVED_APP_LINES);
    const editorLines = this.editor?.render(safeWidth) ?? this.renderWorking(safeWidth);
    const contentLines = renderTranscriptLines(this.transcriptComponents, safeWidth);
    this.lastContentLineCount = contentLines.length;
    const footerLines = this.renderFooter(safeWidth);
    const steeringCapacity = Math.max(0, availableRows - editorLines.length - footerLines.length);
    const steeringLines = renderSteeringLines(
      this.options.steering?.questions ?? [],
      safeWidth,
      this.theme,
      Math.min(MAX_STEERING_DISPLAY_LINES, steeringCapacity),
    );
    const viewportHeight = Math.max(0, availableRows - editorLines.length - footerLines.length - steeringLines.length);
    this.scrollView.updateLayout(contentLines.length, viewportHeight, () => this.tui.requestRender());

    return fitComposerLayout(
      contentLines.slice(this.scrollView.scrollTop, this.scrollView.scrollTop + viewportHeight),
      this.renderFooter(safeWidth),
      editorLines,
      availableRows,
      steeringLines,
    ).map((line) => truncateToWidth(line, safeWidth));
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.pasteGuard.consume(data)) {
      this.editor?.handleEditorInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.shortcuts.matches(data, "exit")) {
      this.finished = true;
      this.loader.stop();
      this.controller.abort();
      this.onCancel();
      return;
    }
    const thinking = this.options.steering?.thinking;
    if (thinking && thinking.levels.length > 1 && this.shortcuts.matches(data, "cycleThinkingLevel")) {
      const currentIndex = thinking.levels.indexOf(this.thinkingLevel ?? thinking.level);
      const nextLevel = thinking.levels[(currentIndex + 1) % thinking.levels.length];
      if (nextLevel) {
        this.thinkingLevel = nextLevel;
        thinking.onChange(nextLevel);
        this.warning = undefined;
        this.tui.requestRender();
      }
      return;
    }
    if (!handleFallbackPaging(data, this.tui, this.keybindings, this.scrollView)) {
      this.editor?.handleEditorInput(data);
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.layoutRoot.invalidate();
  }

  finish(): void {
    this.finished = true;
    releaseScrollbar(this.scrollView);
    this.loader.stop();
  }

  dispose(): void {
    releaseScrollbar(this.scrollView);
    if (this.finished) {
      this.loader.stop();
      this.controller.abort();
      return;
    }
    this.finished = true;
    this.loader.stop();
    this.controller.abort();
    this.onCancel();
  }

  private renderFooter(width: number): string[] {
    return renderConversationFooter(width, this.theme, {
      model: this.options.model,
      thinkingLevel: this.thinkingLevel,
      focus: this.workspaceFocus,
      hint: this.renderHints(width),
      warning: this.warning !== undefined,
    });
  }

  private renderHints(width: number): string {
    const exit = this.shortcuts.label("exit");
    if (this.warning) return fittingHint(width, [`${this.warning} • ${exit} cancel`, `Empty • ${exit}`, exit]);
    const submit = this.editor ? submitHint(this.tui, this.keybindings, "queue next") : "";
    const thinking = this.options.steering?.thinking;
    const cycle =
      thinking && thinking.levels.length > 1 && this.shortcuts.keys.cycleThinkingLevel.length
        ? `${this.shortcuts.label("cycleThinkingLevel")} thinking`
        : "";
    const history = this.getMaxScrollOffset() > 0 ? pagingHint(this.tui, this.keybindings) : "";
    const switchPane = this.workspaceFocus?.shortcutLabel ? `${this.workspaceFocus.shortcutLabel} switch` : "";
    const submitKey = submit.split(" ")[0] ?? "";
    return fittingHint(width, [
      compactHints([submit, `${exit} cancel`, cycle, history, switchPane]),
      compactHints([submit, exit, cycle, history, switchPane]),
      compactHints([submitKey, exit, cycle, history.replace(/ history$/u, ""), switchPane]),
      compactHints([submitKey, exit, history.replace(/ history$/u, "")]),
      compactHints([submitKey, exit]),
      exit,
    ]);
  }

  private renderWorking(width: number): string[] {
    return [this.loader.renderInBorder(Math.max(0, width))];
  }

  private createWorkingComponent(): Component {
    return { render: (width) => this.renderWorking(width), invalidate: () => this.loader.invalidate() };
  }

  private createTranscriptComponent(): Component {
    return {
      render: (width) => {
        const lines = renderTranscriptLines(this.transcriptComponents, width, true);
        this.lastContentLineCount = lines.length;
        return lines;
      },
      invalidate: () => {
        for (const component of this.transcriptComponents) component.invalidate();
      },
    };
  }

  private createSteeringComponent(): Component {
    return {
      render: (width) =>
        renderSteeringLines(this.options.steering?.questions ?? [], width, this.theme, MAX_STEERING_DISPLAY_LINES),
      invalidate() {},
    };
  }

  private createFooterComponent(): Component {
    return {
      render: (width) => this.renderFooter(width),
      invalidate: () => this.loader.invalidate(),
    };
  }

  private getMaxScrollOffset(): number {
    return Math.max(0, this.lastContentLineCount - this.scrollView.viewportHeight);
  }
}

export function formatSideTranscript(turns: readonly SideTranscriptItem[]): string {
  return turns
    .map((turn) => {
      if (turn.kind === "mainContext") return `Main context update\n\n${escapeTerminalControls(turn.snapshot.text)}`;
      const question = escapeTerminalControls(turn.question);
      const rawAnswer = escapeTerminalControls(turn.answer);
      const answer = turn.kind === "error" ? `Error: ${rawAnswer}` : rawAnswer;
      return `${question}\n\n${answer}`;
    })
    .join("\n\n");
}

function buildTranscriptComponents(
  turns: readonly SideTranscriptItem[],
  theme: Theme,
  pendingQuestion?: string,
  markdownTransformers: readonly MarkdownTransformer[] = [],
): Component[] {
  const components = turns.flatMap((turn, index): Component[] => {
    // Pi inserts a spacer before a later user message, outside that message's
    // own Markdown padding. Keep the same separation between side exchanges.
    const preceding = index > 0 ? [new Spacer(1)] : [];
    if (turn.kind === "mainContext") {
      const update: Component = {
        render: (width) =>
          new Text(
            theme.fg("muted", `Main context update\n\n${escapeTerminalControls(turn.snapshot.text)}`),
            1,
            0,
          ).render(width),
        invalidate() {},
      };
      return [...preceding, update];
    }
    const question = new UserMessageComponent(
      escapeTerminalControls(turn.question),
      getMarkdownTheme(),
      1,
      markdownTransformers,
    );
    if (turn.kind === "error") {
      const error: Component = {
        render: (width) =>
          new Text(theme.fg("error", `Error: ${escapeTerminalControls(turn.answer)}`), 1, 0).render(width),
        invalidate() {},
      };
      return [...preceding, question, new Spacer(1), error];
    }
    const response: AssistantMessage = {
      ...turn.response,
      content: [{ type: "text", text: escapeTerminalControls(turn.answer) }],
      stopReason: "stop",
      errorMessage: undefined,
    };
    return [
      ...preceding,
      question,
      new AssistantMessageComponent(response, true, getMarkdownTheme(), "", 1, markdownTransformers),
    ];
  });
  if (pendingQuestion) {
    if (components.length > 0) components.push(new Spacer(1));
    components.push(
      new UserMessageComponent(escapeTerminalControls(pendingQuestion), getMarkdownTheme(), 1, markdownTransformers),
    );
  }
  return components;
}

function renderTranscriptLines(components: readonly Component[], width: number, native = false): string[] {
  return components.flatMap((component) => {
    const lines = component.render(width);
    // Pi adds these exact prefixes outside Markdown. Never trust payload/transformer
    // markers, even when they happen to use the same OSC number.
    const trusted = component instanceof UserMessageComponent || component instanceof AssistantMessageComponent;
    return lines.map((line, index) => {
      let prefix = "";
      if (native && trusted) {
        if (index === 0 && line.startsWith(OSC133_MARKERS[0] ?? "")) prefix += OSC133_MARKERS[0];
        const end = `${OSC133_MARKERS[1]}${OSC133_MARKERS[2]}`;
        if (index === lines.length - 1 && line.slice(prefix.length).startsWith(end)) prefix += end;
      }
      return prefix + truncateToWidth(stripShellIntegrationMarkers(line), Math.max(0, width), "");
    });
  });
}

function fitComposerLayout(
  contentLines: string[],
  footerLines: string[],
  editorLines: string[],
  availableRows: number,
  statusLines: string[] = [],
): string[] {
  if (availableRows <= 0) return [];
  // Keep the active input first in the row budget, while retaining native
  // conversation order: transcript, pending questions, editor, then footer.
  const editorBudget = Math.min(editorLines.length, availableRows);
  const footerBudget = Math.min(footerLines.length, availableRows - editorBudget);
  const statusBudget = Math.min(statusLines.length, availableRows - editorBudget - footerBudget);
  const transcriptBudget = availableRows - editorBudget - footerBudget - statusBudget;
  return [
    ...contentLines.slice(0, transcriptBudget),
    ...statusLines.slice(0, statusBudget),
    ...fitEditorLines(editorLines, editorBudget),
    ...footerLines.slice(0, footerBudget),
  ];
}

function fitEditorLines(editorLines: string[], budget: number): string[] {
  if (budget <= 0) return [];
  if (editorLines.length <= budget) return editorLines;
  const cursorIndex = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (cursorIndex < 0) return editorLines.slice(-budget);
  const start = Math.min(cursorIndex, editorLines.length - budget);
  return editorLines.slice(start, start + budget);
}

function renderSteeringLines(questions: readonly string[], width: number, theme: Theme, maxLines: number): string[] {
  if (questions.length === 0 || maxLines <= 0) return [];
  const formatQuestion = (question: string) => sanitizeSingleLine(question) || "(non-printing message)";
  if (maxLines === 1 && questions.length > 1) {
    return [
      truncateToWidth(
        theme.fg("dim", ` Steering next (+${questions.length - 1} more): ${formatQuestion(questions[0] ?? "")}`),
        width,
      ),
    ];
  }
  const hasOverflow = questions.length > maxLines;
  const questionLimit = hasOverflow ? Math.max(1, maxLines - 1) : maxLines;
  const lines = questions
    .slice(0, questionLimit)
    .map((question) => truncateToWidth(theme.fg("dim", ` Steering next: ${formatQuestion(question)}`), width));
  if (hasOverflow) {
    lines.push(truncateToWidth(theme.fg("dim", ` Steering next: … +${questions.length - questionLimit} more`), width));
  }
  return lines;
}

function stripShellIntegrationMarkers(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove the exact OSC terminal protocol, not printable text.
  return line.replace(/\u001b\]133;[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "");
}

function escapeTerminalControls(text: string): string {
  return [...text]
    .map((character) => {
      if (character === "\n") return character;
      if (character === "\t") return "    ";
      const code = character.charCodeAt(0);
      if (code <= 31 || (code >= 127 && code <= 159)) {
        return `\\x${code.toString(16).padStart(2, "0")}`;
      }
      return character;
    })
    .join("");
}
