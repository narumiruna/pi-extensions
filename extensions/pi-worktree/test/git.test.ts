import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	buildAddArguments,
	currentWorktreePath,
	defaultWorktreePath,
	durableRefsContaining,
	formatWorktree,
	parseWorktreePorcelain,
	prunePreview,
	sameWorktreeIdentity,
	worktreeForBranch,
} from "../src/git.js";

const oid = "0123456789abcdef0123456789abcdef01234567";

test("parseWorktreePorcelain parses NUL records without substring branch matching", () => {
	const output = [
		"worktree /repo with spaces",
		`HEAD ${oid}`,
		"branch refs/heads/main",
		"",
		"worktree /repo-feature",
		`HEAD ${oid.replace(/^0/, "1")}`,
		"branch refs/heads/feat/login",
		"locked in use by CI",
		"prunable gitdir file points to non-existent location",
		"",
		"worktree /repo-detached",
		`HEAD ${oid.replace(/^0/, "2")}`,
		"detached",
		"",
	].join("\0");

	const records = parseWorktreePorcelain(output);
	assert.equal(records.length, 3);
	assert.deepEqual(records[0], {
		path: "/repo with spaces",
		head: oid,
		branchRef: "refs/heads/main",
		branch: "main",
		isMain: true,
		bare: false,
		detached: false,
	});
	assert.equal(records[1]?.lockedReason, "in use by CI");
	assert.equal(records[1]?.prunableReason, "gitdir file points to non-existent location");
	assert.equal(records[2]?.detached, true);
	assert.equal(worktreeForBranch(records, "feat/login")?.path, "/repo-feature");
	assert.equal(worktreeForBranch(records, "feat/log"), undefined);
});

test("parseWorktreePorcelain handles a bare main record and empty lock reasons", () => {
	const records = parseWorktreePorcelain(
		[
			"worktree /srv/repo.git",
			"bare",
			"",
			"worktree /repo",
			`HEAD ${oid}`,
			"detached",
			"locked",
			"",
		].join("\0"),
	);
	assert.equal(records[0]?.bare, true);
	assert.equal(records[0]?.isMain, true);
	assert.equal(records[1]?.lockedReason, "");
});

test("parseWorktreePorcelain rejects malformed fields before a worktree record", () => {
	assert.throws(() => parseWorktreePorcelain(`HEAD ${oid}\0`), /before worktree/i);
	assert.throws(() => parseWorktreePorcelain("worktree\0"), /missing path/i);
});

test("defaultWorktreePath derives a root/project/branch path and normalizes branch slashes", () => {
	assert.equal(
		defaultWorktreePath("/home/me/project", "feat/login", "/home/me/.worktrees"),
		join("/home/me", ".worktrees", "project", "feat-login"),
	);
	assert.equal(
		defaultWorktreePath("/home/me/project", "feat-login", "/home/me/.worktrees"),
		join("/home/me", ".worktrees", "project", "feat-login"),
	);
});

test("buildAddArguments emits only safe attach or create argv", () => {
	assert.deepEqual(buildAddArguments({ path: "/tmp/repo-feature", branch: "feature" }), [
		"worktree",
		"add",
		"/tmp/repo-feature",
		"feature",
	]);
	assert.deepEqual(
		buildAddArguments({
			path: "/tmp/repo-feature",
			branch: "feature",
			startOid: oid,
		}),
		["worktree", "add", "-b", "feature", "/tmp/repo-feature", oid],
	);
});

test("formatWorktree strips terminal controls from Git-owned display values", () => {
	const rendered = formatWorktree({
		path: "/repo\u001b]8;;bad\u0007",
		head: oid,
		branch: "feature\nspoof\u009b2J",
		branchRef: "refs/heads/feature\nspoof\u009b2J",
		isMain: false,
		bare: false,
		detached: false,
		lockedReason: "reason\u001b[2J",
	});
	assert.equal(
		[...rendered].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
		}),
		false,
	);
	assert.match(rendered, /featurespoof2J/);
});

test("published git source loads with Node strip-only TypeScript", () => {
	const moduleUrl = pathToFileURL(
		join(process.cwd(), "extensions", "pi-worktree", "src", "git.ts"),
	).href;
	const loaded = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--input-type=module",
			"--eval",
			`await import(${JSON.stringify(moduleUrl)})`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(loaded.status, 0, loaded.stderr);
});

test("sameWorktreeIdentity binds path, HEAD, branch ref, detached, main, and bare state", () => {
	const record = {
		path: "/repo-feature",
		head: oid,
		branch: "feature",
		branchRef: "refs/heads/feature",
		isMain: false,
		bare: false,
		detached: false,
	};
	assert.equal(sameWorktreeIdentity(record, { ...record }), true);
	for (const changed of [
		{ path: "/other" },
		{ head: oid.replace(/^0/, "1") },
		{ branchRef: "refs/heads/other" },
		{ detached: true },
		{ isMain: true },
		{ bare: true },
	]) {
		assert.equal(sameWorktreeIdentity(record, { ...record, ...changed }), false);
	}
});

test("currentWorktreePath preserves valid trailing spaces while removing Git's line ending", async () => {
	const path = await currentWorktreePath(
		{
			exec: async () => ({
				stdout: "/repo trailing  \n",
				stderr: "",
				code: 0,
				killed: false,
			}),
		},
		"/repo trailing  ",
	);
	assert.equal(path, "/repo trailing  ");
});

test("durable ref checks reject malformed porcelain OIDs without invoking Git", async () => {
	let calls = 0;
	await assert.rejects(
		durableRefsContaining(
			{
				exec: async () => {
					calls += 1;
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
			},
			"/repo",
			"--format=%(objectname)",
		),
		/invalid HEAD object/i,
	);
	assert.equal(calls, 0);
});

test("prune preview includes Git stderr because verbose prune may write there", async () => {
	const preview = await prunePreview(
		{
			exec: async () => ({
				stdout: "stdout line\n",
				stderr: "stderr line\n",
				code: 0,
				killed: false,
			}),
		},
		"/repo",
	);
	assert.equal(preview, "stdout line\nstderr line");
});
