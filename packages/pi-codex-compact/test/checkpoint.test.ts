import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	buildReplacementHistory,
	checkpointMarker,
	createCheckpointDetails,
	fallbackSummary,
	fingerprintMessage,
	latestCheckpoint,
	parseCheckpointDetails,
	projectCheckpointContext,
} from "../src/checkpoint.js";

function user(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function rawUser(text: string) {
	return { role: "user", content: [{ type: "input_text", text }] };
}

const opaque = { type: "compaction", encrypted_content: "opaque" };

function checkpoint(
	kept: AgentMessage[] = [user("kept", 2)],
	id = "checkpoint-123",
	provider = "openai-codex",
) {
	return createCheckpointDetails({
		provider,
		api: "openai-codex-responses",
		modelId: "gpt-5.6",
		protocol: "remote-v2",
		replacementHistory: [rawUser("old"), opaque],
		keptMessages: kept,
		checkpointId: id,
		createdAt: "2026-01-01T00:00:00.000Z",
	});
}

function compactionSummary(summary: string, timestamp: number): AgentMessage {
	return { role: "compactionSummary", summary, tokensBefore: 100, timestamp };
}

function legacyFallbackSummary(checkpointId: string): string {
	return [
		`OpenAI Codex Remote Compaction V2 checkpoint ${checkpointId} stores the older history opaquely.`,
		"Full replay requires @narumitw/pi-codex-compact and an openai-codex model.",
		"Without them, only Pi's retained recent messages remain available.",
	].join(" ");
}

function project(
	messages: readonly AgentMessage[],
	details: ReturnType<typeof checkpoint>,
	checkpointSummary = fallbackSummary(details.checkpointId),
) {
	return projectCheckpointContext(messages, details, checkpointSummary);
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

function compactionEntry(
	id: string,
	parentId: string,
	firstKeptEntryId: string,
	details: ReturnType<typeof checkpoint>,
	timestamp: string,
): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp,
		summary: fallbackSummary(details.checkpointId),
		firstKeptEntryId,
		tokensBefore: 100,
		details,
	};
}

test("builds newest-first bounded replacement history and puts opaque item last", () => {
	const history = buildReplacementHistory(
		[rawUser("oldest"), { type: "compaction", encrypted_content: "old" }, rawUser("newest")],
		opaque,
		{ tokenBudget: 2, byteBudget: 2048 },
	);
	assert.equal(history.at(-1)?.type, "compaction");
	assert.equal(history.at(-1)?.encrypted_content, "opaque");
	assert.match(JSON.stringify(history), /newest/);
	assert.doesNotMatch(JSON.stringify(history), /encrypted_content":"old/);
});

test("partially truncates the oldest fitting text item", () => {
	const history = buildReplacementHistory(
		[rawUser("abcdefghijklmnopqrstuvwxyz".repeat(4))],
		opaque,
		{
			tokenBudget: 10,
			byteBudget: 2048,
		},
	);
	assert.equal(history.length, 2);
	assert.match(JSON.stringify(history[0]), /\[truncated\]/);
	assert.match(JSON.stringify(history[0]), /wxyz/);
});

test("drops media that cannot fit the checkpoint byte budget", () => {
	const media = {
		role: "user",
		content: [{ type: "input_image", image_url: `data:image/png;base64,${"x".repeat(1024)}` }],
	};
	const history = buildReplacementHistory([rawUser("small"), media], opaque, {
		tokenBudget: 100,
		byteBudget: 512,
	});
	assert.equal(history.length, 2);
	assert.match(JSON.stringify(history[0]), /small/);
	assert.doesNotMatch(JSON.stringify(history), /input_image/);
});

test("validates versioned details and rejects malformed or unbounded persisted data", () => {
	const details = checkpoint();
	const customProvider = checkpoint([], "checkpoint-custom", "company-codex-proxy");
	assert.deepEqual(parseCheckpointDetails(details), details);
	assert.deepEqual(parseCheckpointDetails(customProvider), customProvider);
	assert.deepEqual(
		parseCheckpointDetails({
			...details,
			version: 1,
			protocol: "remote-compaction-v2",
		}),
		details,
	);
	assert.equal(parseCheckpointDetails({ ...details, version: 3 }), undefined);
	assert.equal(parseCheckpointDetails({ ...details, checkpointId: "x".repeat(129) }), undefined);
	assert.equal(parseCheckpointDetails({ ...details, provider: "" }), undefined);
	assert.equal(parseCheckpointDetails({ ...details, provider: "x".repeat(257) }), undefined);
	assert.equal(parseCheckpointDetails({ ...details, modelId: "" }), undefined);
	assert.equal(parseCheckpointDetails({ ...details, modelId: "x".repeat(513) }), undefined);
	assert.equal(parseCheckpointDetails({ ...details, replacementHistory: [] }), undefined);
	assert.equal(parseCheckpointDetails({ ...details, keptMessageFingerprints: ["bad"] }), undefined);
	const cyclic: Record<string, unknown> = { ...details };
	cyclic.self = cyclic;
	assert.equal(parseCheckpointDetails(cyclic), undefined);
	for (const api of ["openai-responses", "azure-openai-responses"] as const) {
		for (const protocol of ["remote-v2", "responses-compact"] as const) {
			assert.equal(parseCheckpointDetails({ ...details, api, protocol })?.api, api);
		}
	}
	assert.doesNotMatch(JSON.stringify(details), /token|authorization|header/i);
});

test("projects the persisted summary without regenerating version-dependent prose", () => {
	const before = user("before", 0);
	const kept = user("kept", 2);
	const after = user("after", 3);
	const details = checkpoint([kept]);
	for (const persistedSummary of [
		legacyFallbackSummary(details.checkpointId),
		"Arbitrary summary persisted by the active compaction entry.",
	]) {
		const summary = compactionSummary(persistedSummary, 1);
		const projected = project([before, summary, kept, after], details, persistedSummary);
		assert.ok(projected);
		assert.deepEqual(projected[0], before);
		assert.equal(projected[1].role, "user");
		assert.match(JSON.stringify(projected[1]), new RegExp(details.checkpointId));
		assert.deepEqual(projected[2], after);
		assert.equal(project([before, summary, kept, after], details, "different summary"), undefined);
		assert.equal(
			project([summary, user("changed", 2), after], details, persistedSummary),
			undefined,
		);
	}
	assert.equal(project([kept, after], details), undefined);
});

test("projects resumed repeated compaction when Pi interleaves an older summary", () => {
	const firstKept = user("first kept", 1);
	const secondKept = user("second kept", 2);
	const thirdKept = user("third kept", 4);
	const fourthKept = user("fourth kept", 5);
	const later = user("later", 7);
	const firstDetails = checkpoint([firstKept, secondKept], "checkpoint-first");
	const secondDetails = checkpoint(
		[firstKept, secondKept, thirdKept, fourthKept],
		"checkpoint-second",
	);
	const entries = [
		messageEntry("first-kept", null, firstKept),
		messageEntry("second-kept", "first-kept", secondKept),
		compactionEntry(
			"first-compaction",
			"second-kept",
			"first-kept",
			firstDetails,
			"2026-01-01T00:00:03.000Z",
		),
		messageEntry("third-kept", "first-compaction", thirdKept),
		messageEntry("fourth-kept", "third-kept", fourthKept),
		compactionEntry(
			"second-compaction",
			"fourth-kept",
			"first-kept",
			secondDetails,
			"2026-01-01T00:00:06.000Z",
		),
		messageEntry("later", "second-compaction", later),
	];

	const resumed = buildSessionContext(entries, "later").messages;
	assert.deepEqual(
		resumed.map((message) => message.role),
		["compactionSummary", "user", "user", "compactionSummary", "user", "user", "user"],
	);
	const projected = project(resumed, secondDetails);
	assert.ok(projected);
	assert.equal(projected[0].role, "user");
	assert.match(JSON.stringify(projected[0]), /checkpoint-second/);
	assert.deepEqual(projected[1], later);
});

test("removes trailing older compaction summaries covered by the checkpoint", () => {
	const kept = user("kept", 2);
	const after = user("after", 4);
	const details = checkpoint([kept]);
	const activeSummary = compactionSummary(fallbackSummary(details.checkpointId), 3);
	const olderSummary = compactionSummary("older structural summary", 1);

	const projected = project([activeSummary, kept, olderSummary, after], details);
	assert.ok(projected);
	assert.equal(projected.length, 2);
	assert.deepEqual(projected[1], after);
});

test("does not skip unverified messages or newer compaction summaries", () => {
	const first = user("first", 2);
	const second = user("second", 3);
	const details = checkpoint([first, second]);
	const activeSummary = compactionSummary(fallbackSummary(details.checkpointId), 4);
	const newerSummary = compactionSummary("newer summary", 5);

	assert.equal(project([activeSummary, first, user("unexpected", 3), second], details), undefined);
	assert.equal(project([activeSummary, first, newerSummary, second], details), undefined);
	const projected = project([activeSummary, first, second, newerSummary], details);
	assert.ok(projected);
	assert.deepEqual(projected.at(-1), newerSummary);
});

test("matches stored summary fingerprints before treating old summaries as structural", () => {
	const storedSummary = compactionSummary("fingerprinted summary", 1);
	const kept = user("kept", 2);
	const after = user("after", 4);
	const details = checkpoint([storedSummary, kept]);
	const activeSummary = compactionSummary(fallbackSummary(details.checkpointId), 3);

	const projected = project([activeSummary, storedSummary, kept, after], details);
	assert.ok(projected);
	assert.equal(projected.length, 2);
	assert.deepEqual(projected[1], after);
});

test("uses canonical SHA-256 message fingerprints", () => {
	const message = user("same");
	assert.match(fingerprintMessage(message), /^[a-f0-9]{64}$/);
	assert.equal(fingerprintMessage(message), fingerprintMessage({ ...message }));
	assert.notEqual(fingerprintMessage(message), fingerprintMessage(user("different")));
	assert.match(checkpointMarker("checkpoint-123"), /injection failed/i);
});

test("selects the newest checkpoint on the active branch and ignores forks before it", () => {
	const first = checkpoint([], "checkpoint-first");
	const second = checkpoint([], "checkpoint-second");
	const entry = (
		id: string,
		details: ReturnType<typeof checkpoint>,
		parentId: string | null,
	): CompactionEntry => ({
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		summary: fallbackSummary(details.checkpointId),
		firstKeptEntryId: "kept",
		tokensBefore: 10,
		details,
	});
	const branch = [entry("first", first, null), entry("second", second, "first")] as SessionEntry[];
	assert.equal(latestCheckpoint(branch)?.details.checkpointId, "checkpoint-second");
	assert.equal(latestCheckpoint(branch.slice(0, 1))?.details.checkpointId, "checkpoint-first");
	const native = {
		...entry("native", second, "second"),
		details: undefined,
		summary: "native summary",
	};
	assert.equal(latestCheckpoint([...branch, native]), undefined);
	assert.equal(latestCheckpoint([]), undefined);
});
