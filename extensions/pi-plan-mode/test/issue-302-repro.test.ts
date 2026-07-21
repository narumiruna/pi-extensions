import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import planMode from "../src/plan-mode.js";

test("issue 302: re-entered Plan Mode hides the previous implementation handoff", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
	planMode(mock.pi);
	const context = createMockContext();

	await mock.commands.get("plan")?.handler("", context.ctx);
	const executeComplete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(executeComplete);
	await executeComplete(
		"complete",
		{ plan: "# Plan Mode repro" },
		undefined,
		undefined,
		context.ctx,
	);

	await mock.commands.get("plan")?.handler("implement", context.ctx);
	const implementationHandoff = mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(implementationHandoff, /Plan mode is now disabled/);
	assert.match(implementationHandoff, /Implement this proposed plan now/);
	assert.equal(context.statuses.get("plan-mode"), undefined);

	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const implementationMessages = [
		{ role: "user", content: "Plan a one-line README change." },
		{ role: "user", content: implementationHandoff },
		{ role: "assistant", content: "Implemented the requested plan." },
	];
	const inactiveContext = (await contextHook(
		{ messages: implementationMessages },
		context.ctx,
	)) as { messages: unknown[] };
	assert.deepEqual(inactiveContext.messages, implementationMessages);

	await mock.commands.get("plan")?.handler("", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);

	const beforeStart = mock.events.get("before_agent_start")?.[0];
	assert.ok(beforeStart);
	const promptResult = beforeStart({ systemPrompt: "base" }, context.ctx) as {
		systemPrompt?: string;
	};
	assert.match(promptResult.systemPrompt ?? "", /You are in Plan Mode/);
	assert.match(promptResult.systemPrompt ?? "", /plan_mode_complete/);

	const activeMessages = [...implementationMessages, { role: "user", content: "continue" }];
	const activeContext = (await contextHook({ messages: activeMessages }, context.ctx)) as {
		messages: unknown[];
	};

	assert.deepEqual(activeContext.messages, [
		implementationMessages[0],
		implementationMessages[2],
		activeMessages[3],
	]);
	assert.doesNotMatch(
		JSON.stringify(activeContext.messages),
		/Plan mode is now disabled\. Full tool access is restored/,
	);
});
