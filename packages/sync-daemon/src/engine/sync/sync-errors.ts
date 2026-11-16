import type { SyncDecision } from "./sync-decision.js";

export class SetupPullRequiresUiError extends Error {}

export class SyncDecisionRequiredError extends Error {
  readonly decision: SyncDecision;

  constructor(decision: SyncDecision) {
    super(decision.directMessage);
    this.name = "SyncDecisionRequiredError";
    this.decision = decision;
  }
}

export function isSyncDecisionRequiredError(error: unknown): error is SyncDecisionRequiredError {
  return error instanceof SyncDecisionRequiredError;
}

export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}
