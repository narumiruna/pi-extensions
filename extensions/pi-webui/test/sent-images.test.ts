import assert from "node:assert/strict";
import test from "node:test";
import { SentImageError, SentImageStore } from "../src/sent-images.js";

function image(marker: string) {
	return {
		name: `${marker}.png`,
		mimeType: "image/png",
		data: Buffer.from(marker).toString("base64"),
	};
}

function store(overrides: Partial<{ enabled: boolean; maxImages: number; maxBytes: number }> = {}) {
	return new SentImageStore({ enabled: true, maxImages: 3, maxBytes: 12, ...overrides });
}

test("only accepted sanitized images enter retention and source bytes have no API", () => {
	const sent = store();
	const references = sent.referencesFor("message-one", [image("safe")]);
	assert.equal(references.length, 1);
	assert.equal(sent.residentBytes(), 0);
	assert.deepEqual(sent.publicState().items, []);
	sent.commit("message-one", [image("safe")], references);
	assert.equal(sent.residentBytes(), 4);
	assert.equal(sent.publicState().items[0]?.id, references[0]);
	assert.equal(sent.publicState().items[0]?.mimeType, "image/png");
});

test("duplicate sanitized hashes collapse while preserving stable opaque references", () => {
	const sent = store();
	const first = sent.referencesFor("first", [image("same")]);
	sent.commit("first", [image("same")], first);
	const second = sent.referencesFor("second", [image("same")]);
	assert.deepEqual(second, first);
	sent.commit("second", [image("same")], second);
	assert.equal(sent.publicState().items.length, 1);
	assert.equal(sent.residentBytes(), 4);
});

test("FIFO eviction enforces count and resident byte ceilings", () => {
	const sent = store({ maxImages: 2, maxBytes: 5 });
	for (const marker of ["aa", "bb", "cccc"]) {
		const input = image(marker);
		sent.commit(marker, [input], sent.referencesFor(marker, [input]));
	}
	assert.deepEqual(
		sent.publicState().items.map((item) => item.name),
		["cccc.png"],
	);
	assert.equal(sent.residentBytes(), 4);
});

test("shared resident-byte reconciliation evicts history around active draft and in-flight bytes", () => {
	const sent = store({ maxBytes: 12 });
	for (const marker of ["four", "more"]) {
		const input = image(marker);
		sent.commit(marker, [input], sent.referencesFor(marker, [input]));
	}
	assert.equal(sent.residentBytes(), 8);
	const reconciled = sent.reconcile(6, 12);
	assert.deepEqual(
		reconciled.items.map((item) => item.name),
		["more.png"],
	);
	assert.equal(sent.residentBytes() + 6 <= 12, true);
});

test("cloning selected retained images preserves order and independent bytes", () => {
	const sent = store();
	for (const marker of ["one", "two"]) {
		const input = image(marker);
		sent.commit(marker, [input], sent.referencesFor(marker, [input]));
	}
	const [one, two] = sent.publicState().items;
	assert.ok(one && two);
	const clones = sent.clone([two.id, one.id]);
	assert.deepEqual(
		clones.map((clone) => clone.name),
		["two.png", "one.png"],
	);
	clones[0]?.bytes.fill(0);
	assert.equal(sent.preview(two.id).bytes.toString(), "two");
	assert.throws(() => sent.clone([one.id, one.id]), /duplicate/i);
});

test("delete and clear require current revisions and release bytes", () => {
	const sent = store();
	for (const marker of ["one", "two"]) {
		const input = image(marker);
		sent.commit(marker, [input], sent.referencesFor(marker, [input]));
	}
	const before = sent.publicState();
	const firstId = before.items[0]?.id;
	assert.ok(firstId);
	assert.throws(() => sent.remove(firstId, before.revision - 1), /revision/i);
	const removed = sent.remove(firstId, before.revision);
	assert.equal(removed.items.length, 1);
	sent.clear(removed.revision);
	assert.equal(sent.residentBytes(), 0);
	assert.deepEqual(sent.publicState().items, []);
});

test("disabled retention remains empty and exposes no reattach references", () => {
	const sent = store({ enabled: false });
	assert.deepEqual(sent.referencesFor("message", [image("safe")]), []);
	sent.commit("message", [image("safe")], []);
	assert.equal(sent.residentBytes(), 0);
	assert.equal(sent.publicState().enabled, false);
});

test("close clears session memory and rejects future access idempotently", () => {
	const sent = store();
	const input = image("safe");
	const [id] = sent.referencesFor("message", [input]);
	assert.ok(id);
	sent.commit("message", [input], [id]);
	sent.close();
	sent.close();
	assert.equal(sent.residentBytes(), 0);
	assert.deepEqual(sent.publicState().items, []);
	assert.throws(() => sent.preview(id), SentImageError);
});
