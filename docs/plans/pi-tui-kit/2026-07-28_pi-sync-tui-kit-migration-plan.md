# pi-sync pi-tui-kit migration plan

## Goal

Migrate `@narumitw/pi-sync`'s standard interactive manager, settings, resource list/detail, and
included-content flows to `@narumitw/pi-tui-kit` without changing the `/sync` command surface,
settings schema, storage behavior, remote operations, safety confirmations, or supported mode
behavior. Preserve Included Content as a transactional draft: toggles do not persist until an
explicit reviewed Save, session inclusion remains privacy-gated, and concurrent settings changes
continue to fail closed.

## Context

- `extensions/pi-sync/src/manager-ui.ts` currently implements Main, More, setup switching,
  management entrypoints, recovery, and setup wizards through repeated `ctx.ui.select()` loops. It is
  983 lines, so the migration must extract standard menu ownership rather than grow this file past the
  repository's 1,000-line review boundary.
- `extensions/pi-sync/src/sync-setups-ui.ts` and `storage-connections-ui.ts` own symmetric list/detail
  loops with selected-resource identity, current/invalid/unavailable states, credential redaction,
  and destructive confirmations.
- `extensions/pi-sync/src/settings-ui.ts` owns a `SettingsList`, ordered immediate saves, displayed
  rollback, and a handoff to Included Content.
- `extensions/pi-sync/src/file-selection.ts` owns a specialized transactional draft, custom candidate
  discovery, Save/Discard/Continue review, session privacy acknowledgement, ordered include
  reconstruction, and an `expectedInclude` concurrency guard.
- `packages/pi-tui-kit` already provides typed action, detail, settings, and multi-select screens;
  stable screen stacks and cursor restoration; TUI/RPC adaptation; width-safe rendering; ordered
  setting/toggle callbacks; rollback; cancellation; disposal draining; owner signals; and stale-run
  guards.
- Pi Sync's setup, credential, storage-location, pull/push, and recovery operations include
  extension-specific input, confirmation, secret handling, and commit-aware cancellation. They are
  not standard menu rendering and remain extension-owned.
- Applicable requirements are `docs/extension-conventions.md` and
  `docs/extension-settings.md`: preserve direct routes and mode contracts, call custom UI only in TUI,
  revalidate asynchronous session/state ownership, serialize settings writes, preserve unknown
  fields and malformed-file protection, keep secrets redacted, and verify cancellation and disposal.

## Architecture

### Standard manager boundary

Add a focused declarative manager module under `extensions/pi-sync/src/` that defines stable screen
and action identifiers for:

- Main
- More
- Settings
- Sync setup list and detail
- Storage connection list and detail
- History and recovery

Use structured state and stable item ids rather than user-visible labels as action identity. Dynamic
setup and connection rows must retain an explicit id-to-domain-name mapping so untrusted names are
sanitized only for display and are revalidated against the latest settings before every mutation.
The latest state loader must preserve the current behavior of performing no remote network I/O when
the manager opens.

Run the manager with the existing session-owned cancellation boundary:

```ts
runMenu(ctx, menu, {
  getState: ({ signal }) => loadSyncMenuState(signal),
  signal: sessionSignal,
  isCurrent: () => !sessionSignal.aborted,
});
```

The menu library owns screen rendering, Back/Close navigation, cursor restoration, RPC dialog
adaptation, and standard callback draining. Pi Sync continues to own domain loads, selected-resource
state, notifications, confirmations, persistence, and exact route outcomes.

### Specialized flow boundary

Keep these operations outside the declarative screen model and invoke them from menu actions:

- masked secret and credential input;
- first/add/edit setup and storage-connection wizards;
- exact destructive or externally visible reviews and confirmations;
- `runCancellableOperation()` and its commit-aware cancellation rules;
- pull, push, sync, rollback, doctor, and session-replacement outcomes.

Do not apply `busyLabel` around an action that already owns a loader or whose cancellation becomes
unsafe after commit. Avoid nested competing loaders and preserve the existing operation's signal and
commit callback.

### Settings boundary

Represent Automatic sync and After switching setup as standard `settings` rows. Their action handlers
must continue to re-read the latest valid settings and call the existing locked persistence helpers;
`pi-tui-kit` may serialize callbacks and restore rejected display values but must not own settings
files or publication.

Represent Included content as a settings handoff rather than an immediately persisted value cycle.
In RPC, preserve the current mode-safe manual-path or read-only summary behavior instead of silently
expanding RPC into a new settings mutation contract.

### Included Content flow

Keep `showFileSelection()` as a separate coordinator invoked from the Settings action. In TUI it owns
one in-memory draft for the invocation and uses a standard `multiSelect` screen for built-in roots,
discovered/configured custom paths, and `sessions`. Toggle actions update only that draft and return
`stay`; they never call `updateSyncSetup()`.

After the selection screen closes with changes, show an action-based review containing the exact
Include/Exclude delta and these choices:

- Save changes
- Discard changes
- Continue editing

Use an outer coordinator around `runMenu()` rather than adding a pi-sync-specific dirty-exit hook to
`pi-tui-kit`. This preserves the current Escape-to-review behavior despite the current kit API not
exposing a close reason or screen-level `beforeLeave` callback. Continue editing reopens the same
draft; discard and cancellation write nothing.

Save must:

1. require the existing privacy acknowledgement only when `sessions` changes from excluded to
   included;
2. reconstruct the ordered list as built-in catalog order, draft custom-path order, then `sessions`;
3. call `updateSyncSetup()` with the original `expectedInclude` and owner signal;
4. retain the previous file and report the existing reopen guidance on a concurrent change or save
   failure;
5. publish success only after durable completion and while the session signal remains current.

RPC keeps the existing protocol-safe included-content summary and manual `sync.include` guidance.
Print and JSON continue to reject at the `/sync` command boundary before relying on no-op UI output.

### Compatibility

Preserve:

- every documented `/sync` direct route, argument completion, confirmation flag, and setup-addressing
  behavior;
- version 3 settings bytes/schema, unknown fields, private permissions, migration, locks, and atomic
  publication;
- storage connection and sync setup terminology, menu hierarchy, state wording, and remote-no-contact
  behavior on open;
- current lock, invalid-settings, empty-content, stale-resource, and session-replacement behavior;
- direct TUI-only restrictions for secret-bearing setup and edit flows;
- all remote snapshot, backend, conflict, backup, and commit-boundary semantics.

## Non-Goals

- Adding screens or callbacks to `pi-tui-kit` solely for Pi Sync.
- Changing Pi Sync settings, include ordering, storage paths, remote formats, state files, or backend
  contracts.
- Removing or renaming direct commands, arguments, completions, public menu actions, or README
  terminology.
- Turning RPC Included Content or Settings into a newly supported mutation interface.
- Rewriting masked credential components, setup forms, exact previews, or commit-aware loaders as
  generic menu screens.
- Redesigning the approved Pi Sync information architecture or changing which actions are primary,
  advanced, destructive, or unavailable.

## Assumptions

- The existing session `AbortController` is the manager ownership boundary; checking its captured
  signal is sufficient because every session replacement and shutdown aborts it before rebinding.
- The current `pi-tui-kit` action/detail/settings/multi-select API is sufficient when Included Content
  remains a separate coordinated flow.
- Existing persistence helpers remain authoritative for ordering, cross-process locking, stale-read
  rejection, unknown-field preservation, and atomic publication.
- User-visible labels may change only where required by the kit's standard Back/Close hints; product
  terminology and consequences remain unchanged.

## Risks

- **Transactional draft regression:** treating Included Content like immediate multi-select settings
  could persist partial edits or skip review. Keep draft mutation memory-only and test bytes before
  Save, Discard, cancellation, and disposal.
- **Stale domain identity:** declarative actions may outlive a setup/connection list snapshot. Carry
  explicit selected names, re-read after each await, and reject missing or changed resources before
  mutation.
- **Mode expansion:** the kit adapts standard screens to RPC, which could accidentally make settings
  writable there. Route TUI-only or read-only actions explicitly and retain current RPC tests.
- **Competing cancellation ownership:** wrapping specialized operations in generic busy actions could
  misrepresent commit cancellation. Keep operation-owned loaders and signals.
- **Large migration blast radius:** Main, settings, resource managers, and Included Content currently
  have separate tests and lifecycle behavior. Migrate in bounded stages and keep focused regressions
  green before removing old loops.
- **Selection identity collisions:** setup/connection names and labels can duplicate after display
  sanitization. Use internal stable ids and raw-name maps; never recover identity by matching a
  displayed label.

## Rollback / Recovery

The migration has no settings or remote-data migration. Before publication, rollback removes the
`pi-tui-kit` dependency and restores the prior local menu modules. After publication, fix forward with
another package release or restore the previous extension-owned menu implementation while retaining
the unchanged version 3 settings and backend data. Never alter user settings or remote snapshots to
recover from a menu-only regression.

## Plan

- [ ] Add `@narumitw/pi-tui-kit` as a `<1` runtime dependency of
      `extensions/pi-sync/package.json` and update only the intended lockfile edges; verify with
      `npm run check:boundaries` and inspection that Pi Sync remains independently installable and
      keeps its existing Pi peer dependencies.
- [ ] Add focused failing manager integration tests for declarative Main/More navigation, dynamic
      setup/connection list and detail states, stable item identity, cursor restoration, lock/invalid/
      empty-content states, TUI owner cancellation, and RPC dialog adaptation; verify the initial
      `npm test` failure is limited to the not-yet-migrated menu contract.
- [ ] Extract the standard manager state, screen definition, and action routing from
      `extensions/pi-sync/src/manager-ui.ts` into cohesive menu-owned module(s), wire `runMenu()` to
      the captured session signal and current-state loader, and preserve no-network-on-open behavior;
      verify the focused manager tests pass and every touched source file remains below the 1,000-line
      review boundary or has a documented cohesion justification.
- [ ] Replace the repeated Main, More, Sync setups, Storage connections, and History/recovery selector
      loops with action/detail screens while retaining explicit selected-resource revalidation,
      current/invalid/unavailable text, credential redaction, and existing specialized add/edit/remove/
      switch actions; verify existing `menu-wording.test.ts`, stale-resource, redaction, switching,
      cancellation, and removal-guard coverage passes after adapting tests away from label-driven
      selector mocks.
- [ ] Add focused failing settings integration tests for immediate Automatic sync and After switching
      setup saves, action-order serialization, displayed rollback, Back after pending work, stale
      session disposal, and unchanged RPC manual-path behavior; verify the failures identify the old
      local `SettingsList` orchestration rather than persistence helpers.
- [ ] Replace `extensions/pi-sync/src/settings-ui.ts`'s standard settings component and save queue with
      a `pi-tui-kit` settings screen whose handlers call the existing persistence functions and whose
      Included content row invokes the separate file-selection coordinator; verify settings ordering,
      failure recovery, unknown-field preservation, atomic publication, and mode behavior tests pass.
- [ ] Add focused failing Included Content tests for kit multi-select rendering at 32/60/100 columns,
      memory-only toggles, Escape-to-review, Save/Discard/Continue behavior, cursor/draft retention,
      session privacy acknowledgement, exact include ordering, concurrent `expectedInclude` failure,
      owner cancellation, disposal draining, and unchanged RPC summary; verify the initial failure is
      limited to the not-yet-migrated editor/review implementation.
- [ ] Refactor `extensions/pi-sync/src/file-selection.ts` to coordinate `runMenu()` multi-select and
      review screens while preserving custom candidate discovery, raw domain values, display
      sanitization, transactional persistence, privacy confirmation, stale-write rejection, and
      success/error wording; verify the focused Included Content and existing snapshot/include policy
      tests pass without modifying settings or remote semantics.
- [ ] Remove only superseded menu loops, local standard screen components, and save-queue code; retain
      specialized wizard, secret-input, exact-confirmation, and commit-aware loader code, then audit
      imports and package boundaries to prove no dead Pi TUI dependency or duplicated menu path remains.
- [ ] Update `extensions/pi-sync/README.md` only where runtime navigation or standard key behavior
      changed, document that Included Content remains a reviewed draft and that RPC stays read-only,
      and verify every documented command, safety statement, mode claim, and package-layout path still
      matches source and tests.
- [ ] Run `npm --workspace @narumitw/pi-sync run check`, `npm test`, and `npm run check`; then run
      `npm run pack:sync`, inspect the tarball for the declared source/README/license and runtime
      dependency metadata, and perform an isolated non-interactive Pi RPC load/menu smoke with a
      temporary agent directory and no credential-bearing real settings.
- [ ] Audit the final diff against the TUI, command, settings, lifecycle, cancellation, persistence,
      redaction, verification, and touched-area checklists in `docs/extension-conventions.md` and
      `docs/extension-settings.md`; record any accepted deviation or unverified path before marking
      the plan complete and archiving it.

## Completion Checklist

- [ ] Pi Sync's standard Main, More, Settings, setup/connection list/detail, recovery, and Included
      Content screens run through `@narumitw/pi-tui-kit`; specialized forms and operations remain
      extension-owned.
- [ ] Included Content remains a transactional reviewed draft: no write before Save, Discard and
      cancellation preserve bytes, Continue retains the draft, session inclusion is acknowledged,
      ordering is unchanged, and concurrent changes fail closed.
- [ ] Main-menu state, action hierarchy, Back/Close behavior, explicit selected-resource ownership,
      remote-no-contact behavior, lock/error/empty states, and credential redaction remain compatible.
- [ ] TUI, RPC, print, and JSON behavior remains exactly as documented; no `ctx.ui.custom()` call can
      occur outside TUI and RPC does not gain an unintended settings mutation surface.
- [ ] Session replacement, shutdown, component disposal, user cancellation, action completion, and
      settings publication each cancel or drain their owned work without stale context use.
- [ ] Direct commands, completions, version 3 settings, unknown fields, permissions, locks, storage
      paths, snapshot/state formats, backend behavior, and remote safety semantics are unchanged.
- [ ] Focused tests, workspace checks, root CI-equivalent checks, package inspection, and the isolated
      Pi runtime smoke pass with no unexplained deviation.
