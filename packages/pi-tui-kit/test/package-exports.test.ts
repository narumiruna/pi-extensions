import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

const packageRoot = path.resolve("packages/pi-tui-kit");

test("built package entrypoints resolve their documented exports", async (t) => {
  const productionSpecifier = "@narumitw/pi-tui-kit";
  const editorStatusWidgetSpecifier = "@narumitw/pi-tui-kit/editor-status-widget";
  const interactionHintsSpecifier = "@narumitw/pi-tui-kit/interaction-hints";
  const terminalDocumentSpecifier = "@narumitw/pi-tui-kit/terminal-document";
  const terminalTextSpecifier = "@narumitw/pi-tui-kit/terminal-text";
  const testingSpecifier = "@narumitw/pi-tui-kit/testing";
  const production = await import(productionSpecifier);
  const editorStatusWidget = await import(editorStatusWidgetSpecifier);
  const interactionHints = await import(interactionHintsSpecifier);
  const terminalDocument = await import(terminalDocumentSpecifier);
  const terminalText = await import(terminalTextSpecifier);
  const testing = await import(testingSpecifier);
  assert.equal(production.PI_EXTENSION_MENU_API_VERSION, 17);
  assert.equal(typeof production.renderBoundedFrame, "function");
  assert.equal(typeof production.sanitizeTerminalDocument, "function");
  assert.equal(typeof production.hardWrapTerminalDocument, "function");
  assert.equal(typeof production.sanitizeTerminalText, "function");
  assert.equal(typeof production.formatInteractionHints, "function");
  assert.equal(typeof production.EditorStatusWidget, "function");
  assert.equal(typeof production.HorizontalRule, "function");
  assert.equal(typeof production.runConfirmation, "function");
  assert.equal(typeof production.runCustomInteraction, "function");
  assert.equal(typeof production.runLiveChoice, "function");
  assert.equal(typeof production.runModelSelector, "function");
  assert.equal(typeof production.runThinkingSelector, "function");
  assert.equal(typeof production.runQuestionnaire, "function");
  assert.equal("createTuiHarness" in production, false);
  assert.equal("createRpcHarness" in production, false);
  assert.deepEqual(Object.keys(editorStatusWidget), ["EditorStatusWidget"]);
  assert.deepEqual(Object.keys(interactionHints), ["formatInteractionHints"]);
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
      `import { EditorStatusWidget as RootEditorStatusWidget, HorizontalRule, type HorizontalRuleOptions, PI_EXTENSION_MENU_API_VERSION, type BrowseDetailDocument, type ChoiceScreen, type EditorStatusWidgetOptions, type LiveChoiceItem, type MenuBrowseItem, type QuestionnaireAnswer, type QuestionnaireQuestion, type ReviewFormat, type RunQuestionnaireResult } from "@narumitw/pi-tui-kit";\n` +
      `import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";\n` +
      `import { formatInteractionHints, type FormatInteractionHintsOptions, type InteractionHint, type InteractionKeybindings } from "@narumitw/pi-tui-kit/interaction-hints";\n` +
      `import { hardWrapTerminalDocument, sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";\n` +
      `import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";\n` +
      `import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";\n` +
      `const version: 17 = PI_EXTENSION_MENU_API_VERSION;\n` +
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
      `const choice: LiveChoiceItem = { id: "active", label: "Active", confirmationDisabled: true, confirmationDisabledReason: "Already active" };\n` +
      `const screen: ChoiceScreen<"select"> = { kind: "choice", title: "Records", enableSearch: true, items: [{ id: "one", label: "One", searchText: "alias" }], action: "select" };\n` +
      `const question: QuestionnaireQuestion<"scope"> = { id: "scope", header: "Scope", prompt: "How broad?", options: [{ label: "Small" }] };\n` +
      `const answer: QuestionnaireAnswer<"scope"> = { questionId: "scope", answer: "Small", wasCustom: false, optionIndex: 1 };\n` +
      `const questionnaireResult: RunQuestionnaireResult<"scope"> = { kind: "submitted", answers: [answer] };\n` +
      `void version;\nvoid safeDocument;\nvoid wrappedDocument;\nvoid formattedHints;\nvoid rule.render(80);\nvoid widget.render(80);\nvoid rootWidget.render(80);\nvoid item;\nvoid choice;\nvoid screen;\nvoid question;\nvoid questionnaireResult;\nvoid createTuiHarness();\nvoid createRpcHarness([]);\n`,
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
