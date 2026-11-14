# ADR: pi-sync portable included-content policy

## Status

Accepted.
The policy is implemented by Pi Sync snapshots, orchestration, and review and recovery flows.
Settings version 6 adds shared `.syncignore` selection version 2; the include-list decision below remains the legacy versions 3–5 contract.
See the [current rule and migration reference](../../packages/pi-sync/skills/configure-pi-sync/references/configuration.md#shared-syncignore-rules) for the version 6 contract.

## Context

A sync setup's `sync.include` is local because `pi-sync.json` also owns private storage credentials
and machine-specific behavior. That made a new environment unable to discover a selected custom path
when the path existed only remotely. Inferring intent from snapshot files is insufficient: a selected
path may currently be absent, and a snapshot may preserve files that its publisher did not select.

Syncing `pi-sync.json`, hard-coding another extension's filenames, or automatically selecting every
safe-looking remote file would respectively expose credentials, create cross-extension coupling, or
turn an incomplete denylist into policy.

## Decision

### Portable policy

Each new immutable `Snapshot` carries an additive credential-free field:

```ts
selection: {
  version: 1;
  include: string[];
}
```

The include list uses the same normalization and safety rules as local `sync.include`. It contains no
setup name, storage location, credentials, automatic-sync preference, or switch behavior. Selection
intent is separate from `files`, so selected-but-missing paths remain portable.

S3 and WebDAV include the field in their integrity-checked gzip snapshot. Their latest pointer also
carries a validated projection so Status stays lightweight. Git includes it in the strict publication
manifest, which binds it to the commit and supplies its head projection. Adoption always re-reads the
immutable snapshot and rejects a projection mismatch. New readers accept old snapshots and Git
manifests without `selection`. Invalid versions, extra fields, unsafe paths, oversized collections,
duplicates, and overlaps fail before settings or synced files change.

### Divergence behavior

Orchestration compares an explicit remote policy with the current local setup before applying remote content.
Ordinary sync, automatic startup and shutdown sync, and pull—including forced pull—pause on a difference.
Status names the difference and lists local-only and remote-only selections.
The TUI manager, direct interactive Sync, Pull, and Push routes without `--yes`, and eligible automatic startup work can open the shared inline resolution flow.
An unresolved mismatch remains visible as session attention until it is resolved, invalidated, replaced, or shut down.
Deterministic `--yes` routes report exact remote-only, device-only, or order-only differences plus recovery guidance without opening a dialog.
Automatic shutdown remains warning-only, RPC review remains read-only, and print and JSON command behavior remains rejected.

A force push is the explicit keep-local publication path.
Its confirmation says that the local selection will replace the differing remote policy, while preserved unmanaged remote files remain subject to the existing preservation rules.

Read-only diff remains available and labels policy state. A legacy snapshot without policy preserves
prior sync behavior because no authoritative remote intent exists.

### Review and adoption

Interactive mismatch entry points and **Settings → Compare synced content** share one review-first flow for a differing explicit policy.
The first screen is **Synced content differs**, says that nothing changed, and offers:

- **Review all paths (recommended)** — show exact remote-only paths, device-only paths, and both ordered lists;
- **Use remote content list** — revalidate the reviewed remote head and immutable snapshot, then save only local `sync.include` through the existing cross-process lock, expected-storage/include checks, unknown-field preservation, and atomic publication;
- **Keep this device's content list and update remote…** — open the existing `push --force` route for the captured setup without `--yes`; and
- **Cancel** — make no change.

An order-only mismatch is explicitly labeled instead of being treated as a membership difference.
Adopting `sessions` requires the existing privacy acknowledgement.
Adoption never pulls files, writes sync state, or automatically starts another network operation.
After adoption, **Remote content list saved** offers an explicit fresh continuation for the originating Sync, Pull, or Push operation, or **Continue Sync now…** from Settings, plus **Done**.
Cancelling after adoption leaves the reviewed settings change saved without implying that files were pulled.
Cancelling local-wins preparation or exact push confirmation returns to the selection choice without remote mutation.
Cancellation, component disposal, session replacement, shutdown, a changed remote head, and a concurrent settings edit preserve the last valid local selection.
A stale comparison refreshes before another user decision.

For old snapshots, Settings offers a clearly labeled read-only partial discovery from safe file roots.
It cannot be adopted as authoritative policy because preserved files and selected-but-missing paths cannot be distinguished.
Users can copy needed paths through **Add custom path…**.

## Consequences

### Positive

- New environments can discover and adopt custom remote-only paths such as a TOML configuration
  without syncing private settings or knowing which extension owns the path.
- Selection conflicts are explicit and cannot silently expand automatic synchronization.
- The snapshot remains self-describing even when selected paths are temporarily absent.
- Backend transport stays extension-neutral; selection policy remains orchestration-owned.

### Negative

- Remote-policy review reads the active immutable snapshot; Status relies on the validated head
  projection and cannot partially discover legacy paths.
- Keeping the device list still requires a separately confirmed reviewed force push.
- Adoption and file continuation are separate steps, so a user may intentionally stop after saving the list.
- Legacy discovery is necessarily incomplete and cannot reconstruct exact intent.
- Git publications containing `selection` require a reader that understands the additive manifest
  field; newer pi-sync remains backward-compatible with older Git publications, but an older strict
  Git reader may reject newer manifests.

## Verification

- Policy and legacy discovery: `packages/pi-sync/test/portable-selection.test.ts`.
- Snapshot intent and codec validation: `sync-snapshot.test.ts` and `snapshot-codec.test.ts`.
- Backend round trips: shared backend contract tests and Git backend tests.
- Divergence, automatic no-mutation, pull pause, and reviewed keep-local push:
  `sync-decision.test.ts`.
- Inline classification, direct guidance, automatic warning-only behavior, and mode boundaries:
  `sync.test.ts` and `sync-decision.test.ts`.
- Review-first presentation, order-only wording, adoption, explicit continuation, local-wins routing, legacy review, stale refresh, RPC read-only behavior, and disposal:
  `remote-selection-ui.test.ts` and `sync-resolution-ui.test.ts`.
- Direct and automatic recovery, persistent attention, invalidation, session replacement, and shutdown:
  `sync.test.ts` and `sync-attention.test.ts`.
