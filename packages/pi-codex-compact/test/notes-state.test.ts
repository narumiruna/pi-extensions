import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	createNoteMutation,
	loadNotes,
	MAX_NOTE_COUNT,
	MAX_NOTE_MUTATION_BYTES,
	NOTES_ENTRY_TYPE,
	parseNoteMutation,
} from "../src/notes-state.js";

function entry(id: string, data: unknown, parentId: string | null = null): SessionEntry {
	return {
		type: "custom",
		customType: NOTES_ENTRY_TYPE,
		data,
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
	};
}

test("replays write and append mutations in active-branch order", () => {
	const entries = [
		entry("one", { version: 1, action: "write", note: "decisions", content: "OAuth" }),
		entry("two", { version: 1, action: "append", note: "decisions", content: " + PKCE" }, "one"),
	];
	assert.equal(loadNotes(entries).get("decisions"), "OAuth + PKCE");
	const replacement = createNoteMutation(entries, {
		action: "write",
		note: "decisions",
		content: "Passkeys",
	});
	assert.equal(replacement.notes.get("decisions"), "Passkeys");
});

test("ignores malformed stored mutations and rejects invalid new mutations", () => {
	assert.equal(parseNoteMutation({ version: 2 }), undefined);
	assert.equal(loadNotes([entry("bad", { version: 1, action: "erase" })]).size, 0);
	assert.throws(
		() => createNoteMutation([], { action: "write", note: " spaced ", content: "x" }),
		/Invalid note mutation/,
	);
	for (const note of ["decision\u001b[31m", "line\nbreak", "c1\u009bcontrol"]) {
		assert.equal(parseNoteMutation({ version: 1, action: "write", note, content: "x" }), undefined);
		assert.throws(
			() => createNoteMutation([], { action: "write", note, content: "x" }),
			/without terminal controls/,
		);
	}
	assert.throws(
		() =>
			createNoteMutation([], {
				action: "write",
				note: "large",
				content: "x".repeat(MAX_NOTE_MUTATION_BYTES + 1),
			}),
		/Invalid note mutation/,
	);
});

test("enforces note-count and aggregate bounds before publication", () => {
	const entries = Array.from({ length: MAX_NOTE_COUNT }, (_, index) =>
		entry(String(index), {
			version: 1,
			action: "write",
			note: `note-${index}`,
			content: "x",
		}),
	);
	assert.throws(
		() => createNoteMutation(entries, { action: "write", note: "overflow", content: "x" }),
		/limited/,
	);
});

test("ignores persisted mutations that would exceed aggregate bounds", () => {
	const entries = Array.from({ length: 17 }, (_, index) =>
		entry(String(index), {
			version: 1,
			action: "write",
			note: `large-${index}`,
			content: "x".repeat(MAX_NOTE_MUTATION_BYTES),
		}),
	);
	assert.equal(loadNotes(entries).size, 15);
});

test("branch reconstruction follows only supplied entries", () => {
	const base = entry("base", {
		version: 1,
		action: "write",
		note: "branch",
		content: "base",
	});
	const left = entry(
		"left",
		{ version: 1, action: "append", note: "branch", content: "-left" },
		"base",
	);
	const right = entry(
		"right",
		{ version: 1, action: "append", note: "branch", content: "-right" },
		"base",
	);
	assert.equal(loadNotes([base, left]).get("branch"), "base-left");
	assert.equal(loadNotes([base, right]).get("branch"), "base-right");
});
