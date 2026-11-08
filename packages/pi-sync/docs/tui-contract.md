# Sync TUI behavior contract

This reference records the setting and transfer contracts used by the TUI. It does not add a settings format or change transfer authorization.

## Settings

All settings are private to this device. There are no project overrides. Defaults and validation are defined in `src/settings/settings-validation.ts` and `src/settings/config.ts`; mutation is owned by `settings-management.ts` and `settings-store.ts`.

| Row | Persisted fields and default | Scope | Save and effective time |
| --- | --- | --- | --- |
| Included paths | `sync.include`, explicit array | Current setup | Draft, then exact Save/Discard review; subsequent operations |
| Compare included paths | `sync.include` | Current setup | Review remote policy and fresh head before save; does not transfer files without explicit Continue |
| Machine-local fields | `sync.localFields`, absent | Current setup | Input and compatibility review; subsequent snapshots exclude whole settings.json root fields; directional migration required |
| Automatic sync | `sync.automatic`, explicit boolean; setup proposes Off | Current setup | Immediate save; next session start checks once; subsequent shutdown pushes all selected content only if sessions included; reload skips shutdown push |
| Startup transfer | `sync.automaticTransfer`, false | Current setup | Immediate save; enabling schedules next session start; independent of Automatic sync |
| Autonomous sync | `sync.agentMode`, false | Current setup | Reviewed opt-in; eligible next-startup and Sync now transfers without another transfer confirmation, plus selected-model assistance for supported conflicts; no transfer from Settings or automatic reload |
| Continuous sync | `sync.continuous`, false | Current setup | Separate reviewed opt-in; requires Autonomous sync; recurring work starts at eligible startup or after the command/manager closes |
| On setup switch | `onSwitch`, `ask-before-pull` | All setups | Immediate save; subsequent switches |
| Storage location | `storage.bucket`, `branch`, `path` as applicable | Current setup | Reviewed save; changes future destination without moving remote history |
| Manage sync setups | `syncSetups`, `activeSyncSetup` | This device | Existing reviewed catalog flows; replacing/removing the current setup closes its old settings owner |
| Manage storage connections | `storageConnections` | Shared by named setups | Existing affected-setup review; changes future operations |
| Merge settings fields | `sync.mergeSettings`, false | Current setup | Immediate save; opt-in merge on subsequent sync with a verified ancestor |
| Content merge / partial progress | `sync.mergeContent`, `sync.partialSync`, false/false | Current setup | Explicit compatibility review and atomic save; Off, Merge only, Merge + partial, Partial only preserve all combinations |
| Skip secret scan | `skipSecretScan`, false | All setups | Immediate save; subsequent manual/automatic pushes; Diagnostics still scans |
| Show sync status | `showStatus`, true | All setups | Immediate save and immediate status visibility change; notifications/widgets remain |
| Debug startup timings | `debug`, false | All setups | Immediate save; fixed-label duration notifications from the next session start; TUI/RPC only |

Opening foreground Settings cancels and drains startup work. Back does not undo successful saves; cancelling a draft or compatibility review leaves that change unsaved. A failed save retains the previous document and effective/displayed value. Completed transfers are never undone by changing a preference.

Writers queue the complete read-modify-write operation, hold the cross-process lock through validation and same-directory atomic replacement, preserve unknown fields and private permissions, and refuse invalid existing files. UI changes do not replace those writers.

## Presentation decisions

Selecting **Settings** in `/sync` opens **Pi Sync Settings** directly as one searchable flat list, with all 16 rows in their existing order and no category navigation or headings. Row values, descriptions, actions, reviews, and save behavior are unchanged. Typing searches the list. Back returns directly to the manager; hard Ctrl+C closes the flow. No `/ Search` hint is added because slash is ordinary search text.

The existing public Kit settings adapter is retained rather than adding a second selector or accessing private Pi fields. Installed `SettingsList` provides `updateValue()` and `selectItem()`, but has no injected keybinding or awaited-save/rejection contract and does not expose search focus. Kit already owns ordered pending changes, rollback, retained search/selection, IME focus, bounded frames, and clipped mouse coordinates. This is an intentional existing deviation from the literal native-component convention. No new Kit API, dependency floor, or release is required. A package-owned public rendering boundary returns no lines at zero width and retains the selected row (or search when nothing matches) below five content rows; compact mouse events map back to the original rendered row. It does not access private component state or add key handlers. Search placeholder and position-footer relocation remain unsupported by that public API; the existing native-style hints and position indicator are retained rather than patched through private fields.

Last applied shows a compact opaque snapshot ID and explicitly states that application time is unavailable. History retains the full recorded ID even when the remote history no longer lists that snapshot. Snapshot `createdAt` is not a local application time; opening the manager performs no remote timestamp fetch.

Startup transfer summaries report the preference and prerequisites, not a claim that a transfer is eligible now. Runtime evidence in `merged-sync.ts` and `s3/s3-backend.ts` permits Git, conditional WebDAV, and R2/S3 with verified conditional writes. `read-check-write-verify` publication is refused for automatic operations. Baseline, matching authoritative include policy, idle ownership, and conflict/secret checks remain mandatory. This corrects the earlier settings reference's manual-only R2/S3 statement without expanding backend authorization.

## Transfer review matrix

| Branch | Review and effect | Freshness / acceptance evidence |
| --- | --- | --- |
| Sync now, empty selection | Warning; no useful transfer | `empty-policy-acceptance.test.ts` |
| Sync now, first sync / empty remote | Existing decision or reviewed directional Pull/Push | `sync.test.ts`, `sync-decision.test.ts`; selection/policy checks remain |
| Sync now, equal files | Existing no-op or baseline acceptance; not represented as file changes | `sync.test.ts`, `sync-inspection.test.ts` |
| Pull | Remote → local counts and paths; protected loaded session excluded; backup before apply | `sync-mutations.ts`: settings, local hashes, head and baseline rechecked before commit; `recovery-pull-freshness.test.ts`, `local-field-pull-policy.test.ts` |
| Push | Local → remote active snapshot counts and paths; preserve eligible unmanaged content; removals do not erase retained history | `sync-mutations.ts`: fresh interactive before-image, local hashes/settings/baseline rechecked, expected-head publication; `backend-orchestration.test.ts`, `review-feedback.test.ts` |
| Forced Pull/Push | Same directional review, not a bypass of conditional publication | Refreshed force-push plan requires new approval; migration confirmation remains mandatory even with `--yes`; `sync-state-revision.test.ts`, `local-field-migration.test.ts` |
| Merge / partial progress | Effective before/after snapshots, local/remote counts, conflicts/withheld groups, backups and publication | Existing scrollable review unless Autonomous sync or another explicit transfer authorization applies; recheck settings, hashes, state and remote before journal/apply; `merged-sync-confirmation.test.ts`, `partial-directional-progress.test.ts`, `merged-sync-summary.test.ts` |
| Conflicts | Review complete dependency group and separately choose authority | Artifact fingerprint, group versions, baseline, config, owner and head checks; `conflict-confirmation.test.ts`, `conflict-preview.test.ts` |
| Case-variant cleanup | Pull/rollback include the apply engine’s additional top-level alias removals, even when canonical snapshot bytes are unchanged | `apply-review.ts` uses the authoritative apply planner, streams file hashes, records symlink identity without following its target, and rechecks the complete alias set before commit; `transfer-preview.test.ts` covers changed, added, removed, cancelled and symlink aliases plus descriptor cleanup on cancellation. Merge preflight rejects noncanonical changed targets instead of deleting aliases. |
| History rollback | Historical snapshot → local and active remote head; backup and protected-session summary | Settings, local bytes, current head, selected backend/setup and baseline rechecked; `history-confirmation-cancellation.test.ts`, `history-cancellation.test.ts`, `rollback-field-policy.test.ts` |
| Explicit `--yes` | Existing documented review bypass only | Mandatory migration and operation safety remain; existing route suites |
| Automatic startup / shutdown | No new modal; existing opt-in, capability, idle, all-or-nothing conflict and secret policies | `automatic-transfer.test.ts`, `startup-check.test.ts`, `backend-orchestration.test.ts` |

TUI Pull and Push reviews reuse the existing scrollable safe-default confirmation and exact Details document; RPC and History rollback retain their observable confirmation protocols. The existing History dialog ownership/cancellation flow is not replaced. All changed counts come from effective snapshot differences rather than raw merge decisions. Protected paths, preserved remote files, merged bytes, and withheld paths must be accounted for before rendering. Cancellation performs no transfer; pre-commit preparation may retain recovery evidence. After the commit boundary, existing completion/recovery rules apply instead of promising undo.

## Review boundaries

This change does not touch model prompts, tool exposure, shared-terminal handoff, settings formats, credentials, or default sync policies. Existing startup/session signals and Kit/custom-interaction disposal own new UI calls. Any awaited review is followed by owner validation, and each mutating operation revalidates its mutable inputs before its existing commit boundary. Status and differences actions use existing routes; manager opening/refresh remains observational and does not contact the remote. Diagnostics discloses its WebDAV write/repair behavior before execution.

## Settings wording verification

The 2026-11-08 wording update uses **Autonomous sync**, removes Settings maturity markers at the user's request, and keeps `sync.agentMode`, saved consent, defaults, opt-ins, and risk warnings unchanged. A semantic diff audit checked all 16 changed runtime files against the base plus approved prose substitutions; authorization, settings storage, resolver prompts, cancellation, disposal, session replacement, and shutdown logic are unchanged. Review followed `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`, plus the skill editing rules. An independent complete-diff review found no issues.

Verification evidence:

- Root `npm run check` and `npm test` passed: 935 test files, 20,528 passed tests, 34 existing skips, and no unhandled errors.
- The focused Pi Sync suite passed: 185 files, 3,293 passed tests, and 19 existing skips. Cases cover all four Settings descriptions, TUI/RPC consent, cancellation, the RPC Done exit without authorization, durable saves and failure recovery, Continuous sync dependencies, non-default keys, narrow rendering, and current/legacy documentation anchors.
- A fenced-code-aware heading audit passed for all 37 package READMEs. Legacy fragment aliases remain in the README, authoritative settings reference, and compatibility index.
- `npm run package:pack -- sync` and an actual temporary tarball inspection passed: 330 entries include the runtime, source, docs, skill, license, and changelog, without tests or repository plans.

The first direct-Vitest run used a symlinked macOS temporary path and triggered existing alias-path safety checks; the successful focused run used the canonical temporary root, as the root runner does. New RPC choice assertions were corrected to include Kit's existing Done exit, and both consent flows now test that exit. No runtime safety check or acceptance criterion was relaxed. Later full-suite command-level rechecks exceeded the harness's 300-second command limit. A background full-suite recheck hit the readiness watchdog in the unchanged `test/packed-publish-native.test.ts`; that file passed separately. The final full-suite recheck uses a managed background runner without changing per-test limits. Biome reports existing schema-version and unrelated lint advisories; its gates pass without changing repository tooling.

Physical-terminal appearance, rendered Markdown fragment navigation, live model quality, production backends, Windows, and Android were not newly verified. A maintainer needs the relevant terminal/platform and a separately authorized provider/backend environment to check those paths before claiming new coverage. These are not additional gates for this wording-only change; normal CI and explicit publication approval still apply. No live-provider request, production transfer, publication, tag, or release workflow was performed.
