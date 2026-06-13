import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import sync, {
	encodeKey,
	isCloudflareR2Endpoint,
	isDeniedPath,
	isEnabled,
	parseOptions,
	posixJoin,
	preflightSnapshotApply,
	safeJoin,
	safeName,
	scanSnapshot,
	sessionTokenWarnings,
	splitArgs,
} from "../src/sync.js";

test("sync registers pisync command and session lifecycle hooks", () => {
	const mock = createMockPi();
	sync(mock.pi);

	assert.ok(mock.commands.has("pisync"));
	assert.deepEqual([...mock.events.keys()].sort(), ["session_shutdown", "session_start"]);
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

test("snapshot preflight validates checksums, duplicate paths, and deletes stale files", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-apply-"));
	const content = Buffer.from("hello");
	const remote = snapshot([{ path: "settings.json", content }]);
	const current = snapshot([
		{ path: "settings.json", content },
		{ path: "skills/old.md", content: Buffer.from("old") },
	]);

	const plan = preflightSnapshotApply(root, remote, current);
	assert.deepEqual(
		plan.writes.map((item) => item.target),
		[path.join(root, "settings.json")],
	);
	assert.deepEqual(plan.deletes, [path.join(root, "skills", "old.md")]);
	assert.throws(
		() => preflightSnapshotApply(root, snapshot([{ path: "../bad", content }]), current),
		/Unsafe path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				{ ...remote, files: [remote.files[0], remote.files[0]] },
				current,
			),
		/Duplicate path/,
	);
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
