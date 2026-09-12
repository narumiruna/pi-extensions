import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  type CompactionEntry,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  activeExperimentalCompaction,
  CONTEXT_CONTRACT_MESSAGE_TYPE,
  CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  CONTEXT_DETAILS_KIND,
  CONTEXT_STATE_ENTRY_TYPE,
  CONTEXT_VERSION,
  compactionRetainedContext,
  contextContract,
  contextDeactivation,
  createExperimentalContextDetails,
  createInitialContextState,
  latestContextMode,
  loadContextLineage,
  parseExperimentalCompaction,
  parseExperimentalContextDetails,
  projectExperimentalContext,
  reconcileContextContract,
} from "../src/context-window.js";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

function message(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function customState(data: unknown): SessionEntry {
  return {
    type: "custom",
    customType: CONTEXT_STATE_ENTRY_TYPE,
    data,
    id: "state",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function customMessage(
  id: string,
  parentId: string,
  customType: string,
  content: string,
): Extract<SessionEntry, { type: "custom_message" }> {
  return {
    type: "custom_message",
    customType,
    content,
    display: false,
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
  };
}

test("creates and reconstructs versioned context lineage", () => {
  const state = createInitialContextState(first);
  assert.deepEqual(state, {
    kind: CONTEXT_DETAILS_KIND,
    version: CONTEXT_VERSION,
    firstWindowId: first,
    currentWindowId: first,
  });
  const kept = message("kept", 2);
  const details = createExperimentalContextDetails({
    lineage: state,
    keptMessages: [kept],
    reason: "manual",
    windowId: second,
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  const compaction: SessionEntry = {
    type: "compaction",
    id: "compact",
    parentId: "state",
    timestamp: "2026-01-01T00:00:01.000Z",
    summary: contextContract(details),
    firstKeptEntryId: "kept",
    tokensBefore: 100,
    details,
  };
  assert.deepEqual(loadContextLineage([customState(state), compaction]), details);
  assert.deepEqual(activeExperimentalCompaction([customState(state), compaction])?.details, details);
  assert.equal(parseExperimentalContextDetails({ ...details, retryResponseFingerprint: "bad" }), undefined);
});

test("rejects malformed and unsupported context details", () => {
  assert.equal(parseExperimentalContextDetails(undefined), undefined);
  assert.equal(
    parseExperimentalContextDetails({
      kind: CONTEXT_DETAILS_KIND,
      version: 2,
      firstWindowId: first,
      previousWindowId: first,
      currentWindowId: second,
      reason: "manual",
      keptMessageFingerprints: [],
      createdAt: "now",
    }),
    undefined,
  );
});

test("accepts persisted context details only with their canonical summary", () => {
  const state = createInitialContextState(first);
  const details = createExperimentalContextDetails({
    lineage: state,
    keptMessages: [],
    reason: "manual",
    windowId: second,
  });
  const replaced: CompactionEntry = {
    type: "compaction",
    id: "replaced",
    parentId: "state",
    timestamp: "2026-01-01T00:00:01.000Z",
    summary: "Replacement summary",
    firstKeptEntryId: "state",
    tokensBefore: 100,
    details,
  };
  assert.equal(parseExperimentalCompaction(replaced), undefined);
  assert.deepEqual(loadContextLineage([customState(state), replaced]), state);
  assert.equal(activeExperimentalCompaction([customState(state), replaced]), undefined);
});

test("derives context mode from Pi's compaction-aware model order", () => {
  const state = createInitialContextState(first);
  const activation = customMessage("activation", "state", CONTEXT_CONTRACT_MESSAGE_TYPE, contextContract(state));
  const deactivation = customMessage(
    "deactivation",
    "activation",
    CONTEXT_DEACTIVATION_MESSAGE_TYPE,
    contextDeactivation(),
  );
  const details = createExperimentalContextDetails({
    lineage: state,
    keptMessages: sessionEntryToContextMessages(deactivation),
    reason: "threshold",
    windowId: second,
  });
  const compaction: SessionEntry = {
    type: "compaction",
    id: "compaction",
    parentId: "deactivation",
    timestamp: "2026-01-01T00:00:02.000Z",
    summary: contextContract(details),
    firstKeptEntryId: "deactivation",
    tokensBefore: 100,
    details,
  };
  const entries = [customState(state), activation, deactivation, compaction];
  assert.equal(latestContextMode(entries), "inactive");

  const reactivation = customMessage(
    "reactivation",
    "compaction",
    CONTEXT_CONTRACT_MESSAGE_TYPE,
    contextContract(details),
  );
  assert.equal(latestContextMode([...entries, reactivation]), "active");

  const later: SessionEntry = {
    type: "message",
    id: "later",
    parentId: "deactivation",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: message("later retained message", 2),
  };
  const discardedDetails = createExperimentalContextDetails({
    lineage: state,
    keptMessages: [later.message],
    reason: "threshold",
    windowId: second,
  });
  const compactionDiscardingDeactivation: SessionEntry = {
    ...compaction,
    id: "discarding-compaction",
    parentId: "later",
    summary: contextContract(discardedDetails),
    firstKeptEntryId: "later",
    details: discardedDetails,
  };
  assert.equal(
    latestContextMode([customState(state), activation, deactivation, later, compactionDiscardingDeactivation]),
    "active",
  );
});

test("projects only an exactly fingerprinted retained prefix", () => {
  const kept = message("old retained", 2);
  const later = message("new window", 4);
  const details = createExperimentalContextDetails({
    lineage: createInitialContextState(first),
    keptMessages: [kept],
    reason: "threshold",
    windowId: second,
    createdAt: "2026-01-01T00:00:03.000Z",
  });
  const summary: AgentMessage = {
    role: "compactionSummary",
    summary: contextContract(details),
    tokensBefore: 100,
    timestamp: 3,
  };
  const entry = {
    type: "compaction",
    id: "compact",
    parentId: "kept",
    timestamp: "2026-01-01T00:00:03.000Z",
    summary: contextContract(details),
    firstKeptEntryId: "kept",
    tokensBefore: 100,
    details,
  } as CompactionEntry<typeof details>;
  assert.deepEqual(projectExperimentalContext([summary, kept, later], entry, details), [summary, later]);
  assert.equal(projectExperimentalContext([summary, message("changed", 2), later], entry, details), undefined);
  const next = message("next ordinary turn", 5);
  const firstProjection = projectExperimentalContext([summary, kept, later], entry, details);
  const secondProjection = projectExperimentalContext([summary, kept, later, next], entry, details);
  assert.deepEqual(secondProjection?.slice(0, firstProjection?.length), firstProjection);
});

test.each(["error", "length"] as const)(
  "excludes a retried overflow %s response immediately and after reconstruction",
  (stopReason) => {
    const user = message("kept", 1);
    const failed: AgentMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: 2,
    };
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: user,
      },
      {
        type: "message",
        id: "failed",
        parentId: "user",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: failed,
      },
    ];
    const event: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "user",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: entries,
      reason: "overflow",
      willRetry: true,
      signal: new AbortController().signal,
    };
    const retained = compactionRetainedContext(event);
    assert.deepEqual(retained.keptMessages, [user]);
    assert.match(retained.retryResponseFingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(compactionRetainedContext({ ...event, willRetry: false }), {
      keptMessages: [user, failed],
    });

    const details = createExperimentalContextDetails({
      lineage: createInitialContextState(first),
      ...retained,
      reason: "overflow",
      windowId: second,
    });
    const summary: AgentMessage = {
      role: "compactionSummary",
      summary: contextContract(details),
      tokensBefore: 100,
      timestamp: 3,
    };
    const entry: CompactionEntry<typeof details> = {
      type: "compaction",
      id: "retry-compaction",
      parentId: "failed",
      timestamp: new Date(3).toISOString(),
      summary: contextContract(details),
      firstKeptEntryId: "user",
      tokensBefore: 100,
      details,
    };
    const next = message("retried response", 4);
    assert.deepEqual(projectExperimentalContext([summary, user, next], entry, details), [summary, next]);
    const reconstructedMessages = buildSessionContext(
      [
        ...entries,
        entry,
        {
          type: "message",
          id: "retry",
          parentId: entry.id,
          timestamp: new Date(4).toISOString(),
          message: next,
        },
      ],
      "retry",
    ).messages;
    assert.deepEqual(projectExperimentalContext(reconstructedMessages, entry, details), [summary, next]);
  },
);

test("fails closed when the active compaction summary timestamp is non-finite", () => {
  const kept = message("kept", 2);
  const details = createExperimentalContextDetails({
    lineage: createInitialContextState(first),
    keptMessages: [kept],
    reason: "threshold",
    windowId: second,
  });
  const summary: AgentMessage = {
    role: "compactionSummary",
    summary: contextContract(details),
    tokensBefore: 100,
    timestamp: Number.POSITIVE_INFINITY,
  };
  const olderSummary: AgentMessage = {
    role: "compactionSummary",
    summary: "older",
    tokensBefore: 50,
    timestamp: 1,
  };
  const entry = {
    type: "compaction",
    summary: contextContract(details),
  } as CompactionEntry<typeof details>;
  assert.equal(projectExperimentalContext([summary, olderSummary, kept], entry, details), undefined);
});

test("restores exactly one current context contract", () => {
  const lineage = createInitialContextState(first);
  const ordinary = [message("hello", 1)];
  const once = reconcileContextContract(ordinary, lineage);
  const twice = reconcileContextContract(once, lineage);
  assert.equal(once.length, 2);
  assert.deepEqual(twice, once);
  const branchSummary: AgentMessage = {
    role: "branchSummary",
    summary: "branch",
    fromId: "old",
    timestamp: 2,
  };
  const restored = reconcileContextContract([branchSummary, ...ordinary], lineage);
  assert.equal(restored[0], branchSummary);
  assert.equal(restored[1], ordinary[0]);
  assert.equal(restored[2].role, "custom");
});
