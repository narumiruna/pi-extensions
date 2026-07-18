import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type StateHelpers = {
	summarizeBatch(batch: unknown): {
		label: string;
		ready: number;
		uploading: number;
		error: number;
	};
	summarizeHistory(history: unknown): {
		label: string;
		usage: string;
		total: number;
		bytes: number;
		maxImages: number;
		maxBytes: number;
	};
	draftGuidance(batch: unknown): string;
	moveItem(ids: string[], id: string, direction: number): string[];
	moveItemBefore(ids: string[], id: string, target: string): string[];
	canMutate(batch: { phase: string }): boolean;
	preferNewestState<T extends { batch: { revision: number } }>(current: T | undefined, next: T): T;
	attemptMutation<T>(
		operation: () => Promise<T>,
	): Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
	formatBytes(value: number): string;
};

const helpers = (await import(
	pathToFileURL(path.join(process.cwd(), "extensions/pi-image-drop/src/web/state.js")).href
)) as StateHelpers;

test("web state helpers summarize every visible batch state without color-only meaning", () => {
	assert.equal(
		helpers.summarizeBatch({ phase: "empty", items: [], totalSourceBytes: 0 }).label,
		"No images staged",
	);
	assert.deepEqual(
		helpers.summarizeBatch({
			phase: "blocked",
			items: [{ status: "ready" }, { status: "processing" }, { status: "error" }],
			totalSourceBytes: 123,
		}),
		{
			ready: 1,
			uploading: 1,
			error: 1,
			total: 3,
			bytes: 123,
			label: "1/3 ready · 1 uploading · 1 need attention",
		},
	);
	assert.equal(
		helpers.summarizeBatch({ phase: "reserved", items: [{ status: "ready" }], totalSourceBytes: 1 })
			.label,
		"1 image queued with Pi",
	);
});

test("web history helpers separate concise status from secondary retention limits", () => {
	assert.deepEqual(
		helpers.summarizeHistory({
			items: [],
			totalBytes: 0,
			maxImages: 128,
			maxBytes: 512 * 1024 * 1024,
		}),
		{
			total: 0,
			bytes: 0,
			maxImages: 128,
			maxBytes: 512 * 1024 * 1024,
			label: "No images sent yet",
			usage: "0/128 images · 0 B of 512 MB",
		},
	);
	assert.deepEqual(
		helpers.summarizeHistory({
			items: [{}, {}],
			totalBytes: 5 * 1024 * 1024,
			maxImages: 128,
			maxBytes: 512 * 1024 * 1024,
		}),
		{
			total: 2,
			bytes: 5 * 1024 * 1024,
			maxImages: 128,
			maxBytes: 512 * 1024 * 1024,
			label: "2 images · 5.0 MB",
			usage: "2/128 images · 5.0 MB of 512 MB",
		},
	);
});

test("draft guidance names the next valid action for every lifecycle state", () => {
	assert.equal(
		helpers.draftGuidance({ phase: "empty", items: [] }),
		"Choose images to add them to your next Pi message.",
	);
	assert.equal(
		helpers.draftGuidance({
			phase: "editing",
			items: [{ status: "processing" }, { status: "processing" }],
		}),
		"Wait for 2 images to finish processing before sending from Pi.",
	);
	assert.equal(
		helpers.draftGuidance({
			phase: "blocked",
			items: [{ status: "ready" }, { status: "error" }],
		}),
		"Fix or delete 1 image that needs attention before sending from Pi.",
	);
	assert.equal(
		helpers.draftGuidance({ phase: "ready", items: [{ status: "ready" }] }),
		"Return to Pi and send a non-empty message. 1 ready image will be attached automatically.",
	);
	assert.equal(
		helpers.draftGuidance({
			phase: "reserved",
			items: [{ status: "ready" }, { status: "ready" }],
		}),
		"Queued with Pi. These images will be attached when Pi sends this message.",
	);
	assert.equal(
		helpers.draftGuidance({ phase: "closed", items: [{ status: "ready" }] }),
		"This Pi session is no longer accepting images.",
	);
});

test("web ordering helpers are immutable and bounded", () => {
	const ids = ["one", "two", "three"];
	assert.deepEqual(helpers.moveItem(ids, "two", -1), ["two", "one", "three"]);
	assert.deepEqual(helpers.moveItem(ids, "one", -1), ids);
	assert.deepEqual(helpers.moveItemBefore(ids, "three", "one"), ["three", "one", "two"]);
	assert.deepEqual(ids, ["one", "two", "three"]);
});

test("web mutation attempts expose failures so local retry files can be retained", async () => {
	const failure = new Error("stale revision");
	assert.deepEqual(await helpers.attemptMutation(async () => Promise.reject(failure)), {
		ok: false,
		error: failure,
	});
	assert.deepEqual(await helpers.attemptMutation(async () => "updated"), {
		ok: true,
		value: "updated",
	});
});

test("web helpers gate frozen state, reject stale events, and format bounded sizes", () => {
	assert.equal(helpers.canMutate({ phase: "ready" }), true);
	assert.equal(helpers.canMutate({ phase: "reserved" }), false);
	assert.equal(helpers.canMutate({ phase: "closed" }), false);
	const current = { batch: { revision: 4 }, marker: "current" };
	assert.equal(
		helpers.preferNewestState(current, { batch: { revision: 3 }, marker: "stale" }),
		current,
	);
	assert.equal(
		helpers.preferNewestState(current, { batch: { revision: 5 }, marker: "new" }).marker,
		"new",
	);
	assert.equal(helpers.formatBytes(512), "512 B");
	assert.equal(helpers.formatBytes(1536), "1.5 KB");
	assert.equal(helpers.formatBytes(2 * 1024 * 1024), "2.0 MB");
});
