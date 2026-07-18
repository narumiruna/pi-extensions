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
	moveItem(ids: string[], id: string, direction: number): string[];
	moveItemBefore(ids: string[], id: string, target: string): string[];
	canMutate(batch: { phase: string }): boolean;
	preferNewestState<T extends { batch: { revision: number } }>(current: T | undefined, next: T): T;
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

test("web ordering helpers are immutable and bounded", () => {
	const ids = ["one", "two", "three"];
	assert.deepEqual(helpers.moveItem(ids, "two", -1), ["two", "one", "three"]);
	assert.deepEqual(helpers.moveItem(ids, "one", -1), ids);
	assert.deepEqual(helpers.moveItemBefore(ids, "three", "one"), ["three", "one", "two"]);
	assert.deepEqual(ids, ["one", "two", "three"]);
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
