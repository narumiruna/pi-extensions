import assert from "node:assert/strict";
import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, test } from "vitest";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
	driveCustomSelector,
} from "../../../test/support.js";
import type { ManagedAgent } from "../src/registry.js";
import { applyStatefulLimitSetting } from "../src/stateful-limit-ui.js";
import { resolveStatefulLimits } from "../src/stateful-limits.js";
import subagents, { updateAgentToolsSetting } from "../src/subagents.js";
import { installSubagentsTestEnvironment, type SubagentTool } from "./subagents-test-helpers.js";

const restoreTestEnvironment = installSubagentsTestEnvironment();
afterAll(restoreTestEnvironment);

test("delegation workflow settings control the registered tool surface", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflows-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		const cases = [
			{
				name: "all delegation methods",
				settings: {},
				tools: [
					"subagent",
					"subagent_spawn",
					"subagent_send",
					"subagent_await",
					"subagent_manage",
					"subagent_mailbox",
					"subagent_inspect",
					"subagent_consult",
				],
				forbiddenPromptText: undefined,
			},
			{
				name: "async only",
				settings: { blocking: { enabled: false }, stateful: { enabled: true } },
				tools: [
					"subagent_spawn",
					"subagent_send",
					"subagent_manage",
					"subagent_mailbox",
					"subagent_inspect",
				],
				forbiddenPromptText: /blocking subagent|subagent_consult/i,
			},
			{
				name: "blocking only",
				settings: { blocking: { enabled: true }, stateful: { enabled: false } },
				tools: ["subagent", "subagent_inspect", "subagent_consult"],
				forbiddenPromptText: /subagent_(?:spawn|send|await|manage|mailbox)/i,
			},
			{
				name: "disabled",
				settings: { blocking: { enabled: false }, stateful: { enabled: false } },
				tools: ["subagent_inspect"],
				forbiddenPromptText:
					/blocking subagent|subagent_(?:spawn|send|await|manage|mailbox|consult)/i,
			},
		] as const;
		for (const scenario of cases) {
			writeFileSync(settingsPath, JSON.stringify(scenario.settings));
			const mock = createMockPi();
			subagents(mock.pi);
			assert.deepEqual(
				mock.tools.map((tool) => tool.name),
				scenario.tools,
				scenario.name,
			);
			assert.ok(mock.commands.has("subagents"), `${scenario.name} keeps recovery commands`);
			const promptMetadata = mock.tools
				.flatMap((tool) => [
					tool.promptSnippet,
					...(Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : []),
				])
				.filter((value): value is string => typeof value === "string")
				.join("\n");
			if (scenario.forbiddenPromptText) {
				assert.doesNotMatch(promptMetadata, scenario.forbiddenPromptText, scenario.name);
			}
			if (scenario.name === "async only") {
				const spawnGuidance = mock.tools.find(
					(tool) => tool.name === "subagent_spawn",
				)?.promptGuidelines;
				assert.ok(Array.isArray(spawnGuidance));
				const guidance = spawnGuidance.join("\n");
				assert.doesNotMatch(guidance, /blocking subagent/i);
				assert.match(guidance, /identify.*non-overlapping.*main-agent work/i);
				assert.match(guidance, /immediately continue.*identified.*local task/i);
				assert.match(guidance, /supported.*integration path/i);
				assert.match(
					guidance,
					/without concurrent main-agent work.*specialist model.*tool profile.*isolation/i,
				);
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("disabled stateful settings do not advertise unavailable lifecycle tools", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-guidance-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		writeFileSync(
			path.join(directory, "pi-subagents.json"),
			JSON.stringify({ stateful: { enabled: false } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			["subagent", "subagent_inspect", "subagent_consult"],
		);
		const blockingTool = mock.tools[0];
		assert.doesNotMatch(String(blockingTool?.description), /subagent_spawn/i);
		assert.doesNotMatch(
			Array.isArray(blockingTool?.promptGuidelines) ? blockingTool.promptGuidelines.join("\n") : "",
			/subagent_spawn/i,
		);
		assert.equal(mock.commands.has("subagents:agents"), false);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const renders: string[][] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const driven = driveCustomSelector(factory, ["\u001b"], 60);
				renders.push(...driven.renders);
				return driven.result;
			},
		});
		await command.handler("", context.ctx);
		assert.match(
			renders.flat().join("\n"),
			/How subagents run: Compatibility blocking methods \(sync\)/,
		);
		await command.handler("help", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /Start here/);
		assert.match(context.notifications.at(-1)?.message ?? "", /workflow.*tools.*blocking/i);
		assert.doesNotMatch(context.notifications.at(-1)?.message ?? "", /Recommended/i);
		assert.doesNotMatch(context.notifications.at(-1)?.message ?? "", /Usage path:/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("runtime settings validate, save, and immediately apply the blocking worker limit", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-limit-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ future: true, blocking: { futureBlocking: "keep" } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);

		let applyCall = 0;
		const applyFrames: string[] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				const frame = stripVTControlCharacters(harness.render().join("\n"));
				applyFrames.push(frame);
				if (applyCall === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (applyCall === 1) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (applyCall === 2) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (applyCall === 3) {
					assert.match(frame, /Blocking Worker Limit/);
					assert.match(frame, /Current: 8/);
					harness.setFocused(true);
					harness.handleInput("3");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else {
					assert.match(frame, /Blocking worker limit/);
					harness.handleInput("\u0003");
				}
				applyCall++;
				return harness.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(applyCall, 5, applyFrames.join("\n---\n"));
		assert.ok(
			applyFrames.flatMap((frame) => frame.split("\n")).every((line) => visibleWidth(line) <= 60),
		);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			blocking: { futureBlocking: "keep", maxParallelTasks: 3 },
		});
		assert.match(context.notifications.at(-1)?.message ?? "", /saved and applied.*3/i);
		const refreshedBlocking = mock.tools.filter((tool) => tool.name === "subagent");
		assert.equal(refreshedBlocking.length, 1);
		assert.match(String(refreshedBlocking[0]?.description), /session-guidance message/i);
		assert.doesNotMatch(
			`${String(refreshedBlocking[0]?.description)}\n${String(refreshedBlocking[0]?.promptGuidelines)}`,
			/configured max 3/i,
		);
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /blocking worker limit: 3/i);

		writeFileSync(
			settingsPath,
			JSON.stringify({ future: true, blocking: { futureBlocking: "keep", maxParallelTasks: 2 } }),
		);
		let staleCall = 0;
		const staleContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				if (staleCall === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (staleCall === 1) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (staleCall === 2) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (staleCall === 3) {
					harness.setFocused(true);
					harness.handleInput("3");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else {
					harness.handleInput("\u0003");
				}
				staleCall++;
				return harness.result;
			},
		});
		await command.handler("", staleContext.ctx);
		assert.equal(staleCall, 5);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			blocking: { futureBlocking: "keep", maxParallelTasks: 3 },
		});

		const savedDocument = readFileSync(settingsPath, "utf8");
		let invalidCall = 0;
		const invalidContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				if (invalidCall === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (invalidCall === 1) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (invalidCall === 2) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (invalidCall === 3) {
					harness.setFocused(true);
					harness.handleInput("0");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
					assert.match(stripVTControlCharacters(harness.render().join("\n")), /0/);
					harness.handleInput("tui.select.cancel");
					await harness.resultPromise;
				} else {
					harness.handleInput("\u0003");
				}
				invalidCall++;
				return harness.result;
			},
		});
		await command.handler("", invalidContext.ctx);
		assert.equal(invalidCall, 5);
		assert.match(
			invalidContext.notifications.at(-1)?.message ?? "",
			/blocking worker limit.*whole number from 1 to 64/i,
		);
		assert.equal(readFileSync(settingsPath, "utf8"), savedDocument);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detached-limit UI saves several startup limits without mutating the current runtime", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-detached-limit-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ future: true, stateful: { futureStateful: "keep" } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const frames: string[] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 64);
				const frame = stripVTControlCharacters(harness.render().join("\n"));
				frames.push(frame);
				if (call === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 1) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 2) {
					for (let index = 0; index < 2; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 3) {
					assert.match(frame, /Background Agent Limits/);
					assert.match(frame, /Subagents saved for follow-up/);
					for (const label of [
						"Subagents working at once",
						"Direct children per subagent",
						"Nested subagent levels",
						"Stored subagent records",
					]) {
						assert.match(frame, new RegExp(label));
					}
					harness.handleInput("tui.select.confirm");
				} else if (call === 4) {
					assert.match(frame, /Current session: 16/);
					harness.setFocused(true);
					harness.handleInput("20");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else if (call === 5) {
					assert.match(frame, /Subagents saved for follow-up/);
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 6) {
					assert.match(frame, /Current session: 4/);
					harness.setFocused(true);
					harness.handleInput("6");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else if (call === 7) {
					assert.match(frame, /Subagents saved for follow-up/);
					assert.match(frame, /Subagents working at once/);
					harness.handleInput("tui.select.cancel");
				} else if (call === 8) {
					assert.match(frame, /Advanced Runtime Settings/);
					harness.handleInput("tui.select.cancel");
				} else if (call === 9) {
					assert.match(frame, /Subagent Settings/);
					harness.handleInput("tui.select.cancel");
				} else {
					assert.match(
						frame,
						/After \/reload: subagents saved for follow-up 20.*subagents\s+working at once 6/s,
					);
					harness.handleInput("\u0003");
				}
				call++;
				return harness.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 11, frames.join("\n---\n"));
		assert.ok(
			frames.flatMap((frame) => frame.split("\n")).every((line) => visibleWidth(line) <= 64),
		);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			stateful: { futureStateful: "keep", maxAgents: 20, maxActiveTurns: 6 },
		});
		assert.match(context.notifications.at(-1)?.message ?? "", /applies after \/reload/i);

		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /background-agent limits: 16 saved/i);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/configured subagents saved for follow-up: 20/i,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detached-limit lowering cancellation and stale previews leave settings unchanged", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-detached-preview-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const controller = new AbortController();
		const agents: ManagedAgent[] = [
			{
				id: "older",
				agent: "explorer",
				rootId: "older",
				depth: 0,
				children: [],
				state: "idle",
				createdAt: 1,
				updatedAt: 1,
				cwd: process.cwd(),
				history: [],
				mailbox: [],
			},
			{
				id: "newer",
				agent: "reviewer",
				rootId: "newer",
				depth: 0,
				children: [],
				state: "idle",
				createdAt: 2,
				updatedAt: 2,
				cwd: process.cwd(),
				history: [],
				mailbox: [],
			},
		];
		const runtime = {
			getRuntimeStatus: () => ({
				enabled: true,
				initialized: true,
				transport: "subprocess" as const,
				completionDelivery: "next-turn" as const,
				limits: resolveStatefulLimits(),
				activeAgents: 0,
				retainedAgents: agents.length,
			}),
			listAgents: () => [...agents],
		};
		const invalid = createMockContext({ mode: "tui", hasUI: true });
		assert.deepEqual(
			await applyStatefulLimitSetting("maxDepth", "-1", invalid.ctx, runtime, {
				signal: controller.signal,
				isCurrent: () => true,
			}),
			{ kind: "rejected" },
		);
		assert.match(invalid.notifications.at(-1)?.message ?? "", /whole number.*0 or greater/i);
		assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);

		let preview = "";
		const cancelled = createMockContext({
			mode: "tui",
			hasUI: true,
			confirm: async (_title: string, message: string) => {
				preview = message;
				return false;
			},
		});
		assert.deepEqual(
			await applyStatefulLimitSetting("maxAgents", "1", cancelled.ctx, runtime, {
				signal: controller.signal,
				isCurrent: () => true,
			}),
			{ kind: "rejected" },
		);
		assert.match(preview, /exclude 1 saved subagent record/i);
		assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);

		const stale = createMockContext({
			mode: "tui",
			hasUI: true,
			confirm: async () => {
				agents.push({ ...agents[0], id: "changed", rootId: "changed", updatedAt: 3 });
				return true;
			},
		});
		assert.deepEqual(
			await applyStatefulLimitSetting("maxAgents", "1", stale.ctx, runtime, {
				signal: controller.signal,
				isCurrent: () => true,
			}),
			{ kind: "rejected" },
		);
		assert.match(stale.notifications.at(-1)?.message ?? "", /agents changed.*review/i);
		assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);

		const replacedController = new AbortController();
		let current = true;
		const replaced = createMockContext({
			mode: "tui",
			hasUI: true,
			confirm: async () => {
				current = false;
				replacedController.abort();
				return true;
			},
		});
		assert.deepEqual(
			await applyStatefulLimitSetting("maxAgents", "1", replaced.ctx, runtime, {
				signal: replacedController.signal,
				isCurrent: () => current,
			}),
			{ kind: "close" },
		);
		assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detached-limit previews depth and stored-record reductions", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-detached-preview-fields-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const root: ManagedAgent = {
			id: "root",
			agent: "explorer",
			rootId: "root",
			depth: 0,
			children: ["child"],
			state: "idle",
			createdAt: 1,
			updatedAt: 1,
			cwd: process.cwd(),
			history: [],
			mailbox: [],
		};
		const child: ManagedAgent = {
			...root,
			id: "child",
			rootId: "root",
			parentId: "root",
			depth: 1,
			children: [],
			updatedAt: 3,
		};
		const other: ManagedAgent = {
			...root,
			id: "other",
			rootId: "other",
			children: [],
			updatedAt: 2,
		};
		for (const [field, value, agents] of [
			["maxDepth", "0", [root, child]],
			["maxStoredAgents", "1", [root, other]],
		] as const) {
			let preview = "";
			const context = createMockContext({
				mode: "tui",
				hasUI: true,
				confirm: async (_title: string, message: string) => {
					preview = message;
					return false;
				},
			});
			const runtime = {
				getRuntimeStatus: () => ({
					enabled: true,
					initialized: true,
					transport: "subprocess" as const,
					completionDelivery: "next-turn" as const,
					limits: resolveStatefulLimits(),
					activeAgents: 0,
					retainedAgents: agents.length,
				}),
				listAgents: () => [...agents],
			};
			assert.deepEqual(
				await applyStatefulLimitSetting(field, value, context.ctx, runtime, {
					signal: new AbortController().signal,
					isCurrent: () => true,
				}),
				{ kind: "rejected" },
			);
			assert.match(preview, /exclude 1 saved subagent record/i);
			assert.equal(existsSync(path.join(directory, "pi-subagents.json")), false);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detached-limit save failure preserves the previous configured value", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-detached-save-failure-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const settingsPath = path.join(directory, "pi-subagents.json");
	writeFileSync(settingsPath, "{}\n");
	const originalRenameSync = fs.renameSync;
	try {
		fs.renameSync = (() => {
			throw new Error("rename unavailable");
		}) as typeof fs.renameSync;
		syncBuiltinESMExports();
		const context = createMockContext({ mode: "tui", hasUI: true });
		const runtime = {
			getRuntimeStatus: () => ({
				enabled: true,
				initialized: true,
				transport: "subprocess" as const,
				completionDelivery: "next-turn" as const,
				limits: resolveStatefulLimits(),
				activeAgents: 0,
				retainedAgents: 0,
			}),
			listAgents: () => [],
		};
		assert.deepEqual(
			await applyStatefulLimitSetting("maxAgents", "20", context.ctx, runtime, {
				signal: new AbortController().signal,
				isCurrent: () => true,
			}),
			{ kind: "rejected" },
		);
		assert.equal(readFileSync(settingsPath, "utf8"), "{}\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /not saved.*unchanged/i);
	} finally {
		fs.renameSync = originalRenameSync;
		syncBuiltinESMExports();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("parallel-limit UI keeps the runtime unchanged after a settings save failure", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-limit-failure-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalRenameSync = fs.renameSync;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		fs.renameSync = (() => {
			throw new Error("rename unavailable");
		}) as typeof fs.renameSync;
		syncBuiltinESMExports();
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				if (call === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 1) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 2) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 3) {
					harness.setFocused(true);
					harness.handleInput("4");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
					assert.match(stripVTControlCharacters(harness.render().join("\n")), /4/);
					harness.handleInput("\u0003");
					await harness.resultPromise;
				} else {
					harness.handleInput("\u0003");
				}
				call++;
				return harness.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 4);
		assert.match(context.notifications.at(-1)?.message ?? "", /were not saved/i);
		const blocking = mock.tools.filter((tool) => tool.name === "subagent");
		assert.equal(blocking.length, 1);
		assert.match(String(blocking[0]?.description), /session-guidance message/i);
	} finally {
		fs.renameSync = originalRenameSync;
		syncBuiltinESMExports();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("parallel-limit UI applies runtime changes without re-registering tools", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-limit-runtime-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		const blocking = mock.tools.find((tool) => tool.name === "subagent") as SubagentTool;
		assert.ok(blocking);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				if (call === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 1) {
					for (let index = 0; index < 3; index++) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 2) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (call === 3) {
					harness.setFocused(true);
					harness.handleInput("4");
					harness.handleInput("tui.input.submit");
					await harness.waitForPending();
				} else {
					harness.handleInput("\u0003");
				}
				call++;
				return harness.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 5);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			blocking: { maxParallelTasks: 4 },
		});
		assert.match(context.notifications.at(-1)?.message ?? "", /saved and applied.*4/i);
		assert.equal(mock.tools.filter((tool) => tool.name === "subagent").length, 1);
		await assert.rejects(
			() =>
				blocking.execute(
					"runtime-limit",
					{
						tasks: Array.from({ length: 5 }, (_, index) => ({
							agent: "missing",
							task: `task ${index + 1}`,
						})),
					},
					undefined,
					undefined,
					createMockContext().ctx,
				),
			/configured max is 4/i,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI preserves unknown JSON and applies completion delivery immediately", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ futureOption: true, stateful: { futureStatefulOption: "keep" } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const initialSpawnGuidance = mock.tools.find(
			(tool) => tool.name === "subagent_spawn",
		)?.promptGuidelines;
		assert.ok(Array.isArray(initialSpawnGuidance));
		assert.match(initialSpawnGuidance.join("\n"), /session-guidance/i);
		assert.match(initialSpawnGuidance.join("\n"), /next-turn.*auto-resume/i);
		let customCalls = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (customCalls === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (customCalls === 1) {
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					harness.handleInput("tui.select.cancel");
				} else if (customCalls === 3) {
					harness.handleInput("tui.select.confirm");
				} else if (customCalls === 4) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					harness.handleInput("tui.select.cancel");
				} else {
					harness.handleInput("\u0003");
				}
				customCalls++;
				return harness.result;
			},
		});
		for (const handler of mock.events.get("session_start") ?? []) {
			await handler({ reason: "new" }, context.ctx);
		}
		await command.handler("settings", context.ctx);
		assert.equal(customCalls, 3);
		const spawnRegistrations = mock.tools.filter((tool) => tool.name === "subagent_spawn");
		assert.equal(spawnRegistrations.length, 1);
		const updatedSpawnGuidance = spawnRegistrations[0]?.promptGuidelines;
		assert.deepEqual(updatedSpawnGuidance, initialSpawnGuidance);
		assert.deepEqual(mock.sentMessages.at(-1)?.options, {
			deliverAs: "nextTurn",
			triggerTurn: false,
		});
		assert.match(
			String((mock.sentMessages.at(-1)?.message as { content?: unknown } | undefined)?.content),
			/"completionDelivery":"auto-resume"/u,
		);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			futureOption: true,
			stateful: {
				futureStatefulOption: "keep",
				completionDelivery: "auto-resume",
			},
		});
		updateAgentToolsSetting("explorer", ["read"]);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			futureOption: true,
			stateful: {
				futureStatefulOption: "keep",
				completionDelivery: "auto-resume",
			},
			agents: { explorer: { tools: ["read"] } },
		});
		await command.handler("status", context.ctx);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/When work finishes: Continue automatically when work finishes/,
		);
		assert.match(context.notifications.at(-1)?.message ?? "", /User Settings/);

		await command.handler("settings", context.ctx);
		assert.equal(customCalls, 6);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			futureOption: true,
			stateful: {
				futureStatefulOption: "keep",
				completionDelivery: "auto-resume",
			},
			agents: { explorer: { tools: ["read"] } },
			consult: { resources: "none" },
		});
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /No project resources/);
		const consultRegistrations = mock.tools.filter((tool) => tool.name === "subagent_consult");
		assert.equal(consultRegistrations.length, 1);
		assert.match(String(consultRegistrations[0]?.description), /session-guidance message/i);
		assert.doesNotMatch(String(consultRegistrations[0]?.description), /resources: none/i);
		assert.match(
			String((mock.sentMessages.at(-1)?.message as { content?: unknown } | undefined)?.content),
			/"consultResourcePolicy":"none"/u,
		);

		const nonTui = createMockContext({
			mode: "json",
			hasUI: true,
			custom: async () => {
				throw new Error("custom UI must not open");
			},
		});
		await command.handler("settings", nonTui.ctx);
		assert.match(nonTui.notifications[0]?.message ?? "", /Edit settings manually/);
		for (const handler of mock.events.get("session_shutdown") ?? []) {
			await handler({ reason: "quit" }, context.ctx);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI explicitly enables local-only usage recording", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-usage-settings-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, JSON.stringify({ future: true }));
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let rendered = "";
		let customCalls = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 90);
				rendered += stripVTControlCharacters(harness.render().join("\n"));
				if (customCalls === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (customCalls === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					harness.handleInput("tui.select.cancel");
				} else {
					harness.handleInput("\u0003");
				}
				customCalls++;
				return harness.result;
			},
		});
		await command.handler("settings", context.ctx);
		assert.match(rendered, /Local usage recording/);
		assert.match(rendered, /content-free.*30 days/i);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			usageRecording: { enabled: true },
		});
		assert.match(context.notifications.at(-1)?.message ?? "", /local.*recording enabled/i);
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /Local usage recording: enabled/i);
		assert.match(context.notifications.at(-1)?.message ?? "", /Usage retention: 30 days/i);
		assert.ok(existsSync(path.join(directory, "pi-subagents-usage")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI exposes and immediately applies both cwd policies", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cwd-settings-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		let rendered = "";
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 90);
				rendered += stripVTControlCharacters(harness.render().join("\n"));
				if (call === 0 || call === 3) {
					harness.handleInput("tui.select.confirm");
				} else if (call === 1 || call === 4) {
					if (call === 4) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					harness.handleInput("tui.select.cancel");
				} else {
					harness.handleInput("\u0003");
				}
				call++;
				return harness.result;
			},
		});
		await command.handler("settings", context.ctx);
		await command.handler("settings", context.ctx);
		assert.match(rendered, /Where read-only consultations can start/);
		assert.match(rendered, /Where subagents can start/);
		assert.match(rendered, /Resources for trusted read-only consultations/);
		assert.doesNotMatch(rendered, /When background work finishes/);
		assert.match(rendered, /do not restrict files.*shell commands.*network access/i);
		assert.match(rendered, /Pi \/trust/);
		assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "pi-subagents.json"), "utf8")), {
			cwdPolicy: {
				consultation: "current-workspace",
				delegation: "current-workspace",
			},
		});
		const blockingDescription = mock.tools
			.filter((tool) => tool.name === "subagent")
			.at(-1)?.description;
		const spawnDescription = mock.tools
			.filter((tool) => tool.name === "subagent_spawn")
			.at(-1)?.description;
		const consultDescription = mock.tools
			.filter((tool) => tool.name === "subagent_consult")
			.at(-1)?.description;
		for (const description of [blockingDescription, spawnDescription, consultDescription]) {
			assert.match(String(description), /session-guidance message/i);
			assert.doesNotMatch(String(description), /target policy: current-workspace/i);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI rolls back after an atomic save failure", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-rollback-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (call === 0) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else {
					rmSync(settingsPath);
					mkdirSync(settingsPath);
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					harness.handleInput("\u0003");
				}
				call++;
				return harness.result;
			},
		});
		await command.handler("settings", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /were not saved/i);
		await command.handler("status", context.ctx);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/When work finishes: Wait for my next message/,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});
