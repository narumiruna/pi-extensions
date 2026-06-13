import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import btw, { buildConversationContext, buildUserPrompt, sanitizeSingleLine } from "../src/btw.js";

test("btw command validates usage before asking a side question", async () => {
	const mock = createMockPi();
	btw(mock.pi);

	const command = mock.commands.get("btw");
	assert.ok(command);
	const emptyQuestion = createMockContext();
	await command.handler("   ", emptyQuestion.ctx);

	const nonInteractive = createMockContext({ hasUI: false });
	await command.handler("question?", nonInteractive.ctx);

	assert.equal(mock.commands.size, 1);
	assert.equal(
		command.description,
		"Ask a quick side question without adding it to the main conversation",
	);
	assert.equal(emptyQuestion.notifications[0]?.level, "warning");
	assert.match(emptyQuestion.notifications[0]?.message ?? "", /Usage: \/btw/);
	assert.equal(nonInteractive.notifications[0]?.level, "error");
});

test("buildConversationContext formats user, assistant, and tool content", () => {
	const context = buildConversationContext([
		{ type: "ignored", message: { role: "user", content: "skip" } },
		{
			type: "message",
			message: {
				role: "user",
				content: [
					{ type: "text", text: " Inspect this " },
					{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				stopReason: "length",
				content: [{ type: "toolResult", name: "read", result: { ok: true } }],
			},
		},
	]);

	assert.match(context, /User: Inspect this\nTool call: read\(\{"path":"README\.md"\}\)/);
	assert.match(context, /Assistant \(length\): Tool result from read: \{"ok":true\}/);
	assert.doesNotMatch(context, /skip/);
});

test("buildUserPrompt falls back when no conversation context exists", () => {
	const prompt = buildUserPrompt("What now?", "");

	assert.match(prompt, /<side_question>\nWhat now\?\n<\/side_question>/);
	assert.match(prompt, /No prior conversation context was available/);
});

test("sanitizeSingleLine removes controls and collapses whitespace", () => {
	assert.equal(sanitizeSingleLine(" /btw\nhello\t\u0000 world  "), "/btw hello world");
});
