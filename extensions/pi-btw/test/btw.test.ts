import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import btw, {
	buildConversationContext,
	buildUserPrompt,
	loadComplete,
	sanitizeSingleLine,
} from "../src/btw.js";

test("loadComplete prefers compat and falls back to the root module", async () => {
	const compatComplete = async () => ({ source: "compat" });
	const rootComplete = async () => ({ source: "root" });
	const preferredImports: string[] = [];
	const preferred = await loadComplete(async (moduleId) => {
		preferredImports.push(moduleId);
		return moduleId.endsWith("/compat") ? { complete: compatComplete } : { complete: rootComplete };
	});

	assert.equal(preferred, compatComplete);
	assert.deepEqual(preferredImports, ["@earendil-works/pi-ai/compat"]);

	const fallbackImports: string[] = [];
	const fallback = await loadComplete(async (moduleId) => {
		fallbackImports.push(moduleId);
		if (moduleId.endsWith("/compat")) throw new Error("missing compat export");
		return { complete: rootComplete };
	});

	assert.equal(fallback, rootComplete);
	assert.deepEqual(fallbackImports, ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"]);
});

test("loadComplete reports when neither module exports complete", async () => {
	await assert.rejects(
		loadComplete(async (moduleId) => {
			if (moduleId.endsWith("/compat")) throw new Error("missing compat export");
			return {};
		}),
		/@earendil-works\/pi-ai does not export complete/,
	);
});

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
