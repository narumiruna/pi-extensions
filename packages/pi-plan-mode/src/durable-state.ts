import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type {
  DurablePlanAnswers,
  DurablePlanMutation,
  DurablePlanOperation,
  DurablePlanOptions,
  DurablePlanReceipt,
  DurablePlanRevision,
  DurablePlanStart,
  DurablePlanState,
  DurablePlanView,
} from "./durable-types.js";
import {
  normalizePlanModeQuestionParams,
  type PlanModeQuestion,
  type PlanModeQuestionAnswer,
} from "./question-domain.js";

export const MAX_RECEIPTS = 32;
export const MAX_FIELD = 4_000;
export const WorkflowDoc = defineDoc<DurablePlanState>({
  kind: "narumitw.plan-mode.workflow",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => initialState(0),
});
export function initialState(owner: number): DurablePlanState {
  return {
    version: 1,
    owner,
    workflowId: null,
    revision: 0,
    phase: "inactive",
    registryVersion: "",
    capabilities: [],
    receipts: [],
    helperReceipts: [],
  };
}
export function validateState(state: DurablePlanState) {
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Number.isSafeInteger(state.owner) ||
    !["inactive", "planning", "awaiting_answers", "ready", "handoff_pending", "implementing"].includes(state.phase) ||
    !Array.isArray(state.receipts) ||
    state.receipts.length > MAX_RECEIPTS ||
    !Array.isArray(state.helperReceipts) ||
    state.helperReceipts.length > MAX_RECEIPTS ||
    !Array.isArray(state.capabilities)
  ) {
    throw new Error("Unsupported or invalid durable Plan workflow document");
  }
}
export function viewOf(state: DurablePlanState | undefined, owner: number): DurablePlanView {
  const value = structuredClone(state ?? initialState(owner));
  validateState(value);
  const forked = value.owner !== owner && value.workflowId !== null;
  if (forked) {
    value.phase = "inactive";
    delete value.question;
    delete value.approval;
    delete value.delivery;
    delete value.closing;
    value.receipts = [];
    value.helperReceipts = [];
  }
  return { ...value, forked };
}

export function boundedText(value: unknown, name: string, limit: number, blank = false): string {
  if (typeof value !== "string" || value.length > limit || (!blank && !value.trim()))
    throw new Error(`${name} must be ${blank ? "a string" : "nonblank"} of at most ${limit} characters`);
  return value;
}
export function identifier(value: unknown, name: string) {
  const text = boundedText(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)) throw new Error(`${name} contains unsupported characters`);
  return text;
}
export function boundedSerialized(value: unknown, name: string) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > 50 * 1024 || text.split("\n").length > 2_000)
    throw new Error(`${name} exceeds the serialized output limit`);
  return text;
}
export function fingerprint(value: unknown): string {
  const sorted = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sorted);
    if (typeof input === "object" && input !== null)
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          // Optional object fields have the same identity as omitted fields, unlike array elements.
          .filter((key) => (input as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, sorted((input as Record<string, unknown>)[key])]),
      );
    if (input === undefined) throw new Error("Operation payload must be JSON");
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}
export function validateOptions(options: DurablePlanOptions) {
  identifier(options.registryVersion, "registryVersion");
  if (!Array.isArray(options.capabilities) || options.capabilities.length > 128)
    throw new Error("capabilities must contain at most 128 reviewed tools");
  const names = new Set<string>();
  for (const capability of options.capabilities) {
    boundedText(capability.name, "capability name", 128);
    if (names.has(capability.name) || !["read-only", "bash", "powershell"].includes(capability.policy))
      throw new Error("Invalid or duplicate reviewed capability");
    if (["edit", "write", "update_plan", "plan_mode_question", "plan_mode_complete"].includes(capability.name))
      throw new Error(`Planning cannot admit ${capability.name}`);
    names.add(capability.name);
  }
}
export function validatedQuestions(input: unknown): PlanModeQuestion[] {
  const normalized = normalizePlanModeQuestionParams(input);
  if (!normalized.ok) throw new Error(normalized.error);
  const ids = new Set<string>();
  for (const question of normalized.questions) {
    identifier(question.id, "question id");
    if (ids.has(question.id)) throw new Error("Question IDs must be unique");
    ids.add(question.id);
    boundedText(question.header, "question header", 12);
    boundedText(question.question, "question text", 1_000);
    for (const option of question.options) {
      boundedText(option.label, "option label", 128);
      boundedText(option.description, "option description", 1_000);
    }
  }
  boundedSerialized(normalized.questions, "questions");
  return normalized.questions;
}
export function validatedPlan(input: unknown) {
  if (typeof input !== "object" || input === null) throw new Error("plan must be provided");
  return boundedText((input as { plan?: unknown }).plan, "plan", 50_000);
}
function answersContent(state: DurablePlanState, input: DurablePlanAnswers): string {
  if (
    state.phase !== "awaiting_answers" ||
    !state.question ||
    input.batchId !== state.question.batchId ||
    !Array.isArray(input.answers) ||
    input.answers.length !== state.question.questions.length
  )
    throw new Error("Answers do not match the pending batch");
  const answers: PlanModeQuestionAnswer[] = [];
  const byId = new Map(input.answers.map((answer) => [answer.id, answer]));
  if (byId.size !== input.answers.length) throw new Error("Duplicate answer IDs");
  for (const question of state.question.questions) {
    const answer = byId.get(question.id);
    if (
      !answer ||
      answer.header !== question.header ||
      answer.question !== question.question ||
      typeof answer.wasCustom !== "boolean"
    )
      throw new Error("Answer does not match the pending question");
    boundedText(answer.answer, "answer", MAX_FIELD);
    if (answer.note !== undefined) boundedText(answer.note, "note", MAX_FIELD, true);
    if (answer.wasCustom) {
      if (answer.optionIndex !== undefined) throw new Error("Custom answers must not select an option");
    } else {
      const index = answer.optionIndex;
      if (
        !Number.isInteger(index) ||
        index === undefined ||
        index < 1 ||
        !question.options[index - 1] ||
        answer.answer !== question.options[index - 1]?.label
      )
        throw new Error("Invalid selected answer option");
    }
    answers.push({
      id: question.id,
      header: question.header,
      question: question.question,
      answer: answer.answer,
      wasCustom: answer.wasCustom,
      ...(answer.optionIndex === undefined ? {} : { optionIndex: answer.optionIndex }),
      ...(answer.note === undefined ? {} : { note: answer.note }),
    });
  }
  return boundedSerialized({ type: "plan_mode_answers", batchId: input.batchId, answers }, "answers");
}

export function applyHostMutation(
  state: DurablePlanState,
  owner: number,
  kind: DurablePlanOperation,
  input: DurablePlanMutation | DurablePlanStart | DurablePlanAnswers | DurablePlanRevision,
  options: DurablePlanOptions,
): { receipt: DurablePlanReceipt; duplicate: boolean } {
  validateState(state);
  identifier(input.operationId, "operationId");
  const hash = fingerprint({ kind, input });
  const forked = state.owner !== owner && state.workflowId !== null;
  const duplicate = !forked ? state.receipts.find((receipt) => receipt.operationId === input.operationId) : undefined;
  if (duplicate) {
    if (duplicate.kind !== kind || duplicate.fingerprint !== hash)
      throw new Error("Operation ID reused with a different payload");
    return { receipt: duplicate, duplicate: true };
  }
  if (!input.expected || input.expected.workflowId !== state.workflowId || input.expected.revision !== state.revision)
    throw new Error("Stale workflow identity or revision");
  if (forked && kind !== "start") throw new Error("Fork requires explicit activation with a new workflow identity");
  if (state.delivery && !forked && kind !== "discard")
    throw new Error("A workflow delivery is still pending; reconcile or discard it first");
  let content: string | undefined;
  if (kind === "start") {
    const start = input as DurablePlanStart;
    identifier(start.workflowId, "workflowId");
    if (
      start.workflowId === state.workflowId ||
      (!forked && state.phase !== "inactive" && state.phase !== "implementing")
    )
      throw new Error("Start requires an inactive workflow and a new identity");
    if (start.prompt !== undefined) content = boundedText(start.prompt, "prompt", MAX_FIELD);
    if (forked) state.receipts = [];
    state.owner = owner;
    state.workflowId = start.workflowId;
    state.registryVersion = options.registryVersion;
    state.capabilities = structuredClone([...options.capabilities]);
    state.helperReceipts = [];
    delete state.plan;
    delete state.question;
    delete state.approval;
    delete state.closing;
    delete state.delivery;
    state.phase = "planning";
  } else {
    if (state.owner !== owner || state.workflowId === null || state.phase === "inactive")
      throw new Error("No active owned workflow");
    if (kind !== "discard" && state.registryVersion !== options.registryVersion)
      throw new Error("Reviewed registry version changed; close the workflow before activation");
    switch (kind) {
      case "answer":
        content = answersContent(state, input as DurablePlanAnswers);
        delete state.question;
        state.phase = "planning";
        break;
      case "cancel_question":
        if (state.phase !== "awaiting_answers") throw new Error("No question batch to cancel");
        delete state.question;
        state.phase = "planning";
        break;
      case "revise":
        if (state.phase !== "ready") throw new Error("Only a ready plan can be revised");
        content = boundedText((input as DurablePlanRevision).feedback, "feedback", MAX_FIELD);
        delete state.plan;
        state.phase = "planning";
        break;
      case "approve":
        if (state.phase !== "ready" || state.plan === undefined)
          throw new Error("Only the exact ready plan can be approved");
        content = state.plan;
        state.approval = {
          planRevision: state.revision,
          requestId: `plan-mode:${state.workflowId}:${state.revision + 1}:approve`,
        };
        state.phase = "handoff_pending";
        break;
      case "discard":
        delete state.plan;
        delete state.question;
        delete state.approval;
        state.phase = "inactive";
        state.closing = true;
        break;
    }
  }
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Workflow revision limit reached");
  state.revision++;
  const requestId = content === undefined ? undefined : `plan-mode:${state.workflowId}:${state.revision}:${kind}`;
  const pending = content !== undefined || kind === "discard";
  const receipt: DurablePlanReceipt = {
    operationId: input.operationId,
    kind,
    fingerprint: hash,
    revision: state.revision,
    status: pending ? "pending" : "done",
    ...(requestId === undefined ? {} : { requestId }),
  };
  if (pending)
    state.delivery = {
      operationId: input.operationId,
      kind,
      revision: state.revision,
      ...(content === undefined ? {} : { content }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  state.receipts.push(receipt);
  while (state.receipts.length > MAX_RECEIPTS) state.receipts.shift();
  return { receipt, duplicate: false };
}

export type ToolAuthorization = {
  owner: number;
  workflowId: string | null;
  revision: number;
  registryVersion: string;
  mode: "plan" | "normal";
};
export function recordHelper(
  state: DurablePlanState,
  owner: number,
  taskId: number,
  kind: "question" | "complete",
  input: unknown,
  authorization: ToolAuthorization,
  registryVersion: string,
) {
  validateState(state);
  const hash = fingerprint({ kind, input });
  const previous = state.helperReceipts.find((receipt) => receipt.taskId === taskId);
  if (previous) {
    if (
      previous.kind !== kind ||
      previous.fingerprint !== hash ||
      previous.workflowId !== state.workflowId ||
      previous.revision !== state.revision ||
      state.owner !== owner ||
      authorization.owner !== owner ||
      authorization.workflowId !== state.workflowId ||
      authorization.registryVersion !== registryVersion ||
      authorization.mode !== "plan" ||
      state.registryVersion !== registryVersion
    )
      throw new Error("Stale or changed helper replay");
    return;
  }
  if (
    state.owner !== owner ||
    authorization.owner !== owner ||
    authorization.mode !== "plan" ||
    state.workflowId === null ||
    state.phase !== "planning" ||
    state.closing ||
    state.revision !== authorization.revision ||
    state.workflowId !== authorization.workflowId ||
    state.registryVersion !== registryVersion ||
    authorization.registryVersion !== registryVersion
  )
    throw new Error("Plan helper is inactive or stale");
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Workflow revision limit reached");
  if (kind === "question") state.question = { batchId: taskId, questions: validatedQuestions(input) };
  else state.plan = validatedPlan(input);
  state.phase = kind === "question" ? "awaiting_answers" : "ready";
  state.revision++;
  state.helperReceipts.push({
    taskId,
    workflowId: state.workflowId,
    revision: state.revision,
    fingerprint: hash,
    kind,
  });
  while (state.helperReceipts.length > MAX_RECEIPTS) state.helperReceipts.shift();
}
