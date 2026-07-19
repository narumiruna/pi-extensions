import assert from "node:assert/strict";
import test from "node:test";
import {
	ConversationProjection,
	projectBranchMessages,
	projectMessage,
} from "../src/conversation.js";

const session = { id: "session-1", cwd: "/workspace/demo", projectName: "demo" };

test("branch snapshots retain the active message path and omit non-message entries", () => {
	const branch = [
		{ type: "custom", id: "custom" },
		{
			type: "message",
			id: "user-1",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", data: "secret-base64", mimeType: "image/png" },
				],
				timestamp: 1,
			},
		},
	];
	assert.deepEqual(projectBranchMessages(branch), [
		{
			id: "user-1",
			role: "user",
			timestamp: 1,
			final: true,
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", mimeType: "image/png" },
			],
		},
	]);
});

test("message projection keeps semantic blocks and truncates large tool content", () => {
	const projected = projectMessage(
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
			],
			timestamp: 2,
			stopReason: "toolUse",
		},
		undefined,
		false,
	);
	assert.deepEqual(projected.content, [
		{ type: "thinking", text: "private reasoning" },
		{ type: "text", text: "answer" },
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
	]);
	assert.equal(projected.final, false);

	const result = projectMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "x".repeat(60_000) }],
		timestamp: 3,
		isError: false,
	});
	const text = result.content[0];
	assert.equal(text?.type, "text");
	assert.ok(text?.type === "text" && text.text.length < 51_000);
	assert.ok(text?.type === "text" && text.text.endsWith("\n… output truncated"));
});

test("streaming assistant identity remains stable when a tool call appears", () => {
	const projection = new ConversationProjection(session);
	projection.recordMessage({ role: "assistant", content: [], timestamp: 10 }, false);
	projection.recordMessage(
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
			timestamp: 10,
		},
		false,
	);
	const messages = projection.snapshot().messages;
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.id, "assistant:10");
	assert.equal(messages[0]?.content[0]?.type, "toolCall");
});

test("projection emits ordered replaceable updates and suppresses exact duplicates", () => {
	const projection = new ConversationProjection(session, [], 3);
	const events: unknown[] = [];
	projection.subscribe((event) => events.push(event));
	const partial = { role: "assistant", content: [{ type: "text", text: "hel" }], timestamp: 10 };
	projection.recordMessage(partial, false);
	projection.recordMessage(partial, false);
	projection.recordMessage(
		{ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 10 },
		true,
	);
	projection.recordTool("start", "call", "bash", { command: "pwd" });
	projection.recordTool("end", "call", "bash", undefined, {
		content: [{ type: "text", text: "/workspace" }],
	});

	assert.equal(events.length, 4);
	assert.deepEqual(
		(events as Array<{ sequence: number }>).map((event) => event.sequence),
		[1, 2, 3, 4],
	);
	assert.equal(projection.snapshot().messages.length, 1);
	assert.equal(projection.snapshot().tools[0]?.phase, "end");
	assert.equal(projection.eventsAfter(0), undefined, "evicted sequence requires a snapshot");
	assert.deepEqual(
		projection.eventsAfter(1)?.map((event) => event.sequence),
		[2, 3, 4],
	);
});

test("tool projection bounds property scans and contains cycles before serialization", () => {
	let reads = 0;
	const details: Record<string, unknown> = {};
	for (let index = 0; index < 5_000; index += 1) {
		Object.defineProperty(details, `key${index}`, {
			enumerable: true,
			get() {
				reads += 1;
				return index;
			},
		});
	}
	details.self = details;
	const projection = new ConversationProjection(session);
	projection.recordTool("end", "bounded", "custom", {}, { details });
	assert.ok(reads <= 101, `read ${reads} properties`);
	assert.ok(JSON.stringify(projection.snapshot()).length < 50_000);
});

test("transcript and tool snapshots retain only the newest bounded records", () => {
	const projection = new ConversationProjection(session);
	for (let index = 0; index < 510; index += 1) {
		projection.recordMessage({ role: "user", content: String(index), timestamp: index });
		projection.recordTool("end", `tool-${index}`, "test", {}, {});
	}
	const snapshot = projection.snapshot();
	assert.equal(snapshot.messages.length, 500);
	assert.equal(snapshot.messages[0]?.timestamp, 10);
	assert.equal(snapshot.tools.length, 500);
	assert.equal(snapshot.tools[0]?.id, "tool-10");
});

test("branch navigation replaces the transcript with an authoritative sequenced snapshot", () => {
	const projection = new ConversationProjection(session, [
		projectMessage({ role: "user", content: "old", timestamp: 1 }, "old"),
	]);
	const events: Array<{ type: string; payload: unknown }> = [];
	projection.subscribe((event) => events.push(event));
	projection.replaceBranch([projectMessage({ role: "user", content: "new", timestamp: 2 }, "new")]);
	assert.equal(projection.snapshot().messages[0]?.id, "new");
	const [event] = events;
	assert.ok(event);
	assert.equal(event.type, "snapshot");
	assert.equal((event.payload as { sequence: number }).sequence, 1);
});

test("activity and session closure are projected as explicit state", () => {
	const projection = new ConversationProjection(session);
	projection.setActivity("running");
	projection.setActivity("running");
	projection.close();
	assert.equal(projection.snapshot().activity, "ended");
	assert.equal(projection.snapshot().closed, true);
	assert.deepEqual(
		projection.eventsAfter(0)?.map((event) => event.type),
		["activity", "session-ended"],
	);
});
