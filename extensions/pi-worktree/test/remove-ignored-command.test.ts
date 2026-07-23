import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support.js";
import worktreeExtension from "../src/worktree.js";

const oid = "0123456789abcdef0123456789abcdef01234567";

function result(stdout = "", code = 0, stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

function porcelain(
	records: Array<{
		path: string;
		branch?: string;
		head?: string;
	}>,
): string {
	return records
		.flatMap((record) => [
			`worktree ${record.path}`,
			`HEAD ${record.head ?? oid}`,
			`branch refs/heads/${record.branch}`,
			"",
		])
		.join("\0");
}

test("remove confirms and deletes ignored-only data without forcing Git", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-ignored-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	mkdirSync(main);
	mkdirSync(linked);
	const mock = createMockPi();
	const calls: string[][] = [];
	let removed = false;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		calls.push(args);
		if (args[0] === "worktree" && args[1] === "list") {
			return result(
				porcelain([
					{ path: main, branch: "main" },
					...(!removed ? [{ path: linked, branch: "feature" }] : []),
				]),
			);
		}
		if (args[0] === "rev-parse") return result(`${main}\n`);
		if (args[0] === "status") return result("!! node_modules/\n!! cache/\n");
		if (args[0] === "submodule") return result();
		if (args[0] === "worktree" && args[1] === "remove") {
			removed = true;
			return result();
		}
		return result();
	};
	worktreeExtension(mock.pi);
	let selectCount = 0;
	let confirmationTitle = "";
	let confirmationMessage = "";
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async (_title: string, items: string[]) =>
			selectCount++ === 0 ? "Remove worktree" : items[0],
		confirm: async (title: string, message: string) => {
			confirmationTitle = title;
			confirmationMessage = message;
			return true;
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.match(confirmationTitle, /delete ignored files/i);
		assert.match(confirmationMessage, /!! cache\/\n!! node_modules\//);
		assert.deepEqual(
			calls.find((args) => args[0] === "worktree" && args[1] === "remove"),
			["worktree", "remove", linked],
		);
		assert.match(context.notifications.at(-1)?.message ?? "", /branch was preserved/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("remove separates ignored inventory from recovery warnings", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-combined-warning-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	const administrative = join(main, ".git", "worktrees", "repo-feature");
	mkdirSync(main);
	mkdirSync(linked);
	mkdirSync(join(administrative, "logs"), { recursive: true });
	const orphan = oid.replace(/^0/, "1");
	writeFileSync(
		join(administrative, "logs", "HEAD"),
		`${"0".repeat(40)} ${orphan} Test <test@example.invalid> 0 +0000\tcommit\n`,
	);
	const mock = createMockPi();
	let removed = false;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return result(
				porcelain([
					{ path: main, branch: "main" },
					...(!removed ? [{ path: linked, branch: "feature" }] : []),
				]),
			);
		}
		if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
			return result(`${main}\n`);
		}
		if (args[0] === "rev-parse" && args.includes("--git-dir")) {
			return result(`${administrative}\n`);
		}
		if (args[0] === "status") return result("!! cache/\n");
		if (args[0] === "submodule" || args.includes("for-each-ref")) return result();
		if (args[0] === "worktree" && args[1] === "remove") removed = true;
		return result();
	};
	worktreeExtension(mock.pi);
	let selectCount = 0;
	let confirmationMessage = "";
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async (_title: string, items: string[]) =>
			selectCount++ === 0 ? "Remove worktree" : items[0],
		confirm: async (_title: string, message: string) => {
			confirmationMessage = message;
			return true;
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(removed, true);
		assert.match(confirmationMessage, /!! cache\/\nAdministrative recovery warning:/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("remove refuses ignored data that changes after confirmation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-ignored-race-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	mkdirSync(main);
	mkdirSync(linked);
	const mock = createMockPi();
	let statusCalls = 0;
	let removeCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return result(
				porcelain([
					{ path: main, branch: "main" },
					{ path: linked, branch: "feature" },
				]),
			);
		}
		if (args[0] === "rev-parse") return result(`${main}\n`);
		if (args[0] === "status") {
			statusCalls += 1;
			return result(statusCalls === 1 ? "!! node_modules/\n" : "!! node_modules/\n!! cache/\n");
		}
		if (args[0] === "submodule") return result();
		if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
		return result();
	};
	worktreeExtension(mock.pi);
	let selectCount = 0;
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async (_title: string, items: string[]) =>
			selectCount++ === 0 ? "Remove worktree" : items[0],
		confirm: async () => true,
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(removeCalls, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /ignored data changed/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

type ExecFunction = (
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;
