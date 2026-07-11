import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { createMockContext, createMockPi } from "../../../test/support.js";
import sync, {
	addTopLevelCaseVariantDeletes,
	appliedFileHashMap,
	backupLocal,
	canPullRemoteSessionsOnFirstSync,
	canPullRemoteSettingsOnFirstSync,
	collectFiles,
	completeSyncArguments,
	encodeKey,
	filterSnapshotForConfigPolicy,
	hasRemoteChanges,
	isCloudflareR2Endpoint,
	isDeniedPath,
	isEnabled,
	isExplicitlyEnabled,
	loadConfig,
	mergeRemotePreservedFiles,
	mergeRemoteSessionFiles,
	parseOptions,
	posixJoin,
	preflightSnapshotApply,
	protectSnapshotApplyPlan,
	safeJoin,
	safeName,
	scanSnapshot,
	sessionTokenWarnings,
	settingsHashesMatchState,
	settingsHashMap,
	snapshotWithoutSessions,
	splitArgs,
} from "../src/sync.js";

test("sync registers pisync command and session lifecycle hooks", () => {
	const mock = createMockPi();
	sync(mock.pi);

	assert.ok(mock.commands.has("pisync"));
	assert.equal(typeof mock.commands.get("pisync")?.getArgumentCompletions, "function");
	assert.deepEqual([...mock.events.keys()].sort(), ["session_shutdown", "session_start"]);
});

test("completeSyncArguments suggests commands and useful flags", () => {
	assert.deepEqual(
		completeSyncArguments("")?.map((item) => item.label),
		[
			"help",
			"init",
			"config",
			"status",
			"diff",
			"doctor",
			"push",
			"pull",
			"sync",
			"history",
			"rollback",
			"unlock",
		],
	);
	assert.deepEqual(
		completeSyncArguments("pu")?.map((item) => item.value),
		["push", "pull"],
	);
	assert.deepEqual(
		completeSyncArguments("push ")?.map((item) => item.value),
		["push --yes", "push -y", "push --force"],
	);
	assert.deepEqual(
		completeSyncArguments("pull --f")?.map((item) => item.value),
		["pull --force"],
	);
	assert.deepEqual(
		completeSyncArguments("sync -")?.map((item) => item.value),
		["sync --yes", "sync -y", "sync --force"],
	);
	assert.deepEqual(
		completeSyncArguments("push --yes --f")?.map((item) => item.value),
		["push --yes --force"],
	);
	assert.deepEqual(
		completeSyncArguments("rollback 2026-06-22 --y")?.map((item) => item.value),
		["rollback 2026-06-22 --yes"],
	);
	assert.deepEqual(
		completeSyncArguments("unlock --s")?.map((item) => item.value),
		["unlock --stale"],
	);
	assert.equal(completeSyncArguments("status "), null);
	assert.equal(completeSyncArguments("push snapshot"), null);
	assert.equal(completeSyncArguments("wat"), null);
});

test("syncSessions config defaults off and supports file plus env overrides", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "pi-sync.local.json"),
			JSON.stringify({ ...requiredConfig(), syncSessions: true }),
		);

		await withEnv({}, async () => {
			assert.equal((await loadConfig()).syncSessions, true);
		});
		await withEnv({ PI_SYNC_SESSIONS: "false" }, async () => {
			assert.equal((await loadConfig()).syncSessions, false);
		});
		await withEnv({ PI_SYNC_SESSIONS: "" }, async () => {
			assert.equal((await loadConfig()).syncSessions, false);
		});
		await withEnv({ PI_SYNC_SESSIONS: "tru" }, async () => {
			assert.equal((await loadConfig()).syncSessions, false);
		});
		await withEnv({ PI_SYNC_SESSIONS: "yes" }, async () => {
			assert.equal((await loadConfig()).syncSessions, true);
		});

		rmSync(path.join(agentDir, "pi-sync.local.json"));
		writeFileSync(
			path.join(agentDir, "pi-sync.local.json"),
			JSON.stringify({ ...requiredConfig(), extraFiles: "APPEND_SYSTEM.md" }),
		);
		await withEnv({}, async () => {
			assert.deepEqual((await loadConfig()).extraFiles, []);
		});
		writeFileSync(
			path.join(agentDir, "pi-sync.local.json"),
			JSON.stringify({
				...requiredConfig(),
				extraFiles: [
					"LOCAL.md",
					"LOCAL.md",
					"local.md",
					"skills/demo.md",
					"nested\\x",
					"skills",
					"SESSIONS",
					"settings.json",
					"Settings.json",
					"AGENTS.md",
					"append_system.md",
					".",
					"..",
					".git",
					"node_modules",
					".pisync",
					".env",
					"pi-sync.local.json",
					"secret.txt",
					"token.json",
					1,
					"",
				],
			}),
		);
		await withEnv({}, async () => {
			assert.deepEqual((await loadConfig()).extraFiles, ["LOCAL.md"]);
		});

		const customAgentDir = path.join(agentDir, "custom-agent");
		mkdirSync(customAgentDir, { recursive: true });
		writeFileSync(
			path.join(customAgentDir, "pi-sync.local.json"),
			JSON.stringify({ ...requiredConfig(), profile: "custom" }),
		);
		await withEnv({ PI_CODING_AGENT_DIR: customAgentDir }, async () => {
			assert.equal((await loadConfig()).profile, "custom");
		});

		const tildeAgentDir = path.join(path.dirname(agentDir), "agent-tilde");
		mkdirSync(tildeAgentDir, { recursive: true });
		writeFileSync(
			path.join(tildeAgentDir, "pi-sync.local.json"),
			JSON.stringify({ ...requiredConfig(), profile: "tilde" }),
		);
		await withEnv({ PI_CODING_AGENT_DIR: "~/.pi/agent-tilde" }, async () => {
			assert.equal((await loadConfig()).profile, "tilde");
		});

		rmSync(path.join(agentDir, "pi-sync.local.json"));
		writeFileSync(path.join(agentDir, "pi-sync.local.json"), JSON.stringify(requiredConfig()));
		await withEnv({}, async () => {
			assert.equal((await loadConfig()).syncSessions, false);
		});
	});
});

test("pisync config output reports session sync and privacy warning", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "pi-sync.local.json"),
			JSON.stringify({ ...requiredConfig(), syncSessions: true }),
		);
		const mock = createMockPi();
		sync(mock.pi);
		const { ctx, notifications } = createMockContext();

		await withEnv({}, async () => {
			await mock.commands.get("pisync")?.handler("config", ctx);
		});

		assert.match(notifications[0]?.message ?? "", /syncSessions: enabled/);
		assert.match(notifications[0]?.message ?? "", /session JSONL can contain/);
	});
});

test("argument and option helpers parse quoted command lines", () => {
	assert.deepEqual(splitArgs("push --yes 'snapshot one' \"two words\""), [
		"push",
		"--yes",
		"snapshot one",
		"two words",
	]);
	assert.deepEqual(parseOptions(["--yes", "--force", "snapshot-id"]), {
		yes: true,
		force: true,
		stale: false,
		silent: false,
		reload: true,
		auto: false,
		args: ["snapshot-id"],
	});
});

test("path and key helpers normalize safe names and reject escapes", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-test-"));
	assert.equal(safeJoin(root, "skills/demo.md"), path.join(root, "skills", "demo.md"));
	assert.equal(
		safeJoin(root, path.join(root, "skills/demo.md")),
		path.join(root, "skills/demo.md"),
	);
	assert.throws(() => safeJoin(root, "../escape"), /Unsafe path/);
	assert.equal(isDeniedPath("skills/.env.local"), true);
	assert.equal(isDeniedPath(".git"), true);
	assert.equal(isDeniedPath("node_modules"), true);
	assert.equal(isDeniedPath(".pisync"), true);
	assert.equal(isDeniedPath("skills/demo.md"), false);
	assert.equal(encodeKey("a b/c+d"), "a%20b/c%2Bd");
	assert.equal(posixJoin("/prefix/", "profile", "/latest.json"), "prefix/profile/latest.json");
	assert.equal(safeName("team/prod"), "team_prod");
});

test("snapshot collection includes session jsonl files only when enabled", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-collect-"));
	mkdirSync(path.join(root, "skills"), { recursive: true });
	mkdirSync(path.join(root, "sessions", "--project--"), { recursive: true });
	mkdirSync(path.join(root, "sessions", "token-project"), { recursive: true });
	writeFileSync(path.join(root, "APPEND_SYSTEM.md"), "append\n");
	writeFileSync(path.join(root, "LOCAL.md"), "local\n");
	writeFileSync(path.join(root, "local-case.md"), "local case\n");
	writeFileSync(path.join(root, "settings.json"), "{}\n");
	writeFileSync(path.join(root, "skills", "demo.md"), "demo\n");
	if (path.sep === "/") writeFileSync(path.join(root, "skills", "foo\\bar.md"), "skip\n");
	writeFileSync(path.join(root, "sessions", "--project--", "session.jsonl"), "{}\n");
	writeFileSync(path.join(root, "sessions", "--project--", "notes.txt"), "skip\n");
	writeFileSync(path.join(root, "sessions", "token-project", "session.jsonl"), "skip\n");
	const customSessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-sync-sessions-"));
	writeFileSync(path.join(customSessionDir, "custom.jsonl"), "{}\n");

	assert.deepEqual(
		(await collectFiles(root)).map((file) => file.path),
		["APPEND_SYSTEM.md", "settings.json", "skills/demo.md"],
	);
	const caseRoot = mkdtempSync(path.join(os.tmpdir(), "pi-sync-collect-case-"));
	writeFileSync(path.join(caseRoot, "append_system.md"), "append\n");
	assert.deepEqual(
		(await collectFiles(caseRoot)).map((file) => file.path),
		["APPEND_SYSTEM.md"],
	);
	assert.deepEqual(
		(await collectFiles(root, { extraFiles: ["LOCAL.md"] })).map((file) => file.path),
		["APPEND_SYSTEM.md", "LOCAL.md", "settings.json", "skills/demo.md"],
	);
	assert.deepEqual(
		(await collectFiles(root, { extraFiles: ["LOCAL-CASE.md"] })).map((file) => file.path),
		["APPEND_SYSTEM.md", "LOCAL-CASE.md", "settings.json", "skills/demo.md"],
	);
	writeFileSync(path.join(root, "LOCAL-CASE.md"), "local exact case\n");
	if (readdirSync(root).includes("LOCAL-CASE.md")) {
		const exactCaseFiles = await collectFiles(root, { extraFiles: ["LOCAL-CASE.md"] });
		assert.deepEqual(
			exactCaseFiles.map((file) => file.path),
			["APPEND_SYSTEM.md", "LOCAL-CASE.md", "settings.json", "skills/demo.md"],
		);
		assert.equal(
			Buffer.from(
				exactCaseFiles.find((file) => file.path === "LOCAL-CASE.md")?.contentBase64 ?? "",
				"base64",
			).toString("utf8"),
			"local exact case\n",
		);
	}
	assert.deepEqual(
		(await collectFiles(root, { syncSessions: true })).map((file) => file.path),
		["APPEND_SYSTEM.md", "sessions/--project--/session.jsonl", "settings.json", "skills/demo.md"],
	);
	assert.deepEqual(
		(await collectFiles(root, { syncSessions: true, sessionDir: customSessionDir })).map(
			(file) => file.path,
		),
		["APPEND_SYSTEM.md", "sessions/custom.jsonl", "settings.json", "skills/demo.md"],
	);
	const nestedSessionDir = path.join(root, "sessions", "work");
	mkdirSync(nestedSessionDir, { recursive: true });
	writeFileSync(path.join(nestedSessionDir, "nested.jsonl"), "{}\n");
	assert.deepEqual(
		(await collectFiles(root, { syncSessions: true, sessionDir: nestedSessionDir })).map(
			(file) => file.path,
		),
		["APPEND_SYSTEM.md", "sessions/nested.jsonl", "settings.json", "skills/demo.md"],
	);
});

test("snapshot preflight validates checksums, duplicate session paths, and deletes stale files", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-apply-"));
	const content = Buffer.from("hello");
	const remote = snapshot([{ path: "settings.json", content }]);
	const current = snapshot([
		{ path: "settings.json", content },
		{ path: "sessions/--project--/old.jsonl", content: Buffer.from("old") },
	]);

	const plan = preflightSnapshotApply(root, remote, current);
	assert.deepEqual(
		plan.writes.map((item) => item.target),
		[path.join(root, "settings.json")],
	);
	assert.deepEqual(plan.deletes, [path.join(root, "sessions", "--project--", "old.jsonl")]);
	assert.throws(
		() => preflightSnapshotApply(root, snapshot([{ path: "../bad", content }]), current),
		/Unsafe path/,
	);
	assert.throws(
		() => preflightSnapshotApply(root, snapshot([{ path: ".", content }]), current),
		/Unsafe path/,
	);
	assert.throws(
		() => preflightSnapshotApply(root, snapshot([{ path: "..", content }]), current),
		/Unsafe path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(root, snapshot([{ path: "sessions\\bad.jsonl", content }]), current),
		/Unsafe path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				snapshot([{ path: "sessions/../settings.json", content }]),
				current,
			),
		/Unsafe path/,
	);
	assert.throws(
		() => preflightSnapshotApply(root, snapshot([{ path: ".env", content }]), current),
		/Unsafe path/,
	);
	const sessionSnapshot = snapshot([{ path: "sessions/--project--/session.jsonl", content }]);
	const customSessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-sync-session-apply-"));
	assert.deepEqual(
		preflightSnapshotApply(root, sessionSnapshot, snapshot([]), {
			sessionDir: customSessionDir,
		}).writes.map((item) => item.target),
		[path.join(customSessionDir, "--project--", "session.jsonl")],
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				{ ...sessionSnapshot, files: [sessionSnapshot.files[0], sessionSnapshot.files[0]] },
				current,
			),
		/Duplicate path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				{
					...sessionSnapshot,
					files: [{ ...sessionSnapshot.files[0], sha256: "bad" }],
				},
				current,
			),
		/Checksum mismatch/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				snapshot([{ path: "sessions/--project--/notes.txt", content }]),
				current,
			),
		/Unsafe session path/,
	);
});

test("snapshot apply deletes stale top-level case variants", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-apply-case-"));
	writeFileSync(path.join(root, "append_system.md"), "old\n");
	const remote = snapshot([{ path: "APPEND_SYSTEM.md", content: Buffer.from("new\n") }]);
	const current = snapshot([{ path: "APPEND_SYSTEM.md", content: Buffer.from("old\n") }]);
	const plan = preflightSnapshotApply(root, remote, current);
	assert.deepEqual(plan.deletes, []);

	const withCaseDeletes = await addTopLevelCaseVariantDeletes(root, plan, remote);
	assert.deepEqual(withCaseDeletes.deletes, [path.join(root, "append_system.md")]);

	const directoryRoot = mkdtempSync(path.join(os.tmpdir(), "pi-sync-apply-case-dir-"));
	mkdirSync(path.join(directoryRoot, "append_system.md"));
	const directoryPlan = preflightSnapshotApply(directoryRoot, remote, current);
	const withoutDirectoryDelete = await addTopLevelCaseVariantDeletes(
		directoryRoot,
		directoryPlan,
		remote,
	);
	assert.deepEqual(withoutDirectoryDelete.deletes, []);
});

test("unconfigured extra top-level files are filtered locally and preserved on upload", () => {
	const settings = { path: "settings.json", content: Buffer.from("settings") };
	const custom = { path: "LOCAL.md", content: Buffer.from("custom") };
	const configured = { path: "CONFIGURED.md", content: Buffer.from("configured") };
	const session = { path: "sessions/--project--/session.jsonl", content: Buffer.from("session") };
	const unsafeSession = { path: "sessions/../evil.jsonl", content: Buffer.from("evil") };
	const reservedExtra = { path: "skills", content: Buffer.from("reserved") };
	const builtInCaseExtra = { path: "Settings.json", content: Buffer.from("duplicate") };
	const remote = {
		...snapshot([
			custom,
			configured,
			session,
			unsafeSession,
			reservedExtra,
			builtInCaseExtra,
			settings,
		]),
		syncSessions: true,
	};
	const config = {
		...requiredConfig(),
		region: "auto",
		profile: "default",
		prefix: "pi-sync",
		syncSessions: false,
		extraFiles: ["CONFIGURED.md"],
	};

	const filtered = filterSnapshotForConfigPolicy(remote, config);
	assert.deepEqual(filtered.files.map((file) => file.path).sort(), [
		"CONFIGURED.md",
		"settings.json",
	]);
	assert.deepEqual(
		filterSnapshotForConfigPolicy(
			snapshot([{ path: "append_system.md", content: Buffer.from("append") }]),
			config,
		).files.map((file) => file.path),
		["APPEND_SYSTEM.md"],
	);
	assert.notEqual(
		filterSnapshotForConfigPolicy(remote, config, { regenerateId: true }).id,
		remote.id,
	);
	assert.deepEqual(
		filterSnapshotForConfigPolicy(remote, { ...config, syncSessions: true })
			.files.map((file) => file.path)
			.sort(),
		["CONFIGURED.md", "sessions/--project--/session.jsonl", "settings.json"],
	);
	const lowerCaseRemoteExtra = filterSnapshotForConfigPolicy(
		snapshot([{ path: "local.md", content: Buffer.from("local") }]),
		{
			...config,
			extraFiles: ["LOCAL.md"],
		},
	);
	assert.deepEqual(
		lowerCaseRemoteExtra.files.map((file) => file.path),
		["LOCAL.md"],
	);
	assert.equal(
		hasRemoteChanges(
			lowerCaseRemoteExtra,
			{
				version: 1,
				profile: "default",
				lastAppliedSnapshot: lowerCaseRemoteExtra.id,
				lastFileHashes: Object.fromEntries(
					snapshot([{ path: "local.md", content: Buffer.from("local") }]).files.map((file) => [
						file.path,
						file.sha256,
					]),
				),
				extraFiles: ["LOCAL.md"],
			},
			{ ...config, extraFiles: ["LOCAL.md"] },
		),
		false,
	);
	assert.deepEqual(
		mergeRemotePreservedFiles(snapshot([settings]), remote, config).files.map((file) => file.path),
		["LOCAL.md", "sessions/--project--/session.jsonl", "settings.json"],
	);
	assert.deepEqual(
		mergeRemotePreservedFiles(snapshot([settings]), remote, {
			...config,
			extraFiles: ["CONFIGURED.md", "LOCAL.md"],
		}).files.map((file) => file.path),
		["sessions/--project--/session.jsonl", "settings.json"],
	);
	assert.deepEqual(
		mergeRemotePreservedFiles(
			snapshot([settings, { path: "local.md", content: Buffer.from("local") }]),
			remote,
			config,
		).files.map((file) => file.path),
		["local.md", "sessions/--project--/session.jsonl", "settings.json"],
	);
	assert.equal(
		hasRemoteChanges(
			filtered,
			{
				version: 1,
				profile: "default",
				lastAppliedSnapshot: remote.id,
				lastFileHashes: Object.fromEntries(
					snapshot([settings]).files.map((file) => [file.path, file.sha256]),
				),
				extraFiles: [],
			},
			config,
		),
		true,
	);
});

test("settings-only uploads preserve remote session files", () => {
	const settings = { path: "settings.json", content: Buffer.from("local") };
	const remoteSession = {
		path: "sessions/--project--/session.jsonl",
		content: Buffer.from("remote"),
	};
	const invalidSession = {
		path: "sessions/--project--/notes.txt",
		content: Buffer.from("skip"),
	};
	const deniedSession = {
		path: "sessions/--project--/token.jsonl",
		content: Buffer.from("skip"),
	};
	const local = snapshot([settings]);

	const merged = mergeRemoteSessionFiles(
		local,
		snapshot([remoteSession, invalidSession, deniedSession]),
	);

	assert.notEqual(merged.id, local.id);
	assert.deepEqual(
		merged.files.map((file) => file.path),
		["sessions/--project--/session.jsonl", "settings.json"],
	);
	assert.equal(merged.syncSessions, true);

	const emptySessionSet = mergeRemoteSessionFiles(local, { ...snapshot([]), syncSessions: true });
	assert.notEqual(emptySessionSet.id, local.id);
	assert.deepEqual(
		emptySessionSet.files.map((file) => file.path),
		["settings.json"],
	);
	assert.equal(emptySessionSet.syncSessions, true);
});

test("settings hash maps ignore session differences for first sync checks", () => {
	const local = snapshot([
		{ path: "settings.json", content: Buffer.from("settings") },
		{ path: "sessions/--project--/local.jsonl", content: Buffer.from("local") },
	]);
	const remote = snapshot([
		{ path: "settings.json", content: Buffer.from("settings") },
		{ path: "sessions/--project--/remote.jsonl", content: Buffer.from("remote") },
	]);

	assert.deepEqual(settingsHashMap(local), settingsHashMap(remote));
	const state = {
		version: 1,
		profile: "default",
		lastAppliedSnapshot: "old",
		lastFileHashes: Object.fromEntries(local.files.map((file) => [file.path, file.sha256])),
	};
	const config = {
		...requiredConfig(),
		region: "auto",
		profile: "default",
		prefix: "pi-sync",
		syncSessions: false,
	};

	assert.equal(settingsHashesMatchState(remote, state), true);
	assert.equal(hasRemoteChanges(remote, state, config), false);
	assert.equal(hasRemoteChanges(remote, state, { ...config, syncSessions: true }), true);
	assert.equal(
		hasRemoteChanges(
			snapshot([{ path: "settings.json", content: Buffer.from("changed") }]),
			state,
			config,
		),
		true,
	);
});

test("first sync only auto-pulls remote files when local files are not at risk", () => {
	const settings = { path: "settings.json", content: Buffer.from("settings") };
	const appendSystem = { path: "APPEND_SYSTEM.md", content: Buffer.from("append") };
	const changedSettings = { path: "settings.json", content: Buffer.from("changed") };
	const remoteOnly = snapshot([
		{ path: "sessions/--project--/remote.jsonl", content: Buffer.from("r") },
	]);
	const shared = { path: "sessions/--project--/shared.jsonl", content: Buffer.from("same") };
	const changed = { path: "sessions/--project--/shared.jsonl", content: Buffer.from("changed") };

	assert.equal(
		canPullRemoteSettingsOnFirstSync(snapshot([settings]), snapshot([settings, appendSystem])),
		true,
	);
	assert.equal(
		canPullRemoteSettingsOnFirstSync(snapshot([settings]), snapshot([changedSettings])),
		false,
	);
	assert.equal(
		canPullRemoteSettingsOnFirstSync(snapshot([appendSystem]), snapshot([settings])),
		false,
	);
	assert.equal(canPullRemoteSessionsOnFirstSync(snapshot([]), remoteOnly), true);
	assert.equal(canPullRemoteSessionsOnFirstSync(snapshot([shared]), snapshot([shared])), true);
	assert.equal(canPullRemoteSessionsOnFirstSync(snapshot([shared]), remoteOnly), false);
	assert.equal(canPullRemoteSessionsOnFirstSync(snapshot([changed]), snapshot([shared])), false);
});

test("snapshotWithoutSessions clears session opt-in even when no session files exist", () => {
	const source = {
		...snapshot([{ path: "settings.json", content: Buffer.from("{}") }]),
		syncSessions: true,
	};
	const filtered = snapshotWithoutSessions(source);

	assert.equal(filtered.syncSessions, false);
	assert.notEqual(filtered.id, source.id);
	assert.deepEqual(
		filtered.files.map((file) => file.path),
		["settings.json"],
	);
});

test("protected session apply plans keep the live session file", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-protect-"));
	const live = path.join(root, "sessions", "--project--", "live.jsonl");
	const old = path.join(root, "sessions", "--project--", "old.jsonl");
	const plan = protectSnapshotApplyPlan(
		root,
		{
			writes: [
				{ target: live, content: Buffer.from("remote") },
				{ target: path.join(root, "settings.json"), content: Buffer.from("{}") },
			],
			deletes: [live, old],
		},
		new Set(["sessions/--project--/live.jsonl"]),
	);

	assert.deepEqual(
		plan.writes.map((item) => item.target),
		[path.join(root, "settings.json")],
	);
	assert.deepEqual(plan.deletes, [old]);

	const current = snapshot([
		{ path: "sessions/--project--/live.jsonl", content: Buffer.from("local") },
		{ path: "sessions/--project--/old.jsonl", content: Buffer.from("old") },
	]);
	const remote = snapshot([
		{ path: "settings.json", content: Buffer.from("{}") },
		{ path: "sessions/--project--/live.jsonl", content: Buffer.from("remote") },
	]);
	const hashes = appliedFileHashMap(remote, current, new Set(["sessions/--project--/live.jsonl"]));

	assert.equal(
		hashes["sessions/--project--/live.jsonl"],
		current.files.find((file) => file.path === "sessions/--project--/live.jsonl")?.sha256,
	);
	assert.equal(
		hashes["settings.json"],
		remote.files.find((file) => file.path === "settings.json")?.sha256,
	);
	const config = {
		...requiredConfig(),
		region: "auto",
		profile: "default",
		prefix: "pi-sync",
		syncSessions: true,
	};
	const protectedState = {
		version: 1,
		profile: "default",
		lastAppliedSnapshot: remote.id,
		lastFileHashes: hashes,
		syncSessions: true,
		extraFiles: [],
	};
	assert.equal(hasRemoteChanges(remote, protectedState, config), false);

	const advancedRemote = { ...remote, id: "advanced" };
	assert.equal(hasRemoteChanges(advancedRemote, protectedState, config), true);
	assert.equal(
		hasRemoteChanges(
			advancedRemote,
			protectedState,
			config,
			new Set(["sessions/--project--/live.jsonl"]),
		),
		false,
	);
});

test("session backups include session jsonl files when enabled", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(path.join(agentDir, "sessions", "--project--"), { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
		writeFileSync(path.join(agentDir, "sessions", "--project--", "session.jsonl"), "{}\n");

		const backupPath = await backupLocal("default", { syncSessions: true });
		const backup = JSON.parse(gunzipSync(readFileSync(backupPath)).toString("utf8"));

		assert.ok(
			backup.files.some(
				(file: { path: string }) => file.path === "sessions/--project--/session.jsonl",
			),
		);
	});
});

test("snapshot backups expand a tilde-configured agent directory", async () => {
	await withTempHome(async (defaultAgentDir) => {
		const home = path.resolve(defaultAgentDir, "../../");
		const tildeAgentDir = path.join(home, ".pi", "agent-tilde");
		mkdirSync(tildeAgentDir, { recursive: true });
		writeFileSync(path.join(tildeAgentDir, "settings.json"), '{"tilde":true}\n');

		await withEnv({ PI_CODING_AGENT_DIR: "~/.pi/agent-tilde" }, async () => {
			const backupPath = await backupLocal("tilde");
			const backup = JSON.parse(gunzipSync(readFileSync(backupPath)).toString("utf8"));
			assert.ok(backup.files.some((file: { path: string }) => file.path === "settings.json"));
			assert.equal(backupPath.startsWith(tildeAgentDir), true);
		});
	});
});

test("session backups honor the configured session directory fallback", async () => {
	await withTempHome(async (agentDir) => {
		const sessionDir = path.join(path.dirname(agentDir), "custom-sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(path.join(sessionDir, "--project--"), { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir })}\n`);
		writeFileSync(path.join(sessionDir, "--project--", "configured.jsonl"), "{}\n");

		const backupPath = await backupLocal("configured", { syncSessions: true });
		const backup = JSON.parse(gunzipSync(readFileSync(backupPath)).toString("utf8"));
		assert.ok(
			backup.files.some(
				(file: { path: string }) => file.path === "sessions/--project--/configured.jsonl",
			),
		);
	});
});

test("security and configuration helpers detect secrets and R2 session-token warnings", () => {
	const secret = Buffer.from("FIRECRAWL_API_KEY=sk-12345678901234567890");
	assert.deepEqual(scanSnapshot(snapshot([{ path: "settings.json", content: secret }])), [
		"settings.json",
	]);
	assert.equal(isCloudflareR2Endpoint("https://abc.r2.cloudflarestorage.com"), true);
	assert.equal(isCloudflareR2Endpoint("https://s3.amazonaws.com"), false);
	assert.equal(
		sessionTokenWarnings({ endpoint: "https://abc.r2.cloudflarestorage.com", sessionToken: "x" })
			.length,
		1,
	);
	assert.equal(isEnabled("off", true), false);
	assert.equal(isEnabled(undefined, true), true);
	assert.equal(isExplicitlyEnabled("true"), true);
	assert.equal(isExplicitlyEnabled("tru"), false);
	assert.equal(isExplicitlyEnabled(""), false);
});

function snapshot(files: Array<{ path: string; content: Buffer }>) {
	return {
		version: 1,
		id: "snap",
		createdAt: "2026-01-01T00:00:00.000Z",
		machine: "test",
		profile: "default",
		files: files.map((file) => ({
			path: file.path,
			contentBase64: file.content.toString("base64"),
			sha256: createHash("sha256").update(file.content).digest("hex"),
		})),
	};
}

function requiredConfig() {
	return {
		endpoint: "https://example.r2.cloudflarestorage.com",
		bucket: "pi-sync-test",
		accessKeyId: "access-key",
		secretAccessKey: "secret-key",
		extraFiles: [],
	};
}

async function withTempHome<T>(fn: (agentDir: string) => Promise<T>) {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-home-"));
	const agentDir = path.join(home, ".pi", "agent");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
	try {
		return await fn(agentDir);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
		rmSync(home, { recursive: true, force: true });
	}
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>) {
	const keys = [
		"PI_SYNC_ENDPOINT",
		"PI_SYNC_BUCKET",
		"PI_SYNC_ACCESS_KEY_ID",
		"PI_SYNC_SECRET_ACCESS_KEY",
		"PI_SYNC_SESSIONS",
		"PI_SYNC_SESSION_TOKEN",
		"PI_SYNC_REGION",
		"PI_SYNC_PROFILE",
		"PI_SYNC_PREFIX",
		"PI_SYNC_AUTO_SYNC",
		"PI_CODING_AGENT_DIR",
		"PI_CODING_AGENT_SESSION_DIR",
		"R2_ENDPOINT",
		"R2_BUCKET",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_REGION",
	];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	Object.assign(process.env, env);
	try {
		return await fn();
	} finally {
		for (const key of keys) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
