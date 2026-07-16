import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DEFAULT_MAX_CONTEXT_BYTES,
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_MAX_STDERR_BYTES,
} from "../src/limits.js";
import { renderSubagentResult } from "../src/render.js";
import {
	buildFanInContext,
	formatResultFailure,
	isResultError,
	runSingleAgent,
	type SubagentDetails,
	terminateProcess,
} from "../src/runner.js";

test("runSingleAgent normalizes invalid cwd without spawning or throwing", async () => {
	const result = await runSingleAgent(
		process.cwd(),
		[
			{
				name: "test",
				description: "test",
				systemPrompt: "",
				source: "built-in",
				filePath: "built-in:test",
			},
		],
		"test",
		"task",
		path.join(os.tmpdir(), "definitely-missing-pi-subagent-cwd"),
		undefined,
		undefined,
		undefined,
		100,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
	);
	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Invalid subagent cwd/);
});

test("runSingleAgent preserves partial output on mid-stream abort and handles pre-abort", async () => {
	const script = [
		"const message={role:'assistant',content:[{type:'text',text:'PARTIAL'}],timestamp:Date.now()};",
		"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		"setInterval(()=>{},1000);",
	].join("");
	const agents = [
		{
			name: "test",
			description: "test",
			systemPrompt: "",
			source: "built-in" as const,
			filePath: "built-in:test",
		},
	];
	const makeDetails = (results: Parameters<Parameters<typeof runSingleAgent>[10]>[0]) => ({
		mode: "single" as const,
		agentScope: "user" as const,
		projectAgentsDir: null,
		results,
	});
	const controller = new AbortController();
	let sawPartial = false;
	const running = runSingleAgent(
		process.cwd(),
		agents,
		"test",
		"task",
		undefined,
		undefined,
		controller.signal,
		undefined,
		1_000,
		(partial) => {
			if (partial.content[0]?.type === "text" && partial.content[0].text === "PARTIAL") {
				sawPartial = true;
				controller.abort();
			}
		},
		makeDetails,
		{ command: process.execPath, argsPrefix: ["-e", script, "--"] },
	);
	const aborted = await running;
	assert.equal(sawPartial, true);
	assert.equal(aborted.aborted, true);
	assert.equal(aborted.exitCode, 130);
	assert.equal(aborted.finalOutput, "PARTIAL");

	const preAborted = new AbortController();
	preAborted.abort();
	const beforeStart = await runSingleAgent(
		process.cwd(),
		agents,
		"test",
		"task",
		undefined,
		undefined,
		preAborted.signal,
		undefined,
		1_000,
		undefined,
		makeDetails,
		{ command: process.execPath, argsPrefix: ["-e", "setInterval(()=>{},1000)", "--"] },
	);
	assert.equal(beforeStart.aborted, true);
	assert.equal(beforeStart.exitCode, 130);
});

test("runSingleAgent preserves final text beyond its history budget and rejects empty final output", async () => {
	const agents = [
		{
			name: "test",
			description: "test",
			systemPrompt: "",
			source: "built-in" as const,
			model: "requested-alias",
			filePath: "built-in:test",
		},
	];
	const makeDetails = (results: Parameters<Parameters<typeof runSingleAgent>[10]>[0]) => ({
		mode: "single" as const,
		agentScope: "user" as const,
		projectAgentsDir: null,
		results,
	});
	const runScript = (script: string) =>
		runSingleAgent(
			process.cwd(),
			agents,
			"test",
			"task",
			undefined,
			undefined,
			undefined,
			undefined,
			1_000,
			undefined,
			makeDetails,
			{ command: process.execPath, argsPrefix: ["-e", script, "--"] },
		);

	const script = [
		`const large='x'.repeat(${DEFAULT_MAX_OUTPUT_BYTES});`,
		"const tool={role:'toolResult',toolCallId:'call-1',toolName:'read',content:[{type:'text',text:large}],isError:false,timestamp:Date.now()};",
		"process.stdout.write(JSON.stringify({type:'tool_result_end',message:tool})+'\\n');",
		"process.stdout.write(JSON.stringify({type:'tool_result_end',message:{...tool,toolCallId:'call-2'}})+'\\n');",
		"const final={role:'assistant',content:[{type:'text',text:'FINAL_SURVIVES'}],stopReason:'stop',timestamp:Date.now()};",
		"process.stdout.write(JSON.stringify({type:'message_end',message:final})+'\\n');",
	].join("");
	const result = await runScript(script);
	assert.equal(result.exitCode, 0);
	assert.equal(result.truncated, true);
	assert.equal(result.finalOutput, "FINAL_SURVIVES");
	assert.match(buildFanInContext([result]), /FINAL_SURVIVES/);

	const hugeFinal = await runScript(
		[
			`const text='界'.repeat(${DEFAULT_MAX_OUTPUT_BYTES});`,
			"const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	assert.ok(Buffer.byteLength(hugeFinal.finalOutput ?? "", "utf8") <= DEFAULT_MAX_OUTPUT_BYTES);
	assert.match(hugeFinal.finalOutput ?? "", /truncated by pi-subagents/);

	const providerError = await runScript(
		[
			`const errorMessage='E'.repeat(${DEFAULT_MAX_OUTPUT_BYTES});`,
			"const message={role:'assistant',content:[{type:'text',text:'PARTIAL'}],stopReason:'error',errorMessage,timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	assert.ok(
		Buffer.byteLength(providerError.errorMessage ?? "", "utf8") <= DEFAULT_MAX_STDERR_BYTES,
	);
	assert.match(providerError.errorMessage ?? "", /truncated by pi-subagents/);
	assert.equal(providerError.finalOutput, "PARTIAL");
	assert.equal(isResultError(providerError), true);
	const providerFailureContext = buildFanInContext([providerError]);
	assert.match(providerFailureContext, /test \(failed\)/);
	assert.match(providerFailureContext, /Error:\nE/);
	assert.match(providerFailureContext, /Partial output:\nPARTIAL/);

	const emptyProviderError = await runScript(
		[
			"const message={role:'assistant',content:[],stopReason:'error',errorMessage:'RATE_LIMIT_DETAIL',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	assert.equal(emptyProviderError.stopReason, "error");
	assert.equal(emptyProviderError.errorMessage, "RATE_LIMIT_DETAIL");
	assert.equal(emptyProviderError.finalOutput, "");

	const multiBlock = await runScript(
		[
			"const message={role:'assistant',content:[{type:'text',text:'FIRST'},{type:'text',text:'SECOND'}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	assert.equal(multiBlock.exitCode, 0);
	assert.equal(multiBlock.finalOutput, "FIRST\nSECOND");

	const paddedActivity = await runScript(
		[
			"const message={role:'assistant',content:[{type:'text',text:'\\n'.repeat(2048)+'LATEST_ACTIVITY\\n\\n'}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	assert.deepEqual(paddedActivity.recentActivity, [{ type: "text", text: "LATEST_ACTIVITY" }]);

	const empty = await runScript(
		[
			"const commentary={role:'assistant',content:[{type:'text',text:'OLD_COMMENTARY'}],stopReason:'toolUse',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message:commentary})+'\\n');",
			"const final={role:'assistant',content:[{type:'text',text:''}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message:final})+'\\n');",
		].join(""),
	);
	assert.equal(empty.exitCode, 1);
	assert.equal(empty.stopReason, "error");
	assert.equal(empty.finalOutput, "");
	assert.equal(empty.errorMessage, "Subagent completed without final text");

	const boundedFailure = formatResultFailure({
		agent: "test",
		agentSource: "built-in",
		task: "task",
		exitCode: 124,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 1,
		},
		errorMessage: "E".repeat(20_000),
		finalOutput: "界".repeat(DEFAULT_MAX_CONTEXT_BYTES),
	});
	assert.ok(Buffer.byteLength(boundedFailure, "utf8") <= DEFAULT_MAX_CONTEXT_BYTES);
	assert.match(boundedFailure, /Partial output/);
	assert.match(boundedFailure, /truncated by pi-subagents/);

	const rollingWindow = await runScript(
		[
			"for(let i=0;i<201;i++){const arguments_=i===200?{command:'echo call-200 '+ 'x'.repeat(200000)}:{};const toolCall={type:'toolCall',id:'call-'+i,name:'bash',arguments:arguments_};const content=i===200?[{type:'thinking',thinking:'omit'},toolCall]:[toolCall];const message={role:'assistant',content,stopReason:'toolUse'};process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');}",
			"const final={role:'assistant',provider:'actual-provider',responseModel:'actual-model',model:'fallback-alias',content:[{type:'text',text:'FINAL_WINDOW_SURVIVES'}],stopReason:'stop'};process.stdout.write(JSON.stringify({type:'message_end',message:final})+'\\n');",
		].join(""),
	);
	assert.equal(rollingWindow.finalOutput, "FINAL_WINDOW_SURVIVES");
	assert.equal(rollingWindow.actualProvider, "actual-provider");
	assert.equal(rollingWindow.actualModel, "actual-model");
	assert.equal(rollingWindow.model, "requested-alias");
	assert.equal(rollingWindow.recentActivityTotal, 202);
	assert.equal(rollingWindow.recentActivity?.length, 10);
	assert.ok(Buffer.byteLength(JSON.stringify(rollingWindow.recentActivity), "utf8") <= 8 * 1024);
	assert.ok(
		rollingWindow.recentActivity?.some(
			(item) => item.type === "toolCall" && String(item.args.command).startsWith("echo call-200"),
		),
	);
	assert.ok(rollingWindow.messages.length <= 200);
	assert.ok(
		Buffer.byteLength(JSON.stringify(rollingWindow.messages), "utf8") <= DEFAULT_MAX_OUTPUT_BYTES,
	);
	const calls = rollingWindow.messages.flatMap((message) =>
		message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [],
	);
	assert.equal(
		calls.some((call) => call.id === "call-0"),
		false,
	);
	assert.ok(calls.some((call) => call.id === "call-200" && call.name === "bash"));
	const lastCall = calls.find((call) => call.id === "call-200");
	assert.match(String(lastCall?.arguments.command), /^echo call-200/);
	assert.ok(
		rollingWindow.messages.every(
			(message) =>
				message.role !== "assistant" || message.content.every((part) => part.type !== "thinking"),
		),
	);
	assert.ok(
		rollingWindow.messages.every((message) =>
			message.role !== "assistant" && message.role !== "toolResult"
				? true
				: message.content.every((part) => part.type !== "text" || part.text.trim()),
		),
	);

	const updateSnapshots: Array<{ details: { results: Array<{ messages: unknown[] }> } }> = [];
	await runSingleAgent(
		process.cwd(),
		agents,
		"test",
		"task",
		undefined,
		undefined,
		undefined,
		undefined,
		1_000,
		(update) => updateSnapshots.push(structuredClone(update) as never),
		makeDetails,
		{
			command: process.execPath,
			argsPrefix: [
				"-e",
				`const tool={role:'toolResult',toolCallId:'oversize-call',toolName:'read',content:[{type:'text',text:'x'.repeat(${DEFAULT_MAX_OUTPUT_BYTES * 2})}],isError:true,timestamp:123};process.stdout.write(JSON.stringify({type:'tool_result_end',message:tool})+'\\n');`,
				"--",
			],
		},
	);
	assert.equal(updateSnapshots.length, 1);
	const compressedToolResult = updateSnapshots[0].details.results[0].messages.find(
		(
			message,
		): message is {
			role: "toolResult";
			content: Array<{ type: "text"; text: string }>;
			toolCallId: string;
			toolName: string;
			isError: boolean;
			timestamp: number;
		} =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			message.role === "toolResult",
	);
	assert.ok(compressedToolResult);
	assert.ok(
		Buffer.byteLength(JSON.stringify(compressedToolResult), "utf8") <= DEFAULT_MAX_OUTPUT_BYTES,
	);
	assert.equal(compressedToolResult.toolCallId, "oversize-call");
	assert.equal(compressedToolResult.toolName, "read");
	assert.equal(compressedToolResult.isError, true);
	assert.equal(compressedToolResult.timestamp, 123);
	assert.ok(compressedToolResult.content[0].text.length > 0);

	const smallMessages = await runScript(
		[
			"const tool={role:'toolResult',content:[{type:'text',text:'small tool result'}],toolCallId:'tool-1',toolName:'read',isError:true,timestamp:123};",
			"process.stdout.write(JSON.stringify({type:'tool_result_end',message:tool})+'\\n');",
			"const message={role:'assistant',content:[{type:'text',text:'small assistant'}],timestamp:456,provider:'small-provider',responseModel:'small-model',usage:{input:1,output:2,cacheRead:3,cacheWrite:4,totalTokens:5,cost:{total:0.1}},stopReason:'stop'};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	assert.notEqual(smallMessages.truncated, true);
	const smallToolResult = smallMessages.messages.find((message) => message.role === "toolResult");
	assert.deepEqual(smallToolResult, {
		role: "toolResult",
		content: [{ type: "text", text: "small tool result" }],
		toolCallId: "tool-1",
		toolName: "read",
		isError: true,
		timestamp: 123,
	});
	const smallAssistant = smallMessages.messages.find((message) => message.role === "assistant");
	assert.equal(smallAssistant?.timestamp, 456);
	assert.equal(smallAssistant?.provider, "small-provider");
	assert.equal(smallAssistant?.responseModel, "small-model");
	assert.deepEqual(smallAssistant?.usage, {
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 5,
		cost: { total: 0.1 },
	});
});

test("large tool results do not erase recent collapsed activity", async () => {
	const agents = [
		{
			name: "test",
			description: "test",
			systemPrompt: "",
			source: "built-in" as const,
			filePath: "built-in:test",
		},
	];
	const makeDetails = (results: Parameters<Parameters<typeof runSingleAgent>[10]>[0]) => ({
		mode: "single" as const,
		agentScope: "user" as const,
		projectAgentsDir: null,
		results,
	});
	const snapshots: Array<ReturnType<typeof structuredClone>> = [];
	const script = [
		"const assistant={role:'assistant',content:[{type:'toolCall',id:'latest',name:'bash',arguments:{command:'echo stays visible'}}],stopReason:'toolUse',timestamp:1};",
		"process.stdout.write(JSON.stringify({type:'message_end',message:assistant})+'\\n');",
		`const tool={role:'toolResult',toolCallId:'latest',toolName:'bash',content:[{type:'text',text:'x'.repeat(${DEFAULT_MAX_OUTPUT_BYTES * 2})}],isError:false,timestamp:2};`,
		"process.stdout.write(JSON.stringify({type:'tool_result_end',message:tool})+'\\n');",
	].join("");
	await runSingleAgent(
		process.cwd(),
		agents,
		"test",
		"task",
		undefined,
		undefined,
		undefined,
		undefined,
		1_000,
		(update) => snapshots.push(structuredClone(update)),
		makeDetails,
		{ command: process.execPath, argsPrefix: ["-e", script, "--"] },
	);
	assert.equal(snapshots.length, 2);
	const afterToolResult = snapshots[1] as never;
	const details = (snapshots[1] as { details: SubagentDetails }).details;
	assert.equal(details.results[0].recentActivityTotal, 1);
	assert.deepEqual(details.results[0].recentActivity, [
		{ type: "toolCall", name: "bash", args: { command: "echo stays visible" } },
	]);
	assert.equal(
		details.results[0].messages.some(
			(message) =>
				message.role === "assistant" && message.content.some((part) => part.type === "toolCall"),
		),
		false,
	);
	const identityTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const rendered = renderSubagentResult(
		afterToolResult,
		{ expanded: false, isPartial: true } as never,
		identityTheme as never,
	)
		.render(120)
		.join("\n");
	assert.match(rendered, /echo stays visible/);
	assert.doesNotMatch(rendered, /\(running\.\.\.\)/);
});

test("renderSubagentResult keeps collapsed partial output dense and current", () => {
	const identityTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const partial = renderSubagentResult(
		{
			content: [],
			details: {
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{
						agent: "worker",
						agentSource: "built-in",
						task: "task",
						exitCode: 0,
						messages: [
							{
								role: "assistant",
								content: [
									...Array.from({ length: 12 }, () => ({ type: "text" as const, text: "" })),
									{
										type: "toolCall" as const,
										id: "latest",
										name: "bash",
										arguments: { command: "echo newest" },
									},
								],
							},
						],
						stderr: "",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 1,
						},
						actualProvider: "actual-provider",
						actualModel: "actual-model",
						thinkingLevel: "high",
					},
				],
			},
		} as never,
		{ expanded: false, isPartial: true } as never,
		identityTheme as never,
	)
		.render(120)
		.join("\n");
	assert.doesNotMatch(partial, /\n{2,}/);
	assert.match(partial, /echo newest/);
	assert.match(partial, /actual-provider\/actual-model/);
	assert.match(partial, /requested-thinking:high/);

	const empty = (isPartial: boolean) =>
		renderSubagentResult(
			{
				content: [],
				details: {
					mode: "single",
					agentScope: "user",
					projectAgentsDir: null,
					results: [
						{
							agent: "worker",
							agentSource: "built-in",
							task: "task",
							exitCode: 0,
							messages: [],
							stderr: "",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								contextTokens: 0,
								turns: 0,
							},
						},
					],
				},
			} as never,
			{ expanded: false, isPartial } as never,
			identityTheme as never,
		)
			.render(120)
			.join("\n");
	assert.match(empty(true), /\(running\.\.\.\)/);
	assert.match(empty(false), /\(no output\)/);
});

test("renderSubagentResult keeps partial views running and renders final-only previews", () => {
	const identityTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const result = (agent: string, finalOutput = "", exitCode = 0) => ({
		agent,
		agentSource: "built-in",
		task: `${agent} task`,
		exitCode,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		finalOutput,
	});
	const render = (details: unknown, isPartial: boolean, expanded = false) =>
		renderSubagentResult(
			{ content: [], details } as never,
			{ expanded, isPartial } as never,
			identityTheme as never,
		)
			.render(120)
			.join("\n");

	const singlePartial = render(
		{ mode: "single", agentScope: "user", projectAgentsDir: null, results: [result("single")] },
		true,
	);
	assert.match(singlePartial, /^⏳ single/);
	assert.doesNotMatch(singlePartial, /^✓/);

	const timedOutPartial = render(
		{
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				{
					...result("timed-out"),
					timedOut: true,
					stopReason: "timeout",
					errorMessage: "Subagent timed out after 1000ms",
				},
			],
		},
		true,
	);
	assert.match(timedOutPartial, /^✗ timed-out .*\[timeout\]/);
	assert.match(timedOutPartial, /Error: Subagent timed out after 1000ms/);
	assert.doesNotMatch(timedOutPartial, /\(running\.\.\.\)/);

	const timedOutResult = (agent: string, exitCode: number) => ({
		...result(agent, "", exitCode),
		timedOut: true,
		stopReason: "timeout",
		errorMessage: `${agent} timed out`,
	});
	const parallelTimeout = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("done"), timedOutResult("timed-task", -1)],
		},
		true,
	);
	assert.match(parallelTimeout, /timed-task ✗/);
	assert.match(parallelTimeout, /Error: timed-task timed out/);
	assert.doesNotMatch(parallelTimeout, /running/);

	const mixedParallel = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [timedOutResult("timed-task", -1), result("still-running", "", -1)],
		},
		true,
	);
	assert.match(mixedParallel, /^⏳ parallel 1\/2 done, 1 running/);
	assert.match(mixedParallel, /still-running ⏳/);

	const settlingParallel = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("done")],
		},
		true,
	);
	assert.match(settlingParallel, /^⏳ parallel 1\/1 done, running/);

	const fanInTimeout = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("done")],
			aggregator: timedOutResult("fan-in", 0),
		},
		true,
	);
	assert.match(fanInTimeout, /fan-in → fan-in ✗/);
	assert.match(fanInTimeout, /Error: fan-in timed out/);
	assert.doesNotMatch(fanInTimeout, /running/);

	const failedWithOutput = (agent: string) => ({
		...result(agent, `${agent.toUpperCase()}_PARTIAL`),
		stopReason: "error",
		errorMessage: `${agent} provider failed`,
	});
	const singleFailure = render(
		{
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [failedWithOutput("single-failed")],
		},
		true,
	);
	assert.match(singleFailure, /Error: single-failed provider failed/);
	assert.match(singleFailure, /SINGLE-FAILED_PARTIAL/);

	const chainTimeoutDetails = {
		mode: "chain",
		agentScope: "user",
		projectAgentsDir: null,
		results: [
			{
				...timedOutResult("chain-timeout", -1),
				step: 1,
				finalOutput: "CHAIN_TIMEOUT_PARTIAL",
			},
		],
	};
	for (const chainTimeout of [
		render(chainTimeoutDetails, true),
		render(chainTimeoutDetails, true, true),
	]) {
		assert.match(chainTimeout, /Error: chain-timeout timed out/);
		assert.match(chainTimeout, /CHAIN_TIMEOUT_PARTIAL/);
		assert.doesNotMatch(chainTimeout, /running/);
	}

	const parallelFailure = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [failedWithOutput("parallel-failed")],
		},
		true,
	);
	assert.match(parallelFailure, /Error: parallel-failed provider failed/);
	assert.match(parallelFailure, /PARALLEL-FAILED_PARTIAL/);

	const failedFanOutPendingFanIn = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [failedWithOutput("fan-out-failed")],
			aggregator: result("fan-in-pending", "", -1),
		},
		true,
	);
	assert.match(failedFanOutPendingFanIn, /^⏳ parallel 1\/1 done, fan-in running/);
	assert.doesNotMatch(failedFanOutPendingFanIn, /Total:/);

	const fanInFailure = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("done")],
			aggregator: failedWithOutput("fan-in-failed"),
		},
		true,
	);
	assert.match(fanInFailure, /Error: fan-in-failed provider failed/);
	assert.match(fanInFailure, /FAN-IN-FAILED_PARTIAL/);

	const chainPartial = render(
		{
			mode: "chain",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				{ ...result("first"), step: 1 },
				{ ...result("current"), step: 2 },
			],
		},
		true,
	);
	assert.match(chainPartial, /^⏳ chain 1\/2 steps/);
	assert.match(chainPartial, /Step 2: current ⏳/);

	const parallelPartial = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("done"), result("running", "", -1)],
		},
		true,
	);
	assert.match(parallelPartial, /^⏳ parallel 1\/2 done, 1 running/);
	assert.match(parallelPartial, /done ✓/);
	assert.match(parallelPartial, /running ⏳/);

	const fanInPartial = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("task")],
			aggregator: result("fan-in"),
		},
		true,
	);
	assert.match(fanInPartial, /^⏳ parallel 1\/1 done, fan-in running/);
	assert.match(fanInPartial, /fan-in → fan-in ⏳/);

	const withActivity = (agent: string, command: string) => ({
		...result(agent),
		recentActivity: [{ type: "toolCall" as const, name: "bash", args: { command } }],
		recentActivityTotal: 1,
	});
	const chainActivity = render(
		{
			mode: "chain",
			agentScope: "user",
			projectAgentsDir: null,
			results: [{ ...withActivity("chain", "echo chain activity"), step: 1 }],
		},
		false,
	);
	const parallelActivity = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [withActivity("parallel", "echo parallel activity")],
		},
		false,
	);
	const aggregatorActivity = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("task")],
			aggregator: withActivity("fan-in", "echo fan-in activity"),
		},
		false,
	);
	assert.match(chainActivity, /echo chain activity/);
	assert.match(parallelActivity, /echo parallel activity/);
	assert.match(aggregatorActivity, /echo fan-in activity/);

	const finalOnly = "FINAL_ONLY_1\nFINAL_ONLY_2\nFINAL_ONLY_3\nFINAL_ONLY_4";
	const chainFinal = render(
		{
			mode: "chain",
			agentScope: "user",
			projectAgentsDir: null,
			results: [{ ...result("chain", finalOnly), step: 1 }],
		},
		false,
	);
	const parallelFinal = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("parallel", finalOnly)],
		},
		false,
	);
	const aggregatorFinal = render(
		{
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [result("task")],
			aggregator: result("fan-in", finalOnly),
		},
		false,
	);
	for (const output of [chainFinal, parallelFinal, aggregatorFinal]) {
		assert.match(output, /FINAL_ONLY_1/);
		assert.match(output, /FINAL_ONLY_2/);
		assert.match(output, /FINAL_ONLY_3/);
		assert.doesNotMatch(output, /FINAL_ONLY_4/);
	}
});

test("terminateProcess escalates when a child ignores SIGTERM", {
	skip: process.platform === "win32",
}, async () => {
	const child = spawn(
		process.execPath,
		[
			"-e",
			"process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
		],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
	const started = Date.now();
	terminateProcess(child, 30);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("child did not exit")), 1000);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	assert.ok(Date.now() - started < 1000);
});

test("terminateProcess cleans a group whose leader exited before inherited stdout closed", {
	skip: process.platform === "win32",
}, async () => {
	const child = spawn(
		process.execPath,
		[
			"-e",
			"require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});process.stdout.write('descendant-ready\\\\n');setTimeout(()=>{},2000)\"],{stdio:['ignore','inherit','ignore']}).unref()",
		],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	const leaderExited = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("process-group leader did not exit")), 1000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.once("error", reject);
	});
	const descendantReady = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("process-group descendant did not start")),
			1000,
		);
		child.stdout?.once("data", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	await Promise.all([leaderExited, descendantReady]);

	const started = Date.now();
	terminateProcess(child, 30);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("descendant kept inherited stdout open")),
			3000,
		);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	assert.ok(Date.now() - started < 1000);
});
