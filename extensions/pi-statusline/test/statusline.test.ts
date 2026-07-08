import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext, createMockPi } from "../../../test/support.js";
import statusline, {
	contextColor,
	extensionColor,
	formatCount,
	formatExtensionStatus,
	formatGitBranchText,
	formatGitStatusSummary,
	formatToolActivity,
	npmPackageName,
	parseGitStatusPorcelain,
	prLinkFromStatuses,
	readStatuslineSettings,
	shortenModel,
	simplifyExtensionStatusText,
	splitExtensionStatusIcon,
	stripExtensionStatusPrefix,
	wrapExtensionStatusline,
} from "../src/statusline.js";

async function emit(
	events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
	name: string,
	...args: unknown[]
) {
	for (const handler of events.get(name) ?? []) await handler(...args);
}

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

function deferred<T>() {
	let resolveValue: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolveValue = resolve;
	});
	return {
		promise,
		resolve(value: T) {
			resolveValue?.(value);
		},
	};
}

async function flushAsync() {
	await new Promise((resolve) => setImmediate(resolve));
}

test("statusline registers lifecycle handlers without reading thinking level at load time", () => {
	const mock = createMockPi();
	mock.rawPi.getThinkingLevel = () => {
		throw new Error("should be deferred until session_start");
	};

	assert.doesNotThrow(() => statusline(mock.pi));
	assert.ok(mock.events.has("session_start"));
	assert.ok(mock.events.has("tool_execution_start"));
});

test("statusline skips git status refreshes outside TUI mode", async () => {
	const mock = createMockPi();
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const { ctx } = createMockContext({ mode: "print" });

	await emit(mock.events, "session_start", {}, ctx);
	await emit(mock.events, "tool_execution_end", { toolName: "write" }, ctx);

	assert.equal(execCalls, 0);

	async function execGitStatus() {
		execCalls += 1;
		return { stdout: "## main\n", stderr: "", code: 0, killed: false };
	}
});

test("statusline renders cached git status without executing git during render", async () => {
	const mock = createMockPi();
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const context = createMockContext({ mode: "tui" });

	await emit(mock.events, "session_start", {}, context.ctx);
	const footerFactory = context.footer as (
		tui: { requestRender(): void },
		theme: { fg(_color: string, text: string): string; bold(text: string): string },
		footerData: {
			getGitBranch(): string | null;
			getExtensionStatuses(): ReadonlyMap<string, string>;
			onBranchChange(callback: () => void): () => void;
		},
	) => { render(width: number): string[]; dispose(): void };
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	const callsBeforeRender = execCalls;

	footer.render(120);
	footer.dispose();

	assert.equal(execCalls, callsBeforeRender);
	assert.equal(callsBeforeRender, 1);

	async function execGitStatus() {
		execCalls += 1;
		return { stdout: "## main\n M changed.ts\n", stderr: "", code: 0, killed: false };
	}
});

test("statusline ignores stale git refresh events from a previous cwd", async () => {
	const mock = createMockPi();
	const cwdCalls: string[] = [];
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const oldCwd = join(tmpdir(), "stale-a");
	const newCwd = join(tmpdir(), "current-b");
	const oldContext = createMockContext({ mode: "tui", cwd: oldCwd });
	const newContext = createMockContext({ mode: "tui", cwd: newCwd });

	await emit(mock.events, "session_start", {}, oldContext.ctx);
	await emit(mock.events, "session_shutdown", {}, oldContext.ctx);
	await emit(mock.events, "session_start", {}, newContext.ctx);
	await emit(mock.events, "tool_execution_end", { toolName: "write" }, oldContext.ctx);
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.deepEqual(cwdCalls, [oldCwd, newCwd]);

	async function execGitStatus(_command: string, _args: string[], options?: { cwd?: string }) {
		cwdCalls.push(options?.cwd ?? "");
		return { stdout: "## main\n", stderr: "", code: 0, killed: false };
	}
});

test("statusline stops git refreshes after its footer is disposed", async () => {
	const mock = createMockPi();
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const context = createMockContext({ mode: "tui" });

	await emit(mock.events, "session_start", {}, context.ctx);
	const footerFactory = context.footer as (
		tui: { requestRender(): void },
		theme: { fg(_color: string, text: string): string; bold(text: string): string },
		footerData: {
			getGitBranch(): string | null;
			getExtensionStatuses(): ReadonlyMap<string, string>;
			onBranchChange(callback: () => void): () => void;
		},
	) => { dispose(): void; render(width: number): string[] };
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	footer.dispose();
	await emit(mock.events, "tool_execution_end", { toolName: "write" }, context.ctx);
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.equal(execCalls, 1);

	async function execGitStatus() {
		execCalls += 1;
		return { stdout: "## main\n", stderr: "", code: 0, killed: false };
	}
});

test("statusline does not render stale in-flight git status after a branch change", async () => {
	const mock = createMockPi();
	const firstStatus = deferred<ExecResult>();
	const secondStatus = deferred<ExecResult>();
	const execResults = [firstStatus.promise, secondStatus.promise];
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const context = createMockContext({ mode: "tui" });

	await emit(mock.events, "session_start", {}, context.ctx);
	let branchChange: (() => void) | undefined;
	const footerFactory = context.footer as (
		tui: { requestRender(): void },
		theme: { fg(_color: string, text: string): string; bold(text: string): string },
		footerData: {
			getGitBranch(): string | null;
			getExtensionStatuses(): ReadonlyMap<string, string>;
			onBranchChange(callback: () => void): () => void;
		},
	) => { dispose(): void; render(width: number): string[] };
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange(callback) {
				branchChange = callback;
				return () => {
					branchChange = undefined;
				};
			},
		},
	);

	assert.equal(execCalls, 1);
	assert.ok(branchChange);
	branchChange();
	firstStatus.resolve({ stdout: "## main\n M stale.ts\n", stderr: "", code: 0, killed: false });
	await flushAsync();

	assert.equal(execCalls, 2);
	assert.equal(footer.render(120).join("\n").includes("~1"), false);

	secondStatus.resolve({ stdout: "## main\n?? fresh.ts\n", stderr: "", code: 0, killed: false });
	await flushAsync();

	assert.match(footer.render(120).join("\n"), /\?1/u);
	footer.dispose();

	async function execGitStatus() {
		const result = execResults[execCalls];
		execCalls += 1;
		if (!result) throw new Error("unexpected git status refresh");
		return result;
	}
});

test("statusline invalidates in-flight git status while a debounced refresh is pending", async () => {
	const mock = createMockPi();
	const firstStatus = deferred<ExecResult>();
	const secondStatus = deferred<ExecResult>();
	const execResults = [firstStatus.promise, secondStatus.promise];
	let execCalls = 0;
	(mock.rawPi as typeof mock.rawPi & { exec: typeof execGitStatus }).exec = execGitStatus;
	statusline(mock.pi);
	const context = createMockContext({ mode: "tui" });

	await emit(mock.events, "session_start", {}, context.ctx);
	const footerFactory = context.footer as (
		tui: { requestRender(): void },
		theme: { fg(_color: string, text: string): string; bold(text: string): string },
		footerData: {
			getGitBranch(): string | null;
			getExtensionStatuses(): ReadonlyMap<string, string>;
			onBranchChange(callback: () => void): () => void;
		},
	) => { dispose(): void; render(width: number): string[] };
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color, text) => text, bold: (text) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);

	assert.equal(execCalls, 1);
	await emit(mock.events, "tool_execution_end", { toolName: "write" }, context.ctx);
	firstStatus.resolve({ stdout: "## main\n M stale.ts\n", stderr: "", code: 0, killed: false });
	await flushAsync();

	assert.equal(execCalls, 1);
	assert.equal(footer.render(120).join("\n").includes("~1"), false);

	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(execCalls, 2);
	secondStatus.resolve({ stdout: "## main\n?? fresh.ts\n", stderr: "", code: 0, killed: false });
	await flushAsync();

	assert.match(footer.render(120).join("\n"), /\?1/u);
	footer.dispose();

	async function execGitStatus() {
		const result = execResults[execCalls];
		execCalls += 1;
		if (!result) throw new Error("unexpected git status refresh");
		return result;
	}
});

test("formatToolActivity prioritizes active tools, streaming, completed tools, and idle", () => {
	type Runtime = Parameters<typeof formatToolActivity>[0];
	const runtime = (value: Partial<Runtime> & Pick<Runtime, "activeTools" | "isStreaming">) =>
		value as Runtime;

	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map([["read", 2]]), isStreaming: false })),
		"⚙ read×2",
	);
	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map(), isStreaming: true })),
		"💭 thinking",
	);
	assert.equal(
		formatToolActivity(
			runtime({
				activeTools: new Map(),
				isStreaming: false,
				lastCompletedTool: "bash",
			}),
		),
		"✅ bash",
	);
	assert.equal(
		formatToolActivity(runtime({ activeTools: new Map(), isStreaming: false })),
		"💤 idle",
	);
});

test("extension status helpers strip prefixes, icons, and simplify text", () => {
	assert.deepEqual(splitExtensionStatusIcon("🔥 running crawl"), {
		icon: "🔥",
		text: "running crawl",
	});
	assert.deepEqual(splitExtensionStatusIcon("plain status"), { text: "plain status" });
	assert.equal(stripExtensionStatusPrefix("firecrawl", "firecrawl: ready"), "ready");
	assert.equal(simplifyExtensionStatusText("ready, missing (details)"), "✓ ✗");
	assert.equal(extensionColor("codex", "checking"), "accent");
	assert.equal(extensionColor("lsp", "command missing"), "warning");
});

test("prLinkFromStatuses keeps the linked PR token and drops the tail and non-PR states", () => {
	const link = "\x1b]8;;https://github.com/o/r/pull/123\x07#123\x1b]8;;\x07";
	assert.equal(
		prLinkFromStatuses(new Map([["github-pr", `PR ${link}: checks failing (1), approved`]])),
		link,
	);
	assert.equal(prLinkFromStatuses(new Map([["github-pr", "PR gh missing"]])), undefined);
	assert.equal(prLinkFromStatuses(new Map()), undefined);
});

test("git status parser and formatter produce compact dirty tokens", () => {
	const summary = parseGitStatusPorcelain(`## main...origin/main [ahead 2, behind 1]
M  staged-modified.ts
A  staged-added.ts
 M modified.ts
 D deleted.ts
?? new-file.ts
UU conflicted.ts
`);

	assert.deepEqual(summary, {
		ahead: 2,
		behind: 1,
		staged: 2,
		modified: 2,
		untracked: 1,
		conflicts: 1,
	});
	assert.equal(formatGitStatusSummary(summary), "⇡2 ⇣1 +2 ~2 ?1 !1");
});

test("git status formatter omits clean markers", () => {
	const summary = parseGitStatusPorcelain("## main...origin/main\n");

	assert.deepEqual(summary, {
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicts: 0,
	});
	assert.equal(formatGitStatusSummary(summary), "");
	assert.equal(formatGitBranchText("main", summary), "🌿 main");
});

test("git branch text includes compact status before PR link", () => {
	const link = "\x1b]8;;https://github.com/o/r/pull/123\x07#123\x1b]8;;\x07";

	assert.equal(
		formatGitBranchText(
			"feature",
			{ ahead: 1, behind: 0, staged: 3, modified: 0, untracked: 2, conflicts: 0 },
			link,
		),
		`🌿 feature ⇡1 +3 ?2 (${link})`,
	);
	assert.equal(formatGitBranchText(null, undefined), "🌿 no-git");
});

test("statusline settings load extension icon overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-test-"));
	const settingsPath = join(root, "pi-statusline-settings.json");

	assert.deepEqual(readStatuslineSettings(settingsPath), { extensionStatusIcons: {} });

	writeFileSync(
		settingsPath,
		JSON.stringify({ extensionStatusIcons: { goal: "", caffeinate: "☕", bad: 1 } }),
	);
	assert.deepEqual(readStatuslineSettings(settingsPath), {
		extensionStatusIcons: { goal: "", caffeinate: "☕" },
	});

	writeFileSync(settingsPath, "not json");
	assert.deepEqual(readStatuslineSettings(settingsPath), { extensionStatusIcons: {} });
});

test("extension status icons use config, leading emoji, defaults, and fallback", () => {
	const theme = { fg: (_color: string, text: string) => text } as never;
	const config = (extensionStatusIcons: Record<string, string>) => ({ extensionStatusIcons });

	assert.equal(formatExtensionStatus("goal", "active", theme, config({})), "🎯 active");
	assert.equal(
		formatExtensionStatus("github-pr", "PR #123 checks passing", theme, config({})),
		"🔎 PR #123 checks passing",
	);
	assert.equal(
		formatExtensionStatus(
			"github-pr",
			"PR #123: checks pending (12), changes requested, 45 comments",
			theme,
			config({}),
		),
		"🔎 PR #123: checks pending (12) changes requested 45 comments",
	);
	assert.equal(
		formatExtensionStatus("caffeinate", "☕ display", theme, config({ caffeinate: "🍵" })),
		"🍵 display",
	);
	assert.equal(formatExtensionStatus("caffeinate", "☕ display", theme, config({})), "☕ display");
	assert.equal(formatExtensionStatus("goal", "active", theme, config({ goal: "" })), "active");
	assert.equal(formatExtensionStatus("unknown", "running", theme, config({})), "🔌 running");
});

test("long extension status lines wrap to terminal width without ellipsis", () => {
	const lines = wrapExtensionStatusline(
		"🔎 PR #123: checks pending (12) changes requested 45 comments",
		30,
	);

	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => visibleWidth(line) <= 30));
	assert.equal(lines.join(" ").includes("…"), false);
	assert.match(lines.join(" "), /45 comments/);
});

test("statusline compact formatting helpers", () => {
	assert.equal(contextColor(undefined), "dim");
	assert.equal(contextColor(75), "warning");
	assert.equal(formatCount(1530), "1.5k");
	assert.equal(formatCount(1_200_000), "1.2m");
	assert.equal(shortenModel("claude-sonnet-20241022"), "sonnet");
	assert.equal(shortenModel("gpt-5.3-codex-latest"), "gpt 5.3-codex");
	assert.equal(npmPackageName("npm:@narumitw/pi-goal@0.4.1"), "@narumitw/pi-goal");
	assert.equal(npmPackageName("npm:typescript@latest"), "typescript");
});
