import assert from "node:assert/strict";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support.js";
import githubPr, {
	formatCompactStatus,
	formatLinkedStatus,
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
	assert.equal(formatCompactStatus(commented), "PR #123: checks passing, commented, 3 comments");
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
			"number,isDraft,url,reviewDecision,latestReviews,statusCheckRollup",
		],
		options: { cwd: "/repo", signal: undefined, timeout: 10_000 },
	});
	assert.deepEqual(calls[1]?.options, { cwd: "/repo", signal: undefined, timeout: 10_000 });
	assert.deepEqual(calls[1]?.args.slice(0, 4), ["api", "graphql", "-f", calls[1]?.args[3]]);
	assert.match(calls[1]?.args[3] ?? "", /^query=\s*query PullRequestCounts/);
	assert.deepEqual(calls[1]?.args.slice(4), [
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

test("lifecycle refresh sets and clears only statusline output", async () => {
	const mock = createMockPi();
	const calls = installExec(mock, async (_command, args) =>
		okResult(args[0] === "pr" ? samplePr : sampleCounts),
	);
	githubPr(mock.pi);
	const context = createMockContext({ cwd: "/repo" });

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
	assert.equal(calls.length, 4);
	assert.equal(
		context.statuses.get("github-pr"),
		`PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
	);

	await sessionShutdown({}, context.ctx);
	assert.equal(context.statuses.get("github-pr"), undefined);
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
