import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import { ACTIVATION_ENTRY_TYPE, registerSessionSkills, STATUS_KEY } from "./extension.js";
import type {
	ResolvedSessionSkill,
	ResolveSessionSkillOptions,
	SkillResolverLike,
} from "./resolver.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type CommandDefinition = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
};

function createHarness(resolver: SkillResolverLike) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandDefinition>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, definition: CommandDefinition) {
			commands.set(name, definition);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	registerSessionSkills(pi, { resolver });
	return {
		commands,
		entries,
		async emit(event: string, payload: Record<string, unknown>, ctx: ExtensionContext) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? [])
				result = await handler(payload as never, ctx);
			return result;
		},
		async command(name: string, args: string, ctx: ExtensionCommandContext) {
			const command = commands.get(name);
			assert.ok(command, `missing command ${name}`);
			await command.handler(args, ctx);
		},
	};
}

function createContext(
	branch: SessionEntry[] = [],
	mode: ExtensionContext["mode"] = "tui",
	existingSkills: Array<{ name: string; baseDir: string; filePath: string }> = [],
) {
	let reloads = 0;
	const notifications: Array<[string, string | undefined]> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const sessionManager = {
		getBranch: () => branch,
	} as unknown as ExtensionContext["sessionManager"];
	const ctx = {
		cwd: "/work/project",
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		sessionManager,
		ui: {
			notify(message: string, level?: string) {
				notifications.push([message, level]);
			},
			setStatus(key: string, value?: string) {
				statuses.push([key, value]);
			},
		},
		getSystemPromptOptions: () => ({ skills: existingSkills }),
		reload: async () => {
			reloads++;
		},
	} as unknown as ExtensionCommandContext;
	return {
		ctx,
		notifications,
		statuses,
		sessionManager,
		get reloads() {
			return reloads;
		},
	};
}

async function createCachedSkill(cacheRoot: string, key: string, name: string): Promise<string> {
	const skillPath = join(cacheRoot, "entries", key, "skill");
	await mkdir(skillPath, { recursive: true });
	await writeFile(
		join(skillPath, "SKILL.md"),
		`---\nname: ${name}\ndescription: Test skill.\n---\n`,
	);
	return skillPath;
}

function snapshotEntry(skills: unknown[]): SessionEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: ACTIVATION_ENTRY_TYPE,
		data: { version: 1, skills },
	} as SessionEntry;
}

test("registers one session-skills command with status and route completions", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-session-skills-extension-"));
	temporaryPaths.push(cacheRoot);
	const resolver = { getCacheRoot: () => cacheRoot, resolve: async () => assert.fail("unused") };
	const harness = createHarness(resolver);
	assert.deepEqual([...harness.commands.keys()], ["session-skills"]);
	assert.deepEqual(harness.commands.get("session-skills")?.getArgumentCompletions?.("l"), [
		{ value: "load", label: "load" },
		{ value: "list", label: "list" },
	]);
	const current = createContext();
	await harness.emit("session_start", { reason: "startup" }, current.ctx);
	await harness.command("session-skills", "", current.ctx);
	assert.match(current.notifications.at(-1)?.[0] ?? "", /Session skills: none.*Usage:/s);
});

test("loads a remote skill, snapshots activation, and reloads exactly once", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-session-skills-load-"));
	temporaryPaths.push(cacheRoot);
	const skillPath = await createCachedSkill(cacheRoot, "demo", "demo-skill");
	let resolvedOptions: ResolveSessionSkillOptions | undefined;
	const resolver: SkillResolverLike = {
		getCacheRoot: () => cacheRoot,
		resolve: async (options) => {
			resolvedOptions = options;
			return {
				name: "demo-skill",
				path: skillPath,
				source: options.source.original,
				selector: options.selector,
				cacheHit: false,
			};
		},
	};
	const harness = createHarness(resolver);
	const current = createContext();
	await harness.emit("session_start", { reason: "startup" }, current.ctx);
	await harness.command("session-skills", "load owner/repo --skill demo-skill", current.ctx);

	assert.equal(resolvedOptions?.selector, "demo-skill");
	assert.equal(current.reloads, 1);
	assert.equal(harness.entries.length, 1);
	assert.equal(harness.entries[0].customType, ACTIVATION_ENTRY_TYPE);
	assert.deepEqual((harness.entries[0].data as { skills: unknown[] }).skills, [
		{
			name: "demo-skill",
			path: skillPath,
			source: "owner/repo",
			selector: "demo-skill",
		},
	]);
	assert.match(current.notifications[0][0], /full Pi permissions/);
	assert.deepEqual(current.statuses.at(-1), [STATUS_KEY, undefined]);

	await harness.command("session-skills", "load owner/repo --skill demo-skill", current.ctx);
	assert.equal(current.reloads, 1);
	assert.equal(harness.entries.length, 1);
	assert.match(current.notifications.at(-1)?.[0] ?? "", /already active/);
});

test("restores the newest root-to-leaf snapshot and keeps discovery stable", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-session-skills-restore-"));
	temporaryPaths.push(cacheRoot);
	const oldPath = await createCachedSkill(cacheRoot, "old", "old-skill");
	const newPath = await createCachedSkill(cacheRoot, "new", "new-skill");
	const resolver = { getCacheRoot: () => cacheRoot, resolve: async () => assert.fail("unused") };
	const harness = createHarness(resolver);
	const current = createContext([
		snapshotEntry([{ name: "old-skill", path: oldPath, source: "old/repo" }]),
		snapshotEntry([{ name: "new-skill", path: newPath, source: "new/repo" }]),
	]);

	await harness.emit("session_start", { reason: "resume" }, current.ctx);
	const first = await harness.emit("resources_discover", { reason: "startup" }, current.ctx);
	const second = await harness.emit("resources_discover", { reason: "reload" }, current.ctx);
	assert.deepEqual(first, { skillPaths: [newPath] });
	assert.deepEqual(second, first);
});

test("unloads a selected skill, snapshots the empty state, and completes known values", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-session-skills-unload-"));
	temporaryPaths.push(cacheRoot);
	const skillPath = await createCachedSkill(cacheRoot, "demo", "demo-skill");
	const resolver = { getCacheRoot: () => cacheRoot, resolve: async () => assert.fail("unused") };
	const harness = createHarness(resolver);
	const current = createContext([
		snapshotEntry([{ name: "demo-skill", path: skillPath, source: "owner/repo" }]),
	]);
	await harness.emit("session_start", { reason: "resume" }, current.ctx);
	assert.deepEqual(
		harness.commands.get("session-skills")?.getArgumentCompletions?.("unload demo"),
		[{ value: "unload demo-skill", label: "demo-skill" }],
	);

	await harness.command("session-skills", "unload demo-skill", current.ctx);
	assert.equal(current.reloads, 1);
	const snapshot = harness.entries.at(-1);
	assert.ok(snapshot);
	assert.deepEqual((snapshot.data as { skills: unknown[] }).skills, []);
});

test("unloads all active skills through the documented --all route", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-session-skills-unload-all-"));
	temporaryPaths.push(cacheRoot);
	const firstPath = await createCachedSkill(cacheRoot, "first", "first-skill");
	const secondPath = await createCachedSkill(cacheRoot, "second", "second-skill");
	const resolver = { getCacheRoot: () => cacheRoot, resolve: async () => assert.fail("unused") };
	const harness = createHarness(resolver);
	const current = createContext([
		snapshotEntry([
			{ name: "first-skill", path: firstPath, source: "owner/first" },
			{ name: "second-skill", path: secondPath, source: "owner/second" },
		]),
	]);
	await harness.emit("session_start", { reason: "fork" }, current.ctx);
	await harness.command("session-skills", "unload --all", current.ctx);
	const snapshot = harness.entries.at(-1);
	assert.ok(snapshot);
	assert.deepEqual((snapshot.data as { skills: unknown[] }).skills, []);
	assert.equal(current.reloads, 1);
});

test("rejects native skill collisions without changing activation", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-session-skills-collision-"));
	temporaryPaths.push(cacheRoot);
	const skillPath = await createCachedSkill(cacheRoot, "demo", "demo-skill");
	const resolver: SkillResolverLike = {
		getCacheRoot: () => cacheRoot,
		resolve: async (options): Promise<ResolvedSessionSkill> => ({
			name: "demo-skill",
			path: skillPath,
			source: options.source.original,
			cacheHit: false,
		}),
	};
	const harness = createHarness(resolver);
	const current = createContext([], "tui", [
		{ name: "demo-skill", baseDir: "/global/demo", filePath: "/global/demo/SKILL.md" },
	]);
	await harness.emit("session_start", { reason: "startup" }, current.ctx);
	await assert.rejects(
		() => harness.command("session-skills", "load owner/repo", current.ctx),
		/already provided/,
	);
	assert.equal(harness.entries.length, 0);
	assert.equal(current.reloads, 0);
});

test("shutdown aborts an in-flight resolver and clears owned status", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-session-skills-shutdown-"));
	temporaryPaths.push(cacheRoot);
	let started!: () => void;
	let released = false;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const resolver: SkillResolverLike = {
		getCacheRoot: () => cacheRoot,
		resolve: (options) =>
			new Promise((_resolve, reject) => {
				started();
				options.signal?.addEventListener(
					"abort",
					() => {
						queueMicrotask(() => {
							released = true;
							reject(new Error("cancelled"));
						});
					},
					{ once: true },
				);
			}),
	};
	const harness = createHarness(resolver);
	const current = createContext();
	await harness.emit("session_start", { reason: "startup" }, current.ctx);
	const command = harness.command("session-skills", "load owner/repo", current.ctx);
	await ready;
	await harness.emit("session_shutdown", { reason: "quit" }, current.ctx);
	assert.equal(released, true);
	await assert.rejects(() => command, /cancelled/);
	assert.deepEqual(current.statuses.at(-1), [STATUS_KEY, undefined]);
	assert.equal(harness.entries.length, 0);
});

test("commands reject unsupported modes and trailing arguments", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-session-skills-modes-"));
	temporaryPaths.push(cacheRoot);
	const resolver = { getCacheRoot: () => cacheRoot, resolve: async () => assert.fail("unused") };
	const harness = createHarness(resolver);
	const json = createContext([], "json");
	await harness.emit("session_start", { reason: "startup" }, json.ctx);
	await assert.rejects(
		() => harness.command("session-skills", "", json.ctx),
		/requires TUI or RPC/,
	);

	const tui = createContext();
	await harness.emit("session_start", { reason: "new" }, tui.ctx);
	await assert.rejects(
		() => harness.command("session-skills", "list extra", tui.ctx),
		/Usage: \/session-skills/,
	);
	await assert.rejects(
		() => harness.command("session-skills", "unload", tui.ctx),
		/Usage: \/session-skills/,
	);
});
