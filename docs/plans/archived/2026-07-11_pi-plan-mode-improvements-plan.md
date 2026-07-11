## Goal

Improve `pi-plan-mode` toward current Codex Plan Mode behavior while preserving Pi-specific ergonomics, with implementation split into bounded stages whose progress and verification can be tracked independently.

## Context

The extension already provides persistent mode state, read-only tool selection, structured questions, `<proposed_plan>` detection, and an implementation handoff. The main gaps are enforcement strength, shell-policy accuracy, prompt drift from `third_party/codex`, malformed-plan handling, Plan-specific thinking level, and end-to-end coverage.

## Non-Goals

- Do not claim sandbox-level guarantees that the Pi extension API cannot provide.
- Do not add dependencies unless a shell parser or another library is proven necessary by the policy-design stage.
- Do not enable arbitrary extension tools by default.
- Do not redesign Pi core APIs as part of this extension change; record any required core metadata as follow-up work.

## Assumptions

- `third_party/codex/codex-rs/collaboration-mode-templates/templates/plan.md` is the behavioral reference, while Pi-specific command, statusline, and tool-selection UX remains supported.
- Each stage below should be independently reviewable and leave `npm run check` passing before the next stage starts.
- Plan-specific thinking level will use Pi's existing `getThinkingLevel()` and `setThinkingLevel()` APIs only if restoration semantics can avoid overwriting an explicit user change made during Plan mode.

## Progress Control

Use this document as the implementation ledger. Work on exactly one unchecked stage at a time, update its task and completion evidence immediately after its verification gate passes, and do not start a dependent stage while the current gate is failing. Prefer one focused commit per numbered stage; if a stage reveals a wider design change, update this plan before coding further. Run the package-focused tests during iteration and `npm run check` at every stage boundary. Archive this plan only after every task and completion check is marked complete with evidence.

## Plan

- [x] **Stage 1 — Enforce mode invariants.** Added direct `tool_call` blocking for `update_plan` while preserving built-in mutation enforcement; hook tests pass in the 304-test root suite.
- [x] **Stage 2 — Synchronize Codex planning behavior.** Reconciled `src/prompt.ts` with recommended-default assumptions, complete replacement and unchanged-plan rules, one-block limits, and behavior-level output guidance; prompt assertions and `npm run check` pass.
- [x] **Stage 3 — Validate proposed plans structurally.** Added deterministic absent/valid/empty/multiple/malformed/unclosed results, warning behavior that stays unready, and complete-block-only stripping; parser and agent-end tests pass.
- [x] **Stage 4 — Harden command policy.** Added quote-aware segmentation for chains and pipelines with fail-closed rejection of redirects, substitutions, subshells, background jobs, unknown commands, mutating flags, and adversarial command forms; the command matrix and `npm run check` pass.
- [x] **Stage 5 — Improve tool risk classification.** Added shared `read-only`, `limited`, `user-opt-in`, and `blocked` classifications for selection and labels, retained unknown non-built-ins as opt-in, and verified built-in/extension selection plus session tool restoration. No external tool received a read-only default because Pi metadata has no mutability contract.
- [x] **Stage 6 — Add optional Plan thinking level.** Added validated `plan-mode.json` inherit/fixed settings with ownership-aware restoration; tests cover entry, resume, provider clamping, manual changes, implementation handoff, normal exit, and session shutdown.
- [x] **Stage 7 — Cover complete lifecycle flows.** Added command/event tests for entry, inline delivery, tool enforcement, valid/invalid readiness, implementation, send/stale-context failure rollback, resume, shutdown, and exact tool/thinking restoration; `npm run check` passes and `pi -ne -e ./extensions/pi-plan-mode --help` exposes `--plan` without opening an interactive UI.
- [x] **Stage 8 — Refresh user documentation.** Updated `extensions/pi-plan-mode/README.md` with safety limits, command classes, malformed-plan recovery, thinking settings, extension-tool risk, and native-Codex differences; `just pack-plan-mode` contains all nine expected files including `src/settings.ts`.

## Risks

- Shell syntax is too broad to secure with incomplete tokenization; ambiguous or unsupported constructs must fail closed rather than receive optimistic classification.
- Tests/builds can run arbitrary project hooks and therefore are not inherently read-only; the Stage 4 policy must distinguish explicitly trusted command forms or continue blocking them.
- Tool names are not stable proof of mutability, especially when extensions override built-ins; source metadata must remain part of every decision.
- Thinking-level restoration can clobber a user's manual change; Stage 6 must be omitted or revised if ownership cannot be detected reliably through available events/state.
- Syncing Codex wording verbatim may conflict with Pi capabilities; intentional deviations must be explicit in tests and documentation rather than silently drifting.

## Completion Checklist

- [x] Active Plan mode blocks `update_plan`, built-in mutation, unsafe shell forms, and blocked policy classes, verified by hook-level and adversarial tests.
- [x] Safe exploration, structured questions, valid plan production, revision rules, implementation handoff, exit, and session restoration are verified by prompt assertions, tool tests, and lifecycle integration tests.
- [x] Proposed-plan parsing reports every defined valid/invalid state deterministically and never marks malformed output ready, verified by parser and agent-end tests.
- [x] Prompt behavior is reconciled against the vendored Codex template, with Pi-specific deviations recorded in source tests and README documentation.
- [x] Optional thinking-level behavior preserves manual user changes and provider-clamped levels across tested transitions.
- [x] User-facing safety and configuration documentation matches implemented behavior, verified by README review and `just pack-plan-mode` output.
- [x] Repository quality gates pass with `npm run check` (304/304 tests), and extension loading is smoke-tested non-interactively with `pi -ne -e ./extensions/pi-plan-mode --help` showing `--plan`.
