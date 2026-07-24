import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext, createMockPi } from "../../../test/support.js";
import piStarship, {
	parseGitStatusPorcelain,
	parseGitWorktree,
	wrapFormattedStatusline,
} from "../src/pi-starship.js";

const lifecycleAgentDir = mkdtempSync(join(tmpdir(), "pi-starship-lifecycle-suite-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = lifecycleAgentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(lifecycleAgentDir, { recursive: true, force: true });
});

async function emit(
	events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
	name: string,
	...args: unknown[]
) {
	for (const handler of events.get(name) ?? []) await handler(...args);
}

type FooterFactory = (
	tui: { requestRender(): void },
	theme: unknown,
	data: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		onBranchChange(callback: () => void): () => void;
	},
) => { render(width: number): string[]; dispose(): void };

test("pi-starship registers lifecycle handlers without reading actions at factory load", () => {
	const mock = createMockPi();
	mock.rawPi.getThinkingLevel = () => {
		throw new Error("must wait for session_start");
	};
	assert.doesNotThrow(() => piStarship(mock.pi));
	assert.ok(mock.events.has("session_start"));
	assert.ok(mock.events.has("session_shutdown"));
	assert.ok(mock.events.has("tool_execution_start"));
});

test("session start creates the default settings file when it is missing", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-lifecycle-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const mock = createMockPi();
		piStarship(mock.pi);
		const context = createMockContext({ mode: "print" });
		await emit(mock.events, "session_start", {}, context.ctx);
		const settings = readFileSync(join(root, "pi-starship.toml"), "utf8");
		assert.match(settings, /^format = """/mu);
		assert.match(settings, /\$brand\\\n\$provider\\\n/u);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-TUI sessions install no footer and execute no git subprocess", async () => {
	const mock = createMockPi();
	let calls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => {
		calls += 1;
		return gitResult();
	};
	piStarship(mock.pi);
	const context = createMockContext({ mode: "print" });
	await emit(mock.events, "session_start", {}, context.ctx);
	await emit(mock.events, "tool_execution_end", { toolName: "read" }, context.ctx);
	assert.equal(context.footer, undefined);
	assert.equal(calls, 0);
});

test("turn module counts user messages instead of repeated LLM turns", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-turns-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(join(root, "pi-starship.toml"), "format = '$turn'\n");
		const mock = createMockPi();
		(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () =>
			gitResult();
		piStarship(mock.pi);
		const context = createMockContext({
			mode: "tui",
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user" } },
					{ type: "message", message: { role: "user" } },
				],
			},
		});
		await emit(mock.events, "session_start", {}, context.ctx);
		await emit(mock.events, "turn_start", {}, context.ctx);
		await emit(mock.events, "turn_start", {}, context.ctx);
		await emit(mock.events, "turn_start", {}, context.ctx);
		const footer = (context.footer as FooterFactory)(
			{ requestRender() {} },
			{},
			{
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
		assert.equal(stripAnsi(footer.render(80).join("\n")), "🔁 #2 ");
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("TUI footer renders cached state and parallel tool activity without executing during render", async () => {
	const mock = createMockPi({ thinkingLevel: "high" });
	let calls = 0;
	let worktreeCalls = 0;
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (_command: string, args: string[]) => Promise<ExecResult>;
		}
	).exec = async (_command, args) => {
		calls += 1;
		if (args[0] === "rev-parse") {
			worktreeCalls += 1;
			return gitResult("/work/pi-feature\n/work/pi/.git\n/work/pi/.git/worktrees/pi-feature\n");
		}
		return gitResult(
			"# branch.oid abcdef1234567890\n# branch.head main\n1 .M N... 100644 100644 100644 a b changed.ts\n",
		);
	};
	piStarship(mock.pi);
	const context = createMockContext({
		mode: "tui",
		model: { provider: "anthropic", id: "claude-sonnet-4" },
		getContextUsage: () => ({ percent: 50, tokens: 500, contextWindow: 1000 }),
	});
	await emit(mock.events, "session_start", {}, context.ctx);
	await flushAsync();
	let branchChange: (() => void) | undefined;
	const footer = (context.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange: (callback) => {
				branchChange = callback;
				return () => undefined;
			},
		},
	);
	await emit(mock.events, "tool_execution_start", { toolName: "read" }, context.ctx);
	await emit(mock.events, "tool_execution_start", { toolName: "read" }, context.ctx);
	await emit(mock.events, "tool_execution_start", { toolName: "bash" }, context.ctx);
	branchChange?.();
	await flushAsync();
	assert.equal(worktreeCalls, 2);
	const beforeRender = calls;
	const lines = footer.render(300);
	assert.equal(calls, beforeRender);
	assert.match(stripAnsi(lines.join("\n")), /pi-feature/);
	assert.match(stripAnsi(lines.join("\n")), /read×2\+1/);
	assert.match(stripAnsi(lines.join("\n")), /!1/);
	footer.dispose();
	await emit(mock.events, "session_shutdown", {}, context.ctx);
});

test("stale Git results from a replaced session cannot overwrite the new footer", async () => {
	const mock = createMockPi();
	const first = deferred<ExecResult>();
	const second = deferred<ExecResult>();
	const pending = [first.promise, second.promise];
	let calls = 0;
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (_command: string, args: string[]) => Promise<ExecResult>;
		}
	).exec = async (_command, args) => {
		if (args[0] === "rev-parse") {
			return gitResult("/work/main\n/work/main/.git\n/work/main/.git\n");
		}
		const result = pending[calls];
		calls += 1;
		if (!result) throw new Error("unexpected git status call");
		return result;
	};
	piStarship(mock.pi);
	const oldContext = createMockContext({ mode: "tui", cwd: join(tmpdir(), "old") });
	const newContext = createMockContext({ mode: "tui", cwd: join(tmpdir(), "new") });
	await emit(mock.events, "session_start", {}, oldContext.ctx);
	await emit(mock.events, "session_shutdown", {}, oldContext.ctx);
	await emit(mock.events, "session_start", {}, newContext.ctx);
	first.resolve(
		gitResult(
			"# branch.oid abcdef1234567890\n# branch.head old\n1 .M N... 100644 100644 100644 a b stale.ts\n",
		),
	);
	await flushAsync();
	second.resolve(gitResult("# branch.oid abcdef1234567890\n# branch.head new\n? fresh.ts\n"));
	await flushAsync();
	const footer = (newContext.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "new",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	const output = stripAnsi(footer.render(300).join("\n"));
	assert.doesNotMatch(output, /!1/);
	assert.match(output, /\?1/);
	footer.dispose();
	await emit(mock.events, "session_shutdown", {}, newContext.ctx);
});

test("stale worktree identity from a replaced session cannot overwrite the new footer", async () => {
	const mock = createMockPi();
	const oldWorktree = deferred<ExecResult>();
	const newWorktree = deferred<ExecResult>();
	const pendingWorktrees = [oldWorktree.promise, newWorktree.promise];
	let worktreeCalls = 0;
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (_command: string, args: string[]) => Promise<ExecResult>;
		}
	).exec = async (_command, args) => {
		if (args[0] !== "rev-parse") return gitResult();
		const result = pendingWorktrees[worktreeCalls];
		worktreeCalls += 1;
		if (!result) throw new Error("unexpected Git worktree call");
		return result;
	};
	piStarship(mock.pi);
	const oldContext = createMockContext({ mode: "tui", cwd: "/work/old" });
	const newContext = createMockContext({ mode: "tui", cwd: "/work/new" });
	await emit(mock.events, "session_start", {}, oldContext.ctx);
	await emit(mock.events, "session_shutdown", {}, oldContext.ctx);
	await emit(mock.events, "session_start", {}, newContext.ctx);
	oldWorktree.resolve(gitResult("/work/old\n/work/main/.git\n/work/main/.git/worktrees/old\n"));
	await flushAsync();
	newWorktree.resolve(
		gitResult("/work/new-worktree\n/work/main/.git\n/work/main/.git/worktrees/new-worktree\n"),
	);
	await flushAsync();

	const footer = (newContext.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	const output = stripAnsi(footer.render(300).join("\n"));
	assert.match(output, /new-worktree/);
	assert.doesNotMatch(output, /old/);
	footer.dispose();
	await emit(mock.events, "session_shutdown", {}, newContext.ctx);
});

test("installed pi-statusline produces one conflict warning and package aliases", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({
				packages: ["npm:@narumitw/pi-statusline", "npm:@vendor/pi-foo@1.0.0"],
			}),
		);
		writeFileSync(
			join(root, "pi-starship.toml"),
			"format = '$extension_status'\n[extension_status.icons]\n'@vendor/pi-foo' = '🧪'\n",
		);
		const mock = createMockPi();
		(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () =>
			gitResult();
		piStarship(mock.pi);
		const context = createMockContext({ mode: "tui" });
		await emit(mock.events, "session_start", {}, context.ctx);
		await emit(mock.events, "session_start", {}, context.ctx);
		assert.equal(
			context.notifications.filter((notice) =>
				/pi-statusline.*footer conflict/iu.test(notice.message),
			).length,
			1,
		);
		const footer = (context.footer as FooterFactory)(
			{ requestRender() {} },
			{},
			{
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map([["foo:server", "running"]]),
				onBranchChange: () => () => undefined,
			},
		);
		assert.match(footer.render(100).join(""), /🧪 running/);
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("formatted output wraps every logical line without ellipsis", () => {
	const link = "\x1b]8;;https://example.test\x07linked\x1b]8;;\x07";
	const lines = wrapFormattedStatusline(`first line\n${link} ${"word ".repeat(10)}`, 14);
	assert.ok(lines.length > 3);
	assert.ok(lines.every((line) => visibleWidth(line) <= 14));
	assert.equal(lines.join(" ").includes("…"), false);
	assert.match(lines.join(" "), /word/);
});

test("Git porcelain parser returns all compact counters", () => {
	assert.deepEqual(
		parseGitStatusPorcelain(
			`## main...origin/main [ahead 2, behind 1]\nM  staged\n M modified\n?? new\nUU conflict\n`,
		),
		{
			ahead: 2,
			behind: 1,
			stashed: 0,
			conflicted: 1,
			deleted: 0,
			renamed: 0,
			modified: 1,
			staged: 1,
			typechanged: 0,
			untracked: 1,
			worktreeAdded: 0,
			worktreeDeleted: 0,
			worktreeModified: 1,
			worktreeTypechanged: 0,
			indexAdded: 0,
			indexDeleted: 0,
			indexModified: 1,
			indexTypechanged: 0,
		},
	);
});

test("Git worktree parser distinguishes linked and primary worktrees", () => {
	assert.deepEqual(
		parseGitWorktree("/work/pi-feature\n/work/pi/.git\n/work/pi/.git/worktrees/pi-feature\n"),
		{ name: "pi-feature", path: "/work/pi-feature" },
	);
	assert.equal(parseGitWorktree("/work/pi\n/work/pi/.git\n/work/pi/.git\n"), undefined);
	assert.equal(parseGitWorktree("malformed\n"), undefined);
});

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

function gitResult(stdout = "## main\n"): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function stripAnsi(value: string): string {
	const escapeSequence = String.fromCharCode(27);
	return value.replace(new RegExp(`${escapeSequence}\\[[0-9;]*m`, "gu"), "");
}

function deferred<T>() {
	let resolveValue: ((value: T) => void) | undefined;
	return {
		promise: new Promise<T>((resolve) => {
			resolveValue = resolve;
		}),
		resolve(value: T) {
			resolveValue?.(value);
		},
	};
}

async function flushAsync() {
	await new Promise((resolve) => setImmediate(resolve));
}
