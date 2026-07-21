import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createMockContext } from "../../../test/support.js";
import { switchToWorktree } from "../src/session.js";

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

test("switchToWorktree forks persisted conversation into a target-cwd session", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-session-"));
	const sourceCwd = join(root, "source");
	const targetCwd = join(root, "target");
	const sessionDir = join(root, "sessions-source");
	const source = SessionManager.create(sourceCwd, sessionDir);
	source.appendMessage({ role: "user", content: "continue here", timestamp: Date.now() });
	source.appendMessage(assistant("working"));
	const sourceFile = source.getSessionFile();
	assert.ok(sourceFile && existsSync(sourceFile));

	let switchedPath = "";
	let replacementNotice = "";
	const context = createMockContext({
		cwd: sourceCwd,
		hasUI: true,
		sessionManager: source,
		switchSession: async (
			path: string,
			options: { withSession?: (ctx: unknown) => Promise<void> },
		) => {
			switchedPath = path;
			await options.withSession?.({
				cwd: targetCwd,
				ui: { notify: (message: string) => (replacementNotice = message) },
			});
			return { cancelled: false };
		},
	});

	try {
		assert.equal(await switchToWorktree(context.ctx, targetCwd), "switched");
		const forked = SessionManager.open(switchedPath);
		assert.equal(forked.getCwd(), targetCwd);
		assert.deepEqual(
			forked.buildSessionContext().messages.map((message) => message.role),
			["user", "assistant"],
		);
		assert.match(replacementNotice, /switched/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("switchToWorktree preserves the currently selected session-tree branch", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-branch-session-"));
	const sourceCwd = join(root, "source");
	const targetCwd = join(root, "target");
	const source = SessionManager.create(sourceCwd, join(root, "sessions-source"));
	const firstUser = source.appendMessage({
		role: "user",
		content: "first branch",
		timestamp: Date.now(),
	});
	source.appendMessage(assistant("first answer"));
	source.appendMessage({ role: "user", content: "latest branch", timestamp: Date.now() });
	source.appendMessage(assistant("latest answer"));
	source.branch(firstUser);

	let switchedPath = "";
	const context = createMockContext({
		cwd: sourceCwd,
		hasUI: true,
		sessionManager: source,
		switchSession: async (
			path: string,
			options: { withSession?: (ctx: unknown) => Promise<void> },
		) => {
			switchedPath = path;
			await options.withSession?.({ cwd: targetCwd, ui: { notify() {} } });
			return { cancelled: false };
		},
	});

	try {
		assert.equal(await switchToWorktree(context.ctx, targetCwd), "switched");
		const switched = SessionManager.open(switchedPath);
		assert.equal(switched.getLeafId(), firstUser);
		assert.deepEqual(
			switched.buildSessionContext().messages.map((message) => message.role),
			["user"],
		);
		const firstMessage = switched.buildSessionContext().messages[0];
		assert.equal(firstMessage?.role, "user");
		assert.equal(firstMessage?.role === "user" ? firstMessage.content : undefined, "first branch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("switchToWorktree creates a readable empty v3 session when no entries exist", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-empty-session-"));
	const targetCwd = join(root, "target");
	let switchedPath = "";
	const context = createMockContext({
		hasUI: true,
		sessionManager: {
			getSessionFile: () => undefined,
			getEntries: () => [],
		},
		switchSession: async (
			path: string,
			options: { withSession?: (ctx: unknown) => Promise<void> },
		) => {
			switchedPath = path;
			await options.withSession?.({ cwd: targetCwd, ui: { notify() {} } });
			return { cancelled: false };
		},
	});

	try {
		assert.equal(await switchToWorktree(context.ctx, targetCwd), "switched");
		assert.ok(existsSync(switchedPath));
		const opened = SessionManager.open(switchedPath);
		assert.equal(opened.getHeader()?.version, 3);
		assert.equal(opened.getCwd(), targetCwd);
		assert.deepEqual(opened.getEntries(), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("switchToWorktree preserves a non-persisted conversation in the target session", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-ephemeral-session-"));
	const sourceCwd = join(root, "source");
	const targetCwd = join(root, "target");
	const source = SessionManager.inMemory(sourceCwd);
	const activeUser = source.appendMessage({
		role: "user",
		content: "continue ephemeral work",
		timestamp: Date.now(),
	});
	source.appendMessage(assistant("ephemeral answer"));
	source.appendMessage({ role: "user", content: "abandoned branch", timestamp: Date.now() });
	source.branch(activeUser);

	let switchedPath = "";
	const context = createMockContext({
		cwd: sourceCwd,
		hasUI: true,
		sessionManager: source,
		switchSession: async (
			path: string,
			options: { withSession?: (ctx: unknown) => Promise<void> },
		) => {
			switchedPath = path;
			await options.withSession?.({ cwd: targetCwd, ui: { notify() {} } });
			return { cancelled: false };
		},
	});

	try {
		assert.equal(await switchToWorktree(context.ctx, targetCwd), "switched");
		const switched = SessionManager.open(switchedPath);
		assert.equal(switched.getCwd(), targetCwd);
		assert.equal(switched.getLeafId(), activeUser);
		assert.deepEqual(
			switched.buildSessionContext().messages.map((message) => message.role),
			["user"],
		);
		const message = switched.buildSessionContext().messages[0];
		assert.equal(message?.role === "user" ? message.content : undefined, "continue ephemeral work");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("successful switching never uses the stale source UI after replacement", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-stale-session-"));
	let replacementNotifications = 0;
	const context = createMockContext({
		sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
		ui: {
			notify() {
				throw new Error("stale source context");
			},
		},
		switchSession: async (
			_path: string,
			options: { withSession?: (ctx: unknown) => Promise<void> },
		) => {
			await options.withSession?.({
				cwd: join(root, "target"),
				ui: { notify: () => (replacementNotifications += 1) },
			});
			return { cancelled: false };
		},
	});
	try {
		assert.equal(await switchToWorktree(context.ctx, join(root, "target")), "switched");
		assert.equal(replacementNotifications, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime replacement failure retains the prepared session and reports without throwing", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-failed-session-"));
	let prepared = "";
	const context = createMockContext({
		hasUI: true,
		sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
		switchSession: async (path: string) => {
			prepared = path;
			throw new Error("runtime rebuild failed");
		},
	});
	try {
		assert.equal(await switchToWorktree(context.ctx, join(root, "target")), "failed");
		assert.ok(existsSync(prepared));
		assert.match(context.notifications.at(-1)?.message ?? "", /retained.*runtime rebuild failed/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("switch cancellation retains the generated target session", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-cancel-session-"));
	let generated = "";
	const context = createMockContext({
		sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
		switchSession: async (path: string) => {
			generated = path;
			return { cancelled: true };
		},
	});
	try {
		assert.equal(await switchToWorktree(context.ctx, join(root, "target")), "cancelled");
		assert.ok(existsSync(generated));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
