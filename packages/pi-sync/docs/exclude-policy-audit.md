# Exclude policy safety audit

Pi Sync owns one include-minus-exclude policy; transports validate its versioned representation but do not choose sync scope. See the [user reference](../skills/configure-pi-sync/references/configuration.md#excluded-paths) for configuration and recovery.

## Decision branches and verification map

| Boundary | Authoritative implementation | Representative evidence |
| --- | --- | --- |
| Grammar and matching | `sync/exclude-policy.ts`: bounded validation, basic glob grammar, explicit Minimatch options, full-path and ancestor matching | `exclude-policy.test.ts`: literals, segment boundaries, zero-depth/nested globstar, dotfiles, case, sessions, invalid inputs, count/UTF-8 limits |
| Settings and persistence | `settings-validation.ts`, `config.ts`, `settings-management.ts`; existing locked, ordered, private atomic store | `exclude-settings.test.ts`, existing settings publication/ordering/filename suites |
| Wire compatibility | Settings 6, snapshot 4, selection 2; old formats still read without exclusions | `exclude-policy.test.ts`, `exclude-snapshot.test.ts`, shared backend contracts on Git (both paths), S3, WebDAV |
| Metadata integrity | `remote-snapshot.ts`, Git manifest validation, object pointer projection; compare the complete versioned policy | Tampered head and malformed/inconsistent payload tests, shared backend contracts |
| Collection | `createSnapshot`, `collectFiles`, directory traversal; prune before content reads, logical virtual session paths | Read/readdir spies in `exclude-snapshot.test.ts`; default session-root tests remain unchanged |
| Directional/force transfer | `sync-mutations.ts`, filtered snapshot options, excluded-path safety preflight | `exclude-sync.test.ts`: reviewed force push, pull, policy mismatch, stale settings, retained unmanaged content/history |
| Local mutation/recovery | `snapshot-apply.ts`, `snapshot-exclude-safety.ts`, transaction rule binding; protect excluded descendants before backup/removal | Apply/deletion/ancestor and changed-policy transaction tests; existing transaction/alias/root-transition recovery suites |
| Merged/partial/field composition | Version-preserving field and partial projections; metadata-only merged target preflight | `exclude-snapshot.test.ts`, `exclude-sync.test.ts`, existing field/partial/journal suites |
| State, ancestors, model authorization | Exclusions in accepted state, review/config/merge/cache identity; excluded ancestors removed before conflict/model evidence | Policy-only identity tests, merged-sync tests, baseline and agent regression suites |
| Continuous work | Filter content watcher hints, retain settings/ancestor hints and periodic scanning; storage-owner binding unchanged | `continuous-watch.test.ts`, existing continuous authorization/freshness/lifecycle suites |
| UI and adoption | Native abortable input, Kit review, full-policy atomic adoption, explicit version review, no implicit transfer | `exclude-settings.test.ts`, `exclude-remote-ui.test.ts`, original selection/disposal/lifecycle suites |
| Generated runtime | External matcher dependency and unchanged package-owned lazy module boundary | Generated-runtime/Jiti tests, pack inspection, controlled RPC CLI smoke |

Matcher audit: Pi's public root exports provide no suitable matcher. `minimatch` is declared directly rather than imported through Pi. `platform: "linux"` removes Windows root/magic differences; `dot` and `nocase` are explicit; negation, comments, braces, and extglobs are disabled and unsupported syntax is rejected before compilation. Match-base and partial matching are not enabled. Repeated slashes, traversal and backslashes are rejected rather than delegated to matcher normalization. A trailing globstar is reduced to its zero-segment root before ancestor matching, so `sessions/**` prunes the root as well as descendants.
Effective-session checks also gate legacy shutdown pushes, session-root guards and status; they do not rely on include membership alone.
Canonical rule sorting uses code-point order, not host locale.

## Semantic audit checklist

Review the complete diff against `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and package `AGENTS.md`. Preserve no-exclude wire formats and legacy identities; inspect every settings/snapshot version branch and constructor. Check exclusion-only differences in direct guidance, attention, adoption, startup, and shutdown. Audit settings read/write ordering, malformed-file protection, unknown fields, and failure rollback together. Audit cancellation, disposal, session replacement and shutdown, including revalidation after awaited reads and dialogs.

Excluded content is absent from future portable publications, not erased from history/backups. Pi session-root configuration resolution remains separate from collection. Locks do not prevent arbitrary external editors from racing filesystem writes; existing preimage/journal safeguards remain in force. Production backend credentials/services and physical-terminal subjective acceptance are not verified by local/mock tests. No package publication, tags, or release workflow dispatch is part of this change.

## Execution evidence

- `npm run format` and `npm run check`: passed, including builds, Biome, package boundaries and all workspace typechecks.
- `npm test`: 22,957 passed, 18 existing platform/conditional skips, 1,005 passing files and one skipped macOS-only file; no failed tests or unhandled errors.
- Shared backend contracts: version-4 snapshot/head round trips and excluded-payload rejection passed for S3, WebDAV, and both Git publication paths.
- Actual base-client smoke at `ff7d07be`: archived original settings validation, object codec and Git manifest reader all refused the new formats before apply.
- Package build and `npm run package:pack -- sync`: passed. A real temporary tarball declared the matcher dependency and contained its entrypoint, notices, docs and skill; all relative imports in 83 generated modules resolved.
- Controlled `pi --no-extensions -e <package> --mode rpc` smokes: both the repository package and extracted tarball registered `/sync`, exercised lazy `/sync files` with an exclude summary, and shut down cleanly. Deadlines started after readiness; no model request or backend transfer ran.
- Fenced-code-aware README foundation/heading/order audit: 37 active packages passed. Skill tests validate both the complete example and version-6 policy fragment.
- `npm run changeset:status`: only Pi Sync has a minor release entry; no versions, tags, publications or release workflows were created.
- Complete-diff semantic review: settings ordering/failure/atomicity, full-policy freshness, legacy formats and identities, all transfer/recovery directions, field/partial/model composition, terminal sanitization, cancellation/disposal/session replacement/shutdown, and generated package boundaries checked against the guides above. No essential acceptance criteria were waived.

The review also caught and corrected the whole-session exclusion class: root pruning, zero-segment trailing globstars, effective-session summaries/root guards, and the legacy shutdown push now agree. A legacy state without an explicit include list retains its original refresh behavior. Native abortable Input and Kit reviews are reused; no custom editing or key-matching implementation was added.

## Review follow-up

The [review ledger](./exclude-review-ledger.md) records each review item, its evidence and its final outcome.
Excluded paths are also omitted from apply preimage assertions; included-file stale checks remain active.
The manager reports include and exclusion differences without calling an exclusion-only change an order change, and its Sessions label uses effective selection.

## External handoff

Maintainer, optional live-service acceptance: after separately authorizing disposable backend writes and configuring credentials outside chat, exercise the existing Git/S3/WebDAV workflows against that service and retain concurrency/recovery evidence. Expected result is the same exclusion policy and local-file protection as the deterministic contracts. Real credentials, provider-specific service behavior, and native Windows/macOS filesystem behavior remain unverified here; do not describe this PR as a live-service or native-platform acceptance run. No publication or release operation is authorized by the implementation plan.
