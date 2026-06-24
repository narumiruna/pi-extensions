## Goal

Change `@narumitw/pi-github-pr` into a passive statusline-only Pi extension. Success means Pi automatically shows a compact current-branch PR status in the footer/status area, without slash commands, custom tools, widgets, detailed panes, or injected PR comments.

## Context

- The extension should behave closer to VS Code's GitHub PR status affordance: ambient, compact, and out of the way.
- The user explicitly does not want `/pr`, widget/detail output, LLM tools, or comment injection into the conversation.
- Keep GitHub access delegated to the authenticated `gh` CLI.

## Architecture

- Register no Pi command and no Pi tool.
- Use lifecycle hooks only:
  - `session_start`: resolve the current branch PR and set a compact `github-pr` status when available.
  - `agent_end`: refresh the current branch PR status after agent turns.
  - `session_shutdown`: clear the `github-pr` status.
- Data flow:
  1. Execute `gh pr view --json number,isDraft,reviewDecision,latestReviews,reviews,comments,statusCheckRollup` through `pi.exec` from `ctx.cwd`.
  2. Normalize the result into `PullRequestStatus`.
  3. Render only `ctx.ui.setStatus("github-pr", compactText)`.
  4. On no PR, missing `gh`, unauthenticated `gh`, or non-GitHub repo, clear or show a short non-intrusive status instead of opening notifications/widgets.

## Non-Goals

- Do not register `/pr` or any other slash command.
- Do not register `github_pr_status` or any other custom tool.
- Do not call `ctx.ui.setWidget`.
- Do not inject comments or PR data into the model conversation.
- Do not read full PR comment bodies with `gh api` in this statusline-only version.
- Do not implement polling, webhooks, token storage, or GitHub OAuth.

## Assumptions

- Statusline refresh on `session_start` and `agent_end` is enough; no continuous background polling is needed.
- `gh pr view` comment/review counts are sufficient for compact status; exact unresolved review-thread counts are out of scope.
- Users prefer silent failure/clear status over notifications for ambient PR detection failures.

## Plan

- [x] Remove the `/pr` command registration, command parsing, command completions, help text, widget rendering, and command-focused tests from `extensions/pi-github-pr/src/github-pr.ts`; verified with `npm run check`.
- [x] Remove the `github_pr_status` tool registration, `typebox` schema usage, and tool-focused tests; verified by package metadata without `typebox` runtime dependency and `npm run check`.
- [x] Keep and simplify the pure `gh pr view` normalization/formatting path so it produces a compact text-only status string shaped like `PR #116 CI ok approved C4`; verified with unit tests for passing, failing, pending, draft, approved, changes-requested, review-required/commented, and no-CI cases.
- [x] Implement passive lifecycle refresh only on `session_start`, `agent_end`, and `session_shutdown`; verified by mocked lifecycle tests showing status is set on successful PR lookup, refreshed after agent turns, and cleared on shutdown.
- [x] Make ambient failures non-intrusive by clearing status or setting a short status only for actionable failures; verified by tests covering no PR, missing `gh`, unauthenticated `gh`, and non-GitHub repo without widget/notification output.
- [x] Update `extensions/pi-github-pr/README.md` to describe statusline-only behavior, `gh` prerequisites, no commands/tools, and known limits; verified by `just pack-github-pr` tarball contents.
- [x] Update package metadata/dependencies after `typebox` became unused; verified with `npm install --package-lock-only --ignore-scripts`.
- [x] Run repository gates; verified by `npm run check` and `just pack-github-pr` passing.

## Risks

- Automatic PR lookup may briefly show errors in non-GitHub directories; mitigated by treating no-PR/non-GitHub as a quiet cleared status.
- `statusCheckRollup` shape varies across checks and statuses; mitigated by defensive normalization and fixture tests.
- Removing the tool means the agent cannot directly query arbitrary PRs or comments through this extension; accepted because the target behavior is statusline-only.

## Completion Checklist

- [x] No slash commands are registered by `pi-github-pr`, verified by unit tests asserting `mock.commands.size === 0`.
- [x] No custom tools are registered by `pi-github-pr`, verified by unit tests asserting `mock.tools` is empty.
- [x] No widget/detail output is produced, verified by tests asserting `setWidget` output stays unused.
- [x] The statusline shows compact current-branch PR status, verified by lifecycle tests for `session_start` and `agent_end`.
- [x] Documentation matches statusline-only behavior, verified in `extensions/pi-github-pr/README.md` and `just pack-github-pr` output.
- [x] Code passes `npm run check` and package dry run passes `just pack-github-pr`.
