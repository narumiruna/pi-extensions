import { stripVTControlCharacters } from "node:util";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  sliceByColumn,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { HorizontalRule } from "../horizontal-rule.js";
import type { QuestionnaireAnswer, QuestionnaireLabels, QuestionnaireQuestion } from "../questionnaire.js";
import type { MenuCloseReason } from "../types.js";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export type QuestionnaireInteractionValue<QuestionId extends string> =
  | { kind: "submitted"; answers: QuestionnaireAnswer<QuestionId>[] }
  | { kind: "closed"; reason: MenuCloseReason };

export interface QuestionnaireComponentOptions<QuestionId extends string> {
  questions: readonly QuestionnaireQuestion<QuestionId>[];
  allowCustomAnswer: boolean;
  allowNotes: boolean;
  maxTextLength?: number;
  labels: QuestionnaireLabels;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  isCurrent(): boolean;
  onDone(value: QuestionnaireInteractionValue<QuestionId>): void;
}

export class QuestionnaireComponent<QuestionId extends string> implements Component, Focusable {
  private readonly options: QuestionnaireComponentOptions<QuestionId>;
  private readonly border: HorizontalRule;
  private readonly editor: RawPreservingEditor;
  private readonly answers: Array<QuestionnaireAnswer<QuestionId> | undefined>;
  private readonly selectedOptions: number[];
  private page = 0;
  private editorKind: "answer" | "note" | undefined;
  private message: string | undefined;
  private finished = false;
  private _focused = false;
  private localOptionRows = new Map<number, number>();
  private optionByFrameRow = new Map<number, number>();
  private localEditorRegion: { start: number; end: number; width: number } | undefined;
  private editorRegion: { start: number; end: number; width: number; xOffset: number } | undefined;
  private mousePressedOption: number | undefined;
  private renderedWidth = 0;

  constructor(options: QuestionnaireComponentOptions<QuestionId>) {
    this.options = options;
    this.border = new HorizontalRule({
      ruleStyle: (text) => options.theme.fg("border", text),
    });
    this.answers = options.questions.map(() => undefined);
    this.selectedOptions = options.questions.map(() => 0);
    const editorTheme: EditorTheme = {
      borderColor: (text) => options.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => options.theme.fg("accent", text),
        selectedText: (text) => options.theme.fg("accent", text),
        description: (text) => options.theme.fg("muted", text),
        scrollInfo: (text) => options.theme.fg("dim", text),
        noMatch: (text) => options.theme.fg("warning", text),
      },
    };
    this.editor = new RawPreservingEditor(options.tui, editorTheme);
    this.editor.onChange = () => {
      this.message = undefined;
    };
    this.editor.onSubmit = (text) => this.submitEditor(text);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.editorKind !== undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.renderedWidth = safeWidth;
    const padding = safeWidth > 1 ? " " : "";
    const contentWidth = Math.max(1, safeWidth - visibleWidth(padding));
    const border = this.border.render(safeWidth)[0] ?? "";
    this.localOptionRows = new Map();
    this.localEditorRegion = undefined;
    const lines = [border, "", ...this.renderHeader(contentWidth), ""];
    const bodyStart = lines.length;
    if (this.isReviewPage()) lines.push(...this.renderReview(contentWidth));
    else lines.push(...this.renderQuestion(contentWidth));
    this.optionByFrameRow = new Map([...this.localOptionRows].map(([row, option]) => [bodyStart + row, option]));
    const localEditorRegion = this.renderedLocalEditorRegion();
    this.editorRegion = localEditorRegion
      ? {
          start: bodyStart + localEditorRegion.start,
          end: bodyStart + localEditorRegion.end,
          width: localEditorRegion.width,
          xOffset: visibleWidth(padding),
        }
      : undefined;
    if (this.message) {
      lines.push(...hardWrap(this.options.theme.fg("warning", this.message), contentWidth));
    }
    lines.push("", ...wrapHintGroups(this.renderHintGroups(), contentWidth), "", border);
    return lines.map((line) => {
      if (!line || line === border) return line;
      return `${padding}${truncateToWidth(line, contentWidth)}`;
    });
  }

  handleInput(data: string): void {
    if (this.finished) return;
    this.mousePressedOption = undefined;
    if (!this.options.isCurrent()) {
      this.finish({ kind: "closed", reason: "back" });
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.finish({ kind: "closed", reason: "close" });
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({ kind: "closed", reason: "back" });
      return;
    }
    if (this.editorKind) this.handleEditorInput(data);
    else this.handlePageInput(data);
    this.options.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished || event.width !== this.renderedWidth) return undefined;
    if (!this.options.isCurrent()) {
      this.finish({ kind: "closed", reason: "back" });
      return { handled: true };
    }
    const editorRegion = this.editorRegion;
    if (this.editorKind && editorRegion && event.y >= editorRegion.start && event.y < editorRegion.end) {
      const result = this.editor.handleMouse({
        ...event,
        x: event.x - editorRegion.xOffset,
        y: event.y - editorRegion.start,
        width: editorRegion.width,
        height: editorRegion.end - editorRegion.start,
      });
      return result ? { ...result, focus: true } : undefined;
    }
    if (this.editorKind) return undefined;
    const mappedOption = this.optionByFrameRow.get(event.y);
    if (mappedOption === undefined) return undefined;
    const option = event.type === "click" ? (this.mousePressedOption ?? mappedOption) : mappedOption;
    const question = this.options.questions[this.page];
    const optionCount = (question?.options.length ?? 0) + Number(this.options.allowCustomAnswer);
    if (option < 0 || option >= optionCount) return undefined;
    if (event.type === "move") return { handled: true };
    if (event.button !== "left") return undefined;
    if (event.type === "press") {
      this.mousePressedOption = option;
      const changed = this.selectedOptions[this.page] !== option;
      this.selectedOptions[this.page] = option;
      if (changed) this.options.tui.requestRender();
      return { handled: true, focus: true, render: changed };
    }
    if (event.type === "click") {
      this.mousePressedOption = undefined;
      this.selectedOptions[this.page] = option;
      this.submitPage();
      this.options.tui.requestRender();
      return { handled: true, render: true };
    }
    return undefined;
  }

  invalidate(): void {
    this.clearMouseLayout();
    this.border.invalidate();
    this.editor.invalidate();
  }

  dispose(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearMouseLayout();
    this.editor.focused = false;
  }

  private handleEditorInput(data: string): void {
    const keybindings = this.options.keybindings;
    if (keybindings.matches(data, "tui.input.newLine")) {
      this.editor.handleInput(data);
    } else if (keybindings.matches(data, "tui.input.submit")) {
      this.submitEditor(this.editor.getExpandedText());
    } else {
      this.editor.handleInput(data);
    }
  }

  private handlePageInput(data: string): void {
    const keybindings = this.options.keybindings;
    if (keybindings.matches(data, "tui.select.up")) {
      if (!this.isReviewPage()) this.moveSelection(-1);
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      if (!this.isReviewPage()) this.moveSelection(1);
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      this.submitPage();
      return;
    }
    if (keybindings.matches(data, "tui.input.tab")) {
      this.movePage(1);
      return;
    }
    if (data === "k") {
      if (!this.isReviewPage()) this.moveSelection(-1);
      return;
    }
    if (data === "j") {
      if (!this.isReviewPage()) this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.movePage(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.movePage(-1);
      return;
    }
    if (this.options.allowNotes && noteShortcutAvailable(keybindings) && data.toLowerCase() === "n") {
      if (this.isReviewPage()) this.message = "Return to a question to add or edit its note.";
      else this.editNote();
    }
  }

  private renderHintGroups(): string[] {
    const { keybindings, theme } = this.options;
    const cancel = cancelHint(theme, keybindings);
    if (this.editorKind) {
      return [
        keybindingHint(
          theme,
          keybindings,
          "tui.input.submit",
          this.editorKind === "answer" && !this.hasReviewPage() ? "submit" : "save",
        ),
        keybindingHint(theme, keybindings, "tui.input.newLine", "newline"),
        cancel,
      ];
    }
    const questions = this.hasReviewPage() ? rawKeyHint(theme, questionNavigationKeys(keybindings), "questions") : "";
    if (this.isReviewPage()) {
      return [keybindingHint(theme, keybindings, "tui.select.confirm", "submit"), cancel, questions];
    }
    return [
      rawKeyHint(theme, selectionNavigationKeys(keybindings), "navigate"),
      keybindingHint(theme, keybindings, "tui.select.confirm", this.hasReviewPage() ? "select" : "submit"),
      cancel,
      questions,
      ...(this.options.allowNotes && noteShortcutAvailable(keybindings) ? [rawKeyHint(theme, "n", "note")] : []),
    ];
  }

  private movePage(delta: number): void {
    const pageCount = this.options.questions.length + Number(this.hasReviewPage());
    this.page = (this.page + delta + pageCount) % pageCount;
    const answer = this.answers[this.page];
    const question = this.options.questions[this.page];
    if (answer?.wasCustom && question) {
      this.selectedOptions[this.page] = question.options.length;
    } else if (answer?.optionIndex !== undefined) {
      this.selectedOptions[this.page] = answer.optionIndex - 1;
    }
    this.message = undefined;
  }

  private renderHeader(width: number): string[] {
    if (!this.hasReviewPage()) {
      const question = this.options.questions[0];
      if (!question) return [];
      const header = sanitizeQuestionnaireText(question.header) || "Question 1";
      return [this.options.theme.fg("muted", truncateToWidth(header, width, "…"))];
    }
    return this.renderTabs(width);
  }

  private renderTabs(width: number): string[] {
    const reviewTab = sanitizeQuestionnaireText(this.options.labels.reviewTab) || "Review";
    const tabs = [
      ...this.options.questions.map((question, index) => {
        const label = sanitizeQuestionnaireText(question.header) || `Question ${index + 1}`;
        const answered = this.answers[index] ? "✓ " : "";
        return this.page === index ? `[${answered}${label}]` : `${answered}${label}`;
      }),
      ...(this.hasReviewPage() ? [this.isReviewPage() ? `[${reviewTab}]` : reviewTab] : []),
    ];
    const lines: string[] = [];
    let line = "";
    for (const tab of tabs) {
      const boundedTab = truncateToWidth(tab, width, "…");
      const candidate = line ? `${line}  ${boundedTab}` : boundedTab;
      if (line && visibleWidth(candidate) > width) {
        lines.push(this.options.theme.fg("accent", line));
        line = boundedTab;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(this.options.theme.fg("accent", line));
    return lines;
  }

  private renderQuestion(width: number): string[] {
    const question = this.options.questions[this.page];
    if (!question) return [];
    const lines = hardWrap(
      this.options.theme.fg("accent", this.options.theme.bold(sanitizeQuestionnaireText(question.prompt))),
      width,
    );
    lines.push("");
    question.options.forEach((option, index) => {
      const selected = this.selectedOptions[this.page] === index;
      const cursor = selected ? "→" : " ";
      const label = `${cursor} ${index + 1}. ${sanitizeQuestionnaireText(option.label)}`;
      const chosen = this.answers[this.page]?.optionIndex === index + 1;
      const description = option.description ? ` — ${sanitizeQuestionnaireText(option.description)}` : "";
      const line = selected
        ? this.options.theme.fg("accent", `${label}${chosen ? " ✓" : ""}${description}`)
        : `${this.options.theme.fg("text", label)}${
            chosen ? this.options.theme.fg("success", " ✓") : ""
          }${description ? this.options.theme.fg("muted", description) : ""}`;
      const rendered = hardWrapWithIndent(line, width, visibleWidth(`${cursor} ${index + 1}. `));
      const start = lines.length;
      lines.push(...rendered);
      for (let row = start; row < start + rendered.length; row += 1) this.localOptionRows.set(row, index);
    });
    if (this.options.allowCustomAnswer) {
      const custom = this.renderCustomOption(question);
      const start = lines.length;
      lines.push(...custom);
      for (let row = start; row < start + custom.length; row += 1) {
        this.localOptionRows.set(row, question.options.length);
      }
    }
    const answer = this.answers[this.page];
    if (answer?.wasCustom) {
      lines.push(...labeledRaw(this.options.labels.answer, answer.answer, width, this.options.theme));
    }
    if (answer?.note) {
      lines.push(...labeledRaw(this.options.labels.note, answer.note, width, this.options.theme));
    }
    if (this.editorKind) {
      lines.push(
        "",
        this.options.theme.fg(
          "accent",
          sanitizeQuestionnaireText(
            this.editorKind === "answer" ? this.options.labels.customAnswer : this.options.labels.optionalNote,
          ),
        ),
      );
      const editorLines = this.editor.render(width);
      const start = lines.length;
      lines.push(...editorLines);
      this.localEditorRegion = { start, end: start + editorLines.length, width };
    }
    return lines;
  }

  private renderCustomOption(question: QuestionnaireQuestion<QuestionId>): string[] {
    const customIndex = question.options.length;
    const selected = this.selectedOptions[this.page] === customIndex;
    const cursor = selected ? "→" : " ";
    const label = `${cursor} ${customIndex + 1}. ${sanitizeQuestionnaireText(this.options.labels.otherOption)}`;
    const chosen = this.answers[this.page]?.wasCustom === true;
    return [
      selected
        ? this.options.theme.fg("accent", `${label}${chosen ? " ✓" : ""}`)
        : `${this.options.theme.fg("text", label)}${chosen ? this.options.theme.fg("success", " ✓") : ""}`,
    ];
  }

  private renderReview(width: number): string[] {
    const reviewTitle = sanitizeQuestionnaireText(this.options.labels.reviewTitle) || "Review answers";
    const lines = [this.options.theme.fg("accent", this.options.theme.bold(reviewTitle)), ""];
    const noteLabel = sanitizeQuestionnaireText(this.options.labels.note) || "Note";
    this.options.questions.forEach((question, index) => {
      const answer = this.answers[index];
      const header = sanitizeQuestionnaireText(question.header) || `Question ${index + 1}`;
      const label = `${index + 1}. ${header}`;
      const summary = ` — ${inlineSummary(answer?.answer ?? "Unanswered")}${
        answer?.note ? ` · ${noteLabel}: ${inlineSummary(answer.note)}` : ""
      }`;
      const line = `${this.options.theme.fg("text", label)}${this.options.theme.fg("muted", summary)}`;
      lines.push(...hardWrapWithIndent(line, width, visibleWidth(`${index + 1}. `)));
    });
    return lines;
  }

  private moveSelection(delta: number): void {
    const question = this.options.questions[this.page];
    const optionCount = (question?.options.length ?? 0) + Number(this.options.allowCustomAnswer);
    if (optionCount === 0) return;
    this.selectedOptions[this.page] = ((this.selectedOptions[this.page] ?? 0) + delta + optionCount) % optionCount;
  }

  private submitPage(): void {
    if (this.isReviewPage()) {
      if (this.answers.some((answer) => !answer)) {
        this.message = "Answer every question before submitting.";
        return;
      }
      this.finish({
        kind: "submitted",
        answers: this.answers.filter((answer): answer is QuestionnaireAnswer<QuestionId> => answer !== undefined),
      });
      return;
    }
    const question = this.options.questions[this.page];
    if (!question) return;
    const selected = this.selectedOptions[this.page] ?? 0;
    if (this.options.allowCustomAnswer && selected === question.options.length) {
      this.beginEditor("answer", this.answers[this.page]?.wasCustom ? this.answers[this.page]?.answer : "");
      return;
    }
    const option = question.options[selected];
    if (!option) return;
    const previous = this.answers[this.page];
    this.answers[this.page] = answerFor(question.id, option.label, {
      wasCustom: false,
      optionIndex: selected + 1,
      note: previous?.optionIndex === selected + 1 ? previous.note : undefined,
    });
    this.advance();
  }

  private editNote(): void {
    const index = this.page;
    let answer = this.answers[index];
    const question = this.options.questions[index];
    const selected = this.selectedOptions[index] ?? 0;
    if (question && this.options.allowCustomAnswer && selected === question.options.length && !answer?.wasCustom) {
      this.beginEditor("answer", "");
      return;
    }
    if (question && selected < question.options.length && answer?.optionIndex !== selected + 1) {
      const option = question.options[selected];
      if (option) {
        answer = answerFor(question.id, option.label, {
          wasCustom: false,
          optionIndex: selected + 1,
        });
        this.answers[index] = answer;
      }
    }
    if (!answer) {
      this.message = "Select an answer before adding a note.";
      return;
    }
    this.beginEditor("note", answer.note ?? "");
  }

  private beginEditor(kind: "answer" | "note", value: string | undefined): void {
    this.editorKind = kind;
    this.editor.setText(value ?? "");
    this.editor.focused = this._focused;
    this.message = undefined;
  }

  private submitEditor(value: string): void {
    if (this.options.maxTextLength !== undefined && value.length > this.options.maxTextLength) {
      this.editor.setText(value);
      this.message = `${this.editorKind === "answer" ? "Answer" : "Note"} must be ${formatLimit(
        this.options.maxTextLength,
      )} characters or fewer.`;
      this.options.tui.requestRender();
      return;
    }
    const index = this.page;
    if (this.editorKind === "answer") {
      if (!value.trim()) {
        this.editor.setText(value);
        this.message = "Custom answer cannot be empty.";
        this.options.tui.requestRender();
        return;
      }
      const question = this.options.questions[index];
      if (!question) return;
      const previous = this.answers[index];
      this.answers[index] = answerFor(question.id, value, {
        wasCustom: true,
        note: previous?.wasCustom ? previous.note : undefined,
      });
      this.editor.setText("");
      this.editorKind = undefined;
      this.editor.focused = false;
      this.advance();
      return;
    }
    const answer = this.answers[index];
    if (answer) answer.note = value.trim() ? value : undefined;
    this.editor.setText("");
    this.editorKind = undefined;
    this.editor.focused = false;
    this.message = value.trim() ? "Note saved." : "Note cleared.";
    this.options.tui.requestRender();
  }

  private advance(): void {
    if (!this.hasReviewPage()) {
      const answers = this.answers.filter((answer): answer is QuestionnaireAnswer<QuestionId> => answer !== undefined);
      this.finish({ kind: "submitted", answers });
      return;
    }
    this.page = Math.min(this.page + 1, this.options.questions.length);
    this.message = undefined;
  }

  private hasReviewPage(): boolean {
    return this.options.questions.length > 1;
  }

  private isReviewPage(): boolean {
    return this.hasReviewPage() && this.page === this.options.questions.length;
  }

  private finish(value: QuestionnaireInteractionValue<QuestionId>): void {
    if (this.finished) return;
    this.finished = true;
    this.clearMouseLayout();
    this.editor.focused = false;
    this.options.onDone(value);
  }

  private renderedLocalEditorRegion(): { start: number; end: number; width: number } | undefined {
    return this.localEditorRegion;
  }

  private clearMouseLayout(): void {
    this.renderedWidth = 0;
    this.mousePressedOption = undefined;
    this.localOptionRows.clear();
    this.optionByFrameRow.clear();
    this.localEditorRegion = undefined;
    this.editorRegion = undefined;
  }
}

class RawPreservingEditor implements Focusable {
  private readonly editor: Editor;
  private readonly rawByMarker = new Map<string, string>();
  private markerCodePoint = 0xe000;
  private pasteBuffer: string | undefined;

  constructor(tui: TUI, theme: EditorTheme) {
    this.editor = new Editor(tui, theme, { paddingX: 0 });
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  set onChange(handler: ((value: string) => void) | undefined) {
    this.editor.onChange = handler ? () => handler(this.getExpandedText()) : undefined;
  }

  set onSubmit(handler: ((value: string) => void) | undefined) {
    this.editor.onSubmit = handler ? (value) => handler(this.decode(value)) : undefined;
  }

  handleInput(data: string): void {
    if (this.pasteBuffer !== undefined) {
      this.pasteBuffer += data;
      this.flushPasteBuffer();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.editor.handleInput(data);
      return;
    }
    const pasteStart = data.indexOf(BRACKETED_PASTE_START);
    if (pasteStart >= 0) {
      if (pasteStart > 0) this.editor.handleInput(data.slice(0, pasteStart));
      this.pasteBuffer = data.slice(pasteStart + BRACKETED_PASTE_START.length);
      this.flushPasteBuffer();
      return;
    }
    if ([...data].some((character) => isUnsafeDirectEditorCharacter(character) || this.rawByMarker.has(character))) {
      this.editor.handleInput(this.encode(data));
      return;
    }
    this.editor.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.editor.handleMouse(event);
  }

  render(width: number): string[] {
    return this.editor
      .render(width)
      .map((line) => [...line].map((character) => (this.rawByMarker.has(character) ? " " : character)).join(""));
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  setText(value: string): void {
    this.rawByMarker.clear();
    this.markerCodePoint = 0xe000;
    this.pasteBuffer = undefined;
    this.editor.setText(this.encode(value));
  }

  getExpandedText(): string {
    return this.decode(this.editor.getExpandedText());
  }

  private flushPasteBuffer(): void {
    if (this.pasteBuffer === undefined) return;
    const pasteEnd = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
    if (pasteEnd < 0) return;
    const raw = this.pasteBuffer.slice(0, pasteEnd);
    const remaining = this.pasteBuffer.slice(pasteEnd + BRACKETED_PASTE_END.length);
    this.pasteBuffer = undefined;
    this.editor.handleInput(`${BRACKETED_PASTE_START}${this.encode(raw)}${BRACKETED_PASTE_END}`);
    if (remaining) this.handleInput(remaining);
  }

  private encode(value: string): string {
    const forbidden = new Set([...value, ...this.editor.getExpandedText(), ...this.rawByMarker.keys()]);
    return [...value]
      .map((character) => {
        if (!isUnsafeEditorCharacter(character) && !this.rawByMarker.has(character)) {
          return character;
        }
        const marker = this.nextMarker(forbidden);
        this.rawByMarker.set(marker, character);
        forbidden.add(marker);
        return marker;
      })
      .join("");
  }

  private decode(value: string): string {
    return [...value].map((character) => this.rawByMarker.get(character) ?? character).join("");
  }

  private nextMarker(forbidden: ReadonlySet<string>): string {
    for (;;) {
      if (this.markerCodePoint === 0xf900) this.markerCodePoint = 0xf0000;
      if (this.markerCodePoint === 0xffffe) this.markerCodePoint = 0x100000;
      if (this.markerCodePoint > 0x10fffd) {
        throw new Error("Questionnaire editor exhausted its safe input markers");
      }
      const marker = String.fromCodePoint(this.markerCodePoint++);
      if (!forbidden.has(marker)) return marker;
    }
  }
}

function isUnsafeDirectEditorCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029 || isBidiControl(codePoint)
  );
}

function isUnsafeEditorCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    character !== "\n" &&
    (codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      isBidiControl(codePoint))
  );
}

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function sanitizeQuestionnaireText(value: string): string {
  return [...stripVTControlCharacters(value)]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029 ||
        isBidiControl(codePoint)
        ? " "
        : character;
    })
    .join("");
}

function answerFor<QuestionId extends string>(
  questionId: QuestionId,
  answer: string,
  options: { wasCustom: boolean; optionIndex?: number; note?: string },
): QuestionnaireAnswer<QuestionId> {
  return {
    questionId,
    answer,
    wasCustom: options.wasCustom,
    ...(options.optionIndex === undefined ? {} : { optionIndex: options.optionIndex }),
    ...(options.note === undefined ? {} : { note: options.note }),
  };
}

type QuestionnaireKeybinding = Parameters<KeybindingsManager["getKeys"]>[0];

function keybindingHint(
  theme: Theme,
  keybindings: KeybindingsManager,
  keybinding: QuestionnaireKeybinding,
  description: string,
): string {
  return rawKeyHint(theme, formatHintKeys(keybindings.getKeys(keybinding)), description);
}

function rawKeyHint(theme: Theme, keys: string, description: string): string {
  if (!keys) return "";
  return `${theme.fg("dim", keys)}${theme.fg("muted", ` ${description}`)}`;
}

function cancelHint(theme: Theme, keybindings: KeybindingsManager): string {
  return rawKeyHint(theme, formatHintKeys([...keybindings.getKeys("tui.select.cancel"), "ctrl+c"]), "cancel");
}

function selectionNavigationKeys(keybindings: KeybindingsManager): string {
  const up = keybindings.getKeys("tui.select.up");
  const down = keybindings.getKeys("tui.select.down");
  if (up.includes("up") && down.includes("down")) {
    return formatHintKeys(["↑↓", ...up.filter((key) => key !== "up"), ...down.filter((key) => key !== "down")]);
  }
  return formatHintKeys([...up, ...down]);
}

function questionNavigationKeys(keybindings: KeybindingsManager): string {
  const conflictingKeys = new Set(
    ["tui.select.cancel", "tui.select.up", "tui.select.down", "tui.select.confirm"].flatMap((binding) =>
      keybindings.getKeys(binding as QuestionnaireKeybinding),
    ),
  );
  const keys: string[] = keybindings.getKeys("tui.input.tab").filter((key) => !conflictingKeys.has(key));
  const left = !conflictingKeys.has("left");
  const right = !conflictingKeys.has("right");
  if (!conflictingKeys.has("shift+tab")) keys.push("shift+tab");
  if (left && right) keys.push("←→");
  else if (left) keys.push("←");
  else if (right) keys.push("→");
  return formatHintKeys(keys);
}

function noteShortcutAvailable(keybindings: KeybindingsManager): boolean {
  return !["tui.select.cancel", "tui.select.up", "tui.select.down", "tui.select.confirm", "tui.input.tab"].some(
    (binding) => keybindings.getKeys(binding as QuestionnaireKeybinding).includes("n"),
  );
}

function formatHintKeys(keys: readonly string[]): string {
  return [...new Set(keys)].map(formatHintKey).join("/");
}

function formatHintKey(key: string): string {
  return key
    .split("+")
    .map((part) => (process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part))
    .join("+");
}

function inlineSummary(value: string): string {
  return value.split("\n").map(sanitizeQuestionnaireText).join(" ↵ ");
}

function labeledRaw(label: string, value: string, width: number, theme: Theme): string[] {
  const safeLabel = sanitizeQuestionnaireText(label);
  const prefix = `${safeLabel}: `;
  const safe = sanitizeQuestionnaireText(value);
  const lines = hardWrap(safe, Math.max(1, width - visibleWidth(prefix)));
  return lines.map((line, index) =>
    index === 0 ? `${theme.fg("muted", prefix)}${line}` : `${" ".repeat(visibleWidth(prefix))}${line}`,
  );
}

function wrapHintGroups(groups: readonly string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const group of groups) {
    if (!group) continue;
    const candidate = line ? `${line}  ${group}` : group;
    if (line && visibleWidth(candidate) > safeWidth) {
      lines.push(line);
      line = "";
    }
    if (visibleWidth(group) <= safeWidth) {
      line = line ? `${line}  ${group}` : group;
      continue;
    }
    const wrapped = hardWrap(group, safeWidth);
    lines.push(...wrapped.slice(0, -1));
    line = wrapped.at(-1) ?? "";
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function hardWrapWithIndent(value: string, width: number, indent: number): string[] {
  const safeWidth = Math.max(1, width);
  const safeIndent = Math.min(Math.max(0, indent), Math.max(0, safeWidth - 1));
  const continuationWidth = Math.max(1, safeWidth - safeIndent);
  const columns = visibleWidth(value);
  if (columns <= safeWidth) return [value];
  const output = [sliceByColumn(value, 0, safeWidth)];
  for (let column = safeWidth; column < columns; column += continuationWidth) {
    output.push(`${" ".repeat(safeIndent)}${sliceByColumn(value, column, continuationWidth)}`);
  }
  return output;
}

function hardWrap(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  if (!value) return [""];
  const output: string[] = [];
  for (const sourceLine of value.split("\n")) {
    const columns = visibleWidth(sourceLine);
    if (columns === 0) output.push("");
    else {
      for (let column = 0; column < columns; column += safeWidth) {
        output.push(sliceByColumn(sourceLine, column, safeWidth));
      }
    }
  }
  return output;
}

function formatLimit(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}
