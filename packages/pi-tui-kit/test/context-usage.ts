import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type BrowseScreen,
  defineMenu,
  type InputScreen,
  type LiveChoiceItem,
  type MenuCloseReason,
  type QuestionnaireQuestion,
  type ReviewScreen,
  type RunConfirmationResult,
  type RunCustomInteractionResult,
  type RunLiveChoiceResult,
  type RunMenuResult,
  type RunQuestionnaireResult,
  type RunTaskResult,
  runConfirmation,
  runCustomInteraction,
  runLiveChoice,
  runMenu,
  runQuestionnaire,
  runTask,
} from "../src/index.js";

type Screen = "main";
type Action = "run";

const commandMenu = defineMenu<undefined, Screen, Action>({
  start: "main",
  screens: {
    main: () => ({
      kind: "actions",
      title: "Command menu",
      items: [{ id: "run", label: "Run", action: "run" }],
    }),
  },
  actions: {
    run: async ({ ctx }) => {
      await ctx.waitForIdle();
      return { kind: "close" };
    },
  },
});

const lifecycleMenu = defineMenu<undefined, Screen, Action, ExtensionContext>({
  start: "main",
  screens: {
    main: () => ({
      kind: "actions",
      title: "Lifecycle menu",
      items: [{ id: "run", label: "Run", action: "run" }],
    }),
  },
  actions: {
    run: async ({ ctx }) => {
      ctx.isIdle();
      // @ts-expect-error Lifecycle handlers must not gain command-only session methods.
      await ctx.waitForIdle();
      return { kind: "close" };
    },
  },
});

const browseScreen: BrowseScreen = {
  kind: "browse",
  title: "Catalog",
  items: [{ id: "one", label: "One", statusText: "Showing" }],
  viewportSize: "adaptive",
};
const inputScreen: InputScreen<Action> = {
  kind: "input",
  title: "Value",
  action: "run",
};
const reviewScreen: ReviewScreen<Action> = {
  kind: "review",
  title: "Review",
  content: "exact content",
  confirm: { id: "apply", label: "Apply", action: "run" },
};
const numericReviewScreen: ReviewScreen<Action> = {
  ...reviewScreen,
  viewportSize: 14,
};
const adaptiveReviewScreen: ReviewScreen<Action> = {
  ...reviewScreen,
  viewportSize: "adaptive",
};
void browseScreen;
void inputScreen;
void reviewScreen;
void numericReviewScreen;
void adaptiveReviewScreen;

const invalidInputScreen: InputScreen<Action> = {
  kind: "input",
  title: "Invalid",
  // @ts-expect-error Input actions stay within the menu action id union.
  action: "missing",
};
const invalidReviewScreen: ReviewScreen<Action> = {
  kind: "review",
  title: "Invalid",
  content: "content",
  // @ts-expect-error Review confirmation actions stay within the menu action id union.
  confirm: { id: "apply", label: "Apply", action: "missing" },
};
const invalidReviewViewport: ReviewScreen<Action> = {
  ...reviewScreen,
  // @ts-expect-error Review viewports accept only a number or the adaptive policy.
  viewportSize: "fluid",
};
void invalidInputScreen;
void invalidReviewScreen;
void invalidReviewViewport;

declare const commandContext: ExtensionCommandContext;
declare const lifecycleContext: ExtensionContext;

void runMenu(commandContext, commandMenu, { getState: () => undefined });
void runMenu(lifecycleContext, lifecycleMenu, { getState: () => undefined });

function describeMenuResult(result: RunMenuResult): string {
  switch (result.kind) {
    case "closed": {
      const reason: MenuCloseReason = result.reason;
      return reason;
    }
    case "stale":
      return "stale";
    case "unsupported":
      return result.mode;
    case "error":
      return String(result.error);
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}
void describeMenuResult;

// @ts-expect-error Closed menu results require a termination reason.
const invalidClosedResult: RunMenuResult = { kind: "closed" };
// @ts-expect-error Menu close reasons are interaction-level Back or Close only.
const invalidCloseReason: MenuCloseReason = "cancelled";
void invalidClosedResult;
void invalidCloseReason;

const commandTask: Promise<RunTaskResult<number>> = runTask(commandContext, {
  label: "Command task",
  task: async ({ ctx, signal }) => {
    await ctx.waitForIdle();
    if (signal.aborted) return 0;
    return 1;
  },
});
void commandTask;

const commandConfirmation: Promise<RunConfirmationResult> = runConfirmation(commandContext, {
  title: "Confirm command",
  message: "Continue?",
  onUnsupportedMode: async (ctx) => ctx.waitForIdle(),
});
void commandConfirmation;

void runConfirmation(lifecycleContext, {
  title: "Confirm lifecycle",
  message: "Continue?",
  onUnsupportedMode: async (ctx) => {
    ctx.isIdle();
    // @ts-expect-error Lifecycle confirmations must not gain command-only session methods.
    await ctx.waitForIdle();
  },
});

const commandInteraction: Promise<RunCustomInteractionResult<string>> = runCustomInteraction(commandContext, {
  create: ({ ctx, complete }) => ({
    render: () => [ctx.cwd],
    invalidate() {},
    handleInput: () => complete("done"),
  }),
});
void commandInteraction;

void runCustomInteraction(lifecycleContext, {
  create: ({ ctx }) => ({
    render: () => [String(ctx.isIdle())],
    invalidate() {},
    // @ts-expect-error Lifecycle custom interactions must not gain command-only session methods.
    handleInput: () => void ctx.waitForIdle(),
  }),
});

const questionnaireQuestions = [
  {
    id: "scope",
    header: "Scope",
    prompt: "How broad?",
    options: [{ label: "Small", description: "Only the bug" }],
  },
] as const satisfies readonly QuestionnaireQuestion[];
const commandQuestionnaire: Promise<RunQuestionnaireResult<"scope">> = runQuestionnaire(commandContext, {
  questions: questionnaireQuestions,
  onUnsupportedMode: async (ctx) => ctx.waitForIdle(),
});
void commandQuestionnaire;

void runQuestionnaire(lifecycleContext, {
  questions: questionnaireQuestions,
  onUnsupportedMode: async (ctx) => {
    ctx.isIdle();
    // @ts-expect-error Lifecycle questionnaires must not gain command-only session methods.
    await ctx.waitForIdle();
  },
});

const confirmationGatedItem: LiveChoiceItem<"one"> = {
  id: "one",
  label: "One",
  confirmationDisabled: true,
  confirmationDisabledReason: "Already active",
};
const commandLiveChoice: Promise<RunLiveChoiceResult<"one", never>> = runLiveChoice(commandContext, {
  title: "Command choice",
  items: [confirmationGatedItem],
  onSelectionChange: async ({ ctx }) => ctx.waitForIdle(),
});
void commandLiveChoice;

void runLiveChoice(commandContext, {
  title: "Invalid shortcut",
  items: [{ id: "one", label: "One" }],
  shortcuts: [
    {
      id: "invalid",
      // @ts-expect-error Live-choice shortcuts accept Pi KeyId values, not uppercase aliases.
      keys: ["E"],
      label: "invalid",
    },
  ],
});

void runLiveChoice(lifecycleContext, {
  title: "Lifecycle choice",
  items: [{ id: "one", label: "One" }],
  onSelectionChange: async ({ ctx }) => {
    ctx.isIdle();
    // @ts-expect-error Lifecycle live choices must not gain command-only session methods.
    await ctx.waitForIdle();
  },
});

void runTask(lifecycleContext, {
  label: "Lifecycle task",
  task: async ({ ctx }) => {
    ctx.isIdle();
    // @ts-expect-error Lifecycle tasks must not gain command-only session methods.
    await ctx.waitForIdle();
  },
});

// @ts-expect-error A command-only menu cannot run with a lifecycle context.
void runMenu(lifecycleContext, commandMenu, { getState: () => undefined });
