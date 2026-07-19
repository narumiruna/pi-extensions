import assert from "node:assert/strict";
import test from "node:test";
import { DraftError, DraftStore } from "../src/drafts.js";

function store() {
	return new DraftStore({ maxTextBytes: 32, maxMutationRecords: 4 });
}

test("draft text mutations require revisions, bound bytes, and deduplicate mutation ids", () => {
	const draft = store();
	assert.deepEqual(draft.publicState(), {
		revision: 0,
		text: "",
		attachmentRevision: 0,
		attachmentIds: [],
	});
	const first = draft.setText("hello", 0, "mutation-1");
	assert.equal(first.revision, 1);
	assert.equal(first.text, "hello");
	assert.equal(draft.residentBytes(), 5);
	assert.deepEqual(draft.setText("hello", 0, "mutation-1"), first);
	assert.throws(() => draft.setText("changed", 1, "mutation-1"), /reused/i);
	assert.throws(() => draft.setText("stale", 0, "mutation-2"), /revision/i);
	assert.throws(() => draft.setText("x".repeat(33), 1, "mutation-3"), /large/i);
	assert.equal(draft.publicState().text, "hello");
});

test("ordered attachment references synchronize independently from processing status", () => {
	const draft = store();
	draft.setText("describe", 0, "text");
	let state = draft.syncAttachments(["one", "two"], 4);
	assert.deepEqual(state.attachmentIds, ["one", "two"]);
	assert.equal(state.attachmentRevision, 4);
	const unchanged = draft.syncAttachments(["one", "two"], 5);
	assert.equal(unchanged.revision, state.revision);
	assert.equal(unchanged.attachmentRevision, 4);
	state = draft.syncAttachments(["two", "one"], 6);
	assert.deepEqual(state.attachmentIds, ["two", "one"]);
	assert.throws(() => draft.syncAttachments(["two", "two"], 7), /duplicate/i);
});

test("accepted sends clear only matching text and attachment references", () => {
	const draft = store();
	draft.setText("old", 0, "old-text");
	draft.syncAttachments(["one"], 2);
	const attempt = draft.beginSend(draft.publicState().revision);
	draft.setText("new", draft.publicState().revision, "new-text");
	const completed = draft.finishSend(attempt.token, true, { revision: 3, ids: [] });
	assert.equal(completed.text, "new");
	assert.deepEqual(completed.attachmentIds, []);
	assert.equal(completed.attachmentRevision, 3);
});

test("a newer attachment draft created during send is preserved", () => {
	const draft = store();
	draft.setText("send", 0, "text");
	draft.syncAttachments(["one"], 2);
	const attempt = draft.beginSend(draft.publicState().revision);
	draft.syncAttachments(["one", "two"], 3);
	const completed = draft.finishSend(attempt.token, true, { revision: 4, ids: [] });
	assert.deepEqual(completed.attachmentIds, ["one", "two"]);
	assert.equal(completed.attachmentRevision, 3);
});

test("failed sends retain the exact draft and reservations reject stale revisions", () => {
	const draft = store();
	draft.setText("retry", 0, "text");
	const before = draft.publicState();
	assert.throws(() => draft.beginSend(0), /revision/i);
	const attempt = draft.beginSend(before.revision);
	assert.deepEqual(draft.finishSend(attempt.token, false), before);
	assert.throws(() => draft.finishSend(attempt.token, false), /stale/i);
});

test("lease takeover leaves authoritative content available to the new client", () => {
	const draft = store();
	draft.setText("recover me", 0, "text");
	draft.syncAttachments(["one", "two"], 3);
	const snapshot = draft.publicState();
	assert.deepEqual(snapshot, draft.publicState());
	assert.notEqual(snapshot.attachmentIds, draft.publicState().attachmentIds);
});

test("close clears memory and rejects later mutations idempotently", () => {
	const draft = store();
	draft.setText("secret", 0, "text");
	draft.syncAttachments(["one"], 2);
	draft.close();
	draft.close();
	assert.equal(draft.residentBytes(), 0);
	assert.deepEqual(draft.publicState().attachmentIds, []);
	assert.equal(draft.publicState().text, "");
	assert.throws(() => draft.setText("late", draft.publicState().revision, "late"), DraftError);
});
