import assert from "node:assert/strict";
import test from "node:test";
import { AttachmentError, AttachmentStore, type PreparedAttachment } from "../src/attachments.js";

const limits = {
	maxImages: 3,
	maxImageBytes: 8,
	maxPromptBytes: 16,
};

function prepared(source: Uint8Array, marker = Buffer.from(source).toString()): PreparedAttachment {
	return {
		bytes: Buffer.from(`safe-${marker}`),
		mimeType: "image/png",
		width: 2,
		height: 1,
		originalWidth: 4,
		originalHeight: 2,
		sourceFormat: "bmp",
		outputFormat: "png",
		resized: true,
		notes: ["Converted from BMP to PNG", "Resized from 4×2"],
	};
}

function createStore(
	process: (source: Uint8Array, signal?: AbortSignal) => Promise<PreparedAttachment> = async (
		source,
	) => prepared(source),
	concurrency = 2,
) {
	return new AttachmentStore({ limits, process, concurrency });
}

async function settle(store: AttachmentStore): Promise<void> {
	await store.waitForIdle();
}

test("attachment admission is atomic across revisions, ids, counts, and source bytes", () => {
	const store = createStore();
	assert.equal(store.publicState().revision, 0);
	store.reserve(
		[
			{ id: "one", name: "one.png", size: 4 },
			{ id: "two", name: "two.png", size: 4 },
		],
		0,
	);
	assert.equal(store.publicState().revision, 1);
	assert.equal(store.residentBytes(), 0);
	assert.equal(store.reservedSourceBytes(), 8);
	assert.throws(() => store.reserve([{ id: "three", name: "three.png", size: 1 }], 0), /revision/i);
	assert.throws(
		() => store.reserve([{ id: "one", name: "duplicate.png", size: 1 }], 1),
		/id|duplicate/i,
	);
	assert.throws(
		() => store.reserve([{ id: "three", name: "three.png", size: 9 }], 1),
		/per-image|maximum/i,
	);
	assert.throws(
		() =>
			store.reserve(
				[
					{ id: "three", name: "three.png", size: 1 },
					{ id: "four", name: "four.png", size: 1 },
				],
				1,
			),
		/count|maximum/i,
	);
	assert.equal(store.publicState().items.length, 2);
});

test("uploads expose processing then sanitized ready state while preserving order", async () => {
	let release: (() => void) | undefined;
	const store = createStore(async (source) => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return prepared(source, "output");
	});
	store.reserve(
		[
			{ id: "one", name: "one.png", size: 3 },
			{ id: "two", name: "two.png", size: 3 },
		],
		0,
	);
	const processing = store.upload("one", Buffer.from("one"), 1);
	assert.equal(processing.items[0]?.status, "processing");
	assert.equal(store.residentBytes(), 3);
	release?.();
	await settle(store);
	const state = store.publicState();
	assert.equal(state.items[0]?.status, "ready");
	assert.equal(state.items[0]?.sourceFormat, "bmp");
	assert.equal(state.items[0]?.outputFormat, "png");
	assert.equal(state.items[0]?.resized, true);
	assert.deepEqual(state.items[0]?.notes, ["Converted from BMP to PNG", "Resized from 4×2"]);
	assert.deepEqual(
		state.items.map((item) => item.id),
		["one", "two"],
	);
	assert.equal(store.residentBytes(), Buffer.byteLength("safe-output"));
});

test("each reserved upload accepts its batch revision after an earlier sibling completes", async () => {
	const store = createStore();
	const reserved = store.reserve(
		[
			{ id: "one", name: "one.png", size: 3 },
			{ id: "two", name: "two.png", size: 3 },
		],
		0,
	);
	store.upload("one", Buffer.from("one"), reserved.revision);
	await settle(store);
	assert.doesNotThrow(() => store.upload("two", Buffer.from("two"), reserved.revision));
	await settle(store);
	assert.equal(store.publicState().phase, "ready");
});

test("processing is concurrency bounded and queued aborts remain retryable", async () => {
	let active = 0;
	let peak = 0;
	const releases: Array<() => void> = [];
	const store = createStore(async (source) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => releases.push(resolve));
		active -= 1;
		return prepared(source);
	}, 1);
	store.reserve(
		[
			{ id: "one", name: "one.png", size: 3 },
			{ id: "two", name: "two.png", size: 3 },
		],
		0,
	);
	store.upload("one", Buffer.from("one"), 1);
	const controller = new AbortController();
	store.upload("two", Buffer.from("two"), store.publicState().revision, controller.signal);
	controller.abort();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(peak, 1);
	releases.shift()?.();
	await settle(store);
	assert.equal(store.publicState().items[0]?.status, "ready");
	assert.equal(store.publicState().items[1]?.status, "error");
	assert.match(store.publicState().items[1]?.error ?? "", /cancel/i);
	assert.equal(store.residentBytes(), Buffer.byteLength("safe-one") + 3);
});

test("processing errors retain only bounded source bytes for retry", async () => {
	let attempts = 0;
	const store = createStore(async (source) => {
		attempts += 1;
		if (attempts === 1) throw new Error("private\ndecoder detail\u0000");
		return prepared(source);
	});
	store.reserve([{ id: "one", name: "one.png", size: 3 }], 0);
	store.upload("one", Buffer.from("one"), 1);
	await settle(store);
	let state = store.publicState();
	assert.equal(state.items[0]?.status, "error");
	assert.equal(state.items[0]?.error, "private decoder detail");
	assert.equal(store.residentBytes(), 3);
	store.retry("one", state.revision);
	await settle(store);
	state = store.publicState();
	assert.equal(state.items[0]?.status, "ready");
	assert.equal(attempts, 2);
	assert.equal(store.residentBytes(), Buffer.byteLength("safe-one"));
});

test("reorder, delete, and clear require exact revisions and release every byte", async () => {
	const store = createStore();
	store.reserve(
		[
			{ id: "one", name: "one.png", size: 3 },
			{ id: "two", name: "two.png", size: 3 },
		],
		0,
	);
	store.upload("one", Buffer.from("one"), 1);
	await settle(store);
	store.upload("two", Buffer.from("two"), store.publicState().revision);
	await settle(store);
	let revision = store.publicState().revision;
	store.reorder(["two", "one"], revision);
	assert.deepEqual(
		store.publicState().items.map((item) => item.id),
		["two", "one"],
	);
	assert.throws(() => store.remove("one", revision), /revision/i);
	revision = store.publicState().revision;
	store.remove("one", revision);
	assert.equal(store.publicState().items.length, 1);
	store.clear(store.publicState().revision);
	assert.equal(store.publicState().phase, "empty");
	assert.equal(store.residentBytes(), 0);
});

test("reattaching prepared images is atomic, ordered, bounded, and rejects draft duplicates", async () => {
	const store = createStore();
	const state = store.attachPrepared(
		[
			{ id: "two", name: "two.png", prepared: prepared(Buffer.from("two")) },
			{ id: "one", name: "one.png", prepared: prepared(Buffer.from("one")) },
		],
		0,
	);
	assert.deepEqual(
		state.items.map((item) => item.id),
		["two", "one"],
	);
	assert.equal(state.phase, "ready");
	assert.throws(
		() =>
			store.attachPrepared(
				[{ id: "duplicate", name: "duplicate.png", prepared: prepared(Buffer.from("two")) }],
				state.revision,
			),
		/duplicate/i,
	);
	assert.throws(
		() =>
			store.attachPrepared(
				[
					{ id: "three", name: "three.png", prepared: prepared(Buffer.from("three")) },
					{ id: "four", name: "four.png", prepared: prepared(Buffer.from("four")) },
				],
				state.revision,
			),
		/maximum/i,
	);
	assert.deepEqual(
		store.publicState().items.map((item) => item.id),
		["two", "one"],
	);
});

test("send reservation transfers sanitized bytes and commits only a matching ready snapshot", async () => {
	const store = createStore();
	store.reserve([{ id: "one", name: "one.png", size: 3 }], 0);
	store.upload("one", Buffer.from("one"), 1);
	await settle(store);
	const before = store.publicState();
	const reservation = store.beginSend(["one"], before.revision);
	assert.equal(store.publicState().phase, "reserved");
	assert.deepEqual(
		reservation.images.map((image) => Buffer.from(image.data, "base64").toString()),
		["safe-one"],
	);
	assert.throws(() => store.clear(before.revision), /reserved/i);
	store.finishSend(reservation.token, false);
	assert.equal(store.publicState().phase, "ready");
	const retry = store.beginSend(["one"], store.publicState().revision);
	store.finishSend(retry.token, true);
	assert.equal(store.publicState().phase, "empty");
	assert.equal(store.residentBytes(), 0);
});

test("delete during processing aborts work and discards late native output", async () => {
	let sawAbort = false;
	let release: (() => void) | undefined;
	const store = createStore(async (source, signal) => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		sawAbort = Boolean(signal?.aborted);
		return prepared(source);
	});
	store.reserve([{ id: "one", name: "one.png", size: 3 }], 0);
	store.upload("one", Buffer.from("one"), 1);
	store.remove("one", store.publicState().revision);
	release?.();
	await settle(store);
	assert.equal(sawAbort, true);
	assert.equal(store.publicState().phase, "empty");
	assert.equal(store.residentBytes(), 0);
});

test("close aborts retained state, waits idempotently, and rejects later mutations", async () => {
	let release: (() => void) | undefined;
	const store = createStore(async (source) => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return prepared(source);
	});
	store.reserve([{ id: "one", name: "one.png", size: 3 }], 0);
	store.upload("one", Buffer.from("one"), 1);
	store.close();
	store.close();
	release?.();
	await settle(store);
	assert.equal(store.residentBytes(), 0);
	assert.equal(store.publicState().phase, "closed");
	assert.throws(() => store.reserve([], store.publicState().revision), AttachmentError);
});
