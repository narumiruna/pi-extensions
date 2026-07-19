import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const transcript = (await import(
	pathToFileURL(path.join(process.cwd(), "extensions/pi-webui/src/web/transcript.js")).href
)) as {
	toolPhaseLabel(tool?: { phase?: string; isError?: boolean }): string;
	toolCommandPreview(tool?: { args?: unknown }): string;
	isCollapsibleMessageRole(role: string): boolean;
	retainedImageStatus(
		block: { retainedImageId?: string },
		ids: Set<string>,
	): "none" | "eligible" | "expired";
};

test("standalone tool-result messages use collapsed disclosure", () => {
	assert.equal(transcript.isCollapsibleMessageRole("toolResult"), true);
	assert.equal(transcript.isCollapsibleMessageRole("assistant"), false);
	assert.equal(transcript.isCollapsibleMessageRole("user"), false);
});

test("tool phase labels describe user-visible state", () => {
	assert.equal(transcript.toolPhaseLabel(undefined), "Requested");
	assert.equal(transcript.toolPhaseLabel({ phase: "start" }), "Running");
	assert.equal(transcript.toolPhaseLabel({ phase: "update" }), "Running");
	assert.equal(transcript.toolPhaseLabel({ phase: "end" }), "Completed");
	assert.equal(transcript.toolPhaseLabel({ phase: "end", isError: true }), "Failed");
});

test("retained image chips distinguish eligible, expired, and terminal-origin images", () => {
	const active = new Set(["sent-one"]);
	assert.equal(transcript.retainedImageStatus({}, active), "none");
	assert.equal(transcript.retainedImageStatus({ retainedImageId: "sent-one" }, active), "eligible");
	assert.equal(transcript.retainedImageStatus({ retainedImageId: "sent-old" }, active), "expired");
});

test("tool command preview accepts only a compact string command", () => {
	assert.equal(
		transcript.toolCommandPreview({ args: { command: "npm run check" } }),
		"npm run check",
	);
	assert.equal(transcript.toolCommandPreview({ args: { command: "a".repeat(300) } }).length, 121);
	assert.equal(transcript.toolCommandPreview({ args: { command: ["rm", "-rf"] } }), "");
	assert.equal(transcript.toolCommandPreview({ args: { path: "/tmp" } }), "");
});
