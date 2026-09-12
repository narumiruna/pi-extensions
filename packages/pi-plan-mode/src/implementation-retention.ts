import {
  findHistoryImplementationArtifact,
  injectActiveImplementationContext,
  isEmptyAssistantMessage,
  messageContainsExactPlanModeImplementationHandoff,
  messageContainsInactivePlanModeArtifact,
  messageContainsLegacyPlanModeContextArtifact,
  messageContainsPlanModeImplementationContextArtifact,
  messageContainsPlanModeImplementationHandoff,
  stripPlanModeCompletionCallsFromMessage,
  stripProposedPlanBlocksFromMessage,
} from "./message-transform.js";
import type { ImplementationPlanRetention } from "./settings.js";
import type { ActiveImplementationPlan, PlanModeState } from "./state.js";

export function retentionLabel(retention: ImplementationPlanRetention) {
  return {
    "clear-on-start": "Off — conversation history only",
    "clear-after-first-run": "Through first implementation run",
    keep: "Until manually cleared",
  }[retention];
}

export function implementationRetentionPreview(retention: ImplementationPlanRetention) {
  return {
    "clear-on-start": "Plan reinjection: Off; use conversation history only.",
    "clear-after-first-run": "Plan reinjection: Through the first implementation run.",
    keep: "Plan reinjection: Until /plan exit.",
  }[retention];
}

export interface ImplementationContextResult {
  messages: unknown[];
  clearActiveImplementationId?: string;
}

export interface ImplementationRetentionCoordinator {
  restore(activeImplementation: ActiveImplementationPlan | undefined): void;
  transformContext(messages: unknown[], state: PlanModeState): ImplementationContextResult;
  implementationSettled(activeImplementation: ActiveImplementationPlan | undefined): string | undefined;
  reset(): void;
}

export function createImplementationRetentionCoordinator(): ImplementationRetentionCoordinator {
  let implementationWithDeliveredContext: string | undefined;
  let restoredImplementationAwaitingContext: string | undefined;

  return {
    restore(activeImplementation) {
      restoredImplementationAwaitingContext =
        activeImplementation && activeImplementation.retention !== "keep" ? activeImplementation.id : undefined;
    },
    transformContext(messages, state) {
      const messagesWithoutLegacyContext = messages.filter(
        (message) => !messageContainsLegacyPlanModeContextArtifact(message),
      );
      if (state.enabled) {
        return {
          messages: messagesWithoutLegacyContext.filter(
            (message) =>
              !messageContainsPlanModeImplementationContextArtifact(message) &&
              !messageContainsPlanModeImplementationHandoff(message),
          ),
        };
      }

      const activeImplementation = state.activeImplementation;
      const inactiveMessages = activeImplementation
        ? messagesWithoutLegacyContext
        : messagesWithoutLegacyContext.filter(
            (message) =>
              !messageContainsPlanModeImplementationContextArtifact(message) &&
              !messageContainsPlanModeImplementationHandoff(message),
          );
      const historyArtifact = activeImplementation ? undefined : findHistoryImplementationArtifact(inactiveMessages);
      const historyArtifactMessage = historyArtifact ? inactiveMessages[historyArtifact.messageIndex] : undefined;
      const historyToolCallMessage =
        historyArtifact?.toolCallMessageIndex !== undefined
          ? inactiveMessages[historyArtifact.toolCallMessageIndex]
          : undefined;
      const filteredMessages = inactiveMessages
        .filter((message) => message === historyArtifactMessage || !messageContainsInactivePlanModeArtifact(message))
        .map((message) =>
          message === historyArtifactMessage && historyArtifact?.kind === "legacy"
            ? message
            : stripProposedPlanBlocksFromMessage(message),
        )
        .map((message) =>
          stripPlanModeCompletionCallsFromMessage(
            message,
            message === historyToolCallMessage ? historyArtifact?.toolCallId : undefined,
          ),
        )
        .filter((message) => !isEmptyAssistantMessage(message));
      if (!activeImplementation) return { messages: filteredMessages };

      const contextualMessages = injectActiveImplementationContext(filteredMessages, activeImplementation);
      // A busy /plan implement queues its handoff behind an older run. Do not arm cleanup
      // until that exact handoff reaches context; a restored session has no older run to drain.
      const deliveredCurrentHandoff =
        restoredImplementationAwaitingContext === activeImplementation.id ||
        filteredMessages.some((message) =>
          messageContainsExactPlanModeImplementationHandoff(message, activeImplementation.plan),
        );
      if (!deliveredCurrentHandoff) return { messages: contextualMessages };
      restoredImplementationAwaitingContext = undefined;

      if (activeImplementation.retention === "clear-after-first-run") {
        implementationWithDeliveredContext = activeImplementation.id;
      }
      return {
        messages: contextualMessages,
        clearActiveImplementationId:
          activeImplementation.retention === "clear-on-start" ? activeImplementation.id : undefined,
      };
    },
    implementationSettled(activeImplementation) {
      if (
        activeImplementation?.retention !== "clear-after-first-run" ||
        implementationWithDeliveredContext !== activeImplementation.id
      ) {
        return undefined;
      }
      implementationWithDeliveredContext = undefined;
      return activeImplementation.id;
    },
    reset() {
      implementationWithDeliveredContext = undefined;
      restoredImplementationAwaitingContext = undefined;
    },
  };
}
