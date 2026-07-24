import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import {
	parseGitDiffShortstat,
	parseGitState,
	parseGitStatusPorcelainV2,
	readGitSnapshot,
} from "../src/modules/git/runtime.js";

test("Git porcelain v2 parser supplies branch, commit, and detailed status modules", () => {
	const parsed = parseGitStatusPorcelainV2(`
# branch.oid 0123456789abcdef0123456789abcdef01234567
# branch.head feature/native-git
# branch.upstream origin/main
# branch.ab +2 -1
# stash 3
1 M. N... 100644 100644 100644 a b index-modified.ts
1 .M N... 100644 100644 100644 a b worktree-modified.ts
1 A. N... 000000 100644 100644 a b index-added.ts
1 .A N... 000000 100644 100644 a b worktree-added.ts
1 D. N... 100644 000000 000000 a b index-deleted.ts
1 .D N... 100644 100644 000000 a b worktree-deleted.ts
1 T. N... 100644 120000 120000 a b index-typechanged.ts
1 .T N... 100644 100644 120000 a b worktree-typechanged.ts
2 R. N... 100644 100644 100644 a b R100 renamed.ts\toriginal.ts
u UU N... 100644 100644 100644 100644 a b c conflicted.ts
? untracked.ts
`);

	assert.deepEqual(parsed.branch, {
		name: "feature/native-git",
		remoteName: "origin",
		remoteBranch: "main",
		detached: false,
	});
	assert.deepEqual(parsed.commit, {
		hash: "0123456789abcdef0123456789abcdef01234567",
		detached: false,
	});
	assert.deepEqual(parsed.status, {
		ahead: 2,
		behind: 1,
		stashed: 3,
		conflicted: 1,
		deleted: 2,
		renamed: 1,
		modified: 2,
		staged: 3,
		typechanged: 1,
		untracked: 1,
		worktreeAdded: 1,
		worktreeDeleted: 1,
		worktreeModified: 1,
		worktreeTypechanged: 1,
		indexAdded: 1,
		indexDeleted: 1,
		indexModified: 1,
		indexTypechanged: 1,
	});
});

test("Git porcelain parser represents detached and unborn HEAD safely", () => {
	const detached = parseGitStatusPorcelainV2(
		"# branch.oid abcdef1234567890\n# branch.head (detached)\n",
	);
	assert.equal(detached.branch?.name, "HEAD");
	assert.equal(detached.branch?.detached, true);
	assert.equal(detached.commit?.hash, "abcdef1234567890");

	const unborn = parseGitStatusPorcelainV2(
		"# branch.oid (initial)\n# branch.head main\n? first-file.ts\n",
	);
	assert.equal(unborn.branch?.name, "main");
	assert.equal(unborn.commit, undefined);
	assert.equal(unborn.status.untracked, 1);
});

test("Git diff shortstat parser returns added and deleted line totals", () => {
	assert.deepEqual(parseGitDiffShortstat(" 2 files changed, 12 insertions(+), 3 deletions(-)\n"), {
		added: 12,
		deleted: 3,
	});
	assert.deepEqual(parseGitDiffShortstat(" 1 file changed, 1 insertion(+)\n"), {
		added: 1,
		deleted: 0,
	});
	assert.deepEqual(parseGitDiffShortstat(""), { added: 0, deleted: 0 });
});

test("Git snapshot refresh collects optional commit tags and line metrics outside render", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-git-snapshot-"));
	try {
		const mock = createMockPi();
		const commands: string[][] = [];
		(
			mock.rawPi as typeof mock.rawPi & {
				exec: (_command: string, args: string[]) => Promise<ExecResult>;
			}
		).exec = async (_command, args) => {
			commands.push(args);
			if (args.includes("status")) {
				return gitResult(
					"# branch.oid 0123456789abcdef\n# branch.head main\n# branch.upstream origin/main\n",
				);
			}
			if (args[0] === "rev-parse") return gitResult(`${root}\n${root}/.git\n${root}/.git\n`);
			if (args.includes("diff"))
				return gitResult(" 1 file changed, 8 insertions(+), 2 deletions(-)\n");
			if (args.includes("describe")) return gitResult("v2.0.0\n");
			throw new Error(`unexpected git args: ${args.join(" ")}`);
		};

		const snapshot = await readGitSnapshot(mock.pi, root, {
			includeMetrics: true,
			includeTag: true,
		});
		assert.equal(snapshot?.commit?.tag, "v2.0.0");
		assert.deepEqual(snapshot?.metrics, { added: 8, deleted: 2 });
		assert.equal(commands.length, 4);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Git snapshot refresh degrades a failed status command to no repository", async () => {
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => ({
		stdout: "",
		stderr: "not a repository",
		code: 128,
		killed: false,
	});
	assert.equal(
		await readGitSnapshot(mock.pi, "/not-a-repository", {
			includeMetrics: false,
			includeTag: false,
		}),
		undefined,
	);
});

test("Git state parser detects operations and rebase progress", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-git-state-"));
	try {
		mkdirSync(join(root, "rebase-merge"));
		writeFileSync(join(root, "rebase-merge", "msgnum"), "3\n");
		writeFileSync(join(root, "rebase-merge", "end"), "10\n");
		assert.deepEqual(parseGitState(root), {
			state: "REBASING",
			progressCurrent: 3,
			progressTotal: 10,
		});

		rmSync(join(root, "rebase-merge"), { recursive: true });
		writeFileSync(join(root, "MERGE_HEAD"), "abc\n");
		assert.deepEqual(parseGitState(root), { state: "MERGING" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

function gitResult(stdout: string): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}
