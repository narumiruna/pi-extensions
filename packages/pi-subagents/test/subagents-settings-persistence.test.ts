import assert from "node:assert/strict";
import fs, {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { discoverAgents } from "../src/agents.js";
import { consumeSubagentSettingsNotice } from "../src/settings.js";
import subagents, {
	inspectCompletionDeliverySettings,
	inspectDelegationWorkflowSettings,
	normalizeSubagentSettings,
	readSubagentSettings,
	saveSubagentConfig,
	updateAgentToolsSetting,
	updateBlockingMaxParallelTasksSetting,
	updateCompletionDeliverySetting,
	updateDelegationWorkflowSetting,
	updateStatefulLimitSetting,
} from "../src/subagents.js";
import { installSubagentsTestEnvironment } from "./subagents-test-helpers.js";

const restoreTestEnvironment = installSubagentsTestEnvironment();
afterAll(restoreTestEnvironment);

test("subagent settings normalize known override fields only", () => {
	assert.deepEqual(
		normalizeSubagentSettings({
			blocking: { enabled: false },
			stateful: { enabled: true },
			agents: {
				explorer: { tools: ["read"], model: null, timeoutMs: 1, thinkingLevel: "medium" },
				clearThinking: { thinkingLevel: null },
				bad: { tools: [1] },
				badThinking: { thinkingLevel: "huge" },
				badTimeout: { timeoutMs: 2_147_483_648 },
			},
		}),
		{
			agents: {
				explorer: { tools: ["read"], model: null, timeoutMs: 1, thinkingLevel: "medium" },
				clearThinking: { thinkingLevel: null },
			},
			blocking: { enabled: false },
			stateful: { enabled: true },
		},
	);
	assert.equal(normalizeSubagentSettings({ blocking: { enabled: "no" } }), undefined);
	assert.equal(normalizeSubagentSettings({ blocking: false }), undefined);
	assert.equal(normalizeSubagentSettings({ agents: [] }), undefined);
});

test("legacy scout agent overrides apply to explorer without overriding conflicts", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-scout-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				agents: {
					scout: {
						tools: ["read"],
						model: "legacy-model",
						thinkingLevel: "medium",
						timeoutMs: 1234,
					},
				},
			}),
		);

		const migrated = discoverAgents(directory, "user", readSubagentSettings()).agents.find(
			(agent) => agent.name === "explorer",
		);
		assert.deepEqual(migrated?.tools, ["read"]);
		assert.equal(migrated?.model, "legacy-model");
		assert.equal(migrated?.thinkingLevel, "medium");
		assert.equal(migrated?.timeoutMs, 1234);

		writeFileSync(
			settingsPath,
			JSON.stringify({
				agents: {
					explorer: { tools: ["grep"] },
					scout: { tools: ["read"] },
				},
			}),
		);
		const explicit = discoverAgents(directory, "user", readSubagentSettings()).agents.find(
			(agent) => agent.name === "explorer",
		);
		assert.deepEqual(explicit?.tools, ["grep"]);

		const agentsDir = path.join(directory, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			path.join(agentsDir, "scout.md"),
			"---\nname: scout\ndescription: Custom scout\ntools: bash\n---\nCustom scout.",
		);
		writeFileSync(settingsPath, JSON.stringify({ agents: { scout: { tools: ["read"] } } }));
		const withCustomScout = discoverAgents(directory, "user", readSubagentSettings()).agents;
		assert.deepEqual(withCustomScout.find((agent) => agent.name === "scout")?.tools, ["read"]);
		assert.deepEqual(withCustomScout.find((agent) => agent.name === "explorer")?.tools, [
			"read",
			"grep",
			"find",
			"ls",
		]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("session start re-reads settings before reporting warnings", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-session-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				cwdPolicy: {
					consultation: "current-workspace",
					delegation: "current-workspace",
				},
				consult: { resources: "none" },
			}),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		writeFileSync(settingsPath, "{ malformed");
		const context = createMockContext({ mode: "tui", hasUI: true });
		for (const handler of mock.events.get("session_start") ?? []) {
			await handler({}, context.ctx);
		}
		assert.match(context.notifications[0]?.message ?? "", /pi-subagents\.json is invalid/i);
		let guidance = "";
		for (const handler of mock.events.get("before_agent_start") ?? []) {
			const result = (await handler({ prompt: "continue", systemPrompt: "base" }, context.ctx)) as
				| { message?: { customType?: string; content?: string } }
				| undefined;
			if (result?.message?.customType === "pi-subagents-session-guidance") {
				guidance = result.message.content ?? "";
			}
		}
		assert.match(guidance, /"consultationCwdPolicy":"current-workspace"/u);
		assert.match(guidance, /"delegationCwdPolicy":"current-workspace"/u);
		assert.match(guidance, /"consultResourcePolicy":"none"/u);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /No project resources/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent status separates runtime cwd policy from manual configured edits", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-status-cwd-drift-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				cwdPolicy: {
					consultation: "current-workspace",
					delegation: "current-workspace",
				},
			}),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		writeFileSync(
			settingsPath,
			JSON.stringify({
				cwdPolicy: { consultation: "anywhere", delegation: "trusted-targets" },
			}),
		);
		const context = createMockContext({ mode: "tui", hasUI: true });
		const command = mock.commands.get("subagents");
		assert.ok(command);
		await command.handler("status", context.ctx);
		const message = context.notifications.at(-1)?.message ?? "";
		assert.match(
			message,
			/Current Session[\s\S]*Read-only consultation folders: This workspace only/,
		);
		assert.match(message, /Current Session[\s\S]*Subagent folders: This workspace only/);
		assert.match(
			message,
			/User Settings[\s\S]*Configured consultation target: Any folder .* no project resources when untrusted/,
		);
		assert.match(
			message,
			/User Settings[\s\S]*Configured delegation target: This workspace or saved-trusted folders/,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings read legacy files and save to the canonical package filename", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const legacyPath = path.join(directory, "pi-subagents-config.json");
		const canonicalPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			legacyPath,
			JSON.stringify({
				agents: { explorer: { tools: ["read"] } },
				blocking: { enabled: false },
				stateful: { completionDelivery: "auto-resume" },
				futureOption: true,
			}),
		);
		assert.deepEqual(inspectDelegationWorkflowSettings(), {
			path: legacyPath,
			value: "async-only",
			source: "user settings",
		});
		assert.deepEqual(inspectCompletionDeliverySettings(), {
			path: legacyPath,
			value: "auto-resume",
			source: "user settings",
		});
		const migrationMock = createMockPi();
		subagents(migrationMock.pi);
		assert.equal(existsSync(canonicalPath), false);
		assert.deepEqual(JSON.parse(readFileSync(legacyPath, "utf8")), {
			agents: { explorer: { tools: ["read"] } },
			blocking: { enabled: false },
			stateful: { completionDelivery: "auto-resume" },
			futureOption: true,
		});
		const migrationContext = createMockContext();
		for (const handler of migrationMock.events.get("session_start") ?? []) {
			await handler({}, migrationContext.ctx);
		}
		assert.match(migrationContext.notifications[0]?.message ?? "", /using legacy/i);

		writeFileSync(legacyPath, JSON.stringify({ agents: { explorer: { tools: ["bash"] } } }));
		writeFileSync(canonicalPath, JSON.stringify({ agents: { explorer: { tools: ["read"] } } }));
		assert.deepEqual(readSubagentSettings(), { agents: { explorer: { tools: ["read"] } } });
		assert.deepEqual(inspectDelegationWorkflowSettings(), {
			path: canonicalPath,
			value: "all",
			source: "default",
		});
		assert.equal(inspectCompletionDeliverySettings().path, canonicalPath);
		assert.equal(existsSync(legacyPath), true);

		writeFileSync(canonicalPath, "invalid");
		assert.equal(readSubagentSettings(), undefined);
		assert.equal(inspectDelegationWorkflowSettings().path, canonicalPath);
		assert.match(inspectDelegationWorkflowSettings().error ?? "", /JSON/i);
		assert.equal(readFileSync(legacyPath, "utf8").includes("bash"), true);
		unlinkSync(legacyPath);
		writeFileSync(canonicalPath, JSON.stringify({ agents: { explorer: { tools: ["read"] } } }));
		assert.deepEqual(readSubagentSettings(), { agents: { explorer: { tools: ["read"] } } });
		assert.equal(consumeSubagentSettingsNotice(), undefined);
		unlinkSync(canonicalPath);
		writeFileSync(legacyPath, "invalid");
		assert.equal(readSubagentSettings(), undefined);
		assert.equal(existsSync(canonicalPath), false);

		writeFileSync(legacyPath, JSON.stringify({ agents: { explorer: { tools: ["read"] } } }));
		symlinkSync("missing-target", canonicalPath);
		assert.deepEqual(readSubagentSettings(), { agents: { explorer: { tools: ["read"] } } });
		assert.equal(existsSync(legacyPath), true);

		saveSubagentConfig({ stateful: { enabled: false } });
		assert.equal(lstatSync(canonicalPath).isSymbolicLink(), false);
		assert.equal(existsSync(path.join(directory, "missing-target")), false);
		assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), {
			stateful: { enabled: false },
		});
		const ignoredMock = createMockPi();
		subagents(ignoredMock.pi);
		const ignoredContext = createMockContext();
		for (const handler of ignoredMock.events.get("session_start") ?? []) {
			await handler({}, ignoredContext.ctx);
		}
		assert.match(ignoredContext.notifications[0]?.message ?? "", /ignored/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings loaders recheck canonical paths after legacy reads", () => {
	const loaders = [
		{
			name: "runtime",
			load: () => readSubagentSettings()?.blocking?.enabled,
			expected: true,
			expectNotice: true,
		},
		{
			name: "inspector",
			load: () => inspectDelegationWorkflowSettings().value,
			expected: "all",
			expectNotice: false,
		},
	] as const;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const loader of loaders) {
			const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-legacy-read-race-"));
			process.env.PI_CODING_AGENT_DIR = directory;
			try {
				const legacyPath = path.join(directory, "pi-subagents-config.json");
				const canonicalPath = path.join(directory, "pi-subagents.json");
				writeFileSync(legacyPath, JSON.stringify({ blocking: { enabled: false } }));

				const originalReadFileSync = fs.readFileSync;
				let createCanonical = true;
				fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
					const result = originalReadFileSync(...args);
					if (createCanonical && path.resolve(String(args[0])) === legacyPath) {
						createCanonical = false;
						writeFileSync(canonicalPath, JSON.stringify({ blocking: { enabled: true } }));
					}
					return result;
				}) as typeof fs.readFileSync;
				syncBuiltinESMExports();
				try {
					assert.equal(loader.load(), loader.expected, loader.name);
					const notice = consumeSubagentSettingsNotice();
					if (loader.expectNotice) assert.match(notice ?? "", /ignored.*created concurrently/i);
					else assert.equal(notice, undefined);
				} finally {
					fs.readFileSync = originalReadFileSync;
					syncBuiltinESMExports();
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("first subagent settings publication renames a complete temporary inside the mutation lock", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-first-publication-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const settingsPath = path.join(directory, "pi-subagents.json");
	const expected = { stateful: { enabled: false }, future: true };
	const originalRenameSync = fs.renameSync;
	let publicationObserved = false;
	fs.renameSync = ((source, destination) => {
		if (path.resolve(String(destination)) === settingsPath) {
			publicationObserved = true;
			assert.deepEqual(JSON.parse(readFileSync(source, "utf8")), expected);
			assert.equal(lstatSync(`${settingsPath}.mutation-lock`).isDirectory(), true);
		}
		return originalRenameSync(source, destination);
	}) as typeof fs.renameSync;
	syncBuiltinESMExports();
	try {
		saveSubagentConfig(expected);
		assert.equal(publicationObserved, true);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), expected);
	} finally {
		fs.renameSync = originalRenameSync;
		syncBuiltinESMExports();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent setting controls seed canonical updates from the active legacy document", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-legacy-update-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const legacyPath = path.join(directory, "pi-subagents-config.json");
		const canonicalPath = path.join(directory, "pi-subagents.json");
		const legacy = {
			future: { retained: true },
			blocking: { enabled: false, futureBlocking: 1 },
			stateful: { completionDelivery: "auto-resume", futureStateful: 2 },
		};
		writeFileSync(legacyPath, JSON.stringify(legacy));

		updateCompletionDeliverySetting("next-turn");

		assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), {
			...legacy,
			stateful: { ...legacy.stateful, completionDelivery: "next-turn" },
		});
		assert.deepEqual(JSON.parse(readFileSync(legacyPath, "utf8")), legacy);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("legacy-seeded updates preserve canonical settings created before publication", () => {
	const updates = [
		["completion delivery", () => updateCompletionDeliverySetting("next-turn")],
		["delegation workflow", () => updateDelegationWorkflowSetting("async-only")],
		["blocking parallel limit", () => updateBlockingMaxParallelTasksSetting(4)],
		["detached limit", () => updateStatefulLimitSetting("maxAgents", 4)],
		["agent tools", () => updateAgentToolsSetting("explorer", ["read"])],
	] as const;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const [name, update] of updates) {
			const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-legacy-race-"));
			process.env.PI_CODING_AGENT_DIR = directory;
			try {
				const legacyPath = path.join(directory, "pi-subagents-config.json");
				const canonicalPath = path.join(directory, "pi-subagents.json");
				const legacy = { stateful: { completionDelivery: "auto-resume" }, legacyOnly: true };
				const concurrent = { stateful: { completionDelivery: "auto-resume" }, concurrent: true };
				writeFileSync(legacyPath, JSON.stringify(legacy));

				const originalWriteFileSync = fs.writeFileSync;
				let createCanonical = true;
				fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
					const result = originalWriteFileSync(...args);
					const writtenPath = path.resolve(String(args[0]));
					if (
						createCanonical &&
						path.dirname(writtenPath) === path.resolve(directory) &&
						path.basename(writtenPath).startsWith(".pi-subagents.json.")
					) {
						createCanonical = false;
						originalWriteFileSync(canonicalPath, JSON.stringify(concurrent));
					}
					return result;
				}) as typeof fs.writeFileSync;
				syncBuiltinESMExports();
				try {
					assert.throws(
						update,
						/created concurrently.*reopen settings and retry/i,
						`${name} should reject the raced-in canonical file`,
					);
				} finally {
					fs.writeFileSync = originalWriteFileSync;
					syncBuiltinESMExports();
				}

				assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), concurrent);
				assert.deepEqual(JSON.parse(readFileSync(legacyPath, "utf8")), legacy);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("delegation workflow inspection and updates preserve unknown settings", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflow-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		assert.deepEqual(inspectDelegationWorkflowSettings(), {
			path: path.join(directory, "pi-subagents.json"),
			value: "all",
			source: "default",
		});
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				future: true,
				blocking: { futureBlocking: 1 },
				stateful: { futureStateful: 2 },
			}),
		);
		updateDelegationWorkflowSetting("async-only");
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			future: true,
			blocking: { futureBlocking: 1, enabled: false },
			stateful: { futureStateful: 2, enabled: true },
		});
		assert.deepEqual(inspectDelegationWorkflowSettings(), {
			path: settingsPath,
			value: "async-only",
			source: "user settings",
		});
		updateDelegationWorkflowSetting("blocking-only");
		assert.equal(inspectDelegationWorkflowSettings().value, "blocking-only");
		updateDelegationWorkflowSetting("all");
		assert.equal(inspectDelegationWorkflowSettings().value, "all");
		writeFileSync(settingsPath, "invalid");
		const malformed = inspectDelegationWorkflowSettings();
		assert.equal(malformed.value, "all");
		assert.match(malformed.error ?? "", /Unexpected token|JSON/i);
		assert.throws(() => updateDelegationWorkflowSetting("async-only"), /Cannot update malformed/);
		assert.equal(readFileSync(settingsPath, "utf8"), "invalid");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("completion delivery inspection rejects malformed settings without overwriting them", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-completion-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		assert.deepEqual(inspectCompletionDeliverySettings(), {
			path: path.join(directory, "pi-subagents.json"),
			value: "next-turn",
			source: "default",
		});
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{ malformed");
		assert.match(inspectCompletionDeliverySettings().error ?? "", /JSON|position|property/i);
		assert.throws(() => updateCompletionDeliverySetting("auto-resume"), /Cannot update malformed/);
		assert.equal(readFileSync(settingsPath, "utf8"), "{ malformed");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("agent tool patches preserve prototype-like names as data", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-tools-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		updateAgentToolsSetting("__proto__", ["read"]);
		const raw = JSON.parse(readFileSync(path.join(directory, "pi-subagents.json"), "utf8"));
		assert.equal(Object.hasOwn(raw.agents, "__proto__"), true);
		assert.deepEqual(Object.getOwnPropertyDescriptor(raw.agents, "__proto__")?.value, {
			tools: ["read"],
		});
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});
