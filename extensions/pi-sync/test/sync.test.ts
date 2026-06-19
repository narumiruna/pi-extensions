import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { createMockContext, createMockPi } from "../../../test/support.js";
import sync, {
	appliedFileHashMap,
	backupLocal,
	canPullRemoteSessionsOnFirstSync,
	collectFiles,
	encodeKey,
	hasRemoteChanges,
	isCloudflareR2Endpoint,
	isDeniedPath,
	isEnabled,
	isExplicitlyEnabled,
	loadConfig,
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
	assert.deepEqual([...mock.events.keys()].sort(), ["session_shutdown", "session_start"]);
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

		const customAgentDir = path.join(agentDir, "custom-agent");
		mkdirSync(customAgentDir, { recursive: true });
		writeFileSync(
			path.join(customAgentDir, "pi-sync.local.json"),
			JSON.stringify({ ...requiredConfig(), profile: "custom" }),
		);
		await withEnv({ PI_CODING_AGENT_DIR: customAgentDir }, async () => {
			assert.equal((await loadConfig()).profile, "custom");
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
	assert.throws(() => safeJoin(root, "../escape"), /Unsafe path/);
	assert.equal(isDeniedPath("skills/.env.local"), true);
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
	writeFileSync(path.join(root, "settings.json"), "{}\n");
	writeFileSync(path.join(root, "skills", "demo.md"), "demo\n");
	writeFileSync(path.join(root, "sessions", "--project--", "session.jsonl"), "{}\n");
	writeFileSync(path.join(root, "sessions", "--project--", "notes.txt"), "skip\n");
	writeFileSync(path.join(root, "sessions", "token-project", "session.jsonl"), "skip\n");

	assert.deepEqual(
		(await collectFiles(root)).map((file) => file.path),
		["settings.json", "skills/demo.md"],
	);
	assert.deepEqual(
		(await collectFiles(root, { syncSessions: true })).map((file) => file.path),
		["sessions/--project--/session.jsonl", "settings.json", "skills/demo.md"],
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
	assert.equal(
		hasRemoteChanges(
			snapshot([{ path: "settings.json", content: Buffer.from("changed") }]),
			state,
			config,
		),
		true,
	);
});

test("first sync only auto-pulls remote sessions when local sessions are not at risk", () => {
	const remoteOnly = snapshot([
		{ path: "sessions/--project--/remote.jsonl", content: Buffer.from("r") },
	]);
	const shared = { path: "sessions/--project--/shared.jsonl", content: Buffer.from("same") };
	const changed = { path: "sessions/--project--/shared.jsonl", content: Buffer.from("changed") };

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
	};
}

async function withTempHome<T>(fn: (agentDir: string) => Promise<T>) {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-home-"));
	const agentDir = path.join(home, ".pi", "agent");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await fn(agentDir);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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
