import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, isKeyRepeat, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import {
  createInteractionContractMessage,
  interactionContractFromMessage,
  latestInteractionContract,
  type PlanInteractionMode,
} from "./interaction-contract.js";
import { answerPlanModeQuestions, type PlanModeQuestion, planModeQuestionCancelled } from "./question-tool.js";
import type { PlanInteractionRestoration, PlanModeState } from "./state.js";

const F2_INPUTS = ["\u001bOQ", "\u001b[12~", "\u001b[[B", "\u001b[1;1Q", "\u001b[12;1~", "\u001b[-22;1u"];
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

interface InteractionDependencies {
  getState(): PlanModeState;
  setState(state: PlanModeState): void;
  persistState(): void;
  captureCurrent(ctx: ExtensionContext): () => boolean;
  clearReadyIntent(): void;
  resetFinalization(): void;
  updateUi(ctx: ExtensionContext): void;
}

interface QuestionInteraction {
  toolCallId: string;
  sessionManager: ExtensionContext["sessionManager"];
  isCurrent(): boolean;
  controller: AbortController;
  discussionRequested: boolean;
  unsubscribe(): void;
}

interface ContextBoundary {
  length: number;
  hash: string;
}

type Contract = ReturnType<typeof createInteractionContractMessage>;

/** Fixed F2 has no modifier aliases; probe every legacy and enhanced matcher branch. */
export function interactionShortcutAvailable(bindings: Record<string, unknown>, otherShortcut?: string) {
  const reserved = [
    ...Object.values(bindings).flatMap((value) => (Array.isArray(value) ? value : [value])),
    otherShortcut,
  ];
  return !reserved.some(
    (key) =>
      typeof key === "string" && F2_INPUTS.some((input) => matchesKey(input, "f2") && matchesKey(input, key as KeyId)),
  );
}

/** Track paste markers across raw input fragments without modifying any editor input. */
export function createInteractionInputGuard() {
  let pasting = false;
  let suffix = "";
  return (data: string) => {
    const text = suffix + data;
    const wasPasting = pasting;
    let markerSeen = false;
    for (let index = 0; index < text.length; index += 1) {
      if (text.startsWith(PASTE_START, index)) {
        pasting = true;
        markerSeen = true;
        index += PASTE_START.length - 1;
      } else if (text.startsWith(PASTE_END, index)) {
        pasting = false;
        markerSeen = true;
        index += PASTE_END.length - 1;
      }
    }
    suffix = "";
    for (let length = 1; length < PASTE_START.length && length <= text.length; length += 1) {
      const candidate = text.slice(-length);
      if (PASTE_START.startsWith(candidate) || PASTE_END.startsWith(candidate)) suffix = candidate;
    }
    return !wasPasting && !pasting && !markerSeen && !suffix && !isKeyRelease(data) && !isKeyRepeat(data);
  };
}

/** Own questionnaire cancellation and interaction transitions, not Plan workflow admission. */
export function createInteractionCoordinator(pi: ExtensionAPI, dependencies: InteractionDependencies) {
  const questions = new Set<QuestionInteraction>();
  const pendingAborts = new Map<string, QuestionInteraction>();
  let shortcutInitialized = false;
  let shortcutRegistered = false;
  let removeSessionInput = () => {};
  let mainShortcutAllowed = true;
  let promptOpen = false;
  let failed = false;

  function mode(): PlanInteractionMode {
    return dependencies.getState().interactionMode === "discussion" ? "discussion" : "questions";
  }

  function publish(nextMode: PlanInteractionMode) {
    const { role: _role, timestamp: _timestamp, ...message } = createInteractionContractMessage(nextMode);
    pi.sendMessage(message, { triggerTurn: false });
  }

  function report(ctx: ExtensionContext, text: string) {
    if (ctx.hasUI) ctx.ui.notify(text, "error");
  }

  function cancelQuestions() {
    for (const question of questions) {
      question.unsubscribe();
      question.controller.abort(new DOMException("Plan question owner changed", "AbortError"));
    }
    questions.clear();
  }

  function reset() {
    cancelQuestions();
    pendingAborts.clear();
    failed = false;
    mainShortcutAllowed = true;
    promptOpen = false;
  }

  function failClosed(ctx: ExtensionContext) {
    failed = true;
    dependencies.resetFinalization();
    dependencies.clearReadyIntent();
    cancelQuestions();
    ctx.abort();
    report(
      ctx,
      "Plan interaction state could not be recovered. Questionnaires are blocked; run /reload before continuing.",
    );
  }

  function toggle(ctx: ExtensionContext): boolean {
    const isCurrent = dependencies.captureCurrent(ctx);
    if (!isCurrent() || !dependencies.getState().enabled) return false;
    if (failed) {
      report(ctx, "Questionnaires are blocked after a failed interaction transition. Run /reload before continuing.");
      return false;
    }
    const currentQuestions = [...questions].filter((question) => question.isCurrent());
    if (!ctx.isIdle() && (ctx.mode !== "tui" || currentQuestions.length === 0)) {
      if (ctx.hasUI)
        ctx.ui.notify("Wait for the agent run to settle before changing Plan interaction mode.", "warning");
      return false;
    }
    const previousState = dependencies.getState();
    const previousMode = mode();
    const nextMode = previousMode === "questions" ? "discussion" : "questions";
    try {
      dependencies.setState({ ...previousState, interactionMode: nextMode });
      dependencies.persistState();
      publish(nextMode);
    } catch {
      dependencies.setState(previousState);
      try {
        dependencies.persistState();
        publish(previousMode);
      } catch {
        failClosed(ctx);
        return false;
      }
      report(ctx, "Unable to change Plan interaction mode. The previous mode and questionnaire are unchanged.");
      return false;
    }
    if (!isCurrent()) return false;
    dependencies.resetFinalization();
    dependencies.clearReadyIntent();
    if (nextMode === "discussion") {
      for (const question of currentQuestions) {
        question.discussionRequested = true;
        pendingAborts.set(question.toolCallId, question);
        question.unsubscribe();
        question.controller.abort(new DOMException("Free discussion requested", "AbortError"));
      }
    }
    dependencies.updateUi(ctx);
    return true;
  }

  return {
    mode,
    publish,
    toggle,
    reset,
    questionsPaused: () => failed || mode() === "discussion",
    shortcutLabel: (ctx: ExtensionContext) =>
      ctx.mode === "tui" &&
      shortcutRegistered &&
      (!promptOpen || [...questions].some((question) => question.isCurrent()))
        ? "F2"
        : undefined,
    promptChanged(open: boolean, ctx: ExtensionContext) {
      if (!dependencies.captureCurrent(ctx)()) return;
      promptOpen = open;
      dependencies.updateUi(ctx);
    },
    startSession(ctx: ExtensionContext, otherShortcut?: string) {
      removeSessionInput();
      removeSessionInput = () => {};
      if (!shortcutInitialized) {
        shortcutInitialized = true;
        if (ctx.mode === "tui") {
          try {
            // No custom component owns this startup callback, so use Pi's public host registry.
            shortcutRegistered = interactionShortcutAvailable(getKeybindings().getResolvedBindings(), otherShortcut);
          } catch {
            shortcutRegistered = false;
          }
          if (shortcutRegistered) {
            pi.registerShortcut("f2", {
              description: "Toggle Plan questionnaires and free discussion",
              handler: (shortcutCtx) => {
                if (mainShortcutAllowed && !promptOpen) toggle(shortcutCtx);
              },
            });
          }
        }
      }
      if (ctx.mode === "tui" && shortcutRegistered) {
        const permitsInput = createInteractionInputGuard();
        // Pi dispatches registered shortcuts before Editor input. Observe paste state first
        // and consume repeat/release events so holding F2 cannot toggle twice.
        removeSessionInput = ctx.ui.onTerminalInput((data) => {
          mainShortcutAllowed = permitsInput(data);
          const ownsInput =
            dependencies.getState().enabled && (!promptOpen || [...questions].some((question) => question.isCurrent()));
          if (ownsInput && matchesKey(data, "f2") && (isKeyRelease(data) || isKeyRepeat(data)))
            return { consume: true };
          return undefined;
        });
      }
    },
    disposeSession() {
      removeSessionInput();
      removeSessionInput = () => {};
      reset();
    },
    async answer(toolCallId: string, values: PlanModeQuestion[], ctx: ExtensionContext, signal?: AbortSignal) {
      if (failed || mode() === "discussion") {
        return planModeQuestionCancelled(
          values,
          "questions_paused",
          "Questionnaires are paused. Continue in plain text; only the user can enable questionnaires.",
        );
      }
      const isCurrent = dependencies.captureCurrent(ctx);
      const controller = new AbortController();
      const signals = [controller.signal, signal, ctx.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      );
      const question: QuestionInteraction = {
        toolCallId,
        sessionManager: ctx.sessionManager,
        isCurrent,
        controller,
        discussionRequested: false,
        unsubscribe: () => {},
      };
      questions.add(question);
      try {
        if (ctx.mode === "tui" && shortcutRegistered) {
          const permitsInput = createInteractionInputGuard();
          const listener: TerminalInputHandler = (data) => {
            if (!permitsInput(data) || !matchesKey(data, "f2") || !isCurrent()) return undefined;
            toggle(ctx);
            return { consume: true };
          };
          question.unsubscribe = ctx.ui.onTerminalInput(listener);
        }
        return await answerPlanModeQuestions(values, ctx, {
          isCurrent,
          isEnabled: () => dependencies.getState().enabled,
          signal: AbortSignal.any(signals),
          discussionRequested: () => question.discussionRequested,
        });
      } finally {
        question.unsubscribe();
        controller.abort(new DOMException("Plan question completed", "AbortError"));
        questions.delete(question);
      }
    },
    toolExecutionEnd(toolCallId: string, ctx: ExtensionContext) {
      const question = pendingAborts.get(toolCallId);
      if (!question) return;
      pendingAborts.delete(toolCallId);
      if (question.sessionManager !== ctx.sessionManager || !question.isCurrent()) return;
      // terminate alone does not stop mixed parallel batches or nested callers.
      pendingAborts.clear();
      ctx.abort();
    },
    transformContext(messages: unknown[], ctx: ExtensionContext): unknown[] {
      // Previously visible contracts remain part of the prefix after later mode
      // changes and exits, even when their fire-and-forget publication was lost.
      const anchored = restoreInteractionHistory(messages, dependencies.getState().interactionRestorations ?? []);
      if (!dependencies.getState().enabled) return anchored;
      const expected = mode();
      if (latestInteractionContract(anchored)?.mode === expected) return anchored;
      const boundary = { length: anchored.length, hash: contextHash(anchored) };
      const canonical = createInteractionContractMessage(expected, 0);
      const message = { ...canonical, details: { ...canonical.details, contextBoundary: boundary } };
      const previousState = dependencies.getState();
      try {
        // sendMessage is fire-and-forget: Pi reports asynchronous failures separately.
        // The synchronous state entry, not that void call, owns this required contract
        // and its first model-visible boundary, including after reload.
        dependencies.setState({
          ...previousState,
          interactionRestorations: [
            ...(previousState.interactionRestorations ?? []),
            { version: 1, mode: expected, boundary },
          ],
        });
        dependencies.persistState();
        const { role: _role, timestamp: _timestamp, ...persisted } = message;
        pi.sendMessage(persisted, { triggerTurn: false });
      } catch {
        dependencies.setState(previousState);
        failClosed(ctx);
      }
      return [...anchored, message];
    },
  };
}

function contextHash(messages: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function boundaryMatches(messages: unknown[], boundary: ContextBoundary): boolean {
  return boundary.length <= messages.length && contextHash(messages.slice(0, boundary.length)) === boundary.hash;
}

function insertAtBoundary(messages: unknown[], message: Contract, index: number) {
  return [...messages.slice(0, index), message, ...messages.slice(index)];
}

function restorationFromMessage(value: unknown): PlanInteractionRestoration | undefined {
  const mode = interactionContractFromMessage(value);
  if (!mode) return undefined;
  const message = value as Contract & { details: { contextBoundary?: ContextBoundary } };
  const boundary = message.details?.contextBoundary;
  if (
    !boundary ||
    !Number.isSafeInteger(boundary.length) ||
    boundary.length < 0 ||
    typeof boundary.hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(boundary.hash)
  )
    return undefined;
  return { version: 1, mode, boundary };
}

function restorationKey(value: PlanInteractionRestoration): string {
  return `${value.mode}:${value.boundary.length}:${value.boundary.hash}`;
}

function restoreInteractionHistory(messages: unknown[], history: readonly PlanInteractionRestoration[]): unknown[] {
  const restorations = new Map(history.map((value) => [restorationKey(value), value]));
  for (const message of messages) {
    const restored = restorationFromMessage(message);
    if (restored) restorations.set(restorationKey(restored), restored);
  }
  let result = messages;
  for (const [key, restored] of restorations) {
    const remaining = result.filter((message) => {
      const candidate = restorationFromMessage(message);
      return !candidate || restorationKey(candidate) !== key;
    });
    // Compaction establishes a new prefix epoch. Do not recreate a historical
    // contract whose original retained boundary no longer exists.
    if (!boundaryMatches(remaining, restored.boundary)) continue;
    const canonical = createInteractionContractMessage(restored.mode, 0);
    const message = { ...canonical, details: { ...canonical.details, contextBoundary: restored.boundary } };
    result = insertAtBoundary(remaining, message, restored.boundary.length);
  }
  return result;
}
