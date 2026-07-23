import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createWorktreeSettingsRuntime } from "../src/settings.js";
import worktreeExtension from "../src/worktree.js";

const oid = "0123456789abcdef0123456789abcdef01234567";

function result(stdout = "", code = 0, stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

function porcelain(
	records: Array<{
		path: string;
		branch?: string;
		detached?: boolean;
		head?: string;
		lockedReason?: string;
		prunableReason?: string;
	}>,
): string {
	return records
		.flatMap((record) => [
			`worktree ${record.path}`,
			`HEAD ${record.head ?? oid}`,
			record.detached ? "detached" : `branch refs/heads/${record.branch}`,
			...(record.lockedReason !== undefined ? [`locked ${record.lockedReason}`] : []),
			...(record.prunableReason !== undefined ? [`prunable ${record.prunableReason}`] : []),
			"",
		])
		.join("\0");
}

test("/worktree registers one argument-free interactive command and no LLM tool", () => {
	const mock = createMockPi();
	worktreeExtension(mock.pi);
	const command = mock.commands.get("worktree");
	assert.ok(command);
	assert.equal(command.getArgumentCompletions, undefined);
	assert.deepEqual(mock.tools, []);
});

test("session_start reloads settings and warns through the replacement context", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-session-settings-"));
	const settingsPath = join(root, "pi-worktree.json");
	writeFileSync(settingsPath, '{"worktreeRoot":"/srv/worktrees"}\n');
	const settings = createWorktreeSettingsRuntime({
		path: settingsPath,
		home: "/home/alice",
		platform: "linux",
	});
	const mock = createMockPi();
	worktreeExtension(mock.pi, { settings });
	const sessionStart = mock.events.get("session_start")?.[0];
	assert.ok(sessionStart);
	try {
		const first = createMockContext({ hasUI: true, mode: "tui" });
		await sessionStart({}, first.ctx);
		assert.equal(settings.get().effectiveRoot, "/srv/worktrees");
		assert.deepEqual(first.notifications, []);

		writeFileSync(settingsPath, "{broken\n");
		const replacement = createMockContext({ hasUI: true, mode: "tui" });
		await sessionStart({}, replacement.ctx);
		assert.equal(settings.get().effectiveRoot, "/srv/worktrees");
		assert.match(replacement.notifications.at(-1)?.message ?? "", /ignored/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("/worktree rejects hidden text arguments and non-UI mode without Git calls", async () => {
	const mock = createMockPi();
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => {
		execCalls += 1;
		return result();
	};
	worktreeExtension(mock.pi);
	const ui = createMockContext({ hasUI: true, mode: "tui" });
	await mock.commands.get("worktree")?.handler("add feature", ui.ctx);
	assert.match(ui.notifications.at(-1)?.message ?? "", /does not accept arguments/i);
	const headless = createMockContext({ hasUI: false, mode: "print" });
	await mock.commands.get("worktree")?.handler("", headless.ctx);
	assert.equal(execCalls, 0);
});

test("/worktree waits for full idle before reading Git state or opening dialogs", async () => {
	const mock = createMockPi();
	const order: string[] = [];
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		order.push(`git:${args[0]}:${args[1]}`);
		return args[0] === "worktree"
			? result(porcelain([{ path: "/repo", branch: "main" }]))
			: result("/repo\n");
	};
	worktreeExtension(mock.pi);
	const context = createMockContext({
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		waitForIdle: async () => order.push("idle"),
		select: async () => {
			order.push("select");
			return undefined;
		},
	});
	await mock.commands.get("worktree")?.handler("", context.ctx);
	assert.deepEqual(order, ["idle", "git:worktree:list", "git:rev-parse:--show-toplevel", "select"]);
});

test("/worktree menu exposes only actionable flows", async () => {
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree") {
			return result(porcelain([{ path: "/repo", branch: "main" }]));
		}
		return result("/repo\n");
	};
	worktreeExtension(mock.pi);
	let actions: string[] = [];
	const context = createMockContext({
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		select: async (_title: string, items: string[]) => {
			actions = items;
			return undefined;
		},
	});
	await mock.commands.get("worktree")?.handler("", context.ctx);
	assert.deepEqual(actions, [
		"Add worktree",
		"Switch worktree",
		"Remove worktree",
		"Prune stale metadata",
		"Configure worktree root",
	]);
});

test("interactive root configuration saves, applies to the next Add, and resets without subcommands", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-configure-"));
	const main = join(root, "repo");
	const settingsPath = join(root, "agent", "pi-worktree.json");
	mkdirSync(main);
	const settings = createWorktreeSettingsRuntime({
		path: settingsPath,
		home: "/home/alice",
		platform: "linux",
	});
	const mock = createMockPi();
	let mutations = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "add") mutations += 1;
		if (args[0] === "worktree" && args[1] === "list") {
			return result(porcelain([{ path: main, branch: "main" }]));
		}
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
		if (args[0] === "check-ref-format") return result("feat/login\n");
		if (args[0] === "show-ref") return result("", 1);
		if (args[0] === "symbolic-ref") return result("main\n");
		if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
		return result();
	};
	worktreeExtension(mock.pi, { settings });

	try {
		const configure = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Configure worktree root",
			input: async () => "/srv/worktrees",
		});
		await mock.commands.get("worktree")?.handler("", configure.ctx);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			worktreeRoot: "/srv/worktrees",
		});
		assert.equal(settings.get().effectiveRoot, "/srv/worktrees");

		const inputs = ["feat/login", "", undefined];
		const menuTitles: string[] = [];
		const pathPlaceholders: string[] = [];
		const add = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async (title: string) => {
				menuTitles.push(title);
				return "Add worktree";
			},
			input: async (title: string, placeholder: string) => {
				if (title.startsWith("Worktree path")) pathPlaceholders.push(placeholder);
				return inputs.shift();
			},
		});
		await mock.commands.get("worktree")?.handler("", add.ctx);
		assert.match(menuTitles[0] ?? "", /Worktree root: \/srv\/worktrees \(user\)/);
		assert.deepEqual(pathPlaceholders, ["/srv/worktrees/repo/feat-login"]);
		assert.equal(mutations, 0);

		const reset = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Configure worktree root",
			input: async () => "   ",
		});
		await mock.commands.get("worktree")?.handler("", reset.ctx);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {});
		assert.equal(settings.get().effectiveRoot, "/home/alice/.worktrees");
		assert.equal(settings.get().source, "default");

		const defaultInputs = ["feat/login", "", undefined];
		let defaultPlaceholder = "";
		const addWithDefault = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Add worktree",
			input: async (title: string, placeholder: string) => {
				if (title.startsWith("Worktree path")) defaultPlaceholder = placeholder;
				return defaultInputs.shift();
			},
		});
		await mock.commands.get("worktree")?.handler("", addWithDefault.ctx);
		assert.equal(defaultPlaceholder, "/home/alice/.worktrees/repo/feat-login");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("interactive root configuration cancels cleanly and never overwrites invalid settings", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-configure-invalid-"));
	const main = join(root, "repo");
	const settingsPath = join(root, "pi-worktree.json");
	mkdirSync(main);
	const settings = createWorktreeSettingsRuntime({
		path: settingsPath,
		home: "/home/alice",
		platform: "linux",
	});
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree") return result(porcelain([{ path: main, branch: "main" }]));
		return result(`${main}\n`);
	};
	worktreeExtension(mock.pi, { settings });
	let inputs = 0;
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Configure worktree root",
		input: async () => {
			inputs += 1;
			return undefined;
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(inputs, 1);
		assert.equal(settings.get().source, "default");

		writeFileSync(settingsPath, "{broken\n");
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(inputs, 1);
		assert.equal(readFileSync(settingsPath, "utf8"), "{broken\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /ignored.*without overwriting/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("interactive root configuration keeps runtime state when atomic publication fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-configure-failure-"));
	const main = join(root, "repo");
	const settingsPath = join(root, "agent", "pi-worktree.json");
	mkdirSync(main);
	const settings = createWorktreeSettingsRuntime({
		path: settingsPath,
		home: "/home/alice",
		platform: "linux",
		operations: {
			rename: async () => {
				throw new Error("publish failed");
			},
		},
	});
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree") return result(porcelain([{ path: main, branch: "main" }]));
		return result(`${main}\n`);
	};
	worktreeExtension(mock.pi, { settings });
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Configure worktree root",
		input: async () => "/srv/worktrees",
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(settings.get().effectiveRoot, "/home/alice/.worktrees");
		assert.equal(settings.get().source, "default");
		assert.match(context.notifications.at(-1)?.message ?? "", /publish failed/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("add creates a new branch with safe argv, verifies it, and can leave the session unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	mkdirSync(main);
	const mock = createMockPi();
	const calls: Array<{ args: string[]; cwd?: string }> = [];
	let added = false;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (
		_command,
		args,
		options,
	) => {
		calls.push({ args, cwd: options?.cwd });
		if (args[0] === "worktree" && args[1] === "list") {
			return result(
				porcelain([
					{ path: main, branch: "main" },
					...(added ? [{ path: linked, branch: "feature" }] : []),
				]),
			);
		}
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
		if (args[0] === "check-ref-format") return result("feature\n");
		if (args[0] === "show-ref") return result("", 1);
		if (args[0] === "symbolic-ref") return result("main\n");
		if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
		if (args[0] === "worktree" && args[1] === "add") {
			added = true;
			return result();
		}
		return result();
	};
	worktreeExtension(mock.pi);
	const inputs = ["feature", "", linked];
	const confirms = [true, false];
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Add worktree",
		input: async () => inputs.shift(),
		confirm: async () => confirms.shift() ?? false,
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(calls.find(({ args }) => args[0] === "worktree" && args[1] === "add")?.args, [
			"worktree",
			"add",
			"-b",
			"feature",
			linked,
			oid,
		]);
		assert.match(context.notifications.at(-1)?.message ?? "", /created.*repo-feature/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("add strips terminal controls from branch-derived prompts", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-controls-"));
	const main = join(root, "repo");
	mkdirSync(main);
	const control = "\u009b2J";
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return result(porcelain([{ path: main, branch: "main" }]));
		}
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
		if (args[0] === "check-ref-format") return result(`feat${control}spoof\n`);
		if (args[0] === "show-ref") return result("", 1);
		if (args[0] === "symbolic-ref") return result(`main${control}spoof\n`);
		if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
		return result();
	};
	worktreeExtension(mock.pi);
	const inputs = ["feature", "", undefined];
	const dialogs: string[] = [];
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Add worktree",
		input: async (title: string, placeholder: string) => {
			dialogs.push(title, placeholder);
			return inputs.shift();
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(dialogs.length, 6);
		assert.equal(
			dialogs.every((value) =>
				[...value].every((character) => {
					const code = character.codePointAt(0) ?? 0;
					return code > 0x1f && (code < 0x7f || code > 0x9f);
				}),
			),
			true,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("add refuses a broken symlink target before creating the branch", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-symlink-add-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	mkdirSync(main);
	symlinkSync("missing-target", linked);
	const mock = createMockPi();
	let mutations = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "add") mutations += 1;
		if (args[0] === "worktree" && args[1] === "list") {
			return result(porcelain([{ path: main, branch: "main" }]));
		}
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
		if (args[0] === "check-ref-format") return result("feature\n");
		if (args[0] === "show-ref") return result("", 1);
		if (args[0] === "symbolic-ref") return result("main\n");
		if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
		return result();
	};
	worktreeExtension(mock.pi);
	const inputs = ["feature", "", linked];
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Add worktree",
		input: async () => inputs.shift(),
		confirm: async () => true,
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(mutations, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /target path already exists/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("add refuses a broken symlink ancestor before creating the branch", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-symlink-parent-add-"));
	const main = join(root, "repo");
	const brokenParent = join(root, "broken-parent");
	const linked = join(brokenParent, "nested", "repo-feature");
	mkdirSync(main);
	symlinkSync("missing-parent", brokenParent);
	const mock = createMockPi();
	let mutations = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "add") mutations += 1;
		if (args[0] === "worktree" && args[1] === "list") {
			return result(porcelain([{ path: main, branch: "main" }]));
		}
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
		if (args[0] === "check-ref-format") return result("feature\n");
		if (args[0] === "show-ref") return result("", 1);
		if (args[0] === "symbolic-ref") return result("main\n");
		if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
		return result();
	};
	worktreeExtension(mock.pi);
	const inputs = ["feature", "", linked];
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Add worktree",
		input: async () => inputs.shift(),
		confirm: async () => true,
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(mutations, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /symbolic-link ancestor/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("add cancellation and occupied branches never execute worktree add", async () => {
	for (const mode of ["cancel", "occupied"] as const) {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-refuse-add-"));
		const main = join(root, "repo");
		const other = join(root, "other");
		mkdirSync(main);
		const mock = createMockPi();
		let mutations = 0;
		(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "add") mutations += 1;
			if (args[0] === "worktree" && args[1] === "list") {
				return result(
					porcelain([
						{ path: main, branch: "main" },
						...(mode === "occupied" ? [{ path: other, branch: "feature" }] : []),
					]),
				);
			}
			if (args[0] === "rev-parse") return result(`${main}\n`);
			if (args[0] === "check-ref-format") return result("feature\n");
			if (args[0] === "show-ref") return result("", mode === "occupied" ? 0 : 1);
			return result();
		};
		worktreeExtension(mock.pi);
		const context = createMockContext({
			cwd: main,
			hasUI: true,
			mode: "tui",
			select: async () => "Add worktree",
			input: async () => (mode === "cancel" ? undefined : "feature"),
		});
		try {
			await mock.commands.get("worktree")?.handler("", context.ctx);
			assert.equal(mutations, 0);
			if (mode === "occupied") {
				assert.match(context.notifications.at(-1)?.message ?? "", /already checked out/i);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("remove deletes only a confirmed clean linked worktree and verifies deregistration", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-"));
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
		if (args[0] === "status" || args[0] === "submodule") return result();
		if (args[0] === "worktree" && args[1] === "remove") {
			removed = true;
			return result();
		}
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
		assert.deepEqual(
			calls.find((args) => args[0] === "worktree" && args[1] === "remove"),
			["worktree", "remove", linked],
		);
		assert.match(context.notifications.at(-1)?.message ?? "", /branch was preserved/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("remove refuses dirty, locked, and unreachable detached worktrees without mutation", async () => {
	for (const mode of ["dirty", "locked", "detached"] as const) {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-refuse-remove-"));
		const main = join(root, "repo");
		const linked = join(root, "repo-linked");
		mkdirSync(main);
		mkdirSync(linked);
		const mock = createMockPi();
		let removeCalls = 0;
		(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return result(
					porcelain([
						{ path: main, branch: "main" },
						mode === "detached"
							? { path: linked, detached: true }
							: {
									path: linked,
									branch: "feature",
									lockedReason: mode === "locked" ? "CI owns this" : undefined,
								},
					]),
				);
			}
			if (args[0] === "rev-parse") return result(`${main}\n`);
			if (args[0] === "status") return result(mode === "dirty" ? "?? local.txt\n" : "");
			if (args[0] === "submodule") return result();
			if (args[0] === "for-each-ref") return result("");
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
			assert.match(
				context.notifications.at(-1)?.message ?? "",
				mode === "dirty" ? /local\.txt/ : mode === "locked" ? /CI owns this/ : /not reachable/i,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("remove explicitly confirms and discards reflog-only recovery history", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-history-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	const administrative = join(main, ".git", "worktrees", "repo-feature");
	mkdirSync(main);
	mkdirSync(linked);
	mkdirSync(join(administrative, "logs"), { recursive: true });
	const orphan = oid.replace(/^0/, "1");
	writeFileSync(
		join(administrative, "logs", "HEAD"),
		`${"0".repeat(40)} ${orphan} Test <test@example.invalid> 0 +0000\tcommit\n${orphan} ${oid} Test <test@example.invalid> 1 +0000\tcheckout\n`,
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
		if (args[0] === "status" || args[0] === "submodule") return result();
		if (args.includes("for-each-ref")) return result();
		if (args[0] === "worktree" && args[1] === "remove") removed = true;
		return result();
	};
	worktreeExtension(mock.pi);
	let selects = 0;
	let confirmation = "";
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async (_title: string, items: string[]) =>
			selects++ === 0 ? "Remove worktree" : items[0],
		confirm: async (_title: string, message: string) => {
			confirmation = message;
			return true;
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(removed, true);
		assert.match(confirmation, new RegExp(orphan));
		assert.match(confirmation, /recovery pointers.*garbage-collected/i);
		assert.match(context.notifications.at(-1)?.message ?? "", /branch was preserved/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("remove refuses administrative recovery history added during final validation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-history-race-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	const administrative = join(main, ".git", "worktrees", "repo-feature");
	const logPath = join(administrative, "logs", "HEAD");
	mkdirSync(linked, { recursive: true });
	mkdirSync(join(administrative, "logs"), { recursive: true });
	const firstOrphan = oid.replace(/^0/, "1");
	const laterOrphan = oid.replace(/^0/, "2");
	writeFileSync(
		logPath,
		`${"0".repeat(40)} ${firstOrphan} Test <test@example.invalid> 0 +0000\tcommit\n`,
	);
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
		if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return result(`${main}\n`);
		if (args[0] === "rev-parse" && args.includes("--git-dir")) return result(`${administrative}\n`);
		if (args[0] === "status") {
			statusCalls += 1;
			if (statusCalls === 2) {
				writeFileSync(
					logPath,
					`${"0".repeat(40)} ${firstOrphan} Test <test@example.invalid> 0 +0000\tcommit\n${firstOrphan} ${laterOrphan} Test <test@example.invalid> 1 +0000\tcommit\n`,
				);
			}
			return result();
		}
		if (args[0] === "submodule" || args.includes("for-each-ref")) return result();
		if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
		return result();
	};
	worktreeExtension(mock.pi);
	let selects = 0;
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async (_title: string, items: string[]) =>
			selects++ === 0 ? "Remove worktree" : items[0],
		confirm: async () => true,
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(removeCalls, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /history changed/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("remove refuses path reuse when the selected worktree identity changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-race-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	mkdirSync(main);
	mkdirSync(linked);
	const mock = createMockPi();
	let listCalls = 0;
	let removeCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			listCalls += 1;
			return result(
				porcelain([
					{ path: main, branch: "main" },
					listCalls === 1
						? { path: linked, branch: "feature" }
						: { path: linked, branch: "replacement", head: oid.replace(/^0/, "1") },
				]),
			);
		}
		if (args[0] === "rev-parse") return result(`${main}\n`);
		if (args[0] === "status" || args[0] === "submodule") return result();
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
		assert.match(context.notifications.at(-1)?.message ?? "", /changed identity/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("switch action prepares a target-cwd session and uses the replacement context", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-command-switch-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	mkdirSync(main);
	mkdirSync(linked);
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree") {
			return result(
				porcelain([
					{ path: main, branch: "main" },
					{ path: linked, branch: "feature" },
				]),
			);
		}
		return result(`${main}\n`);
	};
	worktreeExtension(mock.pi);
	let selectCount = 0;
	let switchedCwd = "";
	let replacementNotice = "";
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
		select: async (_title: string, items: string[]) =>
			selectCount++ === 0 ? "Switch worktree" : items[0],
		switchSession: async (
			path: string,
			options: { withSession?: (ctx: unknown) => Promise<void> },
		) => {
			const session = (await import("@earendil-works/pi-coding-agent")).SessionManager.open(path);
			switchedCwd = session.getCwd();
			await options.withSession?.({
				cwd: linked,
				ui: { notify: (message: string) => (replacementNotice = message) },
			});
			return { cancelled: false };
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(switchedCwd, linked);
		assert.match(replacementNotice, /switched/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("switch choices use unique ordinals when sanitized worktree labels collide", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-label-collision-"));
	const main = join(root, "repo");
	const first = join(root, "wt-\nsame");
	const second = join(root, "wt-same");
	mkdirSync(main);
	mkdirSync(first);
	mkdirSync(second);
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree") {
			return result(
				porcelain([
					{ path: main, branch: "main" },
					{ path: first, detached: true },
					{ path: second, detached: true },
				]),
			);
		}
		return result(`${main}\n`);
	};
	worktreeExtension(mock.pi);
	let selectCount = 0;
	let switchedCwd = "";
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
		select: async (_title: string, items: string[]) =>
			selectCount++ === 0 ? "Switch worktree" : items[1],
		switchSession: async (
			path: string,
			options: { withSession?: (ctx: unknown) => Promise<void> },
		) => {
			const session = (await import("@earendil-works/pi-coding-agent")).SessionManager.open(path);
			switchedCwd = session.getCwd();
			await options.withSession?.({ cwd: second, ui: { notify() {} } });
			return { cancelled: false };
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(switchedCwd, second);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("switch refuses path reuse when the selected worktree identity changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-switch-race-"));
	const main = join(root, "repo");
	const linked = join(root, "repo-feature");
	mkdirSync(main);
	mkdirSync(linked);
	const mock = createMockPi();
	let listCalls = 0;
	let switchCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree") {
			listCalls += 1;
			return result(
				porcelain([
					{ path: main, branch: "main" },
					listCalls === 1
						? { path: linked, branch: "feature" }
						: { path: linked, branch: "replacement", head: oid.replace(/^0/, "1") },
				]),
			);
		}
		return result(`${main}\n`);
	};
	worktreeExtension(mock.pi);
	let selectCount = 0;
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async (_title: string, items: string[]) =>
			selectCount++ === 0 ? "Switch worktree" : items[0],
		switchSession: async () => {
			switchCalls += 1;
			return { cancelled: false };
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(switchCalls, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /changed identity/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("prune refuses an unreachable prunable detached HEAD before preview", async () => {
	const mock = createMockPi();
	let previewCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return result(
				porcelain([
					{ path: "/repo", branch: "main" },
					{ path: "/missing", detached: true, prunableReason: "missing gitdir" },
				]),
			);
		}
		if (args[0] === "rev-parse") return result("/repo\n");
		if (args[0] === "for-each-ref") return result("");
		if (args.includes("--dry-run")) previewCalls += 1;
		return result();
	};
	worktreeExtension(mock.pi);
	const context = createMockContext({
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		select: async () => "Prune stale metadata",
	});
	await mock.commands.get("worktree")?.handler("", context.ctx);
	assert.equal(previewCalls, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /not reachable/i);
});

test("prune refuses staged-only administrative index state omitted from porcelain", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-staged-command-"));
	const main = join(root, "repo");
	const admin = join(main, ".git", "worktrees", "hidden");
	mkdirSync(admin, { recursive: true });
	writeFileSync(join(admin, "HEAD"), "ref: refs/heads/feature\n");
	const mock = createMockPi();
	let actualPruneCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return result(porcelain([{ path: main, branch: "main" }]));
		}
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
			return result(`${main}\n`);
		}
		if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
			return result(".git\n");
		}
		if (args[0]?.startsWith("--git-dir=") && args[1] === "diff") return result("", 1);
		if (args.includes("--dry-run")) return result("Removing worktrees/hidden: missing gitdir\n");
		if (args[0] === "worktree" && args[1] === "prune") actualPruneCalls += 1;
		return result();
	};
	worktreeExtension(mock.pi);
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Prune stale metadata",
		confirm: async () => true,
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(actualPruneCalls, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /staged-only index changes/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("prune refuses stale attached metadata whose branch ref is missing", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-missing-ref-command-"));
	const main = join(root, "repo");
	const admin = join(main, ".git", "worktrees", "hidden");
	mkdirSync(admin, { recursive: true });
	writeFileSync(join(admin, "HEAD"), "ref: refs/heads/missing\n");
	const mock = createMockPi();
	let actualPruneCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return result(porcelain([{ path: main, branch: "main" }]));
		}
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
			return result(`${main}\n`);
		}
		if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
			return result(".git\n");
		}
		if (args[0]?.startsWith("--git-dir=") && args[1] === "diff") return result();
		if (args[0] === "show-ref") return result("", 1);
		if (args.includes("--dry-run")) return result("Removing worktrees/hidden: missing gitdir\n");
		if (args[0] === "worktree" && args[1] === "prune") actualPruneCalls += 1;
		return result();
	};
	worktreeExtension(mock.pi);
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Prune stale metadata",
		confirm: async () => true,
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(actualPruneCalls, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /does not resolve.*durable ref/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("prune explicitly confirms and discards reflog-only recovery history", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-prune-history-"));
	const main = join(root, "repo");
	const admin = join(main, ".git", "worktrees", "hidden");
	mkdirSync(join(admin, "logs"), { recursive: true });
	writeFileSync(join(admin, "HEAD"), "ref: refs/heads/feature\n");
	const orphan = oid.replace(/^0/, "1");
	writeFileSync(
		join(admin, "logs", "HEAD"),
		`${"0".repeat(40)} ${orphan} Test <test@example.invalid> 0 +0000\tcommit\n${orphan} ${oid} Test <test@example.invalid> 1 +0000\tcheckout\n`,
	);
	const mock = createMockPi();
	let actualPruneCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return result(porcelain([{ path: main, branch: "main" }]));
		}
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
			return result(`${main}\n`);
		}
		if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
			return result(".git\n");
		}
		if (args[0]?.startsWith("--git-dir=") && args[1] === "diff") return result();
		if (args.includes("for-each-ref")) return result();
		if (args.includes("--dry-run")) return result("Removing worktrees/hidden: missing gitdir\n");
		if (args[0] === "worktree" && args[1] === "prune") actualPruneCalls += 1;
		return result();
	};
	worktreeExtension(mock.pi);
	let confirmation = "";
	const context = createMockContext({
		cwd: main,
		hasUI: true,
		mode: "tui",
		select: async () => "Prune stale metadata",
		confirm: async (_title: string, message: string) => {
			confirmation = message;
			return true;
		},
	});
	try {
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.equal(actualPruneCalls, 1);
		assert.match(confirmation, new RegExp(orphan));
		assert.match(confirmation, /recovery pointers.*garbage-collected/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("prune refuses metadata that changes during recovery-history revalidation", async () => {
	const mock = createMockPi();
	let dryRuns = 0;
	let historyScans = 0;
	let actualPruneCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return result(porcelain([{ path: "/repo", branch: "main" }]));
		}
		if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
			historyScans += 1;
			return result("/repo/.git\n");
		}
		if (args[0] === "rev-parse") return result("/repo\n");
		if (args.includes("--dry-run")) {
			dryRuns += 1;
			return result(
				historyScans < 2
					? "Removing worktrees/first: missing gitdir\n"
					: "Removing worktrees/second: missing gitdir\n",
			);
		}
		if (args[0] === "worktree" && args[1] === "prune") actualPruneCalls += 1;
		return result();
	};
	worktreeExtension(mock.pi);
	const context = createMockContext({
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		select: async () => "Prune stale metadata",
		confirm: async () => true,
	});
	await mock.commands.get("worktree")?.handler("", context.ctx);
	assert.equal(dryRuns, 2);
	assert.equal(actualPruneCalls, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /metadata changed/i);
});

test("prune always previews and cancellation prevents mutation", async () => {
	for (const confirm of [false, true]) {
		const mock = createMockPi();
		const calls: string[][] = [];
		(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
			calls.push(args);
			if (args[0] === "worktree" && args[1] === "list") {
				return result(porcelain([{ path: "/repo", branch: "main" }]));
			}
			if (args[0] === "rev-parse") return result("/repo\n");
			if (args[0] === "worktree" && args.includes("--dry-run")) {
				return result("Removing worktrees/stale: gitdir file points to non-existent location\n");
			}
			if (args[0] === "worktree" && args[1] === "prune") return result("Pruned\n");
			return result();
		};
		worktreeExtension(mock.pi);
		const context = createMockContext({
			cwd: "/repo",
			hasUI: true,
			mode: "tui",
			select: async () => "Prune stale metadata",
			confirm: async () => confirm,
		});
		await mock.commands.get("worktree")?.handler("", context.ctx);
		assert.deepEqual(
			calls.find((args) => args.includes("--dry-run")),
			["worktree", "prune", "--dry-run", "--verbose"],
		);
		assert.equal(
			calls.filter(
				(args) => args[0] === "worktree" && args[1] === "prune" && !args.includes("--dry-run"),
			).length,
			confirm ? 1 : 0,
		);
	}
});

// Structural type used only to make mock assignment concise.
type ExecFunction = (
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;
