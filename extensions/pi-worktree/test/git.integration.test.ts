import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
	addWorktree,
	administrativeHistoryOids,
	administrativePruneCandidates,
	durableRefsContaining,
	listWorktrees,
	localBranchExists,
	removeWorktree,
	resolveCommit,
	validateBranch,
	worktreeAdministrativeDirectory,
	worktreeInventory,
} from "../src/git.js";

const pi = {
	async exec(command: string, args: string[], options?: { cwd?: string }): Promise<ExecResult> {
		const result = spawnSync(command, args, {
			cwd: options?.cwd,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
		});
		if (result.error) throw result.error;
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			code: result.status ?? 1,
			killed: Boolean(result.signal),
		};
	},
};

test("Git service creates, inventories, and removes a real linked worktree while preserving branch", async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-git-")));
	const main = join(temporary, "repo");
	const linked = join(temporary, "repo-feature");
	try {
		git(temporary, ["init", "--initial-branch=main", main]);
		git(main, ["config", "user.name", "Pi Worktree Test"]);
		git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
		writeFileSync(join(main, ".gitignore"), "*.ignored\n");
		writeFileSync(join(main, "README.md"), "main\n");
		git(main, ["add", ".gitignore", "README.md"]);
		git(main, ["commit", "-m", "initial"]);

		assert.equal(await validateBranch(pi, main, "feature/test"), "feature/test");
		assert.equal(await localBranchExists(pi, main, "feature/test"), false);
		const startOid = await resolveCommit(pi, main, "main");
		await addWorktree(pi, main, { path: linked, branch: "feature/test", startOid });
		assert.equal(await localBranchExists(pi, main, "feature/test"), true);
		assert.equal((await listWorktrees(pi, main))[1]?.branch, "feature/test");

		writeFileSync(join(linked, "draft.txt"), "draft\n");
		writeFileSync(join(linked, "cache.ignored"), "cache\n");
		const inventory = await worktreeInventory(pi, linked);
		assert.ok(inventory.some((line) => line.includes("draft.txt")));
		assert.ok(inventory.some((line) => line.includes("cache.ignored")));
		rmSync(join(linked, "draft.txt"));
		rmSync(join(linked, "cache.ignored"));
		assert.deepEqual(await worktreeInventory(pi, linked), []);
		const administrative = await worktreeAdministrativeDirectory(pi, linked);
		for (const historyOid of await administrativeHistoryOids(pi, main, administrative)) {
			assert.ok((await durableRefsContaining(pi, main, historyOid)).length > 0);
		}

		await removeWorktree(pi, main, linked);
		assert.equal((await listWorktrees(pi, main)).length, 1);
		assert.equal(await localBranchExists(pi, main, "feature/test"), true);

		await addWorktree(pi, main, { path: linked, branch: "feature/test" });
		assert.equal((await listWorktrees(pi, main))[1]?.branch, "feature/test");
		await removeWorktree(pi, main, linked);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("administrative history exposes a clean attached worktree's reflog-only commit", async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-history-")));
	const main = join(temporary, "repo");
	const linked = join(temporary, "repo-feature");
	try {
		git(temporary, ["init", "--initial-branch=main", main]);
		git(main, ["config", "user.name", "Pi Worktree Test"]);
		git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
		writeFileSync(join(main, "README.md"), "main\n");
		git(main, ["add", "README.md"]);
		git(main, ["commit", "-m", "initial"]);
		git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
		git(linked, ["checkout", "--detach"]);
		writeFileSync(join(linked, "unique.txt"), "reflog only\n");
		git(linked, ["add", "unique.txt"]);
		git(linked, ["commit", "-m", "unique detached"]);
		const unique = git(linked, ["rev-parse", "HEAD"]).stdout.trim();
		git(linked, ["checkout", "feature"]);
		const tree = git(linked, ["write-tree"]).stdout.trim();
		const perRefOnly = git(linked, ["commit-tree", tree, "-m", "per-ref only"]).stdout.trim();
		git(linked, ["update-ref", "--create-reflog", "refs/worktree/safety", perRefOnly]);
		const durable = git(linked, ["rev-parse", "feature"]).stdout.trim();
		git(linked, ["update-ref", "refs/worktree/safety", durable]);

		const administrative = await worktreeAdministrativeDirectory(pi, linked);
		const history = await administrativeHistoryOids(pi, main, administrative);
		assert.ok(history.includes(unique));
		assert.ok(history.includes(perRefOnly));
		assert.deepEqual(await durableRefsContaining(pi, main, unique), []);
		assert.deepEqual(await durableRefsContaining(pi, main, perRefOnly), []);
		assert.deepEqual(await worktreeInventory(pi, linked), []);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("administrative prune scanning finds an unreachable detached HEAD omitted from porcelain", async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-hidden-prune-")));
	const main = join(temporary, "repo");
	const linked = join(temporary, "repo-detached");
	try {
		git(temporary, ["init", "--initial-branch=main", main]);
		git(main, ["config", "user.name", "Pi Worktree Test"]);
		git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
		writeFileSync(join(main, "README.md"), "main\n");
		git(main, ["add", "README.md"]);
		git(main, ["commit", "-m", "initial"]);
		git(main, ["worktree", "add", "--detach", linked, "HEAD"]);
		writeFileSync(join(linked, "hidden.txt"), "unique\n");
		git(linked, ["add", "hidden.txt"]);
		git(linked, ["commit", "-m", "hidden detached"]);
		const hiddenHead = git(linked, ["rev-parse", "HEAD"]).stdout.trim();
		const adminRoot = join(main, ".git", "worktrees");
		const adminName = readdirSync(adminRoot)[0];
		assert.ok(adminName);
		const admin = join(adminRoot, adminName);
		rmSync(join(admin, "gitdir"));
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		utimesSync(admin, old, old);

		assert.equal((await listWorktrees(pi, main)).length, 1);
		const preview = git(main, ["worktree", "prune", "--dry-run", "--verbose"]);
		assert.match(`${preview.stdout}${preview.stderr}`, /Removing/);
		assert.deepEqual(await administrativePruneCandidates(pi, main), [
			{
				id: admin.split("/").at(-1),
				administrativePath: admin,
				head: hiddenHead,
				indexDirty: false,
			},
		]);
		assert.deepEqual(await durableRefsContaining(pi, main, hiddenHead), []);
		assert.equal(readdirSync(adminRoot).length, 1);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("administrative prune scanning detects staged-only state before metadata removal", async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-staged-prune-")));
	const main = join(temporary, "repo");
	const linked = join(temporary, "repo-feature");
	try {
		git(temporary, ["init", "--initial-branch=main", main]);
		git(main, ["config", "user.name", "Pi Worktree Test"]);
		git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
		writeFileSync(join(main, "README.md"), "main\n");
		git(main, ["add", "README.md"]);
		git(main, ["commit", "-m", "initial"]);
		git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
		writeFileSync(join(linked, "staged.txt"), "not committed\n");
		git(linked, ["add", "staged.txt"]);
		const adminRoot = join(main, ".git", "worktrees");
		const adminName = readdirSync(adminRoot)[0];
		assert.ok(adminName);
		const admin = join(adminRoot, adminName);
		rmSync(join(linked, ".git"));
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		utimesSync(admin, old, old);

		const preview = git(main, ["worktree", "prune", "--dry-run", "--verbose"]);
		assert.match(`${preview.stdout}${preview.stderr}`, /Removing/);
		assert.deepEqual(await administrativePruneCandidates(pi, main), [
			{
				id: adminName,
				administrativePath: admin,
				branchRef: "refs/heads/feature",
				indexDirty: true,
			},
		]);
		assert.equal(readdirSync(adminRoot).length, 1);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("durableRefsContaining distinguishes an unreachable detached commit", async () => {
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-detached-")));
	const main = join(temporary, "repo");
	const linked = join(temporary, "repo-detached");
	try {
		git(temporary, ["init", "--initial-branch=main", main]);
		git(main, ["config", "user.name", "Pi Worktree Test"]);
		git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
		writeFileSync(join(main, "README.md"), "main\n");
		git(main, ["add", "README.md"]);
		git(main, ["commit", "-m", "initial"]);
		git(main, ["worktree", "add", "--detach", linked, "HEAD"]);
		writeFileSync(join(linked, "detached.txt"), "unique\n");
		git(linked, ["add", "detached.txt"]);
		git(linked, ["commit", "-m", "detached"]);
		const head = git(linked, ["rev-parse", "HEAD"]).stdout.trim();
		assert.deepEqual(await durableRefsContaining(pi, main, head), []);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

function git(cwd: string, args: string[]) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result;
}
