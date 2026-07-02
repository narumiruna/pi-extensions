import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import btw, {
	buildConversationContext,
	buildGhosttyForkTabAppleScript,
	buildGhosttyForkTabInitialInput,
	buildUserPrompt,
	sanitizeSingleLine,
	shouldOpenGhosttyTab,
} from "../src/btw.js";

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

test("shouldOpenGhosttyTab detects macOS Ghostty only", () => {
	assert.equal(shouldOpenGhosttyTab({ TERM_PROGRAM: "ghostty" }, "darwin"), true);
	assert.equal(shouldOpenGhosttyTab({ TERM: "xterm-ghostty" }, "darwin"), true);
	assert.equal(shouldOpenGhosttyTab({ TERM_PROGRAM: "Apple_Terminal" }, "darwin"), false);
	assert.equal(shouldOpenGhosttyTab({ TERM_PROGRAM: "iTerm.app" }, "darwin"), false);
	assert.equal(shouldOpenGhosttyTab({ TERM_PROGRAM: "ghostty" }, "linux"), false);
});

test("btw opens Ghostty fork tab before asking locally", async () => {
	const mock = createMockPi();
	btw(mock.pi, { env: { TERM_PROGRAM: "ghostty" }, platform: "darwin" });

	const command = mock.commands.get("btw");
	assert.ok(command);
	let customCalls = 0;
	const context = createMockContext({
		hasUI: true,
		sessionManager: sessionManagerWithFile(sessionFile()),
		custom: async () => {
			customCalls += 1;
			return "unused";
		},
	});

	await command.handler("what's up?", context.ctx);

	assert.equal(mock.execCalls.length, 1);
	assert.equal(mock.execCalls[0]?.command, "osascript");
	assert.deepEqual(mock.execCalls[0]?.options, { timeout: 5000 });
	const script = mock.execCalls[0]?.args?.[1] ?? "";
	assert.match(script, /pi --fork/);
	assert.equal(script.includes(appleScriptHex("Side question:\n\nwhat's up?")), true);
	assert.equal(script.includes("$("), false);
	assert.equal(customCalls, 0);
	assert.equal(context.notifications.length, 0);
});

test("btw uses inline pager outside Ghostty", async () => {
	const mock = createMockPi();
	btw(mock.pi, { env: { TERM_PROGRAM: "Apple_Terminal" }, platform: "darwin" });

	const command = mock.commands.get("btw");
	assert.ok(command);
	let customCalls = 0;
	const context = createMockContext({
		hasUI: true,
		model: { id: "model", provider: "provider" },
		custom: async () => {
			customCalls += 1;
			return customCalls === 1 ? "answer" : undefined;
		},
	});

	await command.handler("question?", context.ctx);

	assert.equal(mock.execCalls.length, 0);
	assert.equal(customCalls, 2);
	assert.equal(context.notifications.length, 0);
});

test("btw falls back to inline pager when Ghostty fork tab has no session file", async () => {
	const mock = createMockPi();
	btw(mock.pi, { env: { TERM_PROGRAM: "ghostty" }, platform: "darwin" });

	const command = mock.commands.get("btw");
	assert.ok(command);
	let customCalls = 0;
	const context = createMockContext({
		hasUI: true,
		model: { id: "model", provider: "provider" },
		custom: async () => {
			customCalls += 1;
			return customCalls === 1 ? "answer" : undefined;
		},
	});

	await command.handler("question?", context.ctx);

	assert.equal(mock.execCalls.length, 0);
	assert.match(context.notifications[0]?.message ?? "", /no saved session/);
	assert.equal(context.notifications[0]?.level, "warning");
	assert.equal(customCalls, 2);
});

test("btw falls back to inline pager when Ghostty session file is empty", async () => {
	const mock = createMockPi();
	btw(mock.pi, { env: { TERM_PROGRAM: "ghostty" }, platform: "darwin" });

	const command = mock.commands.get("btw");
	assert.ok(command);
	let customCalls = 0;
	const context = createMockContext({
		hasUI: true,
		model: { id: "model", provider: "provider" },
		sessionManager: sessionManagerWithFile(sessionFile("")),
		custom: async () => {
			customCalls += 1;
			return customCalls === 1 ? "answer" : undefined;
		},
	});

	await command.handler("question?", context.ctx);

	assert.equal(mock.execCalls.length, 0);
	assert.match(context.notifications[0]?.message ?? "", /empty or invalid/);
	assert.equal(context.notifications[0]?.level, "warning");
	assert.equal(customCalls, 2);
});

test("btw falls back to inline pager when Ghostty AppleScript fails", async () => {
	const mock = createMockPi({ execResult: { stderr: "boom", code: 1 } });
	btw(mock.pi, { env: { TERM: "xterm-ghostty" }, platform: "darwin" });

	const command = mock.commands.get("btw");
	assert.ok(command);
	let customCalls = 0;
	const context = createMockContext({
		hasUI: true,
		model: { id: "model", provider: "provider" },
		sessionManager: sessionManagerWithFile(sessionFile()),
		custom: async () => {
			customCalls += 1;
			return customCalls === 1 ? "answer" : undefined;
		},
	});

	await command.handler("question?", context.ctx);

	assert.equal(mock.execCalls.length, 1);
	assert.match(context.notifications[0]?.message ?? "", /boom/);
	assert.equal(context.notifications[0]?.level, "warning");
	assert.equal(customCalls, 2);
});

test("btw falls back to inline pager when Ghostty AppleScript throws", async () => {
	const mock = createMockPi();
	mock.rawPi.exec = async () => {
		throw new Error("spawn failed");
	};
	btw(mock.pi, { env: { TERM: "xterm-ghostty" }, platform: "darwin" });

	const command = mock.commands.get("btw");
	assert.ok(command);
	let customCalls = 0;
	const context = createMockContext({
		hasUI: true,
		model: { id: "model", provider: "provider" },
		sessionManager: sessionManagerWithFile(sessionFile()),
		custom: async () => {
			customCalls += 1;
			return customCalls === 1 ? "answer" : undefined;
		},
	});

	await command.handler("question?", context.ctx);

	assert.match(context.notifications[0]?.message ?? "", /spawn failed/);
	assert.equal(context.notifications[0]?.level, "warning");
	assert.equal(customCalls, 2);
});

test("buildGhosttyForkTabInitialInput runs pi fork with the side question", () => {
	const input = buildGhosttyForkTabInitialInput(
		`what's "up"?\n下一行`,
		"/tmp/session file's\n下一.jsonl",
	);

	assert.match(input, /^pi --fork \$'\\x/);
	assert.doesNotMatch(input, /^exec /);
	assert.doesNotMatch(input, / -- /);
	assert.equal(input.endsWith("\n"), true);
	assert.equal(isAscii(input), true);
	assert.equal(input.includes("$("), false);
	assert.equal(input.includes(hex("/tmp/session file's\n下一.jsonl")), true);
	assert.equal(input.includes(hex(`Side question:\n\nwhat's "up"?\n下一行`)), true);
});

test("buildGhosttyForkTabInitialInput prefixes flag-like and file-like questions safely", () => {
	for (const question of ["--help", "--model x", "@README.md"]) {
		const input = buildGhosttyForkTabInitialInput(question, "/tmp/session.jsonl");

		assert.equal(input.startsWith("pi --fork $'\\x"), true);
		assert.equal(input.includes(hex(`Side question:\n\n${question}`)), true);
		assert.doesNotMatch(input, /^exec /);
		assert.doesNotMatch(input, / -- /);
		assert.equal(input.includes("$("), false);
		assert.equal(input.includes(question), false);
	}
});

test("buildGhosttyForkTabAppleScript escapes AppleScript strings", () => {
	const script = buildGhosttyForkTabAppleScript(
		`what's "up"?\n下一行`,
		"/tmp/session file's.jsonl",
		'/Users/me/Project "quoted"\n下一行/back\\slash',
	);

	assert.match(script, /tell application "Ghostty"/);
	assert.match(script, /new tab in front window with configuration cfg/);
	assert.equal(
		script.includes(
			'set initial working directory of cfg to "/Users/me/Project \\"quoted\\"" & linefeed & "下一行/back\\\\slash"',
		),
		true,
	);
	assert.doesNotMatch(script, /set command of cfg/);
	assert.match(script, /set initial input of cfg to "pi --fork /);
	assert.match(script, / & linefeed & /);
	assert.equal(script.includes(appleScriptHex("/tmp/session file's.jsonl")), true);
	assert.equal(script.includes(appleScriptHex(`Side question:\n\nwhat's "up"?\n下一行`)), true);
});

function sessionFile(content = `${JSON.stringify({ type: "session", version: 3 })}\n`) {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-btw-session-"));
	const file = path.join(dir, "session.jsonl");
	writeFileSync(file, content);
	return file;
}

function hex(text: string) {
	return [...Buffer.from(text, "utf8")]
		.map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`)
		.join("");
}

function appleScriptHex(text: string) {
	return hex(text).replaceAll("\\", "\\\\");
}

function isAscii(text: string) {
	return [...text].every((char) => (char.codePointAt(0) ?? 0) <= 0x7f);
}

function sessionManagerWithFile(sessionFile: string) {
	return {
		getBranch: () => [],
		getEntries: () => [],
		getSessionFile: () => sessionFile,
	};
}
