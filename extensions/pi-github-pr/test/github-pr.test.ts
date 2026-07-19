import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support.js";
import githubPr, {
	formatCompactStatus,
	formatLinkedStatus,
	isPullRequestVisible,
	normalizeGhPrView,
	runGhPrView,
} from "../src/github-pr.js";

type ExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number };
type ExecCall = { command: string; args: string[]; options?: ExecOptions };
type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const okResult = (stdout: unknown): ExecResult => ({
	stdout: JSON.stringify(stdout),
	stderr: "",
	code: 0,
	killed: false,
});

const textResult = (stdout: string, code = 0, stderr = ""): ExecResult => ({
	stdout,
	stderr,
	code,
	killed: false,
});

const sampleCounts = {
	data: {
		repository: {
			pullRequest: {
				comments: { totalCount: 2 },
				reviews: { totalCount: 3 },
			},
		},
	},
};

const samplePr = {
	number: 123,
	state: "OPEN",
	closedAt: null,
	mergedAt: null,
	isDraft: false,
	url: "https://github.com/narumiruna/pi-extensions/pull/123",
	reviewDecision: "APPROVED",
	latestReviews: [
		{ state: "APPROVED", author: { login: "alice" } },
		{ state: "COMMENTED", author: { login: "bob" } },
	],
	reviews: [
		{ state: "COMMENTED", author: { login: "alice" } },
		{ state: "APPROVED", author: { login: "alice" } },
		{ state: "COMMENTED", author: { login: "bob" } },
	],
	comments: [{}, {}],
	statusCheckRollup: [
		{ status: "COMPLETED", conclusion: "SUCCESS" },
		{ state: "FAILURE" },
		{ status: "IN_PROGRESS" },
	],
};

test("github-pr registers only passive lifecycle events", () => {
	const mock = createMockPi();
	githubPr(mock.pi);

	assert.equal(mock.commands.size, 0);
	assert.deepEqual(mock.tools, []);
	assert.deepEqual([...mock.events.keys()].sort(), [
		"agent_end",
		"session_shutdown",
		"session_start",
	]);
});

test("normalizeGhPrView summarizes approved reviews, failing checks, and comments", () => {
	const status = normalizeGhPrView(samplePr);

	assert.deepEqual(status.checks, { passed: 1, failed: 1, pending: 1, total: 3 });
	assert.deepEqual(status.comments, { issue: 2, reviews: 3, total: 5 });
	assert.deepEqual(status.review.approvedBy, ["alice"]);
	assert.equal(formatCompactStatus(status), "PR #123: checks failing (1), approved, 5 comments");
	assert.equal(
		formatLinkedStatus(status),
		`PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
	);
});

test("formatLinkedStatus falls back to plain text when the PR url is missing", () => {
	const status = normalizeGhPrView({ ...samplePr, url: undefined });

	assert.equal(status.url, "");
	assert.equal(formatLinkedStatus(status), formatCompactStatus(status));
});

test("formatLinkedStatus rejects invalid and non-http PR urls", () => {
	const status = normalizeGhPrView(samplePr);

	for (const url of ["not a url", "javascript:alert(1)"]) {
		const candidate = { ...status, url };
		assert.equal(formatLinkedStatus(candidate), formatCompactStatus(candidate));
	}
});

test("formatLinkedStatus strips terminal controls from OSC 8 url and text", () => {
	const status = normalizeGhPrView({ ...samplePr, url: `${samplePr.url}\x1b` });
	const unsafeNumber = { toString: () => "12\x1b\n3" } as unknown as number;
	const rendered = formatLinkedStatus({ ...status, number: unsafeNumber });

	const controls = [...rendered]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code <= 0x1f || code === 0x7f;
		})
		.join("");
	assert.equal(controls, "\x1b\x07\x1b\x07");
	assert.ok(rendered.includes("#123"));
	assert.ok(!rendered.includes("#12\x1b\n3"));
});

test("normalizeGhPrView summarizes pending, changes-requested, draft, and commented reviews", () => {
	const changesRequested = normalizeGhPrView({
		...samplePr,
		reviewDecision: "CHANGES_REQUESTED",
		latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
		comments: undefined,
		statusCheckRollup: [{ status: "QUEUED" }],
	});
	const draft = normalizeGhPrView({
		...samplePr,
		isDraft: true,
		reviewDecision: "REVIEW_REQUIRED",
		latestReviews: [],
		reviews: [],
		comments: undefined,
		statusCheckRollup: [],
	});
	const commented = normalizeGhPrView({
		...samplePr,
		reviewDecision: "REVIEW_REQUIRED",
		latestReviews: [{ state: "COMMENTED", author: { login: "copilot" } }],
		comments: [],
		statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
	});

	assert.deepEqual(changesRequested.comments, { issue: 0, reviews: 3, total: 3 });
	assert.equal(
		formatCompactStatus(changesRequested),
		"PR #123: checks pending (1), changes requested, 3 comments",
	);
	assert.deepEqual(draft.comments, { issue: 0, reviews: 0, total: 0 });
	assert.equal(formatCompactStatus(draft), "PR #123: no checks, draft, no comments");
	assert.equal(
		formatCompactStatus(commented),
		"PR #123: checks passing, review required, 3 comments",
	);
});

test("terminal pull requests use their terminal state and expire after 24 hours", () => {
	const now = Date.parse("2026-06-26T12:00:00.000Z");
	const merged = normalizeGhPrView({
		...samplePr,
		state: "MERGED",
		mergedAt: "2026-06-25T12:00:00.001Z",
	});
	const closed = normalizeGhPrView({
		...samplePr,
		state: "CLOSED",
		closedAt: "2026-06-25T12:00:00.000Z",
	});

	assert.equal(formatCompactStatus(merged), "PR #123: merged");
	assert.equal(formatCompactStatus(closed), "PR #123: closed");
	assert.equal(isPullRequestVisible(merged, now), true);
	assert.equal(isPullRequestVisible(closed, now), false);
	assert.equal(isPullRequestVisible({ ...merged, mergedAt: undefined }, now), false);
	assert.equal(isPullRequestVisible({ ...closed, closedAt: "invalid" }, now), false);
	assert.equal(isPullRequestVisible(normalizeGhPrView(samplePr), now), true);
	assert.equal(
		isPullRequestVisible(normalizeGhPrView({ ...samplePr, closedAt: "invalid" }), now),
		true,
	);
});

test("normalizeGhPrView accepts count-only review and comment payloads", () => {
	const status = normalizeGhPrView({
		...samplePr,
		reviews: { totalCount: 3 },
		comments: { totalCount: 2 },
	});

	assert.deepEqual(status.comments, { issue: 2, reviews: 3, total: 5 });
});

test("runGhPrView calls gh pr view for the current branch and reports actionable failures", async () => {
	const calls: ExecCall[] = [];
	const pi = {
		exec: async (command, args, options) => {
			calls.push({ command, args, options });
			return okResult(args[0] === "pr" ? samplePr : sampleCounts);
		},
	} satisfies { exec: ExecFunction };

	const status = await runGhPrView(pi, "/repo");

	assert.equal(status.number, 123);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0], {
		command: "gh",
		args: [
			"pr",
			"view",
			"--json",
			"number,isDraft,url,state,closedAt,mergedAt,reviewDecision,latestReviews,statusCheckRollup",
		],
		options: { cwd: "/repo", signal: undefined, timeout: 10_000 },
	});
	assert.deepEqual(calls[1]?.options, { cwd: "/repo", signal: undefined, timeout: 10_000 });
	assert.deepEqual(calls[1]?.args.slice(0, 6), [
		"api",
		"graphql",
		"--hostname",
		"github.com",
		"-f",
		calls[1]?.args[5],
	]);
	assert.match(calls[1]?.args[5] ?? "", /^query=\s*query PullRequestCounts/);
	assert.deepEqual(calls[1]?.args.slice(6), [
		"-F",
		"owner=narumiruna",
		"-F",
		"name=pi-extensions",
		"-F",
		"number=123",
	]);

	await assert.rejects(
		runGhPrView(
			{
				exec: async () => {
					throw new Error("spawn gh ENOENT");
				},
			},
			"/repo",
		),
		/GitHub CLI not found/,
	);
	await assert.rejects(
		runGhPrView(
			{
				exec: async () => {
					throw new Error("operation aborted");
				},
			},
			"/repo",
		),
		/gh pr view could not start: operation aborted/,
	);
	await assert.rejects(
		runGhPrView(
			{
				exec: async () => {
					throw new Error("spawn gh EACCES");
				},
			},
			"/repo",
		),
		/gh pr view could not start: spawn gh EACCES/,
	);
	await assert.rejects(
		runGhPrView(
			{
				exec: async () => ({ stdout: "", stderr: "not logged in", code: 1, killed: false }),
			},
			"/repo",
		),
		/gh auth login/,
	);
	await assert.rejects(
		runGhPrView(
			{
				exec: async () => ({
					stdout: "",
					stderr: "not a GitHub repository",
					code: 1,
					killed: false,
				}),
			},
			"/repo",
		),
		/No GitHub pull request found/,
	);
	await assert.rejects(
		runGhPrView(
			{
				exec: async () => ({
					stdout: "",
					stderr: "no pull requests found",
					code: 1,
					killed: false,
				}),
			},
			"/repo",
		),
		/No GitHub pull request found/,
	);
	await assert.rejects(
		runGhPrView(
			{
				exec: async () => ({
					stdout: "",
					stderr: "HTTP 404: Not Found",
					code: 1,
					killed: false,
				}),
			},
			"/repo",
		),
		/gh pr view failed/,
	);
});

test("runGhPrView sends gh api graphql to the enterprise PR host", async () => {
	const calls: ExecCall[] = [];
	const pi = {
		exec: async (command, args, options) => {
			calls.push({ command, args, options });
			return okResult(
				args[0] === "pr"
					? { ...samplePr, url: "https://github.example.com:8443/org/repo/pull/123" }
					: sampleCounts,
			);
		},
	} satisfies { exec: ExecFunction };

	await runGhPrView(pi, "/repo");

	assert.deepEqual(calls[1]?.args.slice(0, 4), [
		"api",
		"graphql",
		"--hostname",
		"github.example.com:8443",
	]);
	assert.deepEqual(calls[1]?.args.slice(6), [
		"-F",
		"owner=org",
		"-F",
		"name=repo",
		"-F",
		"number=123",
	]);
});

test("lifecycle refresh sets and clears only statusline output", async () => {
	const mock = createMockPi();
	const calls = installExec(mock, async (_command, args) =>
		okResult(args[0] === "pr" ? samplePr : sampleCounts),
	);
	githubPr(mock.pi);
	const signal = new AbortController().signal;
	const context = createMockContext({ cwd: "/repo", signal });

	const sessionStart = mock.events.get("session_start")?.[0];
	const agentEnd = mock.events.get("agent_end")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(agentEnd);
	assert.ok(sessionShutdown);

	await sessionStart({}, context.ctx);
	assert.equal(
		context.statuses.get("github-pr"),
		`PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
	);
	assert.equal(context.widgets.size, 0);
	assert.equal(context.notifications.length, 0);

	await agentEnd({}, context.ctx);
	assert.equal(calls.length, 5);
	assert.deepEqual(calls[0]?.args, ["rev-parse", "--git-path", "HEAD"]);
	assert.equal(calls[0]?.options?.signal, signal);
	assert.equal(
		context.statuses.get("github-pr"),
		`PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
	);

	await sessionShutdown({}, context.ctx);
	assert.equal(context.statuses.get("github-pr"), undefined);
	assert.equal(context.widgets.size, 0);
	assert.equal(context.notifications.length, 0);
});

test("recent terminal pull request status clears when its 24-hour lifetime expires", async () => {
	const mock = createMockPi();
	const mergedAt = new Date(Date.now() - 24 * 60 * 60 * 1000 + 300).toISOString();
	const calls = installExec(mock, async (_command, args) =>
		okResult(args[0] === "pr" ? { ...samplePr, state: "MERGED", mergedAt } : sampleCounts),
	);
	githubPr(mock.pi);
	const context = createMockContext({ cwd: "/repo" });
	const sessionStart = mock.events.get("session_start")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(sessionShutdown);

	await sessionStart({}, context.ctx);
	assert.match(context.statuses.get("github-pr") ?? "", /: merged$/);
	await waitFor(
		() => context.statuses.get("github-pr") === undefined,
		"terminal pull request status expires",
	);
	assert.equal(calls.length, 3);
	await sessionShutdown({}, context.ctx);
});

test("branch changes clear stale PR status and stale refreshes cannot restore it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-github-pr-test-"));
	const gitDir = join(root, ".git");
	const headPath = join(gitDir, "HEAD");
	mkdirSync(gitDir);
	writeFileSync(headPath, "ref: refs/heads/feature\n");

	const firstPrView = deferred<ExecResult>();
	const calls: ExecCall[] = [];
	let ghPrViews = 0;
	const pi = {
		exec: async (command, args, options) => {
			calls.push({ command, args, options });
			if (command === "git") return textResult(".git/HEAD\n");
			if (args[0] === "pr") {
				ghPrViews += 1;
				if (ghPrViews === 1) return firstPrView.promise;
				return textResult("", 1, 'no pull requests found for branch "main"');
			}
			return okResult(sampleCounts);
		},
	} satisfies { exec: ExecFunction };
	const mock = createMockPi();
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = pi.exec;
	githubPr(mock.pi);
	const context = createMockContext({ cwd: root });
	context.statuses.set("github-pr", "PR #4: checks passing, approved, no comments");

	const sessionStart = mock.events.get("session_start")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(sessionShutdown);

	const startPromise = sessionStart({}, context.ctx);
	await waitFor(() => ghPrViews === 1, "initial PR refresh starts");

	writeFileSync(headPath, "ref: refs/heads/main\n");

	await waitFor(
		() => context.statuses.get("github-pr") === undefined,
		"branch change clears stale PR status",
	);
	await waitFor(() => ghPrViews >= 2, "branch change refreshes the current branch");

	firstPrView.resolve(okResult({ ...samplePr, number: 4, url: "https://github.com/o/r/pull/4" }));
	await startPromise;
	await wait(25);

	assert.equal(context.statuses.get("github-pr"), undefined);
	await sessionShutdown({}, context.ctx);
});

test("session shutdown disposes the branch watcher and pending refresh", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-github-pr-test-"));
	const gitDir = join(root, ".git");
	const headPath = join(gitDir, "HEAD");
	mkdirSync(gitDir);
	writeFileSync(headPath, "ref: refs/heads/feature\n");

	let ghPrViews = 0;
	const mock = createMockPi();
	installExec(mock, async (command, args) => {
		if (command === "git") return textResult(".git/HEAD\n");
		if (args[0] === "pr") {
			ghPrViews += 1;
			return okResult(samplePr);
		}
		return okResult(sampleCounts);
	});
	githubPr(mock.pi);
	const context = createMockContext({ cwd: root });
	const sessionStart = mock.events.get("session_start")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(sessionShutdown);

	await sessionStart({}, context.ctx);
	assert.equal(ghPrViews, 1);

	writeFileSync(headPath, "ref: refs/heads/main\n");
	await sessionShutdown({}, context.ctx);
	await wait(300);

	assert.equal(ghPrViews, 1);
	assert.equal(context.statuses.get("github-pr"), undefined);
});

test("queued branch refresh does not run after session shutdown", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-github-pr-test-"));
	const gitDir = join(root, ".git");
	const headPath = join(gitDir, "HEAD");
	mkdirSync(gitDir);
	writeFileSync(headPath, "ref: refs/heads/feature\n");

	let ghPrViews = 0;
	const mock = createMockPi();
	installExec(mock, async (command, args) => {
		if (command === "git") return textResult(".git/HEAD\n");
		if (args[0] === "pr") {
			ghPrViews += 1;
			return okResult(samplePr);
		}
		return okResult(sampleCounts);
	});
	githubPr(mock.pi);
	const context = createMockContext({ cwd: root });
	const sessionStart = mock.events.get("session_start")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(sessionShutdown);

	await sessionStart({}, context.ctx);
	assert.equal(ghPrViews, 1);

	const originalClearTimeout = globalThis.clearTimeout;
	try {
		globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
		writeFileSync(headPath, "ref: refs/heads/main\n");
		await waitFor(
			() => context.statuses.get("github-pr") === undefined,
			"branch change clears stale PR status",
		);

		await sessionShutdown({}, context.ctx);
		await wait(300);
	} finally {
		globalThis.clearTimeout = originalClearTimeout;
	}

	assert.equal(ghPrViews, 1);
	assert.equal(context.statuses.get("github-pr"), undefined);
});

test("branch watcher failures stay non-intrusive", async () => {
	const mock = createMockPi();
	installExec(mock, async (command, args) => {
		if (command === "git") return textResult("", 128, "not a git repository");
		return okResult(args[0] === "pr" ? samplePr : sampleCounts);
	});
	githubPr(mock.pi);
	const context = createMockContext({ cwd: "/repo" });
	const sessionStart = mock.events.get("session_start")?.[0];
	assert.ok(sessionStart);

	await sessionStart({}, context.ctx);

	assert.equal(
		context.statuses.get("github-pr"),
		`PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
	);
	assert.equal(context.widgets.size, 0);
	assert.equal(context.notifications.length, 0);
});

test("ambient failures stay non-intrusive", async () => {
	const missingGh = await lifecycleStatusFor(async () => {
		throw new Error("spawn gh ENOENT");
	});
	const unauthenticated = await lifecycleStatusFor(async () => ({
		stdout: "",
		stderr: "not logged in",
		code: 1,
		killed: false,
	}));
	const execFailure = await lifecycleStatusFor(async () => {
		throw new Error("operation aborted");
	});
	const spawnPermissionFailure = await lifecycleStatusFor(async () => {
		throw new Error("spawn gh EACCES");
	});
	const noPr = await lifecycleStatusFor(async () => ({
		stdout: "",
		stderr: "no pull requests found",
		code: 1,
		killed: false,
	}));
	const notFound = await lifecycleStatusFor(async () => ({
		stdout: "",
		stderr: "HTTP 404: Not Found",
		code: 1,
		killed: false,
	}));

	assert.equal(missingGh.statuses.get("github-pr"), "PR gh missing");
	assert.equal(unauthenticated.statuses.get("github-pr"), "PR gh auth");
	assert.equal(execFailure.statuses.get("github-pr"), undefined);
	assert.equal(spawnPermissionFailure.statuses.get("github-pr"), undefined);
	assert.equal(noPr.statuses.get("github-pr"), undefined);
	assert.equal(notFound.statuses.get("github-pr"), undefined);
	for (const context of [
		missingGh,
		unauthenticated,
		execFailure,
		spawnPermissionFailure,
		noPr,
		notFound,
	]) {
		assert.equal(context.widgets.size, 0);
		assert.equal(context.notifications.length, 0);
	}
});

async function lifecycleStatusFor(exec: ExecFunction) {
	const mock = createMockPi();
	installExec(mock, exec);
	githubPr(mock.pi);
	const context = createMockContext({ cwd: "/repo" });
	const handler = mock.events.get("session_start")?.[0];
	assert.ok(handler);
	await handler({}, context.ctx);
	return context;
}

function installExec(mock: ReturnType<typeof createMockPi>, exec: ExecFunction): ExecCall[] {
	const calls: ExecCall[] = [];
	(mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (
		command,
		args,
		options,
	) => {
		calls.push({ command, args, options });
		return exec(command, args, options);
	};
	return calls;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await wait(10);
	}
	assert.fail(message);
}
