import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const state = (await import(
	pathToFileURL(path.join(process.cwd(), "extensions/pi-webui/src/web/state.js")).href
)) as {
	initialState(): WebState;
	applySnapshot(current: WebState, snapshot: Snapshot): WebState;
	applyDraft(current: WebState, draft: Record<string, unknown>): WebState;
	editDraftText(current: WebState, text: string): WebState;
	acknowledgeDraftText(
		current: WebState,
		draft: Record<string, unknown>,
		submittedText: string,
	): WebState;
	applyAttachments(current: WebState, attachments: Record<string, unknown>): WebState;
	applyImageLimits(current: WebState, limits: Record<string, unknown>): WebState;
	applySentImages(current: WebState, sentImages: Record<string, unknown>): WebState;
	applyConversationEvent(current: WebState, event: ConversationEvent): WebState;
	applyLease(
		current: WebState,
		lease: { activeClientId: string; generation: number },
		clientId: string,
		claimed?: boolean,
	): WebState;
	prepareSend(
		current: WebState,
		requestId: string,
		delivery?: "next" | "steer",
	): { state: WebState; attempt: SendAttempt };
	completeSend(
		current: WebState,
		attempt: SendAttempt,
		delivery: "immediate" | "followUp" | "steer",
	): WebState;
	failSend(current: WebState, attempt: SendAttempt, error: string): WebState;
	invalidateSendAttempt(current: WebState): WebState;
	setNearBottom(current: WebState, nearBottom: boolean): WebState;
	noteUnseenUpdate(current: WebState, key: string): WebState;
	followLatest(current: WebState): WebState;
	moveImage(images: WebImage[], id: string, direction: number): WebImage[];
	moveImageBefore(images: WebImage[], id: string, targetId: string): WebImage[];
	clearDraftImages(current: WebState): WebState;
	canSend(current: WebState): boolean;
	busyLabel(current: WebState): string;
	deliveryNotice(current: WebState): string;
	upsertById<T extends { id: string }>(items: T[], value: T): T[];
};

interface WebImage {
	id: string;
	name?: string;
	status?: string;
	notes?: string[];
}

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
	readingImages: number;
	leaseClaimed: boolean;
	leaseGeneration: number;
	draftRevision: number;
	authoritativeText: string;
	textDirty: boolean;
	attachmentRevision: number;
	attachmentPhase: string;
	imageLimits?: {
		maxImages: number;
		maxImageBytes: number;
		maxBatchBytes: number;
		maxImagePixels: number;
	};
	sentImages: {
		revision: number;
		enabled: boolean;
		items: Array<{ id: string; name?: string }>;
		totalBytes: number;
		maxImages: number;
		maxBytes: number;
	};
	following: boolean;
	unseenUpdateIds: string[];
	text: string;
	images: WebImage[];
	outbox?: SendAttempt;
	lastDelivery?: "immediate" | "followUp" | "steer";
}

interface SendAttempt {
	requestId: string;
	text: string;
	draftRevision: number;
	attachmentRevision: number;
	attachmentIds: string[];
	images: Array<{ id: string }>;
	delivery: "next" | "steer";
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

test("authoritative drafts hydrate refreshes without overwriting newer local input", () => {
	let current = state.applyDraft(state.initialState(), { revision: 1, text: "restored" });
	assert.equal(current.text, "restored");
	assert.equal(current.authoritativeText, "restored");
	current = state.editDraftText(current, "new local text");
	assert.equal(current.textDirty, true);
	const refreshed = state.applyDraft(current, { revision: 2, text: "remote text" });
	assert.equal(refreshed.text, "new local text");
	assert.equal(refreshed.authoritativeText, "remote text");
	assert.equal(refreshed.draftRevision, 2);
	assert.equal(state.applyDraft(refreshed, { revision: 1, text: "stale" }), refreshed);
});

test("delayed text acknowledgements never overwrite input typed after the request", () => {
	let current = state.applyDraft(state.initialState(), { revision: 1, text: "one" });
	current = state.editDraftText(current, "submitted");
	const submitted = current.text;
	current = state.editDraftText(current, "typed later");
	const acknowledged = state.acknowledgeDraftText(
		current,
		{ revision: 2, text: "submitted" },
		submitted,
	);
	assert.equal(acknowledged.text, "typed later");
	assert.equal(acknowledged.authoritativeText, "submitted");
	assert.equal(acknowledged.textDirty, true);
	const final = state.acknowledgeDraftText(
		acknowledged,
		{ revision: 3, text: "typed later" },
		"typed later",
	);
	assert.equal(final.text, "typed later");
	assert.equal(final.textDirty, false);
});

test("older snapshots cannot roll browser state back", () => {
	const current = state.applySnapshot(state.initialState(), snapshot);
	const older = state.applySnapshot(current, {
		...snapshot,
		sequence: 2,
		messages: [{ id: "stale" }],
	});
	assert.equal(older, current);
	assert.equal(older.sequence, 3);
	assert.deepEqual(older.messages, [{ id: "one" }]);
});

test("server attachment revisions replace browser images and ignore stale updates", () => {
	const initial = state.initialState();
	const ready = state.applyAttachments(initial, {
		revision: 2,
		phase: "ready",
		items: [{ id: "one", status: "ready" }],
	});
	assert.equal(ready.attachmentRevision, 2);
	assert.equal(ready.attachmentPhase, "ready");
	assert.deepEqual(ready.images, [{ id: "one", status: "ready", notes: [] }]);
	assert.equal(ready.readingImages, 0);
	const stale = state.applyAttachments(ready, { revision: 1, phase: "empty", items: [] });
	assert.equal(stale, ready);
	const processing = state.applyAttachments(ready, {
		revision: 3,
		phase: "processing",
		items: [{ id: "one", status: "processing" }],
	});
	assert.equal(processing.readingImages, 1);
	assert.equal(state.canSend({ ...processing, connected: true, text: "send" }), false);
});

test("effective image limits hydrate atomically from server state", () => {
	const initial = state.initialState();
	const limits = {
		maxImages: 12,
		maxImageBytes: 20,
		maxBatchBytes: 40,
		maxImagePixels: 60,
	};
	const applied = state.applyImageLimits(initial, limits);
	assert.deepEqual(applied.imageLimits, limits);
	limits.maxImages = 99;
	assert.equal(applied.imageLimits?.maxImages, 12);
	assert.equal(state.applyImageLimits(applied, { ...limits, maxImageBytes: 0 }), applied);
});

test("sent-image snapshots are immutable and ignore stale eviction state", () => {
	const source = {
		revision: 2,
		enabled: true,
		items: [{ id: "sent-one", name: "one.png" }],
		totalBytes: 4,
		maxImages: 32,
		maxBytes: 128,
	};
	const retained = state.applySentImages(state.initialState(), source);
	const first = source.items[0];
	assert.ok(first);
	first.name = "mutated";
	assert.deepEqual(retained.sentImages.items, [{ id: "sent-one", name: "one.png" }]);
	assert.equal(retained.sentImages.enabled, true);
	assert.equal(state.applySentImages(retained, { ...source, revision: 1, items: [] }), retained);
});

test("attachment snapshots clone item notes and gate every non-ready batch phase", () => {
	const source = {
		revision: 1,
		phase: "processing",
		items: [
			{
				id: "one",
				name: "one.bmp",
				status: "processing",
				notes: ["Converted BMP to PNG"],
			},
		],
	};
	const processing = state.applyAttachments(state.initialState(), source);
	source.items[0]?.notes.push("mutated");
	assert.deepEqual(processing.images[0]?.notes, ["Converted BMP to PNG"]);
	assert.equal(processing.readingImages, 1);
	assert.equal(state.canSend({ ...processing, connected: true, text: "send" }), false);
	for (const phase of ["uploading", "processing", "blocked", "reserved"]) {
		assert.equal(
			state.canSend({
				...processing,
				connected: true,
				readingImages: 0,
				attachmentPhase: phase,
			}),
			false,
		);
	}
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
	current = state.applyLease(current, { activeClientId: "other", generation: 1 }, "this-tab");
	assert.equal(current.stale, true);
	assert.equal(current.leaseClaimed, false);
	assert.equal(state.canSend(current), false);
	current = state.applyLease(
		current,
		{ activeClientId: "this-tab", generation: 2 },
		"this-tab",
		true,
	);
	assert.equal(current.stale, false);
	assert.equal(current.leaseClaimed, true);
	current = state.applyLease(current, { activeClientId: "other", generation: 3 }, "this-tab");
	assert.equal(current.stale, true);
	assert.equal(current.leaseClaimed, true);
	const staleSnapshot = state.applyLease(
		current,
		{ activeClientId: "this-tab", generation: 2 },
		"this-tab",
	);
	assert.equal(staleSnapshot, current);
	assert.equal(staleSnapshot.stale, true);
	assert.equal(staleSnapshot.leaseGeneration, 3);
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
	assert.equal(state.busyLabel(base), "Send");
	assert.equal(state.busyLabel({ ...base, activity: "running" }), "Queue next");
	assert.equal(state.busyLabel({ ...base, connected: false }), "Reconnect to send");
	assert.equal(state.canSend({ ...base, pending: true }), false);
	assert.equal(state.canSend({ ...base, readingImages: 1 }), false);
	assert.equal(
		state.canSend({
			...base,
			text: "",
			images: [{ id: "image", status: "ready" }],
			attachmentPhase: "ready",
		}),
		true,
	);
});

test("failed sends retain one idempotent attempt until the draft changes", () => {
	const image = { id: "one" };
	const current = { ...state.initialState(), connected: true, text: "hello", images: [image] };
	const first = state.prepareSend(current, "request-1", "steer");
	assert.equal(first.state.pending, true);
	assert.equal(first.attempt.requestId, "request-1");
	assert.equal(first.attempt.delivery, "steer");

	const failed = state.failSend(first.state, first.attempt, "Connection lost");
	assert.equal(failed.pending, false);
	assert.equal(failed.outbox, first.attempt);
	const retry = state.prepareSend(failed, "request-2", "next");
	assert.equal(retry.attempt.requestId, "request-1");
	assert.equal(retry.attempt.delivery, "steer");

	const definitelyRejected = state.failSend(
		state.invalidateSendAttempt(first.state),
		first.attempt,
		"Invalid request",
	);
	assert.equal(state.prepareSend(definitelyRejected, "request-2").attempt.requestId, "request-2");

	const changed = state.invalidateSendAttempt({ ...failed, text: "different" });
	const replacement = state.prepareSend(changed, "request-2");
	assert.equal(replacement.attempt.requestId, "request-2");
});

test("send completion removes only the submitted draft", () => {
	const submitted = { id: "submitted" };
	const newer = { id: "newer" };
	const prepared = state.prepareSend(
		{ ...state.initialState(), connected: true, text: "old", images: [submitted] },
		"request-1",
	);
	const edited = state.invalidateSendAttempt({
		...prepared.state,
		text: "new",
		images: [submitted, newer],
	});
	const completed = state.completeSend(edited, prepared.attempt, "immediate");
	assert.equal(completed.text, "new");
	assert.deepEqual(completed.images, [newer]);
	assert.equal(completed.pending, false);
	assert.equal(completed.lastDelivery, "immediate");
});

test("clearing attachments preserves text and invalidates the pending retry attempt", () => {
	const images: WebImage[] = [{ id: "one" }, { id: "two" }];
	const prepared = state.prepareSend(
		{ ...state.initialState(), connected: true, text: "keep me", images },
		"request-1",
	);
	const failed = state.failSend(prepared.state, prepared.attempt, "failed");
	const cleared = state.clearDraftImages(failed);
	assert.equal(cleared.text, "keep me");
	assert.deepEqual(cleared.images, []);
	assert.equal(cleared.outbox, undefined);
	assert.equal(cleared.lastDelivery, undefined);
	assert.equal(cleared.pending, false);
	assert.equal(failed.images.length, 2);
});

test("image ordering helpers are immutable and bounded", () => {
	const images: WebImage[] = [{ id: "one" }, { id: "two" }, { id: "three" }];
	assert.deepEqual(
		state.moveImage(images, "two", -1).map((image) => image.id),
		["two", "one", "three"],
	);
	assert.deepEqual(
		state.moveImage(images, "two", 1).map((image) => image.id),
		["one", "three", "two"],
	);
	assert.deepEqual(state.moveImage(images, "one", -1), images);
	assert.deepEqual(state.moveImage(images, "three", 1), images);
	assert.deepEqual(state.moveImage(images, "missing", 1), images);
	assert.deepEqual(
		state.moveImageBefore(images, "three", "one").map((image) => image.id),
		["three", "one", "two"],
	);
	assert.deepEqual(state.moveImageBefore(images, "one", "one"), images);
	assert.deepEqual(state.moveImageBefore(images, "missing", "one"), images);
	assert.deepEqual(
		images.map((image) => image.id),
		["one", "two", "three"],
	);
	assert.notEqual(state.moveImage(images, "one", -1), images);
});

test("send attempts freeze the displayed image order until the draft changes", () => {
	const images: WebImage[] = [{ id: "two" }, { id: "one" }];
	const prepared = state.prepareSend(
		{ ...state.initialState(), connected: true, images },
		"request-1",
	);
	assert.deepEqual(
		prepared.attempt.images.map((image) => image.id),
		["two", "one"],
	);
	assert.equal(prepared.attempt.attachmentRevision, 0);
	assert.deepEqual(prepared.attempt.attachmentIds, ["two", "one"]);
	images.reverse();
	assert.deepEqual(
		prepared.attempt.images.map((image) => image.id),
		["two", "one"],
	);
	const retry = state.prepareSend(
		state.failSend(prepared.state, prepared.attempt, "failed"),
		"new",
	);
	assert.deepEqual(
		retry.attempt.images.map((image) => image.id),
		["two", "one"],
	);
});

test("live transcript follows only near the bottom and deduplicates unseen updates", () => {
	let current = state.initialState();
	current = state.setNearBottom(current, false);
	assert.equal(current.following, false);
	current = state.noteUnseenUpdate(current, "message:one");
	current = state.noteUnseenUpdate(current, "message:one");
	current = state.noteUnseenUpdate(current, "tool:call");
	assert.deepEqual(current.unseenUpdateIds, ["message:one", "tool:call"]);
	current = state.followLatest(current);
	assert.equal(current.following, true);
	assert.deepEqual(current.unseenUpdateIds, []);
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
