import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterAll, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import piStarshipRuntime, {
	parseGitStatusPorcelain,
	parseGitWorktree,
	wrapFormattedStatusline,
} from "../src/pi-starship.js";

const lifecycleAgentDir = mkdtempSync(join(tmpdir(), "pi-starship-lifecycle-suite-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = lifecycleAgentDir;
afterAll(() => {
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

function piStarship(pi: Parameters<typeof piStarshipRuntime>[0]) {
	return piStarshipRuntime(pi, {
		githubPrExec: (command, args, options) =>
			pi.exec(command, args, {
				cwd: options.cwd,
				signal: options.signal,
				timeout: options.timeout,
			}),
	});
}

function useLifecycleConfig(
	t: { onTestFinished(callback: () => void): void },
	rawDocument: string,
) {
	const path = join(lifecycleAgentDir, "pi-starship.toml");
	writeFileSync(path, rawDocument);
	t.onTestFinished(() => rmSync(path, { force: true }));
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

test("session start uses built-in settings without materializing a missing file", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-lifecycle-"));
	const agentDir = join(root, "agent");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const mock = createMockPi();
		piStarship(mock.pi);
		const context = createMockContext({ mode: "print" });
		await emit(mock.events, "session_start", {}, context.ctx);
		await emit(mock.events, "session_start", {}, context.ctx);
		assert.equal(existsSync(agentDir), false);
		assert.deepEqual(context.notifications, []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-TUI sessions install no footer and execute no Git or GitHub subprocess", async () => {
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

test("the footer honors the effective true-color capability", async (t) => {
	useLifecycleConfig(t, 'format = "[status](fg:#010203 bg:#a3aed2)"\n');
	const previousCapabilities = getCapabilities();
	setCapabilities({ ...previousCapabilities, trueColor: false });
	const mock = createMockPi();
	piStarship(mock.pi);
	const context = createMockContext({ mode: "tui" });
	let footer: ReturnType<FooterFactory> | undefined;

	try {
		await emit(mock.events, "session_start", {}, context.ctx);
		const footerData = {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map<string, string>(),
			onBranchChange: () => () => undefined,
		};
		footer = (context.footer as FooterFactory)({ requestRender() {} }, {}, footerData);
		const rendered = footer.render(80).join("\n");
		assert.equal(rendered.includes("\u001b[38;2;"), false);
		assert.equal(rendered.includes("\u001b[48;2;"), false);
		assert.equal(rendered.includes("\u001b[38;5;") || rendered.includes("\u001b[48;5;"), true);
		assert.equal(stripAnsi(rendered), "status");
	} finally {
		footer?.dispose();
		try {
			await emit(mock.events, "session_shutdown", {}, context.ctx);
		} finally {
			setCapabilities(previousCapabilities);
		}
	}
});

test("UI prompt waiting state restores activity and rejects stale session events", async (t) => {
	useLifecycleConfig(t, "format = '$activity'\n");
	const mock = createMockPi();
	piStarship(mock.pi);
	const oldContext = createMockContext({ mode: "tui" });
	const newContext = createMockContext({ mode: "tui" });
	await emit(mock.events, "session_start", {}, oldContext.ctx);
	const footerData = {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		onBranchChange: () => () => undefined,
	};
	const oldFooter = (oldContext.footer as FooterFactory)({ requestRender() {} }, {}, footerData);
	try {
		await emit(mock.events, "agent_start", {}, oldContext.ctx);
		await emit(mock.events, "tool_execution_start", { toolName: "read" }, oldContext.ctx);
		await emit(
			mock.events,
			"ui_prompt_start",
			{ kind: "confirm", title: "Deploy production?" },
			oldContext.ctx,
		);
		assert.match(
			stripAnsi(oldFooter.render(200).join("\n")),
			/waiting for confirm · Deploy production\?/u,
		);
		await emit(mock.events, "ui_prompt_end", { kind: "confirm" }, oldContext.ctx);
		assert.match(stripAnsi(oldFooter.render(200).join("\n")), /read/u);
		await emit(mock.events, "tool_execution_end", { toolName: "read" }, oldContext.ctx);
		assert.match(stripAnsi(oldFooter.render(200).join("\n")), /thinking/u);
		await emit(mock.events, "ui_prompt_start", { kind: "custom" }, oldContext.ctx);
		assert.match(stripAnsi(oldFooter.render(200).join("\n")), /waiting for custom/u);
		await emit(mock.events, "ui_prompt_end", { kind: "custom" }, oldContext.ctx);
		assert.match(stripAnsi(oldFooter.render(200).join("\n")), /thinking/u);

		await emit(mock.events, "ui_prompt_start", { kind: "editor" }, oldContext.ctx);
		await emit(mock.events, "session_start", {}, newContext.ctx);
		const newFooter = (newContext.footer as FooterFactory)({ requestRender() {} }, {}, footerData);
		try {
			assert.match(stripAnsi(newFooter.render(200).join("\n")), /idle/u);
			await emit(mock.events, "ui_prompt_end", { kind: "editor" }, oldContext.ctx);
			await emit(
				mock.events,
				"ui_prompt_start",
				{ kind: "input", title: "Current prompt" },
				newContext.ctx,
			);
			await emit(mock.events, "ui_prompt_end", { kind: "editor" }, oldContext.ctx);
			assert.match(
				stripAnsi(newFooter.render(200).join("\n")),
				/waiting for input · Current prompt/u,
			);
			await emit(mock.events, "ui_prompt_end", { kind: "input" }, newContext.ctx);
			assert.match(stripAnsi(newFooter.render(200).join("\n")), /idle/u);
			await emit(mock.events, "session_shutdown", {}, newContext.ctx);
			assert.equal(newContext.footer, undefined);
		} finally {
			newFooter.dispose();
		}
	} finally {
		oldFooter.dispose();
	}
});

test("reachable directory alone collects repository-root metadata", async (t) => {
	useLifecycleConfig(t, "format = '$directory'\n");
	const mock = createMockPi();
	let statusCalls = 0;
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (_command: string, args: string[]) => Promise<ExecResult>;
		}
	).exec = async (_command, args) => {
		if (args.includes("status")) statusCalls += 1;
		if (args[0] === "rev-parse") return gitResult("/workspace\n/workspace/.git\n/workspace/.git\n");
		return gitResult("# branch.oid 0123456789abcdef\n# branch.head main\n");
	};
	piStarship(mock.pi);
	const context = createMockContext({ mode: "tui", cwd: "/workspace/src" });
	await emit(mock.events, "session_start", {}, context.ctx);
	await flushAsync();
	assert.equal(statusCalls, 1);
	await emit(mock.events, "session_shutdown", {}, context.ctx);
});

test("unreachable and disabled native PR modules execute no gh command", async () => {
	for (const source of ["format = '$model'\n", "[github_pr]\ndisabled = true\n"]) {
		const root = mkdtempSync(join(tmpdir(), "pi-starship-pr-gate-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		try {
			writeFileSync(join(root, "pi-starship.toml"), source);
			const mock = createMockPi();
			let prCalls = 0;
			(
				mock.rawPi as typeof mock.rawPi & {
					exec: (_command: string, args: string[]) => Promise<ExecResult>;
				}
			).exec = async (_command, args) => {
				if (isGithubPrCall(args)) prCalls += 1;
				return gitResult();
			};
			piStarship(mock.pi);
			const context = createMockContext({ mode: "tui" });
			await emit(mock.events, "session_start", {}, context.ctx);
			await flushAsync();
			assert.equal(prCalls, 0, source);
			await emit(mock.events, "session_shutdown", {}, context.ctx);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("native PR refresh clears branch state, aborts stale work, and stops on footer disposal", async (t) => {
	useLifecycleConfig(t, "format = '$github_pr'\n");
	const mock = createMockPi();
	const stale = deferred<ExecResult>();
	const fresh = deferred<ExecResult>();
	const disposal = deferred<ExecResult>();
	const prResults: Promise<ExecResult>[] = [
		Promise.resolve(pullRequestResult(123)),
		stale.promise,
		fresh.promise,
		disposal.promise,
	];
	const prSignals: AbortSignal[] = [];
	let prCalls = 0;
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (
				command: string,
				args: string[],
				options: { signal?: AbortSignal },
			) => Promise<ExecResult>;
		}
	).exec = async (_command, args, options) => {
		if (!isGithubPrCall(args)) return gitResult();
		prCalls += 1;
		if (options.signal) prSignals.push(options.signal);
		const result = prResults.shift();
		if (!result) throw new Error("unexpected gh pr view call");
		return result;
	};
	piStarship(mock.pi);
	const context = createMockContext({ mode: "tui" });
	await emit(mock.events, "session_start", {}, context.ctx);
	await flushAsync();
	let branchChange: (() => void) | undefined;
	const footer = (context.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "feature",
			getExtensionStatuses: () => new Map(),
			onBranchChange: (callback) => {
				branchChange = callback;
				return () => undefined;
			},
		},
	);
	assert.match(stripAnsi(footer.render(300).join("\n")), /PR #123 · ✓1/u);

	await emit(mock.events, "agent_end", {}, context.ctx);
	assert.equal(prCalls, 2);
	branchChange?.();
	assert.equal(prCalls, 2);
	assert.equal(prSignals[1]?.aborted, true);
	assert.doesNotMatch(stripAnsi(footer.render(300).join("\n")), /#123/u);

	stale.resolve(pullRequestResult(999));
	await flushAsync();
	assert.equal(prCalls, 3);
	assert.doesNotMatch(stripAnsi(footer.render(300).join("\n")), /#999/u);
	fresh.resolve(pullRequestResult(456));
	await flushAsync();
	assert.match(stripAnsi(footer.render(300).join("\n")), /PR #456/u);

	await emit(mock.events, "agent_end", {}, context.ctx);
	assert.equal(prCalls, 4);
	footer.dispose();
	assert.equal(prSignals[3]?.aborted, true);
	disposal.resolve(pullRequestResult(777));
	await flushAsync();
	await emit(mock.events, "session_shutdown", {}, context.ctx);
});

test("accepted settings disable and re-enable native PR refresh immediately", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-pr-settings-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(join(root, "pi-starship.toml"), "format = '$github_pr'\n");
		const mock = createMockPi();
		const stale = deferred<ExecResult>();
		const prSignals: AbortSignal[] = [];
		let prCalls = 0;
		(
			mock.rawPi as typeof mock.rawPi & {
				exec: (
					command: string,
					args: string[],
					options: { signal?: AbortSignal },
				) => Promise<ExecResult>;
			}
		).exec = async (_command, args, options) => {
			if (!isGithubPrCall(args)) return gitResult();
			prCalls += 1;
			if (options.signal) prSignals.push(options.signal);
			if (prCalls === 1) return pullRequestResult(123);
			if (prCalls === 2) return stale.promise;
			return pullRequestResult(456);
		};
		piStarship(mock.pi);
		const drafts = ["format = '$model'\n", "format = '$github_pr'\n"];
		const tui = createTuiHarness({ width: 80, rows: 24 });
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			editor: async () => drafts.shift(),
			custom: tui.custom,
			confirm: async () => true,
		});
		await emit(mock.events, "session_start", {}, context.ctx);
		await flushAsync();
		const footer = (context.footer as FooterFactory)(
			{ requestRender() {} },
			{},
			{
				getGitBranch: () => "feature",
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
		assert.match(stripAnsi(footer.render(300).join("\n")), /#123/u);

		await emit(mock.events, "agent_end", {}, context.ctx);
		assert.equal(prCalls, 2);
		const disableSettings = mock.commands.get("starship")?.handler("settings", context.ctx);
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await disableSettings;
		assert.equal(prSignals[1]?.aborted, true);
		assert.equal(prCalls, 2);
		assert.doesNotMatch(stripAnsi(footer.render(300).join("\n")), /#123/u);
		stale.resolve(pullRequestResult(999));
		await flushAsync();
		assert.doesNotMatch(stripAnsi(footer.render(300).join("\n")), /#999/u);

		const enableSettings = mock.commands.get("starship")?.handler("settings", context.ctx);
		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await enableSettings;
		await flushAsync();
		assert.equal(prCalls, 3);
		assert.match(stripAnsi(footer.render(300).join("\n")), /#456/u);
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("session replacement cancels an awaited settings edit before saving or applying", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-stale-settings-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const mock = createMockPi();
		(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => ({
			stdout: "",
			stderr: "no PR",
			code: 1,
			killed: false,
		});
		piStarship(mock.pi);
		const edited = deferred<string | undefined>();
		const oldContext = createMockContext({ mode: "tui", editor: async () => edited.promise });
		const newContext = createMockContext({ mode: "tui", cwd: "/work/replacement" });
		await emit(mock.events, "session_start", {}, oldContext.ctx);
		const command = mock.commands.get("starship")?.handler("settings", oldContext.ctx);
		await flushAsync();
		await emit(mock.events, "session_start", {}, newContext.ctx);
		edited.resolve("format = '$github_pr'\n");
		await command;
		assert.equal(existsSync(join(root, "pi-starship.toml")), false);
		await emit(mock.events, "session_shutdown", {}, newContext.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("same-cwd session replacement aborts and rejects stale native PR publication", async (t) => {
	useLifecycleConfig(t, "format = '$github_pr'\n");
	const mock = createMockPi();
	const oldResult = deferred<ExecResult>();
	const newResult = deferred<ExecResult>();
	const shutdownResult = deferred<ExecResult>();
	const results = [oldResult.promise, newResult.promise, shutdownResult.promise];
	const signals: AbortSignal[] = [];
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (
				command: string,
				args: string[],
				options: { signal?: AbortSignal },
			) => Promise<ExecResult>;
		}
	).exec = async (_command, args, options) => {
		if (!isGithubPrCall(args)) return gitResult();
		if (options.signal) signals.push(options.signal);
		const result = results.shift();
		if (!result) throw new Error("unexpected gh pr view call");
		return result;
	};
	piStarship(mock.pi);
	const oldContext = createMockContext({ mode: "tui", cwd: "/work/shared" });
	const newContext = createMockContext({ mode: "tui", cwd: "/work/shared" });
	await emit(mock.events, "session_start", {}, oldContext.ctx);
	let staleBranchChange: (() => void) | undefined;
	const oldFooter = (oldContext.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "feature",
			getExtensionStatuses: () => new Map(),
			onBranchChange: (callback) => {
				staleBranchChange = callback;
				return () => undefined;
			},
		},
	);
	await emit(mock.events, "session_start", {}, newContext.ctx);
	assert.equal(signals[0]?.aborted, true);
	oldResult.resolve(pullRequestResult(111));
	newResult.resolve(pullRequestResult(222));
	await flushAsync();
	const footer = (newContext.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "feature",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	const rendered = stripAnsi(footer.render(300).join("\n"));
	assert.match(rendered, /#222/u);
	assert.doesNotMatch(rendered, /#111/u);

	staleBranchChange?.();
	await emit(mock.events, "session_shutdown", {}, oldContext.ctx);
	assert.equal(signals.length, 2);
	assert.equal(signals[1]?.aborted, false);
	assert.match(stripAnsi(footer.render(300).join("\n")), /#222/u);

	await emit(mock.events, "agent_end", {}, newContext.ctx);
	assert.equal(signals.length, 3);
	await emit(mock.events, "session_shutdown", {}, newContext.ctx);
	assert.equal(signals[2]?.aborted, true);
	shutdownResult.resolve(pullRequestResult(333));
	await flushAsync();
	footer.dispose();
	oldFooter.dispose();
});

test("reachable native PR refresh uses its own 60-second fallback", async (t) => {
	useLifecycleConfig(t, "format = '$github_pr'\n");
	vi.useFakeTimers({ toFake: ["setInterval"] });
	const mock = createMockPi();
	let prCalls = 0;
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (_command: string, args: string[]) => Promise<ExecResult>;
		}
	).exec = async (_command, args) => {
		if (!isGithubPrCall(args)) return gitResult();
		prCalls += 1;
		return pullRequestResult(prCalls);
	};
	piStarship(mock.pi);
	const context = createMockContext({ mode: "tui" });
	await emit(mock.events, "session_start", {}, context.ctx);
	await flushAsync();
	assert.equal(prCalls, 1);
	vi.advanceTimersByTime(59_999);
	await flushAsync();
	assert.equal(prCalls, 1);
	vi.advanceTimersByTime(1);
	await flushAsync();
	assert.equal(prCalls, 2);
	const footer = (context.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "feature",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	footer.dispose();
	await emit(mock.events, "session_shutdown", {}, context.ctx);
});

test("terminal native PR snapshots clear at their lifecycle expiry", async (t) => {
	useLifecycleConfig(t, "format = '$github_pr'\n");
	vi.useFakeTimers({ toFake: ["setTimeout"] });
	let now = Date.parse("2026-08-01T12:00:00.000Z");
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const mock = createMockPi();
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (_command: string, args: string[]) => Promise<ExecResult>;
		}
	).exec = async (_command, args) =>
		isGithubPrCall(args)
			? pullRequestResult(123, {
					state: "MERGED",
					mergedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 + 500).toISOString(),
				})
			: gitResult();
	piStarship(mock.pi);
	const context = createMockContext({ mode: "tui" });
	await emit(mock.events, "session_start", {}, context.ctx);
	await flushAsync();
	const footer = (context.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "feature",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	t.onTestFinished(async () => {
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	});
	assert.match(stripAnsi(footer.render(300).join("\n")), /#123 · M/u);
	now += 1_000;
	vi.advanceTimersByTime(1_000);
	assert.doesNotMatch(stripAnsi(footer.render(300).join("\n")), /#123/u);
});

test("terminal native PR expiry revalidates the wall clock before clearing", async (t) => {
	useLifecycleConfig(t, "format = '$github_pr'\n");
	vi.useFakeTimers({ toFake: ["setTimeout"] });
	let now = Date.parse("2026-08-01T12:00:00.000Z");
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const expiresAt = now + 500;
	const mock = createMockPi();
	(
		mock.rawPi as typeof mock.rawPi & {
			exec: (_command: string, args: string[]) => Promise<ExecResult>;
		}
	).exec = async (_command, args) =>
		isGithubPrCall(args)
			? pullRequestResult(123, {
					state: "MERGED",
					mergedAt: new Date(expiresAt - 24 * 60 * 60 * 1_000).toISOString(),
				})
			: gitResult();
	piStarship(mock.pi);
	const context = createMockContext({ mode: "tui" });
	await emit(mock.events, "session_start", {}, context.ctx);
	await flushAsync();
	const footer = (context.footer as FooterFactory)(
		{ requestRender() {} },
		{},
		{
			getGitBranch: () => "feature",
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		},
	);
	t.onTestFinished(async () => {
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	});
	assert.match(stripAnsi(footer.render(300).join("\n")), /#123 · M/u);

	now -= 10_000;
	vi.advanceTimersByTime(500);
	assert.match(stripAnsi(footer.render(300).join("\n")), /#123 · M/u);

	now = expiresAt;
	vi.advanceTimersByTime(10_500);
	assert.doesNotMatch(stripAnsi(footer.render(300).join("\n")), /#123/u);
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
				getEntries: () => [],
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

test("TUI footer uses all-entry usage totals and marks subscription-backed cost", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-usage-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(
			join(root, "pi-starship.toml"),
			"format = '$cache$tokens$cost'\n\n[cache]\ndisabled = false\nformat = 'R$read W$write CH$rate '\n\n[[cost.display]]\nthreshold = 0\nstyle = 'bold yellow'\nhidden = false\n",
		);
		const makeUsage = (
			input: number,
			output: number,
			cacheRead: number,
			cacheWrite: number,
			cost: number,
		) => ({
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens: input + output + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		});
		const latest = {
			type: "message",
			message: { role: "assistant", usage: makeUsage(10_700, 287, 0, 0, 0.015) },
		};
		const entries = [
			{
				type: "message",
				message: { role: "assistant", usage: makeUsage(1000, 0, 4600, 1500, 0.04) },
			},
			{
				type: "message",
				message: { role: "toolResult", usage: makeUsage(100, 0, 0, 0, 0.005) },
			},
			{ type: "compaction", usage: makeUsage(100, 0, 0, 0, 0.005) },
			{ type: "branch_summary", usage: makeUsage(100, 0, 0, 0, 0.005) },
			latest,
		];
		const mock = createMockPi();
		piStarship(mock.pi);
		let oauth = true;
		const context = createMockContext({
			mode: "tui",
			model: { provider: "openai", id: "gpt-5" },
			modelRegistry: { isUsingOAuth: () => oauth },
			sessionManager: { getEntries: () => entries, getBranch: () => [latest] },
		});
		await emit(mock.events, "session_start", {}, context.ctx);
		const footer = (context.footer as FooterFactory)(
			{ requestRender() {} },
			{},
			{
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
		const rendered = stripAnsi(footer.render(300).join("\n"));
		assert.match(rendered, /R4\.6k W1\.5k CH0\.0%/u);
		assert.match(rendered, /↑12k ↓287/u);
		assert.match(rendered, /\$0\.070 \(sub\)/u);

		oauth = false;
		(context.ctx as { model: { provider: string; id: string } }).model = {
			provider: "kimi-coding",
			id: "kimi",
		};
		assert.match(stripAnsi(footer.render(300).join("\n")), /\$0\.070 \(sub\)/u);
		(context.ctx as { model: { provider: string; id: string } }).model = {
			provider: "anthropic",
			id: "claude",
		};
		assert.doesNotMatch(stripAnsi(footer.render(300).join("\n")), /\(sub\)/u);
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("TUI footer renders cached state and parallel tool activity without executing during render", async (t) => {
	useLifecycleConfig(t, "format = '$git_worktree$git_status$activity'\n");
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
		if (isGithubPrCall(args)) return { stdout: "", stderr: "no PR", code: 1, killed: false };
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

test("stale worktree identity from a replaced session cannot overwrite the new footer", async (t) => {
	useLifecycleConfig(t, "format = '$git_worktree'\n");
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

test("installed packages do not affect extension status presentation or produce warnings", async () => {
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
			context.notifications.filter((notice) => /pi-statusline/iu.test(notice.message)).length,
			0,
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
		assert.match(footer.render(100).join(""), /🔌 running/);
		assert.doesNotMatch(footer.render(100).join(""), /🧪/u);
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

function isGithubPrCall(args: readonly string[]): boolean {
	return args.includes("pr") && args.includes("view") && args.includes("--json");
}

function pullRequestResult(number: number, overrides: Record<string, unknown> = {}): ExecResult {
	return {
		stdout: JSON.stringify({
			number,
			isDraft: false,
			url: `https://github.com/o/r/pull/${number}`,
			state: "OPEN",
			closedAt: null,
			mergedAt: null,
			reviewDecision: "",
			statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
			...overrides,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function gitResult(stdout = "## main\n"): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function stripAnsi(value: string): string {
	const escapeSequence = String.fromCharCode(27);
	let result = value.replace(new RegExp(`${escapeSequence}\\[[0-9;]*m`, "gu"), "");
	const osc8Prefix = `${escapeSequence}]8;;`;
	const terminator = String.fromCharCode(7);
	while (true) {
		const start = result.indexOf(osc8Prefix);
		if (start === -1) return result;
		const end = result.indexOf(terminator, start + osc8Prefix.length);
		if (end === -1) return result.slice(0, start);
		result = result.slice(0, start) + result.slice(end + terminator.length);
	}
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
