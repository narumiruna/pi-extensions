import { createHash } from "node:crypto";
import { latestModeContract } from "./mode-contract.js";
import { DRAFT_READ_LIMIT, isNativeDraftPath } from "./plan-draft.js";

export const DRAFT_CONTRACT_TYPE = "plan-mode-draft-contract";

export type DraftAuthorization = { kind: "managed"; path: string } | { kind: "unavailable" } | { kind: "read-only" };

interface DraftContractEntry {
  version: 1;
  authorization: DraftAuthorization;
  boundary: { length: number; hash: string };
}

function contractText(authorization: DraftAuthorization) {
  const marker = "[PI PLAN MODE DRAFT CONTRACT v1]";
  if (authorization.kind === "read-only") {
    return `${marker}\nNo draft is writable in this session. Ignore earlier draft authorizations. Use the read-only Plan mode contract and pass the complete Markdown as plan_mode_complete({ plan }).`;
  }
  const policy =
    "Only use this authorization while Plan mode is active. This contract overrides generic Plan, interaction, and finalization wording about file edits and completion parameters, including after questionnaire toggles. Questionnaire and discussion rules still apply. Do not edit project files or implement the plan.";
  if (authorization.kind === "unavailable") {
    return `${marker}\n${policy}\nThe managed draft directory is unavailable. Do not write elsewhere or supply plan text to plan_mode_complete. Ask the user to restore the directory and reload.`;
  }
  return `${marker}\n${policy}
Use Pi's native write, edit, and read to maintain the single Plan Markdown draft. The only file you may change is the draft at this exact absolute path (as a JSON string): ${JSON.stringify(authorization.path)}.
Call write or edit directly, not through another tool. Write to create the draft, edit it for targeted revisions, and read it to check the result. ${DRAFT_READ_LIMIT}
Once the file contains the complete decision-ready plan, call plan_mode_complete({}) alone as the final action. It reads the file and stores a snapshot; do not resend the Markdown as a tool argument or present it as an assistant message.`;
}

function customMessage(authorization: DraftAuthorization) {
  return {
    role: "custom" as const,
    customType: DRAFT_CONTRACT_TYPE,
    content: contractText(authorization),
    display: false,
    timestamp: 0,
  };
}

function isCanonicalDraftMessage(value: unknown, content: string) {
  const message = value as Partial<ReturnType<typeof customMessage>> | undefined;
  return (
    message?.role === "custom" &&
    message.customType === DRAFT_CONTRACT_TYPE &&
    message.display === false &&
    message.content === content
  );
}

function contextHash(messages: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function parseEntry(entry: unknown): DraftContractEntry | undefined {
  const candidate = entry as { type?: string; customType?: string; data?: Partial<DraftContractEntry> } | undefined;
  const data = candidate?.data;
  const boundary = data?.boundary;
  const authorization = data?.authorization;
  if (
    candidate?.type !== "custom" ||
    candidate.customType !== DRAFT_CONTRACT_TYPE ||
    data?.version !== 1 ||
    !boundary ||
    !Number.isSafeInteger(boundary.length) ||
    boundary.length < 0 ||
    typeof boundary.hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(boundary.hash) ||
    !authorization
  )
    return undefined;
  if (authorization.kind === "managed") {
    if (typeof authorization.path !== "string" || !isNativeDraftPath(authorization.path)) return undefined;
  } else if (authorization.kind !== "unavailable" && authorization.kind !== "read-only") return undefined;
  return { version: 1, boundary, authorization };
}

export function hasHistoricalDraftGrant(branch: readonly unknown[]) {
  return branch.some((entry) => {
    const recorded = parseEntry(entry);
    return recorded !== undefined && recorded.authorization.kind !== "read-only";
  });
}

export function reconcileDraftContract(
  messages: unknown[],
  branch: unknown[],
  expected: DraftAuthorization | undefined,
  persist: (entry: DraftContractEntry) => void,
) {
  let result = messages;
  let last: { index: number; content: string } | undefined;
  for (const entry of branch) {
    const recorded = parseEntry(entry);
    if (!recorded) continue;
    const { boundary, authorization } = recorded;
    const index = boundary.length;
    if (index > result.length || boundary.hash !== contextHash(result.slice(0, index))) continue;
    const canonical = customMessage(authorization);
    if (!isCanonicalDraftMessage(result[index], canonical.content)) {
      result = [...result.slice(0, index), canonical, ...result.slice(index)];
    }
    if (!last || index >= last.index) last = { index, content: canonical.content };
  }
  if (!expected) return result;
  const mode = latestModeContract(result);
  if (last && last.index > (mode?.index ?? -1) && last.content === contractText(expected)) {
    return result;
  }
  persist({ version: 1, authorization: expected, boundary: { length: result.length, hash: contextHash(result) } });
  return [...result, customMessage(expected)];
}

export function hasStandaloneAssistantToolCall(branch: unknown[], toolCallId: string, toolName: string) {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as { type?: string; message?: { role?: string; content?: unknown[] } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const calls = entry.message.content?.filter((value) => (value as { type?: string })?.type === "toolCall");
    const call = calls?.[0] as { id?: string; name?: string } | undefined;
    return calls?.length === 1 && call?.id === toolCallId && call.name === toolName;
  }
  return false;
}
