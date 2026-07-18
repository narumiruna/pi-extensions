import assert from "node:assert/strict";
import test from "node:test";
import { BatchError, BatchStore, type ProcessedImage } from "../src/batch.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

function processed(hash: string, marker = hash): ProcessedImage {
	return {
		bytes: Buffer.from(marker),
		mimeType: "image/png",
		width: 10,
		height: 10,
		originalWidth: 10,
		originalHeight: 10,
		sourceFormat: "png",
		outputFormat: "png",
		resized: false,
		hash,
		notes: [],
	};
}

function ready(batch: BatchStore, id: string, marker = id): void {
	const source = Buffer.from(`source-${id}`);
	batch.reserveItems(
		[{ id, name: `${id}.png`, size: source.byteLength }],
		batch.publicState().revision,
	);
	batch.startProcessing(id, source);
	batch.complete(id, processed(`hash-${marker}`, marker));
}

test("item admission is atomic across count, byte, id, name, and stale-revision failures", () => {
	const batch = new BatchStore({
		...DEFAULT_SETTINGS,
		maxImages: 2,
		maxImageBytes: 10,
		maxBatchBytes: 15,
	});
	const revision = batch.publicState().revision;
	assert.throws(
		() =>
			batch.reserveItems(
				[
					{ id: "one", name: "one.png", size: 8 },
					{ id: "two", name: "two.png", size: 8 },
				],
				revision,
			),
		(error: unknown) => error instanceof BatchError && error.code === "limit",
	);
	assert.deepEqual(batch.publicState().items, []);
	assert.equal(batch.publicState().revision, revision);
	assert.throws(
		() => batch.reserveItems([{ id: "bad/id", name: "bad.png", size: 1 }], revision),
		/invalid/i,
	);
	assert.throws(
		() => batch.reserveItems([{ id: "one", name: "bad\nname.png", size: 1 }], revision),
		/invalid/i,
	);
	batch.reserveItems([{ id: "one", name: "one.png", size: 8 }], revision);
	assert.throws(
		() => batch.reserveItems([{ id: "two", name: "two.png", size: 1 }], revision),
		(error: unknown) => error instanceof BatchError && error.code === "stale",
	);
});

test("concurrent completion preserves reserved order and duplicate sanitized hashes collapse", () => {
	const batch = new BatchStore(DEFAULT_SETTINGS);
	batch.reserveItems([
		{ id: "first", name: "first.png", size: 1 },
		{ id: "second", name: "second.png", size: 1 },
		{ id: "third", name: "third.png", size: 1 },
	]);
	batch.startProcessing("third", Buffer.from("3"));
	batch.complete("third", processed("third"));
	batch.startProcessing("first", Buffer.from("1"));
	batch.complete("first", processed("same"));
	batch.startProcessing("second", Buffer.from("2"));
	assert.deepEqual(batch.complete("second", processed("same")), {
		kind: "duplicate",
		existingId: "first",
	});
	assert.deepEqual(
		batch.publicState().items.map((item) => item.id),
		["first", "third"],
	);
	assert.equal(batch.publicState().phase, "ready");

	const reverse = new BatchStore(DEFAULT_SETTINGS);
	reverse.reserveItems([
		{ id: "first", name: "first.png", size: 1 },
		{ id: "second", name: "second.png", size: 1 },
	]);
	reverse.startProcessing("first", Buffer.from("1"));
	reverse.startProcessing("second", Buffer.from("2"));
	reverse.complete("second", processed("same"));
	assert.deepEqual(reverse.complete("first", processed("same")), {
		kind: "duplicate",
		existingId: "first",
	});
	assert.deepEqual(
		reverse.publicState().items.map((item) => item.id),
		["first"],
	);
});

test("error items retain uploaded bytes for retry and sanitize displayed errors", () => {
	const batch = new BatchStore(DEFAULT_SETTINGS);
	const source = Buffer.from("data");
	batch.reserveItems([{ id: "one", name: "one.png", size: source.byteLength }]);
	batch.startProcessing("one", source);
	batch.fail("one", "bad\nthing\u0000");
	assert.equal(batch.publicState().phase, "blocked");
	assert.equal(batch.publicState().items[0]?.error, "bad thing");
	const retry = batch.retrySource("one");
	retry[0] = 0;
	assert.notEqual(batch.retrySource, undefined);
	batch.complete("one", processed("one"));
	assert.equal(batch.publicState().phase, "ready");
	assert.throws(() => batch.failUpload("one", "late browser error"), /no longer pending/i);
	assert.equal(batch.publicState().items[0]?.status, "ready");
});

test("lease replacement cancels uploading and processing items without dropping retry sources", () => {
	const batch = new BatchStore(DEFAULT_SETTINGS);
	batch.reserveItems([
		{ id: "uploading", name: "uploading.png", size: 3 },
		{ id: "processing", name: "processing.png", size: 3 },
	]);
	batch.startProcessing("processing", Buffer.from("two"));
	assert.equal(batch.cancelInFlight("Page was replaced"), true);
	assert.deepEqual(
		batch.publicState().items.map((item) => ({ status: item.status, error: item.error })),
		[
			{ status: "error", error: "Page was replaced" },
			{ status: "error", error: "Page was replaced" },
		],
	);
	assert.throws(() => batch.retrySource("uploading"), /without uploaded source/i);
	assert.deepEqual(batch.retrySource("processing"), Buffer.from("two"));
	assert.equal(batch.cancelInFlight("Again"), true);
	assert.equal(batch.cancelInFlight("Again"), false);
});

test("reorder, delete, and clear require exact current revisions", () => {
	const batch = new BatchStore(DEFAULT_SETTINGS);
	ready(batch, "one");
	ready(batch, "two");
	const revision = batch.publicState().revision;
	batch.reorder(["two", "one"], revision);
	assert.deepEqual(
		batch.publicState().items.map((item) => item.id),
		["two", "one"],
	);
	assert.throws(() => batch.delete("one", revision), /stale/i);
	const next = batch.delete("one", batch.publicState().revision);
	assert.deepEqual(
		batch.publicState().items.map((item) => item.id),
		["two"],
	);
	batch.clear(next);
	assert.equal(batch.publicState().phase, "empty");
});

test("changed auto-resize settings reprocess retained sources exactly once", () => {
	const batch = new BatchStore(DEFAULT_SETTINGS);
	const source = Buffer.from("source");
	batch.reserveItems([{ id: "one", name: "one.png", size: source.byteLength }]);
	batch.startProcessing("one", source);
	batch.complete("one", processed("one"), true);
	const jobs = batch.beginAutoResizeReprocessing(false);
	assert.equal(batch.publicState().phase, "editing");
	assert.deepEqual(jobs, [{ id: "one", source }]);
	batch.complete("one", processed("one-again"), false);
	assert.deepEqual(batch.beginAutoResizeReprocessing(false), []);
	assert.equal(batch.publicState().phase, "ready");
});

test("message reservation freezes mutations and supports digest-bounded commit or recovery", () => {
	const batch = new BatchStore(DEFAULT_SETTINGS);
	ready(batch, "one", "one");
	ready(batch, "two", "two");
	const reservation = batch.reserveMessage("describe", "followUp");
	assert.equal(batch.publicState().phase, "reserved");
	assert.deepEqual(
		reservation.images.map((image) => image.data),
		[Buffer.from("one").toString("base64"), Buffer.from("two").toString("base64")],
	);
	assert.throws(() => batch.clear(batch.publicState().revision), /frozen/i);
	assert.equal(batch.commitReservation("wrong"), false);
	assert.equal(batch.publicState().phase, "reserved");
	assert.equal(batch.restoreReservation()?.text, "describe");
	assert.equal(batch.publicState().phase, "ready");
	const next = batch.reserveMessage("describe again");
	assert.equal(batch.commitReservation(next.digest), true);
	assert.equal(batch.publicState().phase, "empty");
});

test("not-ready and closed batches reject reservation and stale async completion", () => {
	const batch = new BatchStore(DEFAULT_SETTINGS);
	batch.reserveItems([{ id: "one", name: "one.png", size: 1 }]);
	assert.throws(() => batch.reserveMessage("prompt"), /ready/i);
	batch.startProcessing("one", Buffer.from("1"));
	batch.close();
	assert.equal(batch.publicState().phase, "closed");
	assert.deepEqual(batch.publicState().items, []);
	assert.throws(
		() => batch.complete("one", processed("one")),
		(error: unknown) => error instanceof BatchError && error.code === "closed",
	);
	batch.close();
});
