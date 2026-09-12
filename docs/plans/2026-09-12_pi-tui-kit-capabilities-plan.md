# Pi TUI Kit capability alignment plan

## Goal

Align existing Kit interactions with Pi, add the highest-value missing capabilities, and admit new reusable components only when concrete consumers share a compatible contract. Deliver independently reviewable changes without moving extension policy into the library.

This document authorizes no implementation or publication. Execution requires a separate request. Consumer adoption of a new Kit API requires a published Kit release and is outside this plan's implementation boundary.

## Context

The preceding source audit covered Pi's editor, selectors, settings and preview flows, session and conversation trees, authentication and onboarding, CLI configuration, model downloads, message renderers, status UI, fullscreen viewport, and extension UI examples.

The audit inspected installed Pi `0.85.1`; repository manifests declared Pi `0.85.0`. Re-derive these versions from manifests, the lockfile, and the runtime used for execution rather than treating this snapshot as a compatibility requirement.

Two isolated probes against the inspected runtime found:

- Kit's thinking selector uses `app.models.save`, whereas Pi uses `app.thinking.save`; independently remapping the actions exposes the difference.
- Kit's selector changes selection on mouse hover, whereas the inspected public `SelectList` does not.

Source inspection also found that most standard Kit screens do not expose mouse handlers. These findings are not evidence of a complete package test run or an interactive terminal smoke. Root dependencies were absent when this plan was drafted.

Primary evidence:

- [Selector adapter](../../packages/pi-tui-kit/src/pi-selectors.ts), [selector component](../../packages/pi-tui-kit/src/components/pi-selectors.ts), and [screen contracts](../../packages/pi-tui-kit/src/types.ts).
- [Live choice](../../packages/pi-tui-kit/src/live-choice.ts), [document formatting](../../packages/pi-tui-kit/src/components/document-formatting.ts), and [task lifecycle](../../packages/pi-tui-kit/src/task.ts).
- [Sync masked input](../../packages/pi-sync/src/ui/secret-input.ts) and [Langfuse configuration input](../../packages/pi-langfuse/src/langfuse.ts).

## Architecture

Keep production Kit JavaScript on public `pi-tui` primitives; coding-agent imports remain type-only. Inspect Pi implementations as behavioral evidence, never import its runtime root or private components into Kit. Prefer internal helpers over additional public lifecycle APIs.

Kit owns presentation, input routing, and its existing interaction settlement contracts. Extensions retain data acquisition, validation, secrets, persistence, confirmations, preview rollback, and session policy. Existing default behavior and supported modes remain unchanged unless a documented compatibility correction requires a transition.

### Touched areas and mandatory verification

Read [extension conventions](../extension-conventions.md), [settings conventions](../extension-settings.md), [README conventions](../readme-conventions.md), and [Kit guidelines](../../packages/pi-tui-kit/AGENTS.md) before implementation; apply consumer-scoped instructions if that scope is later authorized.

| Area | Applicable MUST rules and repository requirements | Verification |
| --- | --- | --- |
| Runtime and API boundary | Public Pi primitives first; no coding-agent runtime imports or extension-to-extension dependencies; two compatible consumers before a new public screen or lifecycle API | **Review:** imports and consumer contracts; **Validator:** boundaries and typechecks; **Test:** exports and built consumption |
| TUI rendering and input | Width bounds, callback theme and keybindings, focus forwarding, render invalidation, reachable hints, standard actions before shortcuts, Ctrl+C hard close, exact paste semantics | **Test:** component and input matrices; **Review:** listener ordering; **Smoke:** regular and fullscreen Pi |
| Async interactions | Cancel and release owned work on user cancellation, disposal, replacement, and shutdown; revalidate ownership and mutable state after awaits; preserve Back/Close and settlement | **Test:** controlled delayed callbacks and repeated disposal; **Review:** all changed continuations |
| Modes | Enter custom UI only in TUI mode; preserve observable RPC/print/JSON results or explicit rejection; no ad hoc protocol output | **Test:** TUI/RPC harnesses and unsupported modes; **Review:** entrypoints and downgrade contracts |
| Settings and secrets | Keep storage extension-owned; preserve ordered saves, rollback, invalid-file protection, unknown fields, atomic publication, and credential privacy if a consumer path changes | **Review:** read/write paths together; **Test:** affected consumer persistence and redaction suites |
| Documentation and releases | Document actual capabilities and deviations; independently version published behavior with Changesets; publish Kit before consumer floor increases | **Review:** README/API and release intent; **Validator/Test:** root gates; **Smoke:** applicable pack and runtime loading |

## Non-Goals

- Reimplement Pi's Editor, ScrollView, layout, Loader, Image, Markdown, LaTeX, Mermaid, or terminal renderer.
- Introduce a generic session selector, tree, async catalog, chat/transcript framework, auth/setup wizard, overlay coordinator, or reorder framework.
- Change settings schemas, credential locations, provider behavior, prompts, active tools, or terminal ownership.
- Migrate consumers onto unpublished APIs, publish packages, change visibility, create version tags, or dispatch release workflows.

## Plan

All paths below are relative to `packages/pi-tui-kit/` unless stated otherwise. Each implementation slice must include its focused tests, documentation, and Changeset before handoff; do not postpone those requirements until the last slice.

### 0. Establish the execution baseline

- [x] Install root dependencies with `npm install` after confirming intended worktree changes; resolved coding-agent and TUI `0.85.0`, and installation changed no manifest or lockfile.
- [x] Reproduce the thinking-save and hover findings against the resolved runtime in `test/pi-selectors.test.ts`; preserve the independent Model/Thinking remap case and record any difference from the audit runtime. Resolve an explicit compatibility-floor decision first if the baseline lacks the required public action or API.
- [x] Enumerate authoritative input branches in Pi's keybinding manager, public Input/SelectList/SettingsList, and fullscreen routing; execution review established definition-aware key resolution, hard-cancel/action priority, press/click target retention, wheel clamping, Input press versus Editor click behavior, and legacy/Kitty disambiguation for focused tests.
- [x] Establish the root baseline with sequential `npm run check` and `npm test`; both passed (`396` files and `4615` tests), with only two pre-existing non-failing Biome template-literal infos outside the planned scope.

### 1. Correct selector compatibility

- [x] Update `src/pi-selectors.ts` and `src/components/pi-selectors.ts` so Thinking and Model save use their respective injected actions; verify default keys, independently remapped keys, and matching visible hints in `test/pi-selectors.test.ts`.
- [x] Align selector mouse behavior with the established public-control contract, including a stable press target across recentering; verify hover, press/release, disabled and empty lists, wheel navigation, filtering, and resize in `test/pi-selectors.test.ts`.
- [x] Add table-driven shortcut tests for matcher aliases, modifier order, invalid configured strings, legacy collisions, Kitty mode, and first usable fallback; prove configured standard actions take priority and Ctrl+C still closes under remapped cancellation.

### 2. Add mouse support to existing screens

- [x] Extend the existing contracts and internal frame geometry in `src/components/contracts.ts`, `src/components/rendering.ts`, and `src/bounded-frame.ts` only as needed to map rendered coordinates to stable targets; verify clipped headers, multiline rows, fixed actions, and zero/one-column rendering in `test/bounded-frame.test.ts` and screen tests.
- [x] Route mouse input for actions, choice, settings, and multiSelect through their owning components; verify disabled rows cannot activate, filtered selection stays stable, pending actions cannot duplicate, and save failures retain existing rollback behavior in `test/screen-components.test.ts`, `test/searchable-choice.test.ts`, and `test/runtime.test.ts`.
- [x] Route browse/review scrolling and embedded Input/Editor mouse events without adding activation cursors to passive text; verify search focus, confirmation-only targets, document offsets, and exact text in `test/browse-screen.test.ts`, `test/review-screen.test.ts`, and `test/input-screen.test.ts`.
- [x] Preserve mouse, focus, and disposal forwarding through wrappers, including `src/live-choice.ts` and questionnaire components; verify the actual outer component receives events in `test/live-choice.test.ts`, `test/questionnaire.test.ts`, and `test/custom-interaction.test.ts`.
- [x] Extend `src/testing/tui-harness.ts` only for missing event evidence and record its routing limits; capture evidence inside mocked custom-UI callbacks and assert after completion, verify mouse tests do not claim real fullscreen listener coverage, and retain regular-mode keyboard behavior through the existing TUI and RPC suites.

### 3. Deliver focused enhancements as separate slices

#### 3a. Intraline diff

- [x] Add bounded intraline highlighting to `src/components/document-formatting.ts` using Kit's actual diff representation rather than Pi's incompatible line parser; verify a one-line replacement, ambiguous multiline changes, headers, tabs, Unicode, and large-input fallback in `test/terminal-document.test.ts` and `test/review-screen.test.ts`.
- [x] Preserve exact content, search offsets, width bounds, theme invalidation, and non-TUI review pages after highlighting; verify `test/document-search.test.ts`, `test/browse-screen.test.ts`, and `test/review-screen.test.ts`, without bundling copy, hunk navigation, or horizontal scrolling into this slice.

#### 3b. Searchable live choice

- [x] Add opt-in search metadata and filtering to `src/live-choice.ts` by reusing choice behavior; verify stable IDs, empty results, disabled items, current/initial selection, and unchanged RPC lists in `test/live-choice.test.ts`.
- [x] Preserve preview ordering and settlement while filtering, including the selected row disappearing, rapid navigation, rejected previews, and cancellation during pending work; verify no input or paste is consumed by additive shortcuts and no preview survives disposal in `test/live-choice.test.ts`.
- [x] Validate the proposed options against `packages/pi-starship/src/command-preset-picker.ts` and `packages/pi-statusline/src/commands.ts` without changing their dependency floors; record adapter examples proving existing preview and rollback contracts remain expressible.

#### 3c. Input prefill

- [x] Resolve the prefill contract for TUI and RPC before changing `InputScreen`: distinguish placeholder from editable initial content, preserve existing RPC behavior, and document any opt-in unsupported-mode result; verify the decision against Pi's actual RPC protocol and `test/testing-rpc.test.ts`.
- [x] Add prefill to `src/types.ts` and `src/components/input.ts` only after the mode contract is accepted; verify exact initial content, cursor editing, Backspace, submission, paste, focus, rejected-draft retention, and cancellation in `test/input-screen.test.ts` and `test/runtime.test.ts`.

### 4. Resolve new-component admission before implementation

- [x] Compare Sync's masked input and Langfuse's current secret-entry flow, including required versus blank-to-keep semantics, cancellation, validation ownership, and existing non-TUI behavior; record either two compatible adapter contracts or an explicit deferral before adding any public SecretInput API.
- [x] Resolve SecretInput's mode/security contract with explicit user acceptance of any changed mode behavior: RPC has no masking field, so never silently fall back to plain input; specify a safe manual alternative or explicit unsupported result, with existing non-TUI capability preserved unless a breaking change is approved.
- [x] If the admission gate passes, add the smallest masked-input component and existing-lifecycle adapter under `src/`, plus `test/secret-input.test.ts`; prove editing/paste/IME behavior, no secret in rendered frames or error/status metadata, no history, and internal reference cleanup on completion, cancellation, stale context, and disposal, without promising secure JavaScript memory erasure.
- [x] If SecretInput is admitted, expose and document only the tested contract in `src/index.ts`, `README.md`, and `docs/api.md`; verify export/type tests and leave both consumers on their existing implementation until the Kit API is published. If admission fails, mark these conditional implementation tasks not applicable with the recorded reason.
- [x] Record finite admission decisions for the remaining candidates in the execution evidence using the table below; do not implement them in this plan or count superficially similar screens as compatible consumers.

| Candidate | Required evidence | Disposition in this plan |
| --- | --- | --- |
| Controlled Disclosure/ExpandableDocument | Compare `packages/pi-subagents/src/completion-renderer.ts` and `packages/pi-fleet/src/renderer.ts`; prove useful shared collapsed/expanded presentation without owning global expansion keys | Decision only; retain Box/Text composition if abstraction adds little value |
| ProgressMeter and `runTask()` reporting | Compare `packages/pi-usage/src/format.ts` with a second real progress producer; separate passive rendering from task ownership and commit-aware cancellation | Decision only; do not migrate Sync's commit-aware loader to ordinary `runTask()` |
| Model scope and background snapshots | Identify two compatible callers of optional scope/refresh behavior; prove consumer-owned fetching, cache fallback, stale guards, and abort/drain | Defer implementation; retain the current snapshot API |
| Settings metadata and grouped multiSelect | Identify actual consumers requiring disabled reasons/value labels/search metadata or group summaries; preserve existing transitions and bulk actions | Decision only; no generic settings persistence or reorder API |
| Scope/filter bar | Compare actual scope/view controls, starting with `packages/pi-recall/src/picker.ts`; prove a second compatible consumer beyond visual resemblance | Defer implementation; no action/async catalog framework |

### 5. Verify and prepare each implementation handoff

- [x] Update Kit `README.md` and `docs/api.md` for each delivered capability, supported mode, and intentional deviation; verify documented examples, the README guide's fenced-code-aware heading audit, and that deferred candidates are not advertised as implemented.
- [x] Add independently scoped Changesets for every package whose published behavior changes; verify release intent and keep the plan-only documentation change Changeset-free.
- [x] Run root `npm run format`, inspect its diff for unrelated formatting, then run `npm run check` and `npm test` sequentially; final execution found no formatting changes, `npm run check` passed with the two baseline Biome infos, and `npm test` passed with 398 files and 4,646 tests. No timeout override or build-ready override was added.
- [x] Add a test-only fixture at `test/fixtures/interaction-smoke.ts` for corrected selectors and newly delivered options, loading the locally built Kit without changing a published consumer; verify it registers and loads without live credentials and exercises cases absent from the existing showcase.
- [ ] Arrange human-operated regular/fullscreen smokes using `npm run showcase:tui-kit` for existing screens and `pi --no-extensions --no-skills -e ./packages/pi-tui-kit/test/fixtures/interaction-smoke.ts` for new behavior; verify remapped keys, mouse, narrow dimensions, and theme changes. Never launch these interactive commands from a non-interactive agent tool; if unavailable, leave the smoke open and report the unverified paths.
- [x] Run `npm run package:pack -- tui-kit` when metadata, exports, or published contents change and inspect its dry-run file list; final execution packed 84 files, then created and inspected a temporary tarball containing built JavaScript, declarations, README, API documentation, and package metadata. Emitted JavaScript has no coding-agent runtime import and retains the direct `diff` runtime boundary.
- [x] If an extension's runtime loading changes, build it with `npm --workspace @narumitw/pi-<name> run build --if-present`, exercise a representative generated lazy boundary through Pi's Jiti loader, and arrange a human-operated `pi -e ./packages/pi-<name>` smoke; not applicable because this change affects the reusable library and a test-only source fixture, not any packaged extension runtime or generated lazy boundary.
- [x] Audit the final diff against the touched-area table, including all affected async continuations and settings read/write paths; the final review covered event geometry and disposal, action settlement, preview abort/drain, stale completion, TUI/RPC mode branches, terminal sanitization, secret redaction, and package boundaries. No settings read/write or consumer persistence path changed; the human fullscreen smoke remains explicitly unverified.
- [x] Prepare release/adoption handoff without publishing: API version 18 and the minor Changeset cover Kit only; `npm run changeset:status` and `npm ls @narumitw/pi-tui-kit --all` passed. Registry availability is required before any consumer floor increase, followed by root install/resolution/typecheck and each consumer's validation, redaction, cancellation, and mode tests.

## Execution evidence

Execution began on 2026-09-12 from `origin/main` at `2e9b92f8a` on `narumi/feat/tui-kit-capability-alignment` after the separately authorized implementation request.
Root installation resolved Pi Coding Agent and Pi TUI `0.85.0`; the initial sequential `npm run check` and `npm test` passed with 396 files and 4,615 tests.
Pi `0.85.0` does not define `app.thinking.save`, so the selector now prefers that definition when present and falls back to `app.models.save` only for an older Pi definition set, not when the new action is intentionally unbound.
Normalized harness probes confirm passive hover, stable press/click targets, wheel routing, focus forwarding, resize/filter mapping, and disposal cleanup; they do not exercise Pi's real fullscreen listener.

SecretInput admission passed for the shared TUI interaction only:

- Sync's adapter contract is `required: true` by default, submitted value to credential setup, and every closed/stale/unsupported result to its existing cancellation path.
- Langfuse's TUI adapter contract is `required: false`, where an empty submitted value preserves the current secret; its existing plaintext RPC setup is intentionally unchanged and blocks migration until a separately approved manual or breaking mode transition exists.
- `runSecretInput()` itself never opens a plaintext RPC dialog, returns explicit `unsupported`, owns no credential validation or storage, emits no secret metadata, clears component-held references on every exit, and makes no secure-memory-erasure claim.
- Both consumers remain unchanged and keep their current Kit floors until this API is published, as required by the release boundary.

Searchable Live Choice remains compatible without consumer changes.
Starship's existing preview, confirmation gating, rollback, and `e` customization stay expressible by omitting the opt-in search flag; because searchable input reserves printable keys, that picker should not adopt search while retaining its current shortcut.
Statusline's palette picker can later add `enableSearch: true` plus palette aliases in `searchText` without moving its `try/finally` preview reset, save, apply, or rollback policy into Kit.
No dependency floor changed.

| Candidate | Decision | Evidence |
| --- | --- | --- |
| Controlled Disclosure/ExpandableDocument | No-go | Subagents and Fleet both receive Pi-owned `options.expanded`, but differ in Markdown/background framing and exact metadata; neither owns a second compatible activation contract, so local Box/Text composition remains simpler. |
| ProgressMeter and `runTask()` reporting | No-go | Usage has one passive percentage-bar formatter; no second real passive producer shares it, while task and Sync loader flows own different cancellation and commit semantics. |
| Model scope and background snapshots | Defer | No two compatible consumers justify public refresh/scope policy; selectors continue to accept consumer-owned snapshots. |
| Settings metadata and grouped multiSelect | Defer | No two consumers require one compatible disabled-value/group-summary contract; settings persistence, validation, and bulk policy remain local. |
| Scope/filter bar | Defer | Recall supplies one specialized scope/view flow, but no second compatible consumer exists beyond visual similarity. |

Delivered API version 18 adds the compatibility fixes, standard-screen mouse routing, bounded intraline diffing, opt-in Live Choice search, TUI input prefill, and `runSecretInput()`.
The single minor Changeset releases only `@narumitw/pi-tui-kit`; publication, consumer migration, visibility changes, tags, and release workflows remain unauthorized.
The deterministic smoke fixture registers `/kit-capabilities-smoke`, `/kit-selector-smoke`, and `/kit-secret-smoke` without credentials.
Human-operated regular/fullscreen smoke remains open because this non-interactive execution environment must not launch TUI commands.
Final automated validation passed: `npm run format` made no changes; `npm run check` retained only the two baseline Biome infos; `npm test` passed 398 files and 4,646 tests; the Kit suite passed 32 files and 399 tests; Changeset status and installed Kit resolution passed; and both package workflows produced an inspected 84-file tarball with no coding-agent import in emitted JavaScript.
The final semantic audit found no consumer source, settings schema, settings read/write, credential persistence, extension runtime, or dependency-floor change.

## Rollback / Recovery

Keep selector fixes, mouse support, each feature enhancement, and any admitted new API in separate reviewable changes. Before release, revert only the failing slice and its documentation/Changeset, then rerun its affected tests and root gates; do not discard unrelated work.

Keep old consumer implementations until a separately authorized migration can use a published Kit API. After publication, do not remove an API or revert a consumer below its required compatibility floor without an explicit migration decision; prepare a corrective release through the normal approved workflow. No release action is authorized here.

## Completion Checklist

- [x] Verify every implementation task has passing acceptance evidence, every conditional omission has an explicit not-applicable reason, and every admission question has an accepted contract or recorded deferral.
- [x] Verify delivered code retains the runtime boundary, default behavior, supported modes, exact-text handling, and cancellation/settlement guarantees through the named tests and semantic review.
- [ ] Verify root gates, applicable pack checks, and required smokes have passed; automated gates and pack checks passed, but the required human-operated regular/fullscreen smoke remains open.
- [x] Verify the handoff names any remaining rollout dependency and performs no publication or consumer floor increase without the required approval and registry evidence.
- [ ] After all preceding execution and completion checks pass, delete this plan and report its path; retain it while any required evidence is missing.
