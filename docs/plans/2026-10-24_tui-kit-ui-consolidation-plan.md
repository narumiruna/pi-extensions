# TUI Kit UI consolidation plan

## Goal

Reduce repeated terminal UI code in extension packages by adopting existing Pi TUI Kit APIs first. Add a public adapter only if two consumers still need the same behavior after adoption. Preserve native editing, cancellation, mouse routing, persistence, and non-TUI behavior.

Implementation was requested after this draft. Six consumer migrations are implemented and verified on `narumi/refactor/tui-kit-ui-consolidation`, based on `origin/main` at `7fc37d8e`. BTW normalization remains blocked by its published-API and eager-loading boundary; this plan is not complete and must not be deleted. No publication is authorized.

## Context

The source scan found these concrete overlaps:

| Area | Repository evidence | Initial decision |
| --- | --- | --- |
| Frame row mapping | `packages/pi-progress/src/progress-settings-ui.ts` and `packages/pi-subagents/src/settings-ui.ts` use row tokens to restore native mouse coordinates after clipping. | Adopt `renderBoundedFrameLayout()` and its `contentRows`; do not add another layout algorithm. |
| Masked input | `packages/pi-sync/src/ui/secret-input.ts` maintains a masked control similar to `packages/pi-tui-kit/src/secret-input.ts`. | Adopt `runSecretInput()` through a local compatibility wrapper. |
| Configured keys | `packages/pi-btw/src/keybindings.ts`, `packages/pi-notes/src/note-picker.ts`, and `packages/pi-ticker/src/tui-menu.ts` normalize configured key strings. | Adopt `canonicalizeConfiguredKey()` only where native syntax and existing compatibility agree. |
| Interaction ownership | `packages/pi-usage/src/usage-settings-ui.ts` owns custom-dialog abort and disposal logic. | Assess adoption of `runCustomInteraction()` without moving settings policy. |
| Safe editable rendering | `packages/pi-codex-imagegen/src/safe-input-render.ts` preserves raw drafts while sanitizing native rendering; Progress instead hides unsafe drafts. | Defer a public API: compatible behavior across two consumers is not yet established. |

`packages/pi-tui-kit/README.md` and `packages/pi-tui-kit/docs/core-alignment-audit.md` already describe publication-dependent adoption for frame mapping, key normalization, and masked input. Local exports do not prove registry availability.

Draft verification on 2026-10-24: `npm run check` passed; `npm test` passed with 769 files and 14,547 tests passing, one file and two tests skipped. These results establish the planning baseline only; they do not complete any implementation task or prove registry availability or physical-terminal behavior.

## Architecture

Kit owns reusable presentation and interaction mechanics. Extensions own domain data, settings schema, validation, save queues, revisions, rollback, durable-save application, session identity, terminal row reservations, and error policy.

- Frame consumers supply native rendered rows, the focused row, and the row budget; Kit returns visible rows and source-row metadata.
- Key consumers use Kit only for configured-key syntax. Protocol overlap, host listeners, fallback selection, paste exclusions, and action priority stay local.
- Sync keeps setup flow, credential validation, storage, required-value policy, and its existing return contract outside Kit.
- Usage retains native `SettingsList`, immediate saves, invalid-file protection, and its `onApplied` behavior after a durable save wins a cancellation race.

## Non-Goals

- Do not unify reorder screens, fullscreen terminal hosts, trees, session selectors, transcript workflows, OAuth/setup flows, or commit-aware task cancellation.
- Do not migrate Langfuse secret entry: its existing plaintext RPC flow needs a separate compatibility decision.
- Do not change settings schemas, paths, storage algorithms, model-visible prompts, tools, or command routes.
- Do not add dependencies, configuration, or public APIs for hypothetical consumers.
- Do not publish, tag, change visibility, or dispatch release workflows.

## Applicable rules and verification

Read all applicable scoped `AGENTS.md` files before editing each consumer. Read `docs/extension-conventions.md` and `docs/extension-settings.md` completely; read `docs/readme-conventions.md` before changing package READMEs.

| Touched area | Applicable MUST rules and required constraints | Verification |
| --- | --- | --- |
| Custom UI | TUI-only custom entrypoints; bounded width; callback theme/keybindings; focus propagation; render requests; abort owned tasks on disposal. Preserve framed content and the active row at constrained heights. | Review plus rendering, input, mouse, paste, cancellation, and disposal tests. |
| Async lifecycle | Release session-owned resources; reject stale contexts after awaits; drain pending callbacks. Preserve ordinary-turn model-visible prefixes. | Review plus delayed-save, disposal, replacement, and shutdown tests. Confirm no prompt/tool changes in the diff. |
| Settings | Keep native settings interaction, serialized saves, failure recovery, invalid-file protection, unknown fields, and atomic publication. A successful rename can require runtime application even after UI cancellation. | Review settings reads and writes together; run existing persistence and UI regression suites. |
| Package boundary | No extension-to-extension dependencies; consumers must require a published Kit release containing each used API; independently installable packages; Changesets for published behavior changes. | `npm ls @narumitw/pi-tui-kit`, typechecks, boundary checks, pack inspection, Changeset review, and Jiti loader smokes. |
| API admission | Require two compatible consumers by default; keep coding-agent imports type-only in Kit production code; record a no-go when behavior does not converge. | Compare consumer contracts and emitted runtime graphs; public-export and representative Jiti tests if an API is added. |
| Final gates | Run both root checks and tests; do not run root checks concurrently with Kit build/check; rebuild Kit before consumer tests. | Serial `npm run check` and `npm test`, with recorded results and explicit unverified paths. |

## Plan

### 1. Confirm contracts and publication prerequisites

- [x] Compare each candidate with current Kit exports, installed Pi implementations, scoped instructions, and existing tests; record behavior matrices for frame clipping, mouse dispatch, key syntax, paste, secret results, and pending saves. Acceptance: every migration has an explicit preserved contract and no unresolved safety question.
- [x] Query npm metadata and inspect the exact registry tarball for the minimum Kit release required by each migration; compare it with consumer manifests and the lockfile. Acceptance: record the verified version, exports, runtime files, and dependency floor for each consumer. If an API is not published, mark its dependent migration blocked; local workspace resolution is not sufficient evidence.

### 2. Replace frame row tokens

- [x] Migrate Progress and Subagents to `renderBoundedFrameLayout()` after their publication prerequisite passes; replace token restoration with `contentRows` mappings while retaining local row budgets, native focus detection, mouse press/click handling, queues, and submenus. Acceptance: existing framing, settings, mouse, item-limit, and pending-save tests pass; add regressions for zero/narrow widths, constrained heights, resize, invalidation, passive-row clicks, and submenu mouse routing.

### 3. Consolidate masked input

- [x] Replace Sync's local masked control with `runSecretInput()` after its publication prerequisite passes; map typed results through the existing `promptSecret()` boundary. Acceptance: secret-input, secret-cursor, credential UI, and setup compatibility tests pass with synthetic values, required/optional blank input, controls, split paste, configured cancellation, Ctrl+C, disposal, and owner abort; non-TUI paths never open plaintext input.

### 4. Consolidate configured-key syntax

- [ ] Replace compatible normalization logic in BTW, Notes, and Ticker with `canonicalizeConfiguredKey()` after publication is verified; keep package-specific admission and collision policy. Acceptance: table-driven tests cover aliases, modifier order, literal `+`, invalid strings, legacy collisions, terminal modes, standard-action priority, and the first usable fallback. Retain existing accepted spellings or document a blocking compatibility decision rather than silently changing them.

  **Blocked for BTW:** Notes and Ticker adoption and compatibility tests pass. BTW's synchronous normalizer is in the eager settings graph, but the published helper has no focused export. Its implementation and floor remain unchanged. The retained audit records the required maintainer release or separately reviewed loading change; do not weaken the eager-graph tests or use a private import.

### 5. Consolidate Usage interaction ownership

- [x] Adapt Usage settings to `runCustomInteraction()` using a verified published contract; retain its save queue, boolean result, `onApplied` callback, mode rejection, and durable-save semantics. Acceptance: settings-handoff and lifecycle tests prove abort/disposal cleanup, no stale UI writes, queue draining, failure recovery, and correct application when rename wins cancellation.

### 6. Decide whether a new adapter is justified

- [x] Compare the remaining Progress/Subagents frame and mouse glue after row-mapping adoption; record either a minimal common contract or a no-go with concrete differences. Acceptance: two compatible consumers need the same remaining operation; native Pi controls and existing Kit APIs cannot already provide it. A no-go completes this discovery task without adding code.
- [x] Not applicable: no new adapter was admitted. Existing frame metadata supplies the shared operation; remaining submenu, footer, input, and persistence policy stays local. Evidence: `packages/pi-tui-kit/docs/ui-consolidation-audit.md#no-new-settingslist-adapter`.

### 7. Verify and prepare handoff

- [x] Review the selected diff, update affected package documentation and Changesets, and run root `npm install`, `npm ls @narumitw/pi-tui-kit`, and `npm run typecheck` after dependency-floor changes. Acceptance: each consumer resolves a compatible published Kit version and no unrelated package floor is raised.
- [x] Rebuild Kit, run focused consumer and generated-runtime tests, then run `npm run format`, `npm run check`, and `npm test` serially. Acceptance: all required gates pass; failures remain open unless an explicit exception is authorized. Review formatting output and keep only intended paths.
- [x] Run `npm run package:pack -- <unscoped-name>` for each package with metadata or publishing changes and inspect the tarballs; build each changed packaged runtime and smoke it with `pi -e ./packages/pi-<unscoped-name>`. Acceptance: artifacts contain the declared runtime and imports, representative lazy UI boundaries load through Jiti, and offline command cancellation and shutdown work without provider requests. Record any impractical interactive smoke and the exact remaining uncertainty.
- [x] Prepare a retained handoff with guide audits, contract decisions, check results, registry evidence, deviations, and physical-terminal instructions. Acceptance: external items and release restrictions below are preserved in an appropriate package-owned document before this completed plan is deleted.

Execution evidence and the retained external handoff: `packages/pi-tui-kit/docs/ui-consolidation-audit.md`. Final root gates passed with 772 files and 14,619 tests passing, one file and two tests skipped. Six consumer tarballs and offline Pi package-directory smokes passed. Physical terminal checks remain external; the BTW migration is the unresolved agent-task dependency.

## Completion Checklist

- [ ] Every in-scope migration preserves its documented native UI and lifecycle contract, with passing regression evidence.
- [x] Every new consumer import has a verified registry-visible Kit dependency floor; blocked migrations remain incomplete.
- [x] The adapter decision has an evidenced implementation or explicit no-go; no speculative framework was added.
- [x] Required checks, package inspections, and applicable loader smokes pass, or a required exception is explicitly authorized and recorded.
- [x] Changesets cover published behavior changes; documentation and the final diff pass semantic review.
- [x] The retained handoff names all unverified external behavior and release restrictions; no publication was performed.

## Rollback / Recovery

Keep each migration in a separate focused change so it can be reverted without changing another extension's policy. Preserve existing public return contracts and do not migrate stored settings. If regression tests fail, restore that consumer's prior implementation and dependency range together, then regenerate the root lockfile with `npm install`.

Prefer no new Kit public API. If an adapter is added and published, do not remove it as an internal cleanup; preserve compatibility or require an approved breaking migration. If a required Kit API is unavailable from npm, retain the existing consumer implementation and record the dependency as blocked.

## External Handoff

**Kit publication:** The maintainer is responsible. Prerequisite: explicit publication approval and the repository release gates. Action: publish any required Kit API through the existing release workflow, then provide registry-visible artifact evidence. Expected result: independently installed consumers resolve the required runtime exports. Until then, registry compatibility is unverified and dependent migrations cannot complete; do not publish dependent packages.

**Physical terminal verification:** A maintainer or tester with the target terminal is responsible. Prerequisite: passing deterministic tests, built packages, and prepared smoke instructions using synthetic secrets only. Action: check IME placement, hardware/fake cursor visibility, keyboard negotiation, mouse input, resize, and theme changes in regular and fullscreen modes. Expected result: native editing and focus remain correct with no secret disclosure. Simulated-renderer tests do not verify physical-terminal behavior; retain this limitation in release handoff, and resolve any discovered correctness or safety failure before release.
