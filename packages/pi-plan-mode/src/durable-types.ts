import type { Context } from "@earendil-works/chord";
import type { Conversation, Harness, RegistryReader, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import type { PlanModeQuestion, PlanModeQuestionAnswer } from "./question-domain.js";

export type DurablePlanPhase =
  | "inactive"
  | "planning"
  | "awaiting_answers"
  | "ready"
  | "handoff_pending"
  | "implementing";
export type DurablePlanCapability = { name: string; policy: "read-only" | "bash" | "powershell" };
export type DurablePlanIdentity = { workflowId: string | null; revision: number };
export type DurablePlanMutation = { operationId: string; expected: DurablePlanIdentity };
export type DurablePlanStart = DurablePlanMutation & { workflowId: string; prompt?: string };
export type DurablePlanAnswers = DurablePlanMutation & { batchId: number; answers: PlanModeQuestionAnswer[] };
export type DurablePlanRevision = DurablePlanMutation & { feedback: string };
export type DurablePlanOperation = "start" | "answer" | "cancel_question" | "revise" | "approve" | "discard";
export type DurablePlanReceipt = {
  operationId: string;
  kind: DurablePlanOperation;
  fingerprint: string;
  revision: number;
  status: "pending" | "done" | "failed";
  requestId?: string;
  taskId?: TaskId;
  submissionId?: SubmissionId;
  error?: string;
};
export type DurablePlanWithdrawal = {
  workflowId: string;
  operationId: string;
  requestId: string;
  revision: number;
  content: string;
  submissionId: SubmissionId;
};
export type DurablePlanDelivery = {
  operationId: string;
  kind: DurablePlanOperation;
  requestId?: string;
  content?: string;
  revision: number;
  taskId?: TaskId;
  withdrawal?: DurablePlanWithdrawal;
};
export type DurablePlanState = {
  version: 1;
  owner: number;
  workflowId: string | null;
  revision: number;
  phase: DurablePlanPhase;
  registryVersion: string;
  capabilities: DurablePlanCapability[];
  question?: { batchId: number; questions: PlanModeQuestion[] };
  plan?: string;
  approval?: { planRevision: number; requestId: string; submissionId?: SubmissionId };
  delivery?: DurablePlanDelivery;
  closing?: boolean;
  receipts: DurablePlanReceipt[];
  helperReceipts: Array<{
    taskId: number;
    workflowId: string;
    revision: number;
    fingerprint: string;
    kind: "question" | "complete";
  }>;
};
export type DurablePlanView = DurablePlanState & { forked: boolean };
export type DurablePlanOptions = {
  /** Host-reviewed immutable version of the complete registry, including overrides and wrappers. */
  registryVersion: string;
  registry: RegistryReader;
  /** Explicitly reviewed capabilities; names and readOnlyHint annotations do not establish safety. */
  capabilities: readonly DurablePlanCapability[];
};
export interface DurablePlanController {
  inspect(conversation: Conversation, context: Context): Promise<DurablePlanView>;
  start(conversation: Conversation, input: DurablePlanStart, context: Context): Promise<DurablePlanView>;
  answer(conversation: Conversation, input: DurablePlanAnswers, context: Context): Promise<DurablePlanView>;
  cancelQuestion(conversation: Conversation, input: DurablePlanMutation, context: Context): Promise<DurablePlanView>;
  revise(conversation: Conversation, input: DurablePlanRevision, context: Context): Promise<DurablePlanView>;
  approve(conversation: Conversation, input: DurablePlanMutation, context: Context): Promise<DurablePlanView>;
  discard(conversation: Conversation, input: DurablePlanMutation, context: Context): Promise<DurablePlanView>;
  /** Explicitly retry or reconcile a pending delivery; inspection alone never starts execution. */
  reconcile(conversation: Conversation, context: Context): Promise<DurablePlanView>;
  /** Stop and join this controller's transition tasks. This does not remove restrictive execution guards. */
  dispose(context: Context): Promise<void>;
}
export type DurablePlanIntegration = {
  extension: import("@earendil-works/pi-durable").Extension;
  /** Pass this reviewed, execution-guarded reader to Harness.open(), not the unguarded source registry. */
  registry: RegistryReader;
  /** Bind before scheduling recovered tasks; construction does not resume the Harness. */
  createController(harness: Harness): DurablePlanController;
};
