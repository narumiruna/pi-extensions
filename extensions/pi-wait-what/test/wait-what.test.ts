import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import waitWhat, { buildWaitWhatPrompt } from "../src/wait-what.js";

test("buildWaitWhatPrompt includes a trimmed concern and no-tool instruction", () => {
	const prompt = buildWaitWhatPrompt("  Why did you choose bash?  ");

	assert.match(prompt, /<concern>\nWhy did you choose bash\?\n<\/concern>/);
	assert.match(prompt, /Do not call tools/);
	assert.match(prompt, /1\. What you were doing/);
});

test("buildWaitWhatPrompt omits concern block when no concern is provided", () => {
	const prompt = buildWaitWhatPrompt("   ");

	assert.doesNotMatch(prompt, /<concern>/);
	assert.match(prompt, /Wait, what\?/);
});

test("wait-what command steers busy sessions and sends normal messages when idle", async () => {
	const idle = createMockPi();
	waitWhat(idle.pi);
	const command = idle.commands.get("wait-what");
	assert.ok(command);

	await command.handler("explain", createMockContext({ isIdle: () => true }).ctx);
	assert.equal(idle.sentUserMessages.length, 1);
	assert.equal(idle.sentUserMessages[0]?.options, undefined);

	const busy = createMockPi();
	waitWhat(busy.pi);
	const busyCommand = busy.commands.get("wait-what");
	assert.ok(busyCommand);
	await busyCommand.handler("explain", createMockContext({ isIdle: () => false }).ctx);
	assert.deepEqual(busy.sentUserMessages[0]?.options, { deliverAs: "steer" });
});
