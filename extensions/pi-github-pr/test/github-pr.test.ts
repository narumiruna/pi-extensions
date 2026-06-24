import assert from "node:assert/strict";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support.js";
import githubPr, { formatCompactStatus, normalizeGhPrView, runGhPrView } from "../src/github-pr.js";

type ExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number };
type ExecCall = { command: string; args: string[]; options?: ExecOptions };
type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const okResult = (stdout: unknown): ExecResult => ({
	stdout: JSON.stringify(stdout),
	stderr: "",
	code: 0,
	killed: false,
});

const samplePr = {
	number: 123,
	isDraft: false,
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

test("normalizeGhPrView summarizes approved reviews, failed CI, and comments", () => {
	const status = normalizeGhPrView(samplePr);

	assert.deepEqual(status.checks, { passed: 1, failed: 1, pending: 1, total: 3 });
	assert.deepEqual(status.comments, { issue: 2, reviews: 3, total: 5 });
	assert.deepEqual(status.review.approvedBy, ["alice"]);
	assert.equal(formatCompactStatus(status), "PR #123 CI failed 1 approved C5");
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
	assert.equal(formatCompactStatus(changesRequested), "PR #123 CI pending 1 changes requested C3");
	assert.deepEqual(draft.comments, { issue: 0, reviews: 0, total: 0 });
	assert.equal(formatCompactStatus(draft), "PR #123 CI none draft C0");
	assert.equal(formatCompactStatus(commented), "PR #123 CI ok commented C3");
});

test("runGhPrView calls gh pr view for the current branch and reports actionable failures", async () => {
	const calls: ExecCall[] = [];
	const pi = {
		exec: async (command, args, options) => {
			calls.push({ command, args, options });
			return okResult(samplePr);
		},
	} satisfies { exec: ExecFunction };

	const status = await runGhPrView(pi, "/repo");

	assert.equal(status.number, 123);
	assert.deepEqual(calls, [
		{
			command: "gh",
			args: [
				"pr",
				"view",
				"--json",
				"number,isDraft,reviewDecision,latestReviews,reviews,comments,statusCheckRollup",
			],
			options: { cwd: "/repo", signal: undefined, timeout: 10_000 },
		},
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
		/GitHub CLI not available/,
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
});

test("lifecycle refresh sets and clears only statusline output", async () => {
	const mock = createMockPi();
	const calls = installExec(mock, async () => okResult(samplePr));
	githubPr(mock.pi);
	const context = createMockContext({ cwd: "/repo" });

	const sessionStart = mock.events.get("session_start")?.[0];
	const agentEnd = mock.events.get("agent_end")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(agentEnd);
	assert.ok(sessionShutdown);

	await sessionStart({}, context.ctx);
	assert.equal(context.statuses.get("github-pr"), "PR #123 CI failed 1 approved C5");
	assert.equal(context.widgets.size, 0);
	assert.equal(context.notifications.length, 0);

	await agentEnd({}, context.ctx);
	assert.equal(calls.length, 2);
	assert.equal(context.statuses.get("github-pr"), "PR #123 CI failed 1 approved C5");

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
	const noPr = await lifecycleStatusFor(async () => ({
		stdout: "",
		stderr: "no pull requests found",
		code: 1,
		killed: false,
	}));

	assert.equal(missingGh.statuses.get("github-pr"), "PR gh missing");
	assert.equal(unauthenticated.statuses.get("github-pr"), "PR gh auth");
	assert.equal(noPr.statuses.get("github-pr"), undefined);
	for (const context of [missingGh, unauthenticated, noPr]) {
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
