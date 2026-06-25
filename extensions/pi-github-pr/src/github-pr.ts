import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "UNKNOWN";
export type CheckState = "pass" | "fail" | "pending" | "none";

type JsonRecord = Record<string, unknown>;

export interface CheckSummary {
	passed: number;
	failed: number;
	pending: number;
	total: number;
}

export interface ReviewSummary {
	decision: ReviewDecision;
	approvedBy: string[];
	changesRequestedBy: string[];
	commentedBy: string[];
	total: number;
}

export interface CommentSummary {
	issue: number;
	reviews: number;
	total: number;
}

export interface PullRequestStatus {
	number: number;
	url: string;
	isDraft: boolean;
	review: ReviewSummary;
	checks: CheckSummary;
	comments: CommentSummary;
}

const STATUS_KEY = "github-pr";
const GH_TIMEOUT_MS = 10_000;
const GH_PR_FIELDS = [
	"number",
	"isDraft",
	"url",
	"reviewDecision",
	"latestReviews",
	"statusCheckRollup",
];
const GH_PR_COUNT_QUERY = `
	query PullRequestCounts($owner: String!, $name: String!, $number: Int!) {
		repository(owner: $owner, name: $name) {
			pullRequest(number: $number) {
				comments {
					totalCount
				}
				reviews {
					totalCount
				}
			}
		}
	}
`;

export default function githubPr(pi: ExtensionAPI) {
	const refreshStatus = async (ctx: ExtensionContext, signal?: AbortSignal) => {
		try {
			const status = await runGhPrView(pi, ctx.cwd, signal);
			renderStatus(ctx, status);
		} catch (error) {
			renderAmbientFailure(ctx, error);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await refreshStatus(ctx, ctx.signal);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refreshStatus(ctx, ctx.signal);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearStatus(ctx);
	});
}

export async function runGhPrView(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<PullRequestStatus> {
	const args = ["pr", "view", "--json", GH_PR_FIELDS.join(",")];
	const result = await execGh(pi, args, cwd, signal, "gh pr view");
	if (result.killed) throw new Error("gh pr view timed out or was cancelled.");
	if (result.code !== 0) throw new Error(formatGhFailure("gh pr view", result));

	let pr: JsonRecord;
	try {
		pr = objectRecord(JSON.parse(result.stdout));
	} catch (error) {
		throw new Error(`Failed to parse gh pr view output: ${formatError(error)}`);
	}

	const counts = await runGhPrCountQuery(pi, cwd, pr, signal);
	return normalizeGhPrView({ ...pr, ...counts });
}

export function normalizeGhPrView(value: unknown): PullRequestStatus {
	const pr = objectRecord(value);
	const reviews = arrayValue(pr.reviews);
	const latestReviews = arrayValue(pr.latestReviews);
	const comments = summarizeComments(pr.comments, countValue(pr.reviews));

	return {
		number: requiredNumber(pr.number, "number"),
		url: optionalString(pr.url) ?? "",
		isDraft: pr.isDraft === true,
		review: summarizeReviews(pr.reviewDecision, latestReviews.length > 0 ? latestReviews : reviews),
		checks: summarizeChecks(pr.statusCheckRollup),
		comments,
	};
}

function summarizeChecks(value: unknown): CheckSummary {
	const checks = arrayValue(value);
	const summary: CheckSummary = { passed: 0, failed: 0, pending: 0, total: checks.length };

	for (const check of checks) {
		const state = checkState(check);
		if (state === "pass") summary.passed += 1;
		else if (state === "fail") summary.failed += 1;
		else summary.pending += 1;
	}

	return summary;
}

function checkState(value: unknown): Exclude<CheckState, "none"> {
	const check = objectRecord(value);
	const state = optionalString(check.state)?.toUpperCase();
	const status = optionalString(check.status)?.toUpperCase();
	const conclusion = optionalString(check.conclusion)?.toUpperCase();

	if (state === "SUCCESS") return "pass";
	if (state === "FAILURE" || state === "ERROR") return "fail";
	if (state === "PENDING" || state === "EXPECTED") return "pending";

	if (status && status !== "COMPLETED") return "pending";
	if (conclusion === "SUCCESS" || conclusion === "SKIPPED" || conclusion === "NEUTRAL") {
		return "pass";
	}
	if (
		conclusion === "FAILURE" ||
		conclusion === "CANCELLED" ||
		conclusion === "TIMED_OUT" ||
		conclusion === "ACTION_REQUIRED" ||
		conclusion === "STARTUP_FAILURE"
	) {
		return "fail";
	}

	return "pending";
}

function summarizeReviews(decisionValue: unknown, reviewValues: unknown[]): ReviewSummary {
	const latestByAuthor = new Map<string, JsonRecord>();
	let anonymousIndex = 0;

	for (const reviewValue of reviewValues) {
		const review = objectRecord(reviewValue);
		const author = authorLogin(review) ?? `review-${anonymousIndex++}`;
		latestByAuthor.set(author, review);
	}

	const summary: ReviewSummary = {
		decision: reviewDecision(decisionValue),
		approvedBy: [],
		changesRequestedBy: [],
		commentedBy: [],
		total: reviewValues.length,
	};

	for (const [author, review] of latestByAuthor) {
		const state = optionalString(review.state)?.toUpperCase();
		if (state === "APPROVED") summary.approvedBy.push(author);
		else if (state === "CHANGES_REQUESTED") summary.changesRequestedBy.push(author);
		else if (state === "COMMENTED") summary.commentedBy.push(author);
	}

	return summary;
}

function summarizeComments(commentsValue: unknown, reviewCount: number): CommentSummary {
	const issue = countValue(commentsValue);
	return { issue, reviews: reviewCount, total: issue + reviewCount };
}

function countValue(value: unknown): number {
	if (Array.isArray(value)) return value.length;
	const object = objectRecord(value);
	const totalCount = object.totalCount;
	if (typeof totalCount === "number") return totalCount;
	const nodes = object.nodes;
	return Array.isArray(nodes) ? nodes.length : 0;
}

function reviewDecision(value: unknown): ReviewDecision {
	if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
		return value;
	}
	return "UNKNOWN";
}

function authorLogin(review: JsonRecord): string | undefined {
	const author = objectRecord(review.author);
	return optionalString(author.login);
}

function checkOverall(checks: CheckSummary): CheckState {
	if (checks.total === 0) return "none";
	if (checks.failed > 0) return "fail";
	if (checks.pending > 0) return "pending";
	return "pass";
}

export function formatCompactStatus(status: PullRequestStatus): string {
	return `PR #${status.number}: ${[
		formatCheckCompact(status.checks),
		formatReviewCompact(status),
		formatCommentCompact(status.comments),
	].join(", ")}`;
}

function formatCheckCompact(checks: CheckSummary): string {
	switch (checkOverall(checks)) {
		case "pass":
			return "checks passing";
		case "fail":
			return `checks failing (${checks.failed})`;
		case "pending":
			return `checks pending (${checks.pending})`;
		case "none":
			return "no checks";
	}
}

function formatCommentCompact(comments: CommentSummary): string {
	const count = comments.total;
	if (count === 0) return "no comments";
	return `${count} ${count === 1 ? "comment" : "comments"}`;
}

function formatReviewCompact(status: PullRequestStatus): string {
	if (status.isDraft) return "draft";
	const review = status.review;
	switch (review.decision) {
		case "APPROVED":
			return "approved";
		case "CHANGES_REQUESTED":
			return "changes requested";
		case "REVIEW_REQUIRED":
			return review.commentedBy.length > 0 ? "commented" : "review required";
		case "UNKNOWN":
			return review.commentedBy.length > 0 ? "commented" : "review ?";
	}
}

function renderStatus(ctx: ExtensionContext, status: PullRequestStatus) {
	ctx.ui.setStatus(STATUS_KEY, formatLinkedStatus(status));
}

export function formatLinkedStatus(status: PullRequestStatus): string {
	const text = formatCompactStatus(status);
	if (!status.url) return text;
	const label = `#${status.number}`;
	return text.replace(label, osc8Link(status.url, label));
}

function osc8Link(url: string, text: string): string {
	const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, "");
	if (!/^https?:\/\//.test(safeUrl)) return text;
	return `\x1b]8;;${safeUrl}\x07${text}\x1b]8;;\x07`;
}

function clearStatus(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function renderAmbientFailure(ctx: ExtensionContext, error: unknown) {
	const message = formatError(error);
	const lower = message.toLowerCase();

	if (isGhExecutableMissingMessage(lower)) {
		ctx.ui.setStatus(STATUS_KEY, "PR gh missing");
		return;
	}
	if (/not authenticated|auth login|authentication/.test(lower)) {
		ctx.ui.setStatus(STATUS_KEY, "PR gh auth");
		return;
	}

	clearStatus(ctx);
}

async function runGhPrCountQuery(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	pr: JsonRecord,
	signal?: AbortSignal,
): Promise<Pick<JsonRecord, "comments" | "reviews">> {
	const { owner, name, number } = parsePrCoordinates(pr);
	const result = await execGh(
		pi,
		[
			"api",
			"graphql",
			"-f",
			`query=${GH_PR_COUNT_QUERY}`,
			"-F",
			`owner=${owner}`,
			"-F",
			`name=${name}`,
			"-F",
			`number=${number}`,
		],
		cwd,
		signal,
		"gh api graphql",
	);

	if (result.killed) throw new Error("gh api graphql timed out or was cancelled.");
	if (result.code !== 0) throw new Error(formatGhFailure("gh api graphql", result));

	try {
		const payload = objectRecord(JSON.parse(result.stdout));
		const data = objectRecord(payload.data);
		const repository = objectRecord(data.repository);
		const pullRequest = objectRecord(repository.pullRequest);
		return { comments: pullRequest.comments, reviews: pullRequest.reviews };
	} catch (error) {
		throw new Error(`Failed to parse gh api graphql output: ${formatError(error)}`);
	}
}

async function execGh(
	pi: Pick<ExtensionAPI, "exec">,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	command: string,
): Promise<ExecResult> {
	try {
		return await pi.exec(
			"gh",
			args,
			{ cwd, signal, timeout: GH_TIMEOUT_MS },
		);
	} catch (error) {
		const message = formatError(error);
		if (isGhExecutableMissingMessage(message.toLowerCase())) {
			throw new Error(`GitHub CLI not found. Install gh and run: gh auth login. ${message}`);
		}
		throw new Error(`${command} could not start: ${message}`);
	}
}

function formatGhFailure(command: string, result: ExecResult): string {
	const output = (result.stderr || result.stdout).trim();
	const lower = output.toLowerCase();
	if (isGhExecutableMissingMessage(lower)) {
		return "GitHub CLI not found. Install gh and run: gh auth login.";
	}
	if (/not logged in|authentication|auth login|gh auth/.test(lower)) {
		return `GitHub CLI is not authenticated. Run: gh auth login. ${output}`;
	}
	if (/no pull requests|could not resolve|not a github repository/.test(lower)) {
		return `No GitHub pull request found. ${output}`;
	}
	return `${command} failed (${result.code}): ${output || "no output"}`;
}

function isGhExecutableMissingMessage(lowerMessage: string): boolean {
	return (
		/\bgithub cli (?:not available|not found)\b/.test(lowerMessage) ||
		/\b(?:gh|gh\.exe)\b.*\benoent\b|\benoent\b.*\b(?:gh|gh\.exe)\b/.test(lowerMessage) ||
		/\b(?:gh|gh\.exe): (?:command )?not found\b/.test(lowerMessage) ||
		/\bcommand not found: (?:gh|gh\.exe)\b/.test(lowerMessage) ||
		/\b(?:gh|gh\.exe): no such file or directory\b/.test(lowerMessage)
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parsePrCoordinates(pr: JsonRecord): { owner: string; name: string; number: number } {
	const number = requiredNumber(pr.number, "number");
	const url = optionalString(pr.url);
	if (!url) throw new Error("Missing PR url");

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (error) {
		throw new Error(`Invalid PR url: ${formatError(error)}`);
	}

	const match = /^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/.exec(parsed.pathname);
	if (!match) throw new Error(`Unsupported PR url: ${url}`);

	return { owner: match[1], name: match[2], number };
}

function arrayValue(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const object = objectRecord(value);
	return Array.isArray(object.nodes) ? object.nodes : [];
}

function objectRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new Error(`Missing numeric PR ${name}`);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
