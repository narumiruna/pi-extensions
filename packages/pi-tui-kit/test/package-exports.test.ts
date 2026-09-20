import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

const packageRoot = path.resolve("packages/pi-tui-kit");

test("built package entrypoints resolve their documented exports", async (t) => {
  const productionSpecifier = "@narumitw/pi-tui-kit";
  const confirmationSpecifier = "@narumitw/pi-tui-kit/confirmation";
  const customInteractionSpecifier = "@narumitw/pi-tui-kit/custom-interaction";
  const documentReviewSpecifier = "@narumitw/pi-tui-kit/document-review";
  const editorStatusWidgetSpecifier = "@narumitw/pi-tui-kit/editor-status-widget";
  const interactionHintsSpecifier = "@narumitw/pi-tui-kit/interaction-hints";
  const liveChoiceSpecifier = "@narumitw/pi-tui-kit/live-choice";
  const multiSelectSpecifier = "@narumitw/pi-tui-kit/multi-select";
  const questionnaireSpecifier = "@narumitw/pi-tui-kit/questionnaire";
  const selectorsSpecifier = "@narumitw/pi-tui-kit/selectors";
  const taskSpecifier = "@narumitw/pi-tui-kit/task";
  const terminalDocumentSpecifier = "@narumitw/pi-tui-kit/terminal-document";
  const terminalTextSpecifier = "@narumitw/pi-tui-kit/terminal-text";
  const testingSpecifier = "@narumitw/pi-tui-kit/testing";
  const production = await import(productionSpecifier);
  const confirmation = await import(confirmationSpecifier);
  const customInteraction = await import(customInteractionSpecifier);
  const documentReview = await import(documentReviewSpecifier);
  const editorStatusWidget = await import(editorStatusWidgetSpecifier);
  const interactionHints = await import(interactionHintsSpecifier);
  const liveChoice = await import(liveChoiceSpecifier);
  const multiSelect = await import(multiSelectSpecifier);
  const questionnaire = await import(questionnaireSpecifier);
  const selectors = await import(selectorsSpecifier);
  const task = await import(taskSpecifier);
  const terminalDocument = await import(terminalDocumentSpecifier);
  const terminalText = await import(terminalTextSpecifier);
  const testing = await import(testingSpecifier);
  assert.equal(production.PI_EXTENSION_MENU_API_VERSION, 20);
  assert.equal(typeof production.renderBoundedFrame, "function");
  assert.equal(typeof production.sanitizeTerminalDocument, "function");
  assert.equal(typeof production.hardWrapTerminalDocument, "function");
  assert.equal(typeof production.sanitizeTerminalText, "function");
  assert.equal(typeof production.formatInteractionHints, "function");
  assert.equal(typeof production.EditorStatusWidget, "function");
  assert.equal(typeof production.HorizontalRule, "function");
  assert.equal(typeof production.runConfirmation, "function");
  assert.equal(typeof production.runCustomInteraction, "function");
  assert.equal(typeof production.runDocumentReview, "function");
  assert.equal(typeof production.runLiveChoice, "function");
  assert.equal(typeof production.createMermaidMarkdownTransformer, "function");
  assert.equal(typeof production.prepareMermaidMarkdownRenderer, "function");
  assert.equal(typeof production.runMultiSelect, "function");
  assert.equal(typeof production.runModelSelector, "function");
  assert.equal(typeof production.runThinkingSelector, "function");
  assert.equal(typeof production.runQuestionnaire, "function");
  assert.equal(typeof production.runSecretInput, "function");
  assert.equal("createTuiHarness" in production, false);
  assert.equal("createRpcHarness" in production, false);
  assert.equal("callErrorReporter" in production, false);
  assert.equal("notifyInteractionError" in production, false);
  const internalReporterSpecifier = "@narumitw/pi-tui-kit/interaction-error";
  await assert.rejects(import(internalReporterSpecifier), /interaction-error.*not exported/u);
  assert.deepEqual(Object.keys(confirmation), ["runConfirmation"]);
  assert.deepEqual(Object.keys(customInteraction), ["runCustomInteraction"]);
  assert.deepEqual(Object.keys(documentReview), ["runDocumentReview"]);
  assert.deepEqual(Object.keys(editorStatusWidget), ["EditorStatusWidget"]);
  assert.deepEqual(Object.keys(interactionHints), ["formatInteractionHints"]);
  assert.deepEqual(Object.keys(liveChoice), ["runLiveChoice"]);
  assert.deepEqual(Object.keys(multiSelect), ["runMultiSelect"]);
  assert.deepEqual(Object.keys(questionnaire), ["runQuestionnaire"]);
  assert.deepEqual(Object.keys(selectors).sort(), ["runModelSelector", "runThinkingSelector"]);
  assert.deepEqual(Object.keys(task), ["runTask"]);
  assert.deepEqual(Object.keys(terminalDocument).sort(), ["hardWrapTerminalDocument", "sanitizeTerminalDocument"]);
  assert.deepEqual(Object.keys(terminalText), ["sanitizeTerminalText"]);
  assert.deepEqual(Object.keys(testing).sort(), ["createRpcHarness", "createTuiHarness"]);

  const cacheRoot = path.resolve("node_modules/.cache");
  mkdirSync(cacheRoot, { recursive: true });
  const fixture = mkdtempSync(path.join(cacheRoot, "pi-tui-kit-package-export-"));
  t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(
    path.join(fixture, "usage.ts"),
    `import type { Theme } from "@earendil-works/pi-coding-agent";\n` +
      `import { EditorStatusWidget as RootEditorStatusWidget, HorizontalRule, type HorizontalRuleOptions, PI_EXTENSION_MENU_API_VERSION, type BrowseDetailDocument, type ChoiceScreen, type EditorStatusWidgetOptions, type InputScreen, type LiveChoiceItem, type MenuBrowseItem, type MultiSelectItem, type QuestionnaireAnswer, type QuestionnaireQuestion, type ReviewFormat, type RunDocumentReviewOptions, type RunMultiSelectResult, type RunQuestionnaireResult, type RunSecretInputOptions } from "@narumitw/pi-tui-kit";\n` +
      `import { runConfirmation, type RunConfirmationResult } from "@narumitw/pi-tui-kit/confirmation";\n` +
      `import { runCustomInteraction, type RunCustomInteractionResult } from "@narumitw/pi-tui-kit/custom-interaction";\n` +
      `import { runDocumentReview, type DocumentReviewConfirmation } from "@narumitw/pi-tui-kit/document-review";\n` +
      `import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";\n` +
      `import { formatInteractionHints, type FormatInteractionHintsOptions, type InteractionHint, type InteractionKeybindings } from "@narumitw/pi-tui-kit/interaction-hints";\n` +
      `import { runLiveChoice, type RunLiveChoiceResult } from "@narumitw/pi-tui-kit/live-choice";\n` +
      `import { runMultiSelect, type RunMultiSelectOptions } from "@narumitw/pi-tui-kit/multi-select";\n` +
      `import { runQuestionnaire, type RunQuestionnaireOptions } from "@narumitw/pi-tui-kit/questionnaire";\n` +
      `import { runModelSelector, runThinkingSelector, type ThinkingLevel } from "@narumitw/pi-tui-kit/selectors";\n` +
      `import { runTask, type RunTaskResult } from "@narumitw/pi-tui-kit/task";\n` +
      `import { hardWrapTerminalDocument, sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";\n` +
      `import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";\n` +
      `import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";\n` +
      `const version: 20 = PI_EXTENSION_MENU_API_VERSION;\n` +
      `const frame: import("@narumitw/pi-tui-kit").BoundedFrameOptions = { width: 20, maxRows: 3, rule: "─", title: [], content: ["row"] };\n` +
      `void (await import("@narumitw/pi-tui-kit")).renderBoundedFrame(frame);\n` +
      `const keybindings: InteractionKeybindings<"confirm"> = { getKeys: () => ["return"] };\n` +
      `const hints: InteractionHint<"confirm">[] = [{ bindings: ["confirm"], label: sanitizeTerminalText("apply") }];\n` +
      `const hintOptions: FormatInteractionHintsOptions = { separator: "·" };\n` +
      `const formattedHints = formatInteractionHints(keybindings, hints, hintOptions);\n` +
      `const ruleOptions: HorizontalRuleOptions = { label: "Status", labelAlignment: "left", paddingX: 1 };\n` +
      `const rule = new HorizontalRule(ruleOptions);\n` +
      `const theme = { fg: (_role: string, text: string) => text } as Pick<Theme, "fg">;\n` +
      `const widgetOptions: EditorStatusWidgetOptions = { theme, renderBody: () => ["Ready"] };\n` +
      `const widget = new EditorStatusWidget(widgetOptions);\n` +
      `const rootWidget = new RootEditorStatusWidget(widgetOptions);\n` +
      `const markdown: ReviewFormat = { kind: "markdown", renderLatex: false, renderMermaid: true };\n` +
      `const document: BrowseDetailDocument = { content: "# Formula\\n\\n$x^2$", format: markdown };\n` +
      `const item: MenuBrowseItem = { id: "one", label: "One", detailDocument: document };\n` +
      `const safeDocument = sanitizeTerminalDocument("one\\ntwo");\n` +
      `const wrappedDocument = hardWrapTerminalDocument(safeDocument, 20);\n` +
      `const choice: LiveChoiceItem = { id: "active", label: "Active", searchText: "ready", confirmationDisabled: true, confirmationDisabledReason: "Already active" };\n` +
      `const screen: ChoiceScreen<"select"> = { kind: "choice", title: "Records", enableSearch: true, items: [{ id: "one", label: "One", searchText: "alias" }], action: "select" };\n` +
      `const input: InputScreen<"save"> = { kind: "input", title: "Name", initialValue: "draft", action: "save" };\n` +
      `const secret: RunSecretInputOptions = { title: "Token", required: false };\n` +
      `const question: QuestionnaireQuestion<"scope"> = { id: "scope", header: "Scope", prompt: "How broad?", options: [{ label: "Small" }] };\n` +
      `const answer: QuestionnaireAnswer<"scope"> = { questionId: "scope", answer: "Small", wasCustom: false, optionIndex: 1 };\n` +
      `const questionnaireResult: RunQuestionnaireResult<"scope"> = { kind: "submitted", answers: [answer] };\n` +
      `const reviewConfirmation: DocumentReviewConfirmation = { label: "Apply" };\n` +
      `const reviewOptions: RunDocumentReviewOptions = { title: "Review", content: "body", confirmation: reviewConfirmation };\n` +
      `const multiItem: MultiSelectItem<"read"> = { id: "read", label: "Read" };\n` +
      `const multiOptions: RunMultiSelectOptions<typeof multiItem> = { title: "Tools", items: [multiItem] };\n` +
      `const multiResult: RunMultiSelectResult<"read"> = { kind: "completed", selectedItemIds: ["read"] };\n` +
      `const confirmationResult: RunConfirmationResult = { kind: "confirmed" };\n` +
      `const customResult: RunCustomInteractionResult<number> = { kind: "completed", value: 1 };\n` +
      `const liveResult: RunLiveChoiceResult<"active"> = { kind: "selected", itemId: "active" };\n` +
      `const questionnaireOptions: RunQuestionnaireOptions<"scope"> = { questions: [question] };\n` +
      `const taskResult: RunTaskResult<number> = { kind: "completed", value: 1 };\n` +
      `const thinking: ThinkingLevel = "high";\n` +
      `void version;\nvoid safeDocument;\nvoid wrappedDocument;\nvoid formattedHints;\nvoid rule.render(80);\nvoid widget.render(80);\nvoid rootWidget.render(80);\nvoid item;\nvoid choice;\nvoid screen;\nvoid input;\nvoid secret;\nvoid question;\nvoid questionnaireResult;\nvoid reviewOptions;\nvoid multiOptions;\nvoid multiResult;\nvoid confirmationResult;\nvoid customResult;\nvoid liveResult;\nvoid questionnaireOptions;\nvoid taskResult;\nvoid thinking;\nvoid runConfirmation;\nvoid runCustomInteraction;\nvoid runDocumentReview;\nvoid runLiveChoice;\nvoid runMultiSelect;\nvoid runQuestionnaire;\nvoid runModelSelector;\nvoid runThinkingSelector;\nvoid runTask;\nvoid createTuiHarness();\nvoid createRpcHarness([]);\n`,
  );
  writeFileSync(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["usage.ts"],
    }),
  );
  const tsc = path.resolve("node_modules/.bin/tsc");
  execFileSync(tsc, ["-p", path.join(fixture, "tsconfig.json")], {
    cwd: packageRoot,
    stdio: "pipe",
  });
});
