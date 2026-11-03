import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  collectEntriesForBranchSummary,
  convertToLlm,
  type ExtensionFactory,
  prepareBranchEntries,
  SessionManager,
  type SessionTreeEvent,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { withCoreCompatibilityFixture } from "./pi-core-compatibility-fixture.js";

// These regressions cover explicit context_edit projection. They do not claim
// that Pi filters unedited failed or aborted messages from native tree summaries.
for (const role of ["user", "assistant", "custom"] as const) {
  test(`branch preparation applies latest omission/replacement edits to ${role} without changing raw history`, () => {
    const manager = SessionManager.inMemory();
    const original = `RAW_${role}`;
    const targetId =
      role === "custom"
        ? manager.appendCustomMessageEntry("compat-context", original, false, { rawMetadata: "preserved" })
        : manager.appendMessage(
            role === "user"
              ? { role, content: original, timestamp: 100 }
              : fauxAssistantMessage(original, { timestamp: 100 }),
          );
    const raw = structuredClone(manager.getEntry(targetId));
    const prepare = () => {
      const result = prepareBranchEntries(manager.getBranch());
      assert.deepEqual(manager.getEntry(targetId), raw);
      return { ...result, serialized: serializeConversation(convertToLlm(result.messages)) };
    };
    const unedited = prepare();
    assert.equal(unedited.messages.length, 1);
    assert.ok(unedited.serialized.includes(original));
    const originalMessage = unedited.messages[0];
    assert.ok(originalMessage);

    manager.appendContextEdit(targetId, null);
    assert.deepEqual(prepare().messages, []);
    assert.equal(prepare().serialized, "");
    manager.appendContextEdit(targetId, { content: "INTERMEDIATE_REPLACEMENT" });
    const intermediate = prepare();
    assert.deepEqual(intermediate.messages, [
      {
        ...originalMessage,
        content:
          role === "assistant" ? [{ type: "text", text: "INTERMEDIATE_REPLACEMENT" }] : "INTERMEDIATE_REPLACEMENT",
      },
    ]);
    assert.ok(intermediate.serialized.includes("INTERMEDIATE_REPLACEMENT"));
    assert.equal(intermediate.serialized.includes(original), false);

    const latest = [{ type: "text" as const, text: "LATEST_REPLACEMENT" }];
    manager.appendContextEdit(targetId, { content: latest });
    const replaced = prepare();
    assert.deepEqual(replaced.messages, [{ ...originalMessage, content: latest }]);
    assert.ok(replaced.serialized.includes("LATEST_REPLACEMENT"));
    assert.equal(replaced.serialized.includes("INTERMEDIATE_REPLACEMENT"), false);
    assert.equal(replaced.serialized.includes(original), false);

    const branchWithReplacement = manager.getLeafId();
    assert.ok(branchWithReplacement);
    manager.appendContextEdit(targetId, null);
    assert.deepEqual(prepare().messages, []);
    manager.branch(targetId);
    assert.deepEqual(prepare().messages, unedited.messages, "edits on another branch must not apply");
    manager.branch(branchWithReplacement);
    assert.deepEqual(prepare().messages, replaced.messages, "the latest edit is relative to the selected branch");
  });
}

test("native tree summarization sees latest context edits and preserves abandoned raw entries", async () => {
  await withCoreCompatibilityFixture(async (fixture) => {
    const faux = fauxProvider({ provider: "compat-context-tree", tokensPerSecond: Infinity });
    const model = faux.getModel();
    const manager = SessionManager.inMemory(fixture.directory);
    const assistant = (text: string) => ({
      ...fauxAssistantMessage(text),
      api: model.api,
      provider: model.provider,
      model: model.id,
    });
    manager.appendMessage({ role: "user", content: "COMMON_USER", timestamp: 1 });
    const targetId = manager.appendMessage(assistant("COMMON_ASSISTANT"));
    manager.appendMessage({ role: "user", content: "VISIBLE_UNTOUCHED_USER", timestamp: 2 });
    const replacedUser = manager.appendMessage({ role: "user", content: "RAW_REPLACED_USER", timestamp: 3 });
    const omittedUser = manager.appendMessage({ role: "user", content: "OMITTED_USER", timestamp: 4 });
    const replacedAssistant = manager.appendMessage(assistant("RAW_REPLACED_ASSISTANT"));
    const omittedAssistant = manager.appendMessage({
      ...assistant("OMITTED_ASSISTANT"),
      content: [
        { type: "text", text: "OMITTED_ASSISTANT" },
        fauxToolCall("read", { path: "omitted-only.ts" }, { id: "compat-omitted-read" }),
      ],
      stopReason: "toolUse",
    });
    manager.appendMessage({
      role: "toolResult",
      toolName: "read",
      toolCallId: "compat-omitted-read",
      content: [{ type: "text", text: "OMITTED_TOOL_RESULT" }],
      isError: false,
      timestamp: 5,
    });
    manager.appendCustomMessageEntry("compat-visible", "VISIBLE_UNTOUCHED_CUSTOM", false, {
      hiddenDetails: "RAW_DETAILS",
    });
    const replacedCustom = manager.appendCustomMessageEntry("compat-replaced", "RAW_REPLACED_CUSTOM", true);
    const omittedCustom = manager.appendCustomMessageEntry("compat-omitted", "OMITTED_CUSTOM", false);
    manager.appendContextEdit(replacedUser, null);
    manager.appendContextEdit(replacedUser, { content: "STALE_USER_REPLACEMENT" });
    manager.appendContextEdit(replacedUser, { content: "LATEST_USER_REPLACEMENT" });
    manager.appendContextEdit(omittedUser, { content: "STALE_OMITTED_USER" });
    manager.appendContextEdit(omittedUser, null);
    manager.appendContextEdit(replacedAssistant, { content: "STALE_ASSISTANT_REPLACEMENT" });
    manager.appendContextEdit(replacedAssistant, { content: "LATEST_ASSISTANT_REPLACEMENT" });
    manager.appendContextEdit(omittedAssistant, null);
    manager.appendContextEdit(replacedCustom, { content: "STALE_CUSTOM_REPLACEMENT" });
    manager.appendContextEdit(replacedCustom, { content: [{ type: "text", text: "LATEST_CUSTOM_REPLACEMENT" }] });
    manager.appendContextEdit(omittedCustom, null);

    const requests: string[] = [];
    faux.setResponses([
      (context) => {
        requests.push(serializeConversation(context.messages));
        return fauxAssistantMessage("Native edited-branch fixture summary");
      },
    ]);
    let beforeTreeEntryIds: string[] | undefined;
    let treeEvent: SessionTreeEvent | undefined;
    const observer: ExtensionFactory = (pi) => {
      pi.on("session_before_tree", (event) => {
        beforeTreeEntryIds = event.preparation.entriesToSummarize.map((entry) => entry.id);
      });
      pi.on("session_tree", (event) => {
        treeEvent = event;
      });
    };
    const session = await fixture.createSession({
      provider: faux.provider,
      sessionManager: manager,
      extensionFactories: [observer],
    });
    const oldLeaf = manager.getLeafId();
    assert.ok(oldLeaf);
    const rawBefore = structuredClone(manager.getEntries());
    const abandonedBefore = structuredClone(manager.getBranch(oldLeaf));
    const collected = collectEntriesForBranchSummary(manager, oldLeaf, targetId);
    assert.equal(collected.commonAncestorId, targetId);
    const prepared = prepareBranchEntries(collected.entries);
    const conversation = serializeConversation(convertToLlm(prepared.messages));
    for (const marker of [
      "VISIBLE_UNTOUCHED_USER",
      "VISIBLE_UNTOUCHED_CUSTOM",
      "LATEST_USER_REPLACEMENT",
      "LATEST_ASSISTANT_REPLACEMENT",
      "LATEST_CUSTOM_REPLACEMENT",
    ]) {
      assert.ok(conversation.includes(marker), marker);
    }
    assert.doesNotMatch(conversation, /RAW_|STALE_|OMITTED_|COMMON_/u);
    assert.deepEqual([...prepared.fileOps.read], []);
    assert.deepEqual([...prepared.fileOps.edited], []);
    assert.deepEqual([...prepared.fileOps.written], []);

    const result = await session.navigateTree(targetId, { summarize: true });
    assert.equal(result.cancelled, false);
    assert.ok(result.summaryEntry);
    assert.match(result.summaryEntry.summary, /Native edited-branch fixture summary/u);
    assert.notEqual(result.summaryEntry.fromHook, true);
    assert.equal(requests.length, 1, "the default native summarizer must call the provider");
    const nativeConversation = requests[0]?.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/u)?.[1];
    assert.equal(nativeConversation, conversation);
    assert.doesNotMatch(requests[0] ?? "", /RAW_|STALE_|OMITTED_|COMMON_/u);
    assert.deepEqual(
      beforeTreeEntryIds,
      collected.entries.map((entry) => entry.id),
    );
    assert.equal(treeEvent?.fromExtension, false);
    assert.equal(result.summaryEntry.fromId, oldLeaf);
    assert.deepEqual(result.summaryEntry.details, { readFiles: [], modifiedFiles: [] });
    assert.deepEqual(manager.getEntries().slice(0, rawBefore.length), rawBefore);
    assert.deepEqual(manager.getBranch(oldLeaf), abandonedBefore);
    assert.equal(JSON.stringify(rawBefore).includes("RAW_REPLACED_ASSISTANT"), true);
    assert.equal(JSON.stringify(rawBefore).includes("OMITTED_ASSISTANT"), true);
    assert.equal(JSON.stringify(rawBefore).includes("RAW_REPLACED_CUSTOM"), true);
  });
});
