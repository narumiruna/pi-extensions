import { getCapabilities } from "@earendil-works/pi-tui";
import type { GithubPrSnapshot, GithubPrState } from "../modules/types.js";
import type { WorkspaceExec } from "./types.js";

const GH_TIMEOUT_MS = 10_000;
const MAX_GH_OUTPUT_BYTES = 128 * 1024;
const MAX_URL_LENGTH = 4_096;
const MAX_CHECKS = 1_000;
const MAX_FIELD_LENGTH = 128;
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
export const TERMINAL_PR_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const GH_PR_FIELDS = [
  "number",
  "isDraft",
  "url",
  "state",
  "closedAt",
  "mergedAt",
  "reviewDecision",
  "statusCheckRollup",
] as const;

interface GithubPrQueryOptions {
  platform?: NodeJS.Platform;
  environment?: Readonly<Record<string, string | undefined>>;
}

interface CheckSummary {
  failed: number;
  pending: number;
  total: number;
}

type PullRequestState = "OPEN" | "CLOSED" | "MERGED";
type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";

export function ghPrViewInvocation(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  return {
    command: platform === "win32" ? "gh.exe" : "gh",
    args: ["pr", "view", "--json", GH_PR_FIELDS.join(",")],
  };
}

export function githubPrEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toUpperCase();
    if (normalized === "GH_HOST" || normalized === "GH_REPO") continue;
    Object.defineProperty(environment, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return environment;
}

export async function queryGithubPr(
  exec: WorkspaceExec,
  cwd: string,
  signal?: AbortSignal,
  now = Date.now(),
  options: GithubPrQueryOptions = {},
): Promise<GithubPrSnapshot | undefined> {
  const invocation = ghPrViewInvocation(options.platform);
  try {
    const result = await exec(invocation.command, invocation.args, {
      cwd,
      signal,
      timeout: GH_TIMEOUT_MS,
      maxOutputBytes: MAX_GH_OUTPUT_BYTES,
      environment: githubPrEnvironment(options.environment),
    });
    if (result.killed || result.code !== 0) return undefined;
    if (Buffer.byteLength(result.stdout) > MAX_GH_OUTPUT_BYTES) return undefined;
    return buildGithubPrSnapshot(JSON.parse(result.stdout), now);
  } catch {
    return undefined;
  }
}

export function buildGithubPrSnapshot(value: unknown, now = Date.now()): GithubPrSnapshot | undefined {
  try {
    const pr = record(value);
    const number = positiveInteger(pr.number);
    const isDraft = requiredBoolean(pr.isDraft);
    const url = requiredBoundedString(pr.url, MAX_URL_LENGTH, true);
    const state = pullRequestState(pr.state);
    const closedAt = optionalTimestamp(pr.closedAt);
    const mergedAt = optionalTimestamp(pr.mergedAt);
    const reviewDecision = reviewDecisionValue(pr.reviewDecision);
    const checks = summarizeChecks(pr.statusCheckRollup);
    const expiresAt = terminalExpiry(state, closedAt, mergedAt);
    if (state !== "OPEN" && (expiresAt === undefined || now >= expiresAt)) return undefined;

    const presentationState: GithubPrState =
      state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : isDraft ? "draft" : "open";
    const checksText = formatChecks(checks);
    const review = formatReview(reviewDecision);
    const status = compactStatus(presentationState, checks, checksText, review);
    const snapshot: GithubPrSnapshot = {
      number: String(number),
      link: osc8Link(url, `#${number}`),
      state: presentationState,
      checks: checksText,
      review,
      status,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

export function githubPrSnapshotEqual(
  left: GithubPrSnapshot | undefined,
  right: GithubPrSnapshot | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function terminalExpiry(
  state: PullRequestState,
  closedAt: number | undefined,
  mergedAt: number | undefined,
): number | undefined {
  if (state === "OPEN") return undefined;
  const terminalAt = state === "MERGED" ? mergedAt : closedAt;
  return terminalAt === undefined ? undefined : terminalAt + TERMINAL_PR_LIFETIME_MS;
}

function summarizeChecks(value: unknown): CheckSummary {
  if (!Array.isArray(value) || value.length > MAX_CHECKS) throw new Error("Invalid PR checks");
  const summary: CheckSummary = { failed: 0, pending: 0, total: value.length };
  for (const item of value) {
    const check = record(item);
    const state = optionalUppercase(check.state);
    const status = optionalUppercase(check.status);
    const conclusion = optionalUppercase(check.conclusion);
    if (state === "SUCCESS") continue;
    if (state === "FAILURE" || state === "ERROR") {
      summary.failed += 1;
      continue;
    }
    if (state === "PENDING" || state === "EXPECTED") {
      summary.pending += 1;
      continue;
    }
    if (status && status !== "COMPLETED") {
      summary.pending += 1;
      continue;
    }
    if (conclusion === "SUCCESS" || conclusion === "SKIPPED" || conclusion === "NEUTRAL") {
      continue;
    }
    if (
      conclusion === "FAILURE" ||
      conclusion === "CANCELLED" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "ACTION_REQUIRED" ||
      conclusion === "STARTUP_FAILURE"
    ) {
      summary.failed += 1;
      continue;
    }
    summary.pending += 1;
  }
  return summary;
}

function formatChecks(checks: CheckSummary): string {
  if (checks.total === 0) return "-";
  const passed = checks.total - checks.failed - checks.pending;
  return [compactCount("✓", passed), compactCount("×", checks.failed), compactCount("…", checks.pending)]
    .filter(Boolean)
    .join(" ");
}

function compactCount(symbol: string, count: number): string {
  return count > 0 ? `${symbol}${count}` : "";
}

function formatReview(review: ReviewDecision): string {
  if (review === "APPROVED") return "R✓";
  if (review === "CHANGES_REQUESTED") return "R×";
  if (review === "REVIEW_REQUIRED") return "R?";
  return "";
}

function compactStatus(state: GithubPrState, checks: CheckSummary, checksText: string, review: string): string {
  if (state === "merged") return "M";
  if (state === "closed") return "C";
  if (state === "draft") return "D";
  if (checks.failed > 0) return compactCount("×", checks.failed);
  if (review === "R×") return review;
  if (checks.pending > 0) return compactCount("…", checks.pending);
  if (review === "R✓" || review === "R?") return review;
  return checksText;
}

function osc8Link(value: string, label: string): string {
  if (!getCapabilities().hyperlinks || hasTerminalControls(value)) return label;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return label;
    }
    const normalized = url.toString();
    if (normalized.length > MAX_URL_LENGTH || hasTerminalControls(normalized)) return label;
    return `\u001b]8;;${normalized}\u0007${label}\u001b]8;;\u0007`;
  } catch {
    return label;
  }
}

function hasTerminalControls(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    );
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected PR object");
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid PR number");
  }
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid PR boolean");
  return value;
}

function requiredBoundedString(value: unknown, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    throw new Error("Invalid PR string");
  }
  return value;
}

function optionalUppercase(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return requiredBoundedString(value, MAX_FIELD_LENGTH).toUpperCase();
}

function optionalTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const text = requiredBoundedString(value, MAX_FIELD_LENGTH);
  const match = RFC3339_TIMESTAMP.exec(text);
  if (!match) throw new Error("Invalid PR timestamp");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error("Invalid PR timestamp");
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid PR timestamp");
  return timestamp;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function pullRequestState(value: unknown): PullRequestState {
  if (value === "OPEN" || value === "CLOSED" || value === "MERGED") return value;
  throw new Error("Invalid PR state");
}

function reviewDecisionValue(value: unknown): ReviewDecision {
  if (value === null || value === undefined || value === "" || value === "UNKNOWN") return "";
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
    return value;
  }
  throw new Error("Invalid PR review decision");
}
