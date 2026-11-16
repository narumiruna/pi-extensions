# File merge safety and recovery

Established-baseline **Sync now** performs an all-or-nothing, file-level three-way merge. Explicit push and pull remain directional. This phase does not merge JSON fields, text hunks, or divergent sessions, and does not publish partial progress during a conflict.

## Decisions and selection

`sync/file-merge-planner.ts` compares the union of baseline, local, and remote paths. An unavailable ancestor is not an established empty baseline. Absence is not empty content.

| Observation | Decision |
| --- | --- |
| Local and remote equal, including absence | Accept equality. |
| Only local differs from baseline | Select local bytes or deletion. |
| Only remote differs from baseline | Select remote bytes or deletion. |
| Both differ and final contents differ | Require review; includes divergent additions and delete/modify. |
| Ancestor unavailable or selection changed | Keep initial-source/selection review. |
| Remote would write/delete the current session | Require review; never install that version automatically. |
| Case aliases or file/descendant paths occur across inputs | Withhold the complete group; require a reviewed direction. |
| A changed top-level target has a noncanonical physical case variant | Withhold publication/apply; normalize the selected file spelling without changing reviewed bytes before retrying. |
| Accepted settings change the session storage root while sessions are selected | Withhold merged publication/apply/baseline acceptance; require explicit directional review, including interrupted journals. |

Merged input is bounded to 64 MiB decoded content and 16,384 input-file entries; the private journal also has a 384 MiB serialized bound. Larger transfers require a reviewed directional operation rather than an unbounded merge. One unresolved path prevents the whole merged transfer. The planner verifies safe/denied paths, canonical base64 and hashes before authorization. It rejects invalid UTF-16 paths and compares protected context paths using Node’s UTF-8 conversion followed by NFC/case identity. Read-only filesystem preflight refuses non-regular targets, symlinked parents, and hard links before combined publication; applicability is rechecked at installation boundaries. Merged publishable content is scanned for secrets unless the existing global override is explicitly enabled. No file values appear in conflict summaries.

Include order remains significant for policy review in this phase. The inventory covers `sync-policy.ts`, `sync-state.ts`, `remote-snapshot.ts`, config/review fingerprints, `settings-management.ts` stale-selection guards, `snapshot.ts` collection/filter/preservation, codec selection validation, all three backend metadata readers/writers, and selection/attention UI tests. Collection uses membership and sorts files, but ordered lists are also serialized into immutable metadata and captured review identities; those existing compatibility/freshness consumers have not been normalized. Order-only and membership changes retain the existing regression-tested review behavior.

## Authorization and lifecycle

| Setting/mode | Startup | Shutdown |
| --- | --- | --- |
| New opt-in absent/false | Existing `sync.automatic` observation policy only | Existing selected-content push when automatic + sessions are enabled; reload skips it |
| `sync.automaticTransfer: true`, TUI/RPC, idle | One observation and established-baseline conflict-free transfer attempt | Drain startup work before the existing shutdown policy |
| New opt-in enabled, agent busy | Wait for `agent_settled`; no polling/timer for the pending boundary | Clear pending work |
| Print/JSON | No new automatic startup observation/transfer | Existing shutdown behavior only |
| First sync, mismatched/legacy selection, missing established head | No automatic transfer; keep review attention | No overlapping startup transfer |
| Read/check/write/verify backend | Automatic transfer refuses; manual sync remains available with its capability disclosed | Existing shutdown behavior only |

Owned work starts after factory load, is keyed by `sessionManager`, and uses session ID/file, CWD, agent-root, signal, and captured config checks at mutation/review boundaries. It is cancelled/drained before foreground commands, a new agent run, session replacement, and shutdown. Read-only legacy checks are not cancelled merely because an agent run begins. The deadline starts with the owned check, not while waiting for idle. Policy/session/owner checks are repeated around remote, planning, commit, and apply boundaries. User Settings is a foreground command, so it drains work before private ordered saves; a cross-process settings change is detected at authorization boundaries, not through a watcher.

Idle is not proof that external writers are absent. Exact-path `withFileMutationQueue` coordinates Pi edit/write tools within this process. The operation lock coordinates cooperating pi-sync processes. Neither owns other Pi sessions, arbitrary editors, or malicious same-user filesystem changes. Apply checks preimages/postimages again at each installation boundary, but Node does not provide an atomic file-content compare-and-swap against uncoordinated external writers. Pause those writers when strong exclusion is required. Only this process's current session is protected.

Merged transfer never reloads resources, activates recovery copies, changes tools, or alters the model-visible prefix. Existing directional commands may offer a separate explicit resource-reload confirmation; the user’s confirmation remains required. Successful automatic transfers emit one summary; local-resource changes require an explicit later reload/restart/resume.

## Durable boundaries

A setup/backend/selection-bound `*.merge-journal.json` under the denied private state root stores before/after snapshots, the complete upload, expected/committed opaque head, original state fingerprint, backup location, and the effective session root when sessions are selected. Session collection, backup, preflight, apply, and recovery use that pinned root; replacement contexts must match it. Older merge journals without root evidence require directional recovery for selected sessions, never an inferred root. A final local hash/baseline check after durable journal publication refuses stale candidates before any backend attempt and retires those provably unpublished candidates. File permissions are `0600`; new private state subdirectories are `0700`. Sensitive content stays out of discoverable resource directories. Backend snapshot references, content IDs, and revisions remain distinct.

```mermaid
flowchart LR
  A[Validate baseline and reviewed inputs] --> B[Durable private backup]
  B --> C[Publish private merge journal]
  C --> D[Conditional or reviewed-capability remote publication]
  D --> E[Record committed head]
  E --> F[Guarded atomic local writes and deletes]
  F --> G[Publish accepted baseline]
  G --> H[Remove completed journal]
```

Temporary-file publication syncs file contents before rename. On POSIX, directory entries are synced after critical rename/delete boundaries, including newly created ancestor names before journal retirement. Windows retains Node's atomic-rename behavior but does not expose directory fsync; this is not a claim of power-loss durability on every filesystem. Snapshot backends keep their existing documented publication capabilities.

| Interruption | Recovery/result |
| --- | --- |
| Before journal publication | No remote/local mutation; baseline unchanged. |
| Proven pre-commit race with no possible activation | Remove candidate journal and re-read/replan, at most three attempts; review again if interactive. |
| Generic network, after-commit conflict, cancellation, or unknown publication outcome | Retain journal and backup; never blindly republish. |
| Candidate is current and immutable bytes match | Continue guarded local apply; do not publish again. |
| Uncommitted candidate is not active and original opaque revision/local bytes/state still match | Reconcile without transfer, clear the journal, return cancelled rather than false success. |
| Candidate/head/selection/state cannot be reconciled | Refuse automatic recovery; preserve evidence for review. |
| Some local files installed before failure | Each remaining target must equal its recorded preimage or postimage; roll forward idempotently, never restore old bytes over a newer edit. |
| Local apply complete but baseline write failed | Retain journal; verify current head/files, publish baseline, then remove journal. |
| Crash after baseline publication before journal removal | Reconciliation recognizes the recorded committed baseline and clears the redundant journal, even if a later remote head advanced; an unaccepted journal still retains evidence. |

Use `/sync sync` to reconcile a journal. If newer local or remote edits prevent that, preserve evidence, review `/sync diff`, then explicitly choose `/sync push --force` or `/sync pull --force`. Directional recovery revalidates the reviewed local bytes/current head and archives the old journal only after its chosen result and baseline are committed. It does not restore the stale merge preimage. Existing reviewed rollback also retains its normal backup/publication semantics.

Disabling the opt-in cancels pending work but does not undo completed transfers or delete evidence. Do not use an older binary while a journal is pending. Once recovery finishes, accepted state retains the existing hash-only schema; no new state interpretation is required for older readers. Original and resolved journals/backups are kept under denied storage, not loaded as resources. This phase does not add automatic backup pruning.

## Directional snapshot recovery

`snapshot/snapshot-transaction.ts` writes private version-4 journals with verified before/after hashes, bounded planned subtree evidence, and durable removal/replacement intent. Proven top-level regular-file case replacements use version 5: one entry records the original `target` and canonical `afterTarget`, with one backup and one physical Pi queue reservation. Pi resolves existing queue keys with `realpath`, so nesting both aliases would self-deadlock. Apply removes the original spelling and installs the canonical spelling; guarded recovery stages and restores the original spelling even when the bytes did not change. Independent aliases, symlinks, hard links, changed spellings, and multiple writes are not coalesced. It installs files through synced temporary-file renames. Backup files, nested directories, and the top-level `before` directory are synced before journal publication.

Before each recursive apply/recovery deletion, removal intent is published durably for the target and affected descendants; only absence gains recognition, never unknown content. Directory and symlink restoration are staged beside the target, checked against the backup, synced, revalidated, and renamed into place. Copy failure/cancellation leaves the live postimage unchanged; a rename interruption after deletion remains recoverable from the retained backup and intent.

A complete group is checked before recovery mutates any path. Each destructive boundary checks ownership and bytes again; backup hashing precedes the live-target observation, and both file and non-file restoration recheck immediately before removal. Current-session paths and unowned session roots are refused.

Startup recovery reads the journal first and resolves an explicit context root or configured fallback only when its entries target session storage. An unused custom pinned root remains syntactically validated but cannot authorize a path or block guarded agent-root-only restoration. Session targets still require owned roots and current-session protection. It does not parse unrelated or interrupted Pi settings to restore agent-root-only targets.

Legacy version-1 journals lack proven postimages and are retired only if every target still equals its backed-up preimage. Version-2 journals retain their original guarded image rules; known postimages can be restored through staging and upgraded removal evidence, but old missing intermediate states without durable intent still require manual review.

Newer bytes, missing/corrupted backups, malformed journals, and unknown intermediate directory states retain evidence rather than triggering a blind rollback. Interrupted preparation directories without a journal are preserved but never loaded as resources.

Preserve a blocked transaction and backup, close Pi, and review selected paths before restoring them manually. Do not downgrade while either journal format is pending. Pi can load resources before the lifecycle recovery hook; recovery does not undo cached or already-loaded code, so explicitly reload/restart after restored resources need to be used.

## Verification and guides

`test/file-merge-planner.test.ts` covers decision classes, exhaustive hash/absence combinations, checksum/path validation, protected sessions, collision groups, determinism, and immutability. `test/merged-sync.test.ts` covers independent edits/additions/deletions, complete conflict barriers, stale review/apply, private evidence, finite race retry, uncertain publication, cancellation, partial local installation, baseline-write failure, restart-style recovery, and reviewed directional recovery. Existing Git/WebDAV/S3 contract suites verify opaque revisions, conditional/conflict phases, and unknown outcomes; new automatic policy refuses the weak S3 publication capability instead of claiming CAS.

`test/automatic-transfer.test.ts` covers mode gates, no modal prompts, busy/idle scheduling, one attempt, foreground/agent/session/shutdown draining, policy disablement, first-source/selection/head barriers, ordered validation, private permissions, and unknown-field preservation. `test/merge-review.test.ts` verifies cell-exact TUI review with non-default confirmation/cancellation bindings and hard `Ctrl+C`, RPC pagination without custom TUI, and stale-owner refusal. `test/snapshot-transaction-recovery.test.ts` verifies legacy/modern image recognition, newer-write refusal, backup/root/parser protection, cancellation, and file/directory transitions. Existing snapshot mutation tests inject failures at atomic rename/delete boundaries. Installed Pi’s Node Jiti aliases and compiled-runtime virtual modules resolve the coding-agent root to the running Pi, so the imported public queues are the runtime’s queues; packaged peers declare the supported runtime floor.

Existing settings suites retain atomic failures, malformed-file protection, cross-process locking, and save rollback; generated-runtime suites exercise registration, lifecycle, exact emitted imports, and a representative lazy boundary through Pi Jiti.

The semantic review follows `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and `packages/pi-sync/AGENTS.md`. Repository gates, package build/pack inspection, and the isolated package-directory RPC smoke are recorded in the Phase 1 PR. No live-provider or user-storage transfer is needed to verify this deterministic contract. Publishing, tags, and release dispatch remain outside authorization.
