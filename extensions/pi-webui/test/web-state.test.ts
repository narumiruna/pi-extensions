import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const state = (await import(
	pathToFileURL(path.join(process.cwd(), "extensions/pi-webui/src/web/state.js")).href
)) as {
	initialState(): WebState;
	applySnapshot(current: WebState, snapshot: Snapshot): WebState;
	applyConversationEvent(current: WebState, event: ConversationEvent): WebState;
	applyLease(current: WebState, lease: { activeClientId: string }, clientId: string): WebState;
	canSend(current: WebState): boolean;
	busyLabel(current: WebState): string;
	deliveryNotice(current: WebState): string;
	upsertById<T extends { id: string }>(items: T[], value: T): T[];
};

interface WebState {
	sequence: number;
	session?: { projectName: string };
	messages: Array<{ id: string; final?: boolean; content?: unknown[] }>;
	tools: Array<{ id: string; phase: string }>;
	activity: "idle" | "running" | "ended";
	closed: boolean;
	connected: boolean;
	stale: boolean;
	needsSnapshot: boolean;
	pending: boolean;
	text: string;
	images: unknown[];
	lastDelivery?: "immediate" | "followUp" | "steer";
}

interface Snapshot {
	sequence: number;
	session: { projectName: string };
	messages: Array<{ id: string }>;
	tools: Array<{ id: string; phase: string }>;
	activity: "idle" | "running" | "ended";
	closed: boolean;
}

interface ConversationEvent {
	sequence: number;
	type: string;
	payload: unknown;
}

const snapshot: Snapshot = {
	sequence: 3,
	session: { projectName: "demo" },
	messages: [{ id: "one" }],
	tools: [{ id: "call", phase: "start" }],
	activity: "running",
	closed: false,
};

test("snapshots replace authoritative server state without discarding the browser draft", () => {
	const current = { ...state.initialState(), text: "draft", images: [{ id: "image" }] };
	const next = state.applySnapshot(current, snapshot);
	assert.equal(next.sequence, 3);
	assert.equal(next.session?.projectName, "demo");
	assert.deepEqual(next.messages, [{ id: "one" }]);
	assert.equal(next.text, "draft");
	assert.deepEqual(next.images, [{ id: "image" }]);
	assert.equal(next.needsSnapshot, false);
});

test("ordered conversation events replace messages/tools and sequence gaps request snapshots", () => {
	let current = state.applySnapshot(state.initialState(), snapshot);
	current = state.applyConversationEvent(current, {
		sequence: 4,
		type: "message",
		payload: { id: "one", final: true, content: [{ type: "text", text: "updated" }] },
	});
	assert.equal(current.messages.length, 1);
	assert.equal(current.messages[0]?.final, true);
	current = state.applyConversationEvent(current, {
		sequence: 5,
		type: "tool",
		payload: { id: "call", phase: "end" },
	});
	assert.equal(current.tools[0]?.phase, "end");
	assert.equal(
		state.applyConversationEvent(current, { sequence: 5, type: "activity", payload: {} }),
		current,
	);
	const gap = state.applyConversationEvent(current, {
		sequence: 8,
		type: "activity",
		payload: { activity: "idle" },
	});
	assert.equal(gap.needsSnapshot, true);
	assert.equal(gap.sequence, 5);
});

test("sequenced snapshot events replace state after tree navigation", () => {
	const current = state.applySnapshot(state.initialState(), snapshot);
	const nextSnapshot = { ...snapshot, sequence: 4, messages: [{ id: "branch" }], tools: [] };
	const next = state.applyConversationEvent(current, {
		sequence: 4,
		type: "snapshot",
		payload: nextSnapshot,
	});
	assert.deepEqual(next.messages, [{ id: "branch" }]);
	assert.equal(next.sequence, 4);
});

test("session-ended and lease events disable mutation without relying on color", () => {
	let current = { ...state.initialState(), connected: true, text: "hello" };
	current = state.applyLease(current, { activeClientId: "other" }, "this-tab");
	assert.equal(current.stale, true);
	assert.equal(state.canSend(current), false);
	current = state.applyConversationEvent(
		{ ...current, sequence: 0 },
		{ sequence: 1, type: "session-ended", payload: {} },
	);
	assert.equal(current.closed, true);
	assert.equal(current.activity, "ended");
});

test("send availability and labels distinguish immediate, follow-up, and disconnected states", () => {
	const base = { ...state.initialState(), connected: true, text: "hello" };
	assert.equal(state.canSend(base), true);
	assert.equal(state.busyLabel(base), "Send now");
	assert.equal(state.busyLabel({ ...base, activity: "running" }), "Send next");
	assert.equal(state.busyLabel({ ...base, connected: false }), "Reconnect to send");
	assert.equal(state.canSend({ ...base, pending: true }), false);
	assert.equal(state.canSend({ ...base, text: "", images: [{}] }), true);
});

test("accepted delivery modes provide explicit queue feedback", () => {
	const base = state.initialState();
	assert.equal(
		state.deliveryNotice({ ...base, lastDelivery: "immediate" }),
		"Message accepted by Pi.",
	);
	assert.equal(
		state.deliveryNotice({ ...base, lastDelivery: "followUp" }),
		"Queued to run after Pi finishes.",
	);
	assert.equal(
		state.deliveryNotice({ ...base, lastDelivery: "steer" }),
		"Steering message accepted by Pi.",
	);
});

test("upsert is immutable and keeps transcript order", () => {
	const input = [
		{ id: "one", phase: "start" },
		{ id: "two", phase: "start" },
	];
	assert.deepEqual(state.upsertById(input, { id: "one", phase: "end" }), [
		{ id: "one", phase: "end" },
		{ id: "two", phase: "start" },
	]);
	assert.equal(input[0]?.phase, "start");
});
