import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { displayPath } from "./display.js";
import { parseSnapshot, type ScopeState, STATE_TYPE } from "./state.js";

// Keep legacy identities and notice text stable: saved anchors hash the model-visible prefix.
export const NOTICE_TYPE = "scope-contract";
export const ANCHOR_TYPE = "scope-context-anchor";
export const MAX_NOTICE_BYTES = 48_000;

export interface ContractAnchor {
  version: 1;
  stateId: string;
  state: ScopeState["state"];
  count: number;
  digest: string;
  sentAt: number;
  /** A new instance of a contract that already exists earlier in the projected history. */
  recovery?: number;
}

type ScopeNotice = Extract<AgentMessage, { role: "custom" }>;
interface PlacedAnchor {
  anchor: ContractAnchor;
  notice: ScopeNotice;
}

const NON_MODEL_FIELDS = new Set([
  "timestamp",
  "durationMs",
  "usage",
  "stopReason",
  "errorMessage",
  "api",
  "provider",
  "model",
  "details",
  "nestedCalls",
]);

export function createScopeNotice(state: ScopeState, timestamp = 0): ScopeNotice | undefined {
  if (!state.entryId) return undefined;
  let content: string;
  if (state.state === "blocked") {
    content =
      "Scope state is unavailable. Do not edit files or use writing commands. The user must repair it with /scope or exit with /scope off. Reading remains available.";
  } else if (state.state === "inactive") {
    content =
      "The user ended the Scope editing restriction. Earlier Scope notices no longer apply. All other existing instructions and tool restrictions remain unchanged.";
  } else {
    content = [
      "Scope editing restriction is active. This notice replaces earlier Scope notices.",
      "Only write or edit these exact selected file targets. Use their file URLs as tool paths to preserve literal Unicode and control characters:",
      ...(state.snapshot?.targets ?? []).map(
        (target) =>
          `- ${JSON.stringify(pathToFileURL(target.path).href)}${target.path === target.canonical ? "" : ` (canonical target ${displayPath(target.canonical)})`}`,
      ),
      "Other files may be read. Shell commands and unsupported tools cannot bypass this editing boundary. Only the user can change or end the scope with /scope.",
    ].join("\n");
  }
  if (Buffer.byteLength(content) > MAX_NOTICE_BYTES)
    throw new Error(`Scope notice exceeds ${MAX_NOTICE_BYTES} bytes; select fewer files`);
  return {
    role: "custom",
    customType: NOTICE_TYPE,
    content,
    display: false,
    details: { version: 1, stateId: state.entryId },
    timestamp,
  };
}

function contractKey(message: AgentMessage): string | undefined {
  if (message.role !== "custom" || message.customType !== NOTICE_TYPE || typeof message.content !== "string") return;
  const details = message.details as { version?: unknown; stateId?: unknown } | undefined;
  if (details?.version !== 1 || typeof details.stateId !== "string") return;
  return JSON.stringify([details.stateId, message.content]);
}

function noticeKey(message: AgentMessage): string | undefined {
  const key = contractKey(message);
  if (!key) return;
  const recovery = (message as ScopeNotice).details as { recovery?: unknown } | undefined;
  return JSON.stringify([key, typeof recovery?.recovery === "number" ? recovery.recovery : 0]);
}

function anchoredNotice(notice: ScopeNotice, anchor: ContractAnchor): ScopeNotice {
  return anchor.recovery === undefined
    ? notice
    : { ...notice, details: { version: 1, stateId: anchor.stateId, recovery: anchor.recovery } };
}

function prefixDigests(messages: readonly AgentMessage[], counts: ReadonlySet<number>): Map<number, string> {
  const hash = createHash("sha256");
  const results = new Map<number, string>();
  if (counts.has(0)) results.set(0, hash.copy().digest("hex"));
  for (let index = 0; index < messages.length; index += 1) {
    const normalized = convertToLlm([messages[index]]).map((message) =>
      Object.fromEntries(Object.entries(message).filter(([key]) => !NON_MODEL_FIELDS.has(key))),
    );
    hash.update(JSON.stringify(normalized));
    hash.update("\n");
    if (counts.has(index + 1)) results.set(index + 1, hash.copy().digest("hex"));
  }
  return results;
}

function readAnchors(branch: readonly SessionEntry[]): PlacedAnchor[] {
  const states = new Map(
    branch
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)
      .map((entry) => [entry.id, entry]),
  );
  const found = new Map<string, PlacedAnchor>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== ANCHOR_TYPE || !entry.data || typeof entry.data !== "object")
      continue;
    const value = entry.data as Partial<ContractAnchor>;
    if (
      value.version !== 1 ||
      typeof value.stateId !== "string" ||
      !["active", "inactive", "blocked"].includes(value.state ?? "") ||
      !Number.isSafeInteger(value.count) ||
      (value.count as number) < 0 ||
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.sentAt !== "number" ||
      !Number.isFinite(value.sentAt) ||
      (value.recovery !== undefined && (!Number.isSafeInteger(value.recovery) || value.recovery <= 0))
    )
      continue;
    const source = states.get(value.stateId);
    if (source?.type !== "custom") continue;
    try {
      const state: ScopeState =
        value.state === "blocked"
          ? { state: "blocked", entryId: source.id }
          : { state: value.state as "active" | "inactive", entryId: source.id, snapshot: parseSnapshot(source.data) };
      if (state.state !== "blocked" && (state.snapshot?.targets === null) !== (state.state === "inactive")) continue;
      const anchor = value as ContractAnchor;
      const notice = createScopeNotice(state, anchor.sentAt);
      if (!notice) continue;
      const key = JSON.stringify([anchor.stateId, anchor.state, anchor.count, anchor.digest, anchor.recovery ?? 0]);
      if (!found.has(key)) found.set(key, { anchor, notice: anchoredNotice(notice, anchor) });
    } catch {
      // An invalid historical anchor cannot become model instructions.
    }
  }
  return [...found.values()];
}

function baseFor(
  messages: readonly AgentMessage[],
  anchors: readonly PlacedAnchor[],
  exclude: readonly ScopeNotice[] = [],
): AgentMessage[] {
  const keys = new Set([...anchors.map(({ notice }) => noticeKey(notice)), ...exclude.map(noticeKey)]);
  return messages.filter((message) => !keys.has(noticeKey(message)));
}

/** Keep only anchors whose original message prefix still exists after compaction or tree changes. */
function project(
  messages: readonly AgentMessage[],
  candidates: readonly PlacedAnchor[],
  exclude: readonly ScopeNotice[] = [],
) {
  const anchors = [...candidates];
  let base: AgentMessage[];
  for (;;) {
    base = baseFor(messages, anchors, exclude);
    const hashes = prefixDigests(base, new Set(anchors.map(({ anchor }) => anchor.count)));
    const firstSlot = base[0]?.role === "system" ? 1 : 0;
    const stale = anchors.findIndex(
      ({ anchor }) => anchor.count < firstSlot || hashes.get(anchor.count) !== anchor.digest,
    );
    if (stale < 0) break;
    // Removing an older anchor restores its native notice to the base. A newer recovery
    // digest can include that notice, so recompute before rejecting the next candidate.
    anchors.splice(stale, 1);
  }
  const at = new Map<number, ScopeNotice[]>();
  for (const { anchor, notice } of anchors) {
    const notices = at.get(anchor.count) ?? [];
    notices.push(notice);
    at.set(anchor.count, notices);
  }
  const placed: AgentMessage[] = [];
  for (let index = 0; index <= base.length; index += 1) {
    placed.push(...(at.get(index) ?? []));
    if (index < base.length) placed.push(base[index]);
  }
  return { messages: placed, base, anchors };
}

export function hasCurrentScopeNotice(messages: readonly AgentMessage[], state: ScopeState): boolean {
  const expected = createScopeNotice(state);
  if (!expected) return true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "custom" && (messages[index] as ScopeNotice).customType === NOTICE_TYPE) {
      return contractKey(messages[index]) === contractKey(expected);
    }
  }
  return false;
}

/**
 * A missing contract is stored as a non-model session entry before it is returned from context.
 * Its fixed prefix anchor, rather than wall-clock ordering or a moving tail, also places a late
 * sendMessage publication at the boundary where the model first saw it. Untouched messages retain
 * their content and relative order. Anchors are retained across off/change notices, not erased.
 */
export function reconcileScopeContext(
  messages: readonly AgentMessage[],
  branch: readonly SessionEntry[],
  state: ScopeState,
  sentAt = Date.now(),
): { messages: AgentMessage[]; anchor?: ContractAnchor } {
  const candidates = readAnchors(branch);
  const placed = project(messages, candidates);
  if (hasCurrentScopeNotice(placed.messages, state)) return { messages: placed.messages };
  const notice = createScopeNotice(state, sentAt);
  if (!notice || !state.entryId) return { messages: placed.messages };
  // A repeated contract starts a new instance. Removing its earlier native notice can
  // invalidate historical anchors whose digests include it, for example after blocked -> active.
  const repeated = placed.messages.some((message) => contractKey(message) === contractKey(notice));
  const prepared = project(messages, placed.anchors, repeated ? [] : [notice]);
  const count = prepared.base.length;
  const digest = prefixDigests(prepared.base, new Set([count])).get(count) as string;
  const anchor: ContractAnchor = { version: 1, stateId: state.entryId, state: state.state, count, digest, sentAt };
  if (repeated) {
    anchor.recovery =
      candidates.reduce(
        (latest, candidate) =>
          candidate.anchor.stateId === state.entryId ? Math.max(latest, candidate.anchor.recovery ?? 0) : latest,
        0,
      ) + 1;
    if (!Number.isSafeInteger(anchor.recovery)) throw new Error("Scope recovery sequence is exhausted");
  }
  const next = project(messages, [...prepared.anchors, { anchor, notice: anchoredNotice(notice, anchor) }]);
  return { messages: next.messages, anchor };
}
