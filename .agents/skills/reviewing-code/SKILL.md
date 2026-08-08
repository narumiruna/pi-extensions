---
name: reviewing-code
description: Review diffs, pull requests, commits, patches, or source files for correctness, baseline security, performance, maintainability, tests, and integration risk. Use for ordinary read-only review, edge-case audits, PR preflight, and reviewer simulation; use auditing-code-security when security is the primary objective, and hardening-code-paths to fix confirmed failure modes.
---

# Reviewing Code

Review the requested change, not the entire codebase. Treat the task as read-only unless fixes are requested. Keep this as an ordinary code review with a security baseline; when security is the primary objective or acceptance criterion, use `auditing-code-security` instead of expanding this workflow into a full security audit.

## Workflow

1. Determine the exact target and comparison base from the request and repository or PR context. Use the target branch's merge base; do not assume `main`. State broader file-audit scope when no diff is involved.
2. Infer intended behavior from the request, issue/PR context, tests, docs, and surrounding code. Label material assumptions.
3. Trace changed behavior through relevant callers, contracts, state, errors, and downstream consumers. Report issues introduced, worsened, or made reachable by the change; separate directly relevant pre-existing problems.
4. Check, where plausible:
   - correctness, boundaries, state transitions, retries, concurrency, partial failure, and cleanup
   - where repeated work without progress stops, and its worst-case time, resources, cost, and side effects
   - interfaces, schemas, migrations, jobs, caches, feature flags, permissions, and configuration
   - security baseline: affected assets and trust boundaries; authn/authz and tenant or object ownership; source-to-sink validation and injection; secrets, logging, and sensitive data; dependency and configuration exposure
   - repeated work, I/O, queries, blocking, leaks, and expected scale
   - tests for changed behavior and concrete error paths; maintainability only where it creates real cost or risk
5. Run focused checks when feasible. Passing checks support but do not prove correctness.
6. Stop after the relevant diff, directly affected contracts/callers, and focused evidence are covered. Distinguish confirmed findings, inferred risks, and unverified areas.

When fixes are requested, confirm the finding first, then use `hardening-code-paths` for bounded edge-case or failure-mode work. Do not hand off speculative or preference-only comments. Use `auditing-code-security` first when a security alert needs threat-focused reachability analysis. Return to review the resulting diff and evidence.

## Findings

Lead with confirmed findings ordered by severity:

- **Critical:** severe security impact, data loss, or widespread production failure.
- **Major:** important correctness, reliability, security, or maintainability risk that should block merge.
- **Minor:** real, low-risk defect worth correcting.

Each finding needs a file/line when available, concrete trigger, impact, and actionable fix. Omit nits unless requested. If no finding survives verification, say so and name meaningful residual risk or unavailable checks.

Give a merge verdict only for a PR/MR or explicit mergeability request: `Approve`, `Approve with minor comments`, `Request changes`, or `Needs more context`.
