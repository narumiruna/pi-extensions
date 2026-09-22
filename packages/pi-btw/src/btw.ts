import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuContext, RunMenuResult } from "@narumitw/pi-tui-kit";
import {
  type BtwBringToMainSegment,
  type BtwBringToMainSummary,
  BtwTextRangeSelector,
  type BtwTextRangeSelectorState,
  buildQuickBringToMainSegments,
  estimateBringToMainTokens,
  formatBtwBringToMain,
  getAnsweredTurns,
  summarizeBringToMain,
} from "./bring-to-main.js";
import { buildConversationContext } from "./conversation-context.js";
import { type RunBtwFullscreen, runBtwFullscreen } from "./fullscreen-ui.js";
import { registerBtwMainThreadUpdates } from "./main-thread-updates.js";
import { pickMainEntry } from "./main-tree-picker.js";
import {
  type BtwCommandMenuResult,
  type BtwResumeThreadSummary,
  runBtwMenuPreservingEditor,
  showBtwCommandMenu,
  showBtwCustomPreservingEditor,
} from "./menu.js";
import {
  type BtwSettings,
  effectiveBtwLayout,
  effectiveBtwSidePaneRatio,
  effectiveFullscreenCopyOnSelect,
  effectiveRememberThinkingLevelChanges,
  parseBtwModelReference,
  readBtwSettings,
  updateBtwSettings,
} from "./settings.js";
import {
  BTW_THINKING_LEVELS,
  type BtwThinkingLevel,
  type CompleteSimpleFunction,
  completeSideThreadTurn,
  createSideThread,
  type SideQuestionAuth,
  type SideThread,
} from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";
import { type BtwMarkdownTransformers, prepareBtwTranscriptMarkdown } from "./transcript-markdown.js";
import {
  BtwAnsweringView,
  type BtwThinkingControl,
  BtwTranscriptPager,
  type TranscriptPagerAction,
} from "./transcript-pager.js";

export { buildConversationContext } from "./conversation-context.js";
export {
  BTW_LAYOUTS,
  BTW_SETTINGS_FILE,
  type BtwLayout,
  type BtwSettings,
  type BtwSettingsLoadResult,
  normalizeBtwSettings,
  parseBtwModelReference,
  readBtwSettings,
} from "./settings.js";
export {
  BTW_THINKING_LEVELS,
  type BtwThinkingLevel,
  buildUserPrompt,
  completeSideQuestion,
} from "./side-thread.js";
export { sanitizeSingleLine } from "./text.js";

interface LoadBtwThinkingLevelOptions {
  settingsPath?: string;
  warn?: (message: string) => void;
}

type BtwModelRegistry = Pick<ExtensionCommandContext["modelRegistry"], "find" | "getAvailable">;

type BtwCompletionRegistry = Pick<ExtensionCommandContext["modelRegistry"], "streamSimple">;

export function createModelRegistryCompleteSimple(modelRegistry: BtwCompletionRegistry): CompleteSimpleFunction {
  const completeSimple: CompleteSimpleFunction = async (model, context, options) =>
    modelRegistry.streamSimple(model, context, options).result();
  completeSimple.appliesRequestHeaderTransforms = true;
  return completeSimple;
}

interface ResolveBtwModelOptions {
  settings: BtwSettings;
  currentModel: Model<Api> | undefined;
  modelRegistry: BtwModelRegistry;
  warn?: (message: string) => void;
}

export interface ResolvedBtwModel {
  model: Model<Api>;
  /** @deprecated Pi resolves request authentication through modelRegistry.streamSimple(). */
  auth?: SideQuestionAuth;
}

export interface BtwThreadState {
  id: string;
  title?: string;
  thread: SideThread;
  thinkingLevel: BtwThinkingLevel;
  createdAt: number;
  updatedAt: number;
}

export async function resolveBtwModel({
  settings,
  currentModel,
  modelRegistry,
  warn,
}: ResolveBtwModelOptions): Promise<ResolvedBtwModel | undefined> {
  const reportWarning = (message: string) => warn?.(sanitizeSingleLine(message));
  const availableModels = modelRegistry.getAvailable();
  const isAvailable = (model: Model<Api>): boolean =>
    availableModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);

  if (settings.model) {
    const fallback = currentModel ? `${currentModel.provider}/${currentModel.id}` : "the current model";
    const reference = parseBtwModelReference(settings.model);
    if (!reference) {
      reportWarning(`pi-btw model ${settings.model} is invalid; falling back to ${fallback}.`);
      return resolveBtwModel({ settings: {}, currentModel, modelRegistry, warn: reportWarning });
    }
    const configuredModel = modelRegistry.find(reference.provider, reference.modelId);
    if (!configuredModel) {
      reportWarning(`pi-btw model ${settings.model} was not found; falling back to ${fallback}.`);
    } else if (isAvailable(configuredModel)) {
      return { model: configuredModel };
    } else {
      const sameAsCurrent =
        configuredModel === currentModel ||
        (configuredModel.provider === currentModel?.provider && configuredModel.id === currentModel.id);
      const fallbackAction = sameAsCurrent ? "no distinct current model is available" : `falling back to ${fallback}`;
      reportWarning(`pi-btw model ${settings.model} is unavailable; ${fallbackAction}.`);
      if (sameAsCurrent) return undefined;
    }
  }

  return currentModel && isAvailable(currentModel) ? { model: currentModel } : undefined;
}

export async function loadBtwThinkingLevel(
  currentThinkingLevel: BtwThinkingLevel,
  options: LoadBtwThinkingLevelOptions = {},
): Promise<BtwThinkingLevel> {
  const settings = await readBtwSettings(options.settingsPath);
  if (settings.kind === "missing") return currentThinkingLevel;
  if (settings.kind === "loaded") {
    return settings.settings.thinkingLevel ?? currentThinkingLevel;
  }

  options.warn?.(
    sanitizeSingleLine(
      `pi-btw settings ignored: ${settings.reason}; expected optional model "provider/model-id", omitted thinkingLevel for Same as main thread or thinkingLevel "${BTW_THINKING_LEVELS.join('" | "')}", boolean rememberThinkingLevelChanges, boolean fullscreenCopyOnSelect, layout "fullscreen" | "left-pane" | "right-pane", and sidePaneRatio from 0.2 to 0.8. Using current Pi thinking level.`,
    ),
  );
  return currentThinkingLevel;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBtwSessionId(ctx: ExtensionCommandContext): string | undefined {
  const getSessionId = ctx.sessionManager.getSessionId;
  if (typeof getSessionId !== "function") return undefined;
  const sessionId = getSessionId.call(ctx.sessionManager);
  return sessionId.length > 0 ? sessionId : undefined;
}

function notifySafely(
  ctx: ExtensionCommandContext,
  message: string,
  level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
  try {
    ctx.ui.notify(sanitizeSingleLine(message), level);
  } catch {
    // Async command continuations may finish after their ExtensionContext is replaced.
  }
}

// Keep the command coordinator intact: its injectable menu, request, resume, and
// delivery flows share the same thread-state and test seams; settings, keybinding
// policy, terminal ownership, and rendering live in separate modules.
export interface BtwExtensionDependencies {
  showCommandMenu?: (
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    resumeThreads: readonly BtwResumeThreadSummary[],
  ) => Promise<BtwCommandMenuResult>;
  pickMainEntry?: typeof pickMainEntry;
  loadSettings?: typeof loadSettingsForCommand;
  resolveModel?: typeof resolveBtwModelForCommand;
  runThread?: typeof runBtwThread;
  runFullscreen?: RunBtwFullscreen;
}

export default function btw(pi: ExtensionAPI, dependencies: BtwExtensionDependencies = {}) {
  const showCommandMenu = dependencies.showCommandMenu ?? showCommandMenuForBtw;
  const pickEntry = dependencies.pickMainEntry ?? pickMainEntry;
  const loadSettings = dependencies.loadSettings ?? loadSettingsForCommand;
  const resolveModel = dependencies.resolveModel ?? resolveBtwModelForCommand;
  const runThread = dependencies.runThread ?? runBtwThread;
  const runFullscreen = dependencies.runFullscreen ?? runBtwFullscreen;
  const subscribeMainThreadUpdates = registerBtwMainThreadUpdates(pi);
  // Pi creates a fresh extension instance after session replacement or reload.
  const resumableThreads = new Map<string, BtwThreadState>();
  let nextThreadNumber = 1;
  const listResumeThreads = (): BtwResumeThreadSummary[] =>
    [...resumableThreads.values()]
      .reverse()
      .filter((state) => state.thread.turns.length > 0 && state.title)
      .sort((first, second) => second.updatedAt - first.updatedAt || second.createdAt - first.createdAt)
      .map((state) => ({
        id: state.id,
        title: state.title ?? "Untitled side thread",
        questionCount: state.thread.turns.length,
      }));
  pi.registerCommand("btw", {
    description: "Ask a quick side question without adding it to the main conversation",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive TUI mode", "error");
        return;
      }

      let menuResult: BtwCommandMenuResult = "start";
      let selectedConversationContext: string | undefined;
      if (!question) {
        while (true) {
          menuResult = await showCommandMenu(pi, ctx, listResumeThreads());
          if (menuResult === "closed") return;
          if (menuResult !== "tree") break;

          const treeResult = await pickEntry(pi, ctx);
          if (treeResult.kind === "closed") return;
          if (treeResult.kind === "back") continue;
          try {
            if (!ctx.sessionManager.getEntry(treeResult.entryId)) {
              notifySafely(ctx, "The selected main-thread entry is no longer available", "warning");
              continue;
            }
            const branch = ctx.sessionManager.getBranch(treeResult.entryId);
            if (branch.at(-1)?.id !== treeResult.entryId) {
              notifySafely(ctx, "The selected main-thread branch is no longer available", "warning");
              continue;
            }
            selectedConversationContext = buildConversationContext(branch);
            menuResult = "start";
            break;
          } catch {
            return;
          }
        }
      }

      const settings = await loadSettings(ctx);
      const sameAsMainThinkingLevel = settings.thinkingLevel === undefined;
      const resolution = await resolveModel(settings, ctx);
      if (resolution.kind === "cancelled") {
        notifySafely(ctx, "Cancelled", "info");
        return;
      }
      if (resolution.kind === "unavailable") {
        notifySafely(ctx, "No available model for /btw", "error");
        return;
      }

      let state = typeof menuResult === "object" ? resumableThreads.get(menuResult.threadId) : undefined;
      if (typeof menuResult === "object" && !state) {
        notifySafely(ctx, "The selected /btw side thread is no longer available", "warning");
        return;
      }
      const startingTurnCount = state?.thread.turns.length ?? 0;

      try {
        await runFullscreen(
          ctx,
          (fullscreenCtx) => {
            if (!state) {
              const createdAt = Date.now();
              state = {
                id: `btw-${nextThreadNumber}`,
                thread: createSideThread(
                  selectedConversationContext ?? buildConversationContext(fullscreenCtx.sessionManager.getBranch()),
                ),
                thinkingLevel: settings.thinkingLevel ?? pi.getThinkingLevel(),
                createdAt,
                updatedAt: createdAt,
              };
              nextThreadNumber += 1;
            }
            return runThread({
              initialQuestion: question || undefined,
              selected: resolution.selected,
              thinkingLevel: state.thinkingLevel,
              rememberThinkingLevelChanges: !sameAsMainThinkingLevel && effectiveRememberThinkingLevelChanges(settings),
              state,
              ctx: fullscreenCtx,
            });
          },
          {
            copyOnSelect: effectiveFullscreenCopyOnSelect(settings),
            layout: effectiveBtwLayout(settings),
            sidePaneRatio: effectiveBtwSidePaneRatio(settings),
            persistSidePaneRatio: (ratio, signal) =>
              updateBtwSettings({ sidePaneRatio: ratio }, { signal }).then(() => undefined),
            subscribeMainThreadUpdates: (listener) => subscribeMainThreadUpdates(ctx.sessionManager, listener),
            ...(settings.keybindings ? { keybindings: settings.keybindings } : {}),
          },
        );
      } finally {
        if (state?.title && state.thread.turns.length > 0) {
          if (state.thread.turns.length > startingTurnCount) {
            resumableThreads.delete(state.id);
          }
          resumableThreads.set(state.id, state);
        }
      }
    },
  });
}

async function showCommandMenuForBtw(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  resumeThreads: readonly BtwResumeThreadSummary[],
): Promise<BtwCommandMenuResult> {
  return showBtwCommandMenu(ctx, {
    currentThinkingLevel: pi.getThinkingLevel(),
    resumeThreads,
  });
}

async function loadSettingsForCommand(ctx: ExtensionCommandContext): Promise<BtwSettings> {
  const settingsResult = await readBtwSettings();
  if (settingsResult.kind === "loaded") return settingsResult.settings;
  if (settingsResult.kind === "invalid") {
    notifySafely(ctx, `pi-btw settings ignored: ${settingsResult.reason}`, "warning");
  }
  return {};
}

type ModelResolutionOutcome =
  | { kind: "cancelled" }
  | { kind: "unavailable" }
  | { kind: "selected"; selected: ResolvedBtwModel };

async function resolveBtwModelForCommand(
  settings: BtwSettings,
  ctx: ExtensionCommandContext,
): Promise<ModelResolutionOutcome> {
  const selected = await resolveBtwModel({
    settings,
    currentModel: ctx.model,
    modelRegistry: ctx.modelRegistry,
    warn: (message) => notifySafely(ctx, message, "warning"),
  });
  return selected ? { kind: "selected", selected } : { kind: "unavailable" };
}

interface RunBtwThreadDependencies {
  ask?: typeof askThreadQuestion;
  interact?: typeof showThreadComposer;
  chooseBringToMain?: typeof chooseBringToMain;
  deliverBringToMain?: typeof loadBringToMainDraft;
  persistThinkingLevel?: (level: BtwThinkingLevel) => Promise<unknown>;
  now?: () => number;
}

export type BtwThreadResult = { kind: "closed" };

type BtwThreadThinkingControl = Omit<BtwThinkingControl, "keybindings">;

interface BtwThreadSteeringControl {
  questions: readonly string[];
  submit: (question: string) => void;
  thinking: BtwThreadThinkingControl;
}

type BtwBringToMainChoice =
  | BtwThreadResult
  | {
      kind: "bringToMain";
      draft: string;
      summary: BtwBringToMainSummary;
      selectionState?: BtwTextRangeSelectorState;
    }
  | { kind: "back" };

type BtwBringToMainDelivery = "loaded" | "back" | "closed";

interface RunBtwThreadOptions {
  initialQuestion?: string;
  selected: ResolvedBtwModel;
  thinkingLevel: BtwThinkingLevel;
  rememberThinkingLevelChanges?: boolean;
  settingsPath?: string;
  state?: BtwThreadState;
  ctx: ExtensionCommandContext;
  dependencies?: RunBtwThreadDependencies;
}

export async function runBtwThread({
  initialQuestion,
  selected,
  thinkingLevel,
  rememberThinkingLevelChanges = false,
  settingsPath,
  state,
  ctx,
  dependencies = {},
}: RunBtwThreadOptions): Promise<BtwThreadResult> {
  const ask = dependencies.ask ?? askThreadQuestion;
  const interact = dependencies.interact ?? showThreadComposer;
  const chooseBringToMainAction = dependencies.chooseBringToMain ?? chooseBringToMain;
  const deliverBringToMainDraft = dependencies.deliverBringToMain ?? loadBringToMainDraft;
  const persistThinkingLevel =
    dependencies.persistThinkingLevel ??
    ((level: BtwThinkingLevel) => updateBtwSettings({ thinkingLevel: level }, { settingsPath }));
  const now = dependencies.now ?? Date.now;
  const thread = state?.thread ?? createSideThread(buildConversationContext(ctx.sessionManager.getBranch()));
  const thinkingLevels = getSupportedThinkingLevels(selected.model);
  const pendingWrites = new Set<Promise<void>>();
  const steeringQuestions: string[] = [];
  let activeThinkingLevel = clampThinkingLevel(selected.model, state?.thinkingLevel ?? thinkingLevel);
  if (state) state.thinkingLevel = activeThinkingLevel;
  let pendingQuestion = initialQuestion;
  let composerDraft: string | undefined;
  const createThinkingControl = (): BtwThreadThinkingControl => ({
    level: activeThinkingLevel,
    levels: thinkingLevels,
    onChange: (level) => {
      if (!thinkingLevels.includes(level)) return;
      activeThinkingLevel = level;
      if (state) state.thinkingLevel = level;
      if (!rememberThinkingLevelChanges) return;
      let write!: Promise<void>;
      write = Promise.resolve()
        .then(() => persistThinkingLevel(level))
        .then(() => undefined)
        .catch((error: unknown) => {
          notifySafely(
            ctx,
            `Thinking level changed to ${level}, but could not be remembered in pi-btw.json: ${formatError(error)}`,
            "warning",
          );
        })
        .finally(() => pendingWrites.delete(write));
      pendingWrites.add(write);
    },
  });

  try {
    while (true) {
      if (!pendingQuestion) {
        const action = await interact(thread, thread.turns.length > 0, ctx, composerDraft, createThinkingControl());
        if (action.kind === "close") return { kind: "closed" };
        if (action.kind === "bringToMain") {
          const choice = await chooseBringToMainAction(thread, ctx);
          if (choice.kind === "closed") return choice;
          if (choice.kind === "back") {
            composerDraft = action.questionDraft;
            continue;
          }
          const delivery = await deliverBringToMainDraft(choice.draft, ctx, choice.summary);
          if (delivery === "loaded" || delivery === "closed") return { kind: "closed" };
          composerDraft = action.questionDraft;
          continue;
        }
        composerDraft = undefined;
        pendingQuestion = action.question;
      }

      const result = await ask(thread, pendingQuestion, selected, activeThinkingLevel, ctx, {
        questions: steeringQuestions,
        submit: (question) => steeringQuestions.push(question),
        thinking: createThinkingControl(),
      });
      if (result.kind === "aborted") {
        notifySafely(ctx, "Cancelled", "info");
        return { kind: "closed" };
      }
      if (result.kind === "error") {
        thread.turns.push({
          kind: "error",
          question: pendingQuestion,
          answer: result.message,
        });
      }
      if (state) {
        state.title ||= sanitizeSingleLine(pendingQuestion) || "Untitled side thread";
        state.updatedAt = now();
      }

      pendingQuestion = steeringQuestions.shift();
    }
  } finally {
    await Promise.allSettled([...pendingWrites]);
  }
}

interface ChooseBringToMainDependencies {
  showMenu?: typeof showBtwMenu;
  showPreview?: typeof showBringToMainPreview;
}

export async function chooseBringToMain(
  thread: SideThread,
  ctx: ExtensionCommandContext,
  dependencies: ChooseBringToMainDependencies = {},
): Promise<BtwBringToMainChoice> {
  const answered = getAnsweredTurns(thread.turns);
  if (answered.length === 0) return { kind: "back" };
  const showMenu = dependencies.showMenu ?? showBtwMenu;
  const showPreview = dependencies.showPreview ?? showBringToMainPreview;
  const makeChoice = (segments: readonly BtwBringToMainSegment[]) => ({
    kind: "bringToMain" as const,
    draft: formatBtwBringToMain(segments),
    summary: summarizeBringToMain(segments),
  });

  const latestSegments = buildQuickBringToMainSegments(thread.turns, { kind: "latest" });
  const entireSegments = buildQuickBringToMainSegments(thread.turns, { kind: "entire" });
  const latestOption = `Latest question and answer  1 Q&A · ~${estimateBringToMainTokens(latestSegments)} tokens`;
  const fromOption = "From a question onward…  Choose a starting question";
  const exactOption = "Select exact text…  Lines or characters";
  const entireOption = `Entire side thread  ${answered.length} Q&A · ~${estimateBringToMainTokens(entireSegments)} tokens`;
  const cancelOption = "Cancel  Return to the side thread";
  let selectedScope: string | undefined;

  while (true) {
    const scopeResult = await showMenu(
      ctx,
      "Bring what back to the main thread?",
      [latestOption, fromOption, exactOption, entireOption, cancelOption],
      selectedScope,
    );
    if (scopeResult.kind === "close") return { kind: "closed" };
    if (scopeResult.kind === "back" || scopeResult.value === cancelOption) return { kind: "back" };
    const scope = scopeResult.value;
    selectedScope = scope;
    if (scope === latestOption) return makeChoice(latestSegments);
    if (scope === entireOption) {
      const choice = makeChoice(entireSegments);
      const preview = await showPreview(ctx, choice.draft, choice.summary);
      if (preview.kind === "close") return { kind: "closed" };
      if (preview.kind === "back") continue;
      return choice;
    }
    if (scope === fromOption) {
      const questions = answered.map(
        (turn, index) => `${index + 1}. ${truncatePreview(sanitizeSingleLine(turn.question))}`,
      );
      let selectedQuestion: string | undefined;
      while (true) {
        const questionResult = await showMenu(ctx, "Start from which question?", questions, selectedQuestion);
        if (questionResult.kind === "close") return { kind: "closed" };
        if (questionResult.kind === "back") break;
        const answeredTurnIndex = questions.indexOf(questionResult.value);
        if (answeredTurnIndex < 0) continue;
        selectedQuestion = questionResult.value;
        const choice = makeChoice(buildQuickBringToMainSegments(thread.turns, { kind: "from", answeredTurnIndex }));
        const preview = await showPreview(ctx, choice.draft, choice.summary);
        if (preview.kind === "close") return { kind: "closed" };
        if (preview.kind === "back") continue;
        return choice;
      }
      continue;
    }

    if (scope !== exactOption) continue;
    let selectionState: BtwTextRangeSelectorState | undefined;
    while (true) {
      const selectedRange = await showBtwCustomPreservingEditor<BtwBringToMainChoice>(
        ctx,
        (tui, theme, keybindings, done) => {
          let selector: BtwTextRangeSelector;
          selector = new BtwTextRangeSelector(
            tui,
            theme,
            keybindings,
            thread.turns,
            (action) => {
              if (action.kind === "back") done({ kind: "back" });
              else if (action.kind === "close") done({ kind: "closed" });
              else done({ ...makeChoice(action.segments), selectionState: selector.getState() });
            },
            selectionState,
          );
          return selector;
        },
      );
      if (!selectedRange) return { kind: "closed" };
      if (selectedRange.kind === "closed") return selectedRange;
      if (selectedRange.kind === "back") break;
      const preview = await showPreview(ctx, selectedRange.draft, selectedRange.summary);
      if (preview.kind === "close") return { kind: "closed" };
      if (preview.kind === "back") {
        selectionState = selectedRange.selectionState;
        continue;
      }
      return {
        kind: "bringToMain",
        draft: selectedRange.draft,
        summary: selectedRange.summary,
      };
    }
  }
}

type BtwMenuSelectorAction = { kind: "select"; value: string } | { kind: "back" } | { kind: "close" };

type BtwBringToMainPreviewAction = { kind: "bring" } | { kind: "back" } | { kind: "close" };

async function showBringToMainPreview(
  ctx: ExtensionCommandContext,
  draft: string,
  summary: BtwBringToMainSummary,
): Promise<BtwBringToMainPreviewAction> {
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (ctx.signal?.aborted) return { kind: "close" };
  let confirmed = false;
  const count = summary.messages === 1 ? "1 message" : `${summary.messages} messages`;
  const lineCount = summary.lines === 1 ? "1 line" : `${summary.lines} lines`;
  const menu = defineMenu<void, "preview", "bring", MenuContext>({
    start: "preview",
    screens: {
      preview: () => ({
        kind: "review",
        title: `Preview · ${count} · ${lineCount} · ~${summary.tokens} tokens`,
        content: draft,
        viewportSize: "adaptive",
        hint: "back",
        confirm: { id: "bring", label: "Bring", action: "bring" },
      }),
    },
    actions: {
      bring: async () => {
        confirmed = true;
        return { kind: "close" } as const;
      },
    },
  });
  const result = await runBtwMenuPreservingEditor(ctx, (menuContext) =>
    runMenu(menuContext, menu, { getState: () => undefined }),
  );
  if (confirmed && result.kind === "closed" && result.reason === "close") {
    return { kind: "bring" };
  }
  return terminalBtwMenuAction(result);
}

async function showBtwMenu(
  ctx: ExtensionCommandContext,
  title: string,
  options: readonly string[],
  initialValue?: string,
): Promise<BtwMenuSelectorAction> {
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (ctx.signal?.aborted) return { kind: "close" };
  const items = options.map((label, index) => ({ id: `option-${index}`, label }));
  const initialIndex = initialValue === undefined ? -1 : options.indexOf(initialValue);
  let selectedValue: string | undefined;
  const menu = defineMenu<void, "choices", "select", MenuContext>({
    start: "choices",
    screens: {
      choices: () => ({
        kind: "choice",
        title,
        items,
        action: "select",
        initialItemId: initialIndex >= 0 ? `option-${initialIndex}` : undefined,
        hint: "back",
      }),
    },
    actions: {
      select: async ({ itemId }: { itemId: string }) => {
        const index = Number.parseInt(itemId.slice("option-".length), 10);
        selectedValue = options[index];
        return selectedValue === undefined ? ({ kind: "stay" } as const) : ({ kind: "close" } as const);
      },
    },
  });
  const result = await runBtwMenuPreservingEditor(ctx, (menuContext) =>
    runMenu(menuContext, menu, { getState: () => undefined }),
  );
  return selectedValue !== undefined && result.kind === "closed" && result.reason === "close"
    ? { kind: "select", value: selectedValue }
    : terminalBtwMenuAction(result);
}

function terminalBtwMenuAction(result: RunMenuResult): { kind: "back" } | { kind: "close" } {
  if (result.kind === "closed") return { kind: result.reason };
  if (result.kind === "error") throw result.error;
  return { kind: "close" };
}

export async function loadBringToMainDraft(
  draft: string,
  ctx: ExtensionCommandContext,
  summary: BtwBringToMainSummary,
): Promise<BtwBringToMainDelivery> {
  const describeContent = () =>
    `${summary.messages} ${summary.messages === 1 ? "message" : "messages"} (~${summary.tokens} ${summary.tokens === 1 ? "token" : "tokens"})`;
  const existing = ctx.ui.getEditorText();
  if (!existing.trim()) {
    ctx.ui.setEditorText(draft);
    ctx.ui.notify(`Brought ${describeContent()} to the main editor. Review and submit when ready.`, "info");
    return "loaded";
  }

  const appendOption = "Append after current draft  Recommended";
  const replaceOption = "⚠ Replace current draft  Discards current editor text";
  const cancelOption = "Cancel  Return to the side thread";
  while (true) {
    const action = await showBtwMenu(ctx, "The main editor already has a draft", [
      appendOption,
      replaceOption,
      cancelOption,
    ]);
    if (action.kind === "close") return "closed";
    if (action.kind === "back" || action.value === cancelOption) return "back";
    if (action.value === appendOption) {
      ctx.ui.setEditorText(`${ctx.ui.getEditorText()}\n\n${draft}`);
      ctx.ui.notify(
        `Appended ${describeContent()} to the existing main-editor draft. Review and submit when ready.`,
        "info",
      );
      return "loaded";
    }
    if (action.value !== replaceOption) continue;

    const current = ctx.ui.getEditorText();
    const characters = [...current].length;
    const confirmed = await showBtwMenu(ctx, `Replace the current ${characters}-character editor draft?`, [
      "Back  Keep current editor text",
      "⚠ Replace current draft  Cannot be undone",
    ]);
    if (confirmed.kind === "close") return "closed";
    if (confirmed.kind === "back" || confirmed.value === "Back  Keep current editor text") continue;
    if (confirmed.value !== "⚠ Replace current draft  Cannot be undone") continue;
    if (ctx.ui.getEditorText() !== current) {
      ctx.ui.notify(
        "The main editor changed during confirmation. Review the updated draft and choose again.",
        "warning",
      );
      continue;
    }
    ctx.ui.setEditorText(draft);
    ctx.ui.notify(`Replaced the main-editor draft with ${describeContent()}. Review and submit when ready.`, "info");
    return "loaded";
  }
}

function truncatePreview(text: string): string {
  return text.length <= 72 ? text : `${text.slice(0, 69)}…`;
}

async function prepareCurrentTranscriptMarkdown(
  thread: SideThread,
  pendingQuestion: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<BtwMarkdownTransformers | undefined> {
  while (true) {
    const turnCount = thread.turns.length;
    const createMarkdownTransformers = ctx.signal
      ? await prepareBtwTranscriptMarkdown(thread.turns, pendingQuestion, ctx.signal)
      : await prepareBtwTranscriptMarkdown(thread.turns, pendingQuestion);
    if (!createMarkdownTransformers || ctx.signal?.aborted) return undefined;
    if (thread.turns.length === turnCount) return createMarkdownTransformers;
  }
}

async function askThreadQuestion(
  thread: SideThread,
  question: string,
  selected: ResolvedBtwModel,
  thinkingLevel: BtwThinkingLevel,
  ctx: ExtensionCommandContext,
  steering: BtwThreadSteeringControl,
) {
  const createMarkdownTransformers = await prepareCurrentTranscriptMarkdown(thread, question, ctx);
  if (!createMarkdownTransformers) return { kind: "aborted" as const };
  return ctx.ui.custom<Awaited<ReturnType<typeof completeSideThreadTurn>>>((tui, theme, keybindings, done) => {
    let settled = false;
    const view = new BtwAnsweringView(
      tui,
      theme,
      thread.turns,
      question,
      () => {
        if (settled) return;
        settled = true;
        done({ kind: "aborted" });
      },
      thinkingLevel,
      {
        markdownTransformers: createMarkdownTransformers(theme),
        steering: {
          questions: steering.questions,
          onSubmit: steering.submit,
          thinking: { ...steering.thinking, keybindings },
        },
      },
    );
    completeSideThreadTurn({
      thread,
      question,
      model: selected.model,
      thinkingLevel,
      signal: view.signal,
      completeSimple: createModelRegistryCompleteSimple(ctx.modelRegistry),
      sessionId: readBtwSessionId(ctx),
    }).then((result) => {
      if (settled) return;
      settled = true;
      view.finish();
      done(result);
    });
    return view;
  });
}

async function showThreadComposer(
  thread: SideThread,
  startAtBottom: boolean,
  ctx: ExtensionCommandContext,
  initialQuestion: string | undefined,
  thinking: BtwThreadThinkingControl,
): Promise<TranscriptPagerAction> {
  const createMarkdownTransformers = await prepareCurrentTranscriptMarkdown(thread, initialQuestion, ctx);
  if (!createMarkdownTransformers) return { kind: "close" };
  return ctx.ui.custom<TranscriptPagerAction>(
    (tui, theme, keybindings, done) =>
      new BtwTranscriptPager(tui, theme, thread.turns, done, {
        startAtBottom,
        initialQuestion,
        markdownTransformers: createMarkdownTransformers(theme),
        thinking: { ...thinking, keybindings },
      }),
  );
}
