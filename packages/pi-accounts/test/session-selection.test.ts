import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  ACCOUNT_SELECTION_ENTRY_TYPE,
  cloneAccountSelections,
  createAccountSelectionEntryData,
  restoreAccountSelections,
  setAccountSelection,
} from "../src/session-selection.js";

function customEntry(data: unknown, id = randomUUID().slice(0, 8)): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: ACCOUNT_SELECTION_ENTRY_TYPE,
    data,
  };
}

test("session account selections restore the latest matching session snapshot", () => {
  const entries = [
    customEntry(createAccountSelectionEntryData("other-session", { anthropic: "other" }), "other000"),
    customEntry(
      createAccountSelectionEntryData("current-session", {
        anthropic: "work",
        "openai-codex": null,
      }),
      "current1",
    ),
    customEntry(
      createAccountSelectionEntryData("current-session", {
        anthropic: "personal",
        "openai-codex": null,
      }),
      "current2",
    ),
  ];

  const restored = restoreAccountSelections(entries, "current-session");
  assert.equal(restored.status, "loaded");
  if (restored.status === "loaded") {
    assert.deepEqual(
      { ...restored.selections },
      {
        anthropic: "personal",
        "openai-codex": null,
      },
    );
  }
  assert.deepEqual(restoreAccountSelections(entries, "missing-session"), { status: "missing" });
});

test("session account selections preserve valid unknown providers and own properties", () => {
  const source = JSON.parse('{"anthropic":"work","future.provider":"next"}') as Record<string, string>;
  const data = createAccountSelectionEntryData("session", source);
  const updated = setAccountSelection(data.providers, "anthropic", null);
  const cloned = cloneAccountSelections(updated);

  assert.equal(Object.getPrototypeOf(cloned), null);
  assert.equal(cloned.anthropic, null);
  assert.equal(cloned["future.provider"], "next");
  assert.throws(
    () => createAccountSelectionEntryData("session", JSON.parse('{"__proto__":"guarded"}') as Record<string, string>),
    /invalid account selection provider/iu,
  );
});

test("session account selections reject malformed matching snapshots without using older state", () => {
  const valid = customEntry(createAccountSelectionEntryData("session", { anthropic: "work" }), "valid000");
  const malformed = customEntry({ version: 2, sessionId: "session", providers: { anthropic: "personal" } }, "invalid0");
  const restored = restoreAccountSelections([valid, malformed], "session");

  assert.equal(restored.status, "invalid");
  if (restored.status === "invalid") {
    assert.match(restored.message, /invalid.*\/accounts/iu);
  }
});

test("session account selections ignore copied snapshots owned by another session", () => {
  const copied = customEntry(createAccountSelectionEntryData("parent-session", { anthropic: "parent" }));

  assert.deepEqual(restoreAccountSelections([copied], "child-session"), { status: "missing" });
});

test("session account selections survive reopen while copied forks initialize independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-accounts-session-selection-"));
  try {
    const sourceId = randomUUID();
    const source = SessionManager.create(root, join(root, "source"), { id: sourceId });
    source.appendCustomEntry(
      ACCOUNT_SELECTION_ENTRY_TYPE,
      createAccountSelectionEntryData(sourceId, { anthropic: "work" }),
    );
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      api: "openai-responses",
      provider: "openai-codex",
      model: "codex",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const sourceFile = source.getSessionFile();
    assert.ok(sourceFile);

    const reopened = SessionManager.open(sourceFile);
    const restoredSource = restoreAccountSelections(reopened.getEntries(), sourceId);
    assert.equal(restoredSource.status, "loaded");
    if (restoredSource.status === "loaded") {
      assert.deepEqual({ ...restoredSource.selections }, { anthropic: "work" });
    }

    const childId = randomUUID();
    const child = SessionManager.forkFrom(sourceFile, root, join(root, "child"), { id: childId });
    assert.deepEqual(restoreAccountSelections(child.getEntries(), childId), { status: "missing" });
    child.appendCustomEntry(
      ACCOUNT_SELECTION_ENTRY_TYPE,
      createAccountSelectionEntryData(childId, { anthropic: "personal" }),
    );
    const childFile = child.getSessionFile();
    assert.ok(childFile);
    const restoredChild = restoreAccountSelections(SessionManager.open(childFile).getEntries(), childId);
    assert.equal(restoredChild.status, "loaded");
    if (restoredChild.status === "loaded") {
      assert.deepEqual({ ...restoredChild.selections }, { anthropic: "personal" });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
