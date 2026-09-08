# Shared TUI consolidation plan

## Goal

Reduce repeated terminal presentation code by adopting existing pi-tui-kit APIs first, then adding only the shared frame and key-hint capabilities demonstrated necessary by current consumers. Preserve extension-owned behavior and release new Kit APIs before their consumers.

## Context

The review covers `18e29d3c` (pi-tui-kit release from 0.59.0 to 0.60.0) through `5fb65adb`, including 153 non-merge commits. This plan authorizes no implementation or publication by itself.

Evidence:

- `packages/pi-usage/src/usage-settings-ui.ts` duplicates focused-row clipping and frame behavior already implemented internally in `packages/pi-tui-kit/src/components/rendering.ts`; commits `96ab4dbb`, `12274425`, and `e093527c` repaired framing and row budgets.
- `packages/pi-btw/src/fullscreen-ui.ts` added key identity, matchability, and conflict filtering after `f24a5b00`; `text.ts`, `bring-to-main.ts`, Sync input/task UI, and Kit questionnaire rendering also contain key-label helpers.
- `packages/pi-todo/src/widget-renderer.ts` and `packages/pi-stamp/src/metadata.ts` own sanitizers while Herdr and Accounts already consume Kit terminal sanitization.
- Todo draws widget separators itself; Herdr already uses `EditorStatusWidget`, and Sync adopted its shared separator in `0f319d2b`.

## Architecture

Kit owns terminal sanitization primitives, standard presentation, frame bounds, and extension-neutral hint formatting. Consumers own whitespace policy, fallback labels, item priority, settings transactions, session generations, cancellation ownership, and listener precedence.

Prefer Pi core APIs, then existing Kit APIs, before introducing a new public API. A frame API must not require importing private component contracts. A key-availability helper must receive conflicts from the caller rather than encode btw actions or infer another extension's listeners.

## Non-Goals

- Extract the btw fullscreen host or shared-terminal handoff.
- Add a generic adaptive widget, settings persistence framework, or session coordinator.
- Publish Sync's masked input without another demonstrated consumer.
- Generalize Starship's snapshot-based redraw policy.
- Change settings schemas, command routes, raw payloads, or domain-specific display ordering.

## Execution findings

Implementation is authorized on `narumi/refactor/shared-tui-primitives`, based on `origin/main` at `5fb65adb`. The initial worktree contained only this untracked plan. Initial root `npm install` completed without lockfile changes or audit vulnerabilities; the later lockfile change only records Todo's new dependency.

Authorized implementation and verification are complete; the overall plan is not complete. Publication and the first usage frame migration remain blocked by the user's explicit no-publication instruction. Keep this plan until that follow-up release and migration are authorized and verified.

Focused signed implementation commits: `3d4054bf` (Todo), `5372f87b` (Stamp), `7ec32e42` (Sync), `317f7bd4` (Kit frame API), and `536e2eaa` (btw characterization). Signatures verified against the already-configured signing public key using a temporary, command-scoped allowed-signers file; no Git identity or persistent signing configuration changed.

Touched-area MUST rules and verification:

- TUI presentation: preserve width bounds, callback themes, editing semantics and effective bindings; verify with rendering/input tests and Review against installed Pi controls.
- Widgets: preserve the full-width `borderMuted` separator and exact lifecycle key ownership; verify with Todo rendering and lifecycle Tests.
- Async settings: preserve mode guards, owned-task cancellation, disposal, post-await freshness and persistence semantics; verify with usage characterization Tests and settings/lifecycle Review.
- Package APIs: keep public boundaries, independent dependencies and published files aligned; verify with boundaries/typecheck Validators and pack/loader Smokes. New APIs must be published before consumer adoption; publication is explicitly prohibited in this execution.
- Verification: run `npm run check` and `npm test`, add Changesets for published behavior, and report semantic audits separately.

Decision evidence from source inspection (tests still pending):

- Usage's non-searchable SettingsList aborts its local save signal immediately on cancellation. Kit SettingsScreen always enables search and waits for pending saves before Back/Close. Do not migrate the interaction; share only stateless frame layout, leaving consumer adoption pending publication.
- Stamp's metadata sanitizer participates in persisted snapshot validation. Keep its historical control-to-space codec unchanged; consolidate only the exported display sanitizer onto Kit.
- Todo's control-to-space policy matches published `sanitizeTerminalDocument()` followed by local whitespace collapse. Added dependency floor `^0.60.0`; `npm view @narumitw/pi-tui-kit@0.60.0 version --json` confirmed publication, and root install plus `npm ls` confirmed Todo resolves 0.60.0. Unterminated sequences are now removed instead of leaving escape fragments; regression tests explicitly cover this safety improvement.
- Stamp's eager-graph guard initially rejected the new import. Its exact `/terminal-text` leaf is dependency-free in the installed package; the builder now admits only that leaf, with regression tests rejecting other subpaths and verifying the leaf has no imports. Root Kit and first-use menus remain forbidden eagerly.
- Btw uses title-case labels and specialized PgUp/PgDn aliases; questionnaire uses platform-specific Option labels and separately themed key/description spans. Existing `formatInteractionHints()` has neither contract. Keep these formatters local rather than changing public presentation or adding an unproven key API. Sync's lower-case hints match the existing API.
- A public usable-key helper is deferred: current Pi matching includes multiple overlapping raw encodings, while callers have different dispatch precedence. Keep btw's tested compatibility filter local; do not publish a partial matcher mirror.

## Plan

### 1. Establish contracts and decision gates

- [x] Re-read `docs/extension-conventions.md` and `docs/extension-settings.md` before implementation; touched MUST rules and named verification methods are recorded above.
- [x] Inspect installed Pi SettingsList, Input, `matchesKey`, TUI listener dispatch and alternate-screen routing, plus complete TUI/keybindings/terminal-setup documentation and the settings example. Reviewed branches: searchable versus fixed lists, empty lists, cycling versus submenus, selection restoration; paste buffering before cancel/submit/editing; escape/return aliases, case and modifier order, special/function/printable keys, raw Ctrl and Alt collisions, Kitty versus legacy input, release filtering; listener consumption before focused components, overlay focus, search and ordered viewport actions. No matcher or dispatch implementation changed.
- [x] Compare usage's settings flow against Kit SettingsScreen. No-go for whole-screen migration: usage has no search and immediate abort-on-cancel, unlike Kit's search and drain-before-Back contract. Existing passing `pi-usage/test/usage.test.ts` settings tests cover compact rows, selection, save failures, cancellation/disposal and durability races; Kit `screen-components.test.ts` characterizes serialized changes and drain-before-Back. Non-TUI usage remains guarded before custom UI.
- [x] Inventory key-label and sanitization differences. Added table-driven `pi-btw/test/key-label-contract.test.ts`, `pi-todo/test/widget-presentation.test.ts`, and `pi-stamp/test/terminal-presentation.test.ts`; existing questionnaire tests preserve separate styling, navigation, platform labels and remapped bindings. Final full passing run: 386 files / 4398 tests.

### 2. Adopt existing Kit primitives in focused changes

- [x] Consolidate Todo presentation onto Kit document sanitization and Stamp display onto Kit text sanitization. Keep Todo whitespace/fallbacks and Stamp's persisted codec local. New characterization tables and existing lifecycle/metadata tests passed.
- [x] Replace Todo heading/separator drawing with EditorStatusWidget inside its existing row budget. The focused published subpath avoids eagerly loading the Kit menu root. Zero/narrow-width and completion tests plus existing adaptive-priority/lifecycle tests passed after the final import-boundary refinement.
- [x] Consolidate Sync's compatible hints onto existing formatInteractionHints. Preserve control-bearing binding rejection and omit unbound submit hints. Retain btw and questionnaire formatters under the recorded no-go decision because their casing, aliases, platform labels and theme spans differ; do not add a formatter API merely to rename code. Remapped cancellation, hard cancel, alias-deduplication and control-bearing binding regression tests passed in the final full run.
- [x] Retain usage SettingsList. Its cancellation test explicitly proves the whole-screen migration gap; `renderBoundedFrame` supplies stateless bounds without adopting Kit's save/search lifecycle. Consumer migration remains gated on publication.

### 3. Add only demonstrated Kit API gaps

- [x] Extract public renderBoundedFrame/BoundedFrameOptions and reuse it in Kit's existing standard frame adapter. It accepts preformatted rows and explicit original-index priorities, with no selection-glyph inference or lifecycle ownership. New bounded-frame tests cover budgets, resize, descriptions, styling, tiny terminals, invalid dimensions/indexes and read-only rows; all existing Kit screen tests passed. This low-level layout API serves the shared row-retention need without admitting a new screen/lifecycle API.
- [x] Evaluate usable-key extraction; defer it under the recorded no-go decision. Keep Pi matching and btw's caller-specific conflict filter unchanged.
- [x] Not applicable: no usable-key helper added. Existing btw fullscreen regression tests for aliases, modifier order, legacy/Kitty collisions, invalid strings, earlier handlers, hard cancel and fallbacks passed unchanged.
- [x] Document the bounded-frame API and caller responsibilities in Kit `docs/api.md`; add independent Kit/Todo/Stamp/Sync Changesets. Public export/typecheck tests and actual tarball inspection verified `bounded-frame.js`, `bounded-frame.d.ts`, root declarations and API version 16 without consumer private imports. Changesets status reports one Kit minor and three consumer patches.

### 4. Release before adopting new APIs

- [ ] BLOCKED: publish the new bounded-frame API through the repository release workflow before consumer adoption. The current user explicitly prohibits publication, tags and workflow dispatch; do not request or perform a release in this execution.
- [ ] BLOCKED: migrate usage's custom frame after the bounded-frame API is published, raise its Kit floor, run root npm install and npm ls before typechecking. Do not reference the unpublished helper from usage. Btw has no new-API migration after its no-go decision.
- [ ] BLOCKED: add the usage frame consumer Changeset and migration regressions after publication. Todo/Stamp/Sync adoption Changesets use already-published APIs and do not depend on API version 16.

### 5. Validate each implementation change

- [x] Audit asynchronous UI paths: Sync changes only hint construction; its masked-input clearing, paste-first input handling, hard cancellation, operation signal/draining and commit-aware cancellation remain unchanged. `secret-input.test.ts` and `custom-lifecycle.test.ts` passed. Kit changes are stateless rendering only; menu runtime and event handling are unchanged. Todo widget ownership and Stamp session/metadata reconstruction remain unchanged and their lifecycle tests passed.
- [x] Audit usage `settings.ts` and `usage-settings-ui.ts` together: runtime serializes reload/update/flush, reads latest valid documents, preserves unknown fields, stages private same-directory writes and publishes by rename; UI serializes saves, rolls back rejected displays, immediately aborts on cancellation, and applies already-durable updates even if disposal wins the await. Existing settings/usage tests passed. No usage code or persistence contract changed; cross-process locking is not claimed.
- [x] Run final `npm run check` and then `npm test` on 2026-09-08. Build, Biome, boundaries and all workspace typechecks passed without warnings; 386 test files / 4398 tests passed in 23.14 seconds. Kit rebuilt before consumer tests; no timeout overrides or concurrent Kit/root checks. An initial import-only package-export test used CommonJS resolution incorrectly; it was corrected to inspect the declared import target, then the complete suite passed.
- [x] Run `npm run package:pack -- tui-kit`, `-- todo`, and `-- stamp`, then create and inspect actual tarballs under `/tmp/shared-tui-packs-iVMW26`. Verified Kit public JS/declarations, README/license, generated consumer entries, and Todo's published Kit dependency plus focused imports. Repacked Todo after the final EditorStatusWidget refinement.
- [x] Exercise short-terminal and remapped-binding flows through the public TUI harness in deterministic tests, including usage's retained frame, Kit screens, Sync cancellation/paste, and Todo adaptive rendering. Manual visual/IME checks in a real interactive terminal were not run because this harness prohibits interactive commands; no claim of manual terminal validation is made.
- [x] Build and smoke Stamp, Todo and Sync package directories in isolated Pi RPC subprocesses (`--no-extensions -e <package>` with temporary agent dirs). All completed get_state/get_commands handshakes without load errors or model requests; post-readiness deadlines were used. Stamp's existing Jiti tests also exercised its generated lazy menu boundary; Todo/Sync generated-runtime tests passed. Real interactive terminal startup remains unverified.

## Risks

Sanitizers differ in control-to-space behavior; replacing them mechanically can concatenate words. Key labels are not proof that input is matchable or reachable. Frame clipping can hide the focused row or save feedback. Changing UI wrappers can change cancellation and persistence timing even when the screen looks identical. Characterization tests and the decision gates above must resolve these risks before migration.

## Rollback / Recovery

Keep adoption, new Kit APIs, and first-consumer migrations in separate focused commits or pull requests. Use Git reverts for source and dependency recovery; do not add runtime rollback machinery. Do not unpublish or retag a released API without explicit approval. If a new API is defective, fix forward through Changesets or revert the consumer to its last compatible implementation and dependency floor.

## Completion Checklist

- [ ] Every plan task has acceptance evidence or a checked not-applicable decision; no material unknown or external release dependency remains unresolved.
- [x] The final code diff preserves extension boundaries, command/mode behavior, settings ownership and raw payloads. Conventions/settings semantic audits are recorded above; frame selection inference stays adapter-owned, sanitization stays presentation-only, and the Stamp persisted codec remains unchanged.
- [ ] Required checks, tests, pack inspections, publication evidence, smokes, deviations, and explicitly accepted unverified paths are named in the handoff.
- [x] No consumer depends on API version 16. Todo uses registry-confirmed existing APIs; Stamp/Sync retain their existing dependency floors. No publication, version tag or release workflow was run.
- [ ] Delete this plan only after execution and all completion evidence are complete; report its deleted path in the final handoff.
