# Daemon migration and release restrictions

This daemon extraction is experimental. Deterministic Linux verification passed, but publication and production cutover remain separate, unauthorized actions. Keep the restrictions below until their owners complete the required checks.

## Ownership and upgrade

The non-extension npm package is `@narumitw/pi-sync-daemon`; its executable is `pi-sync-daemon`. These replace `@narumitw/sync-daemon` and `sync-daemon`; the new package does not provide the old executable alias. The rename changes the package and executable names, not the IPC names, authorization digests, or
settings and state formats. The Pi extension remains `@narumitw/pi-sync`. Pi uses one detached service
per canonical agent directory. It does not install an OS service.

After an update, use `/reload` in open Pi sessions. On the next active connection, the new client
checks the owner's build over compatible, authenticated IPC. For an older or unversioned owner, the
client checks that no retained unattended permission blocks the upgrade. It then requests a stop
and starts the replacement only after the owner releases its identity and exits. If any check fails,
follow manual recovery. The upgrade does not run a transfer, replay an operation, or change sync
settings. Passive print, JSON, and shutdown paths do not replace an older owner. If an upgrade fails
while switching sessions, Pi Sync reports the failure and tries to attach the new session to the
same owner for file protection only. That attachment cannot submit sync work. Use `/reload`
after recovery.

Manual recovery:

1. Revoke all retained unattended grants before updating. `/sync daemon revoke-after-exit` applies
   only to the active setup. For each setup with a retained grant, make it active, run the command,
   and confirm revocation. If the upgraded client blocks on consent before creating a pending
   upgrade record, use an already available compatible Pi client to revoke each grant from the
   still-running owner.
   Without a pending record, `repair-upgrade` returns `repaired: false` and does not revoke permission.
   If no compatible client is available or revocation fails, stop here and preserve the consent,
   identity, and recovery files.
2. Run `pi-sync-daemon status --root <agent-directory>`.
   - A verified `pid` identifies the owner that answered the handshake. Record it before stopping
     that owner. Check `pendingUpgradePid` for any pending owner, even if `running` is `false` or `null`.
   - `running: null` means the handshake failed, even if there is no pending upgrade. `recordedPid`
     comes from the validated identity file and is only a lead. Unknown status does not prove exit
     or compatibility. Use diagnostics from an already available compatible version to identify the
     owner. If you cannot identify it, stop here and preserve the records.

   To stop an identified, running owner, use `pi-sync-daemon stop --root <agent-directory>` if
   compatible. This works even if the old executable was removed. If the old executable is still
   installed and compatible, you can use `sync-daemon stop --root <agent-directory>` instead.
3. Check the recorded PID in the operating system. On macOS or Linux, use `ps -p <pid> -o pid,args`.
   On Windows, look up the PID in Task Manager's **Details** tab. A successful `stop` confirms
   identity release, not process exit. Wait for the old process to exit. If exit is uncertain, do
   not force a second owner or delete recovery files.
4. If a pending upgrade still blocks restart after exit, close other Pi sessions for that root.
   Run `pi-sync-daemon repair-upgrade --root <agent-directory>`. It verifies exit, revokes all
   retained after-exit grants for that root, and moves the upgrade record and any stale identity
   to the private archive path it reports. It does not start a daemon or transfer data. If repair
   fails, keep the records. Do not edit or delete them to force startup.
5. Use `/reload`, then `/sync daemon status`. Review after-exit permission again if you need it.

Stop the service before rebuilding a local checkout in place. A source rebuild without a package
version change does not trigger automatic replacement.

Before the first daemon-owned transfer, close or upgrade every older Pi process and review `/sync daemon handover`. The existing operation lock excludes observed transfers, but an idle older client cannot be detected from an absent lock. Older binaries cannot be made to honor a new handover record retroactively. Do not run an old and new engine as interchangeable writers.

Backend formats, `pi-sync.json`, `pi-sync/`, `.pisync/`, backups, and journals remain owned by the extracted engine. Legacy directory migration remains explicit. Coexisting or unsafe state roots must be reconciled without merging or deleting evidence automatically.

## Lifetime is not consent

Old Continuous consent was limited to an open Pi session. Existing Automatic, Autonomous, and Continuous defaults stay unchanged. When no registered live client PID remains for that canonical root and no valid explicit after-exit grant covers the active setup, a fixed 30-second grace period starts. Explicit CLI start without clients follows the same policy. Live passive, disconnected, publishing, and orderly retired PIDs keep the owner alive; detach, heartbeat loss, and an empty active-participant list do not prove process exit. `/reload`, `/new`, fork, and resume retain protection while their Pi process lives. A client arriving before shutdown becomes final cancels automatic exit. No new setting, environment variable, or keep-alive flag is added.

After grace, stop new automatic work, cancel cancellable work, and drain committed writes, monitor work, mutation-queue releases, persistence, and owned callbacks before releasing ownership. Closing adds no final sync or model request and preserves journals, backups, request accounting, and existing transfer permissions. The next eligible interactive client or explicit command can use singleton startup only after the old owner's exit is proven. Print/JSON never launch a replacement.

`/sync daemon allow-after-exit` reviews extra unattended permission for the current setup and selected standalone-capable model. `/sync daemon revoke-after-exit` stops new unattended work. Setup changes invalidate the persisted digest. Interactive model, working-directory, or session-directory changes durably revoke older grants; returning to the old binding or restarting does not restore them. A valid active-setup grant keeps service lifetime under the existing fingerprint and binding rules, without expanding work permissions. A grant for another setup, a revoked grant, or a stale fingerprint does not. Temporary provider or backend unavailability does not itself revoke a valid grant. Lifetime checks do not call a model, contact a provider or storage, or execute credential commands. Independent model availability for actual work is checked through public Pi SDK APIs; private extension registrations and parent runtime credentials are not transferred.

Headless print/JSON startup never launches a persistent service. It passively attaches to an existing one to protect its session and pause automatic work. Orderly closed clients retain live-PID file protection without remaining active participants; ambiguous disconnections and replacement gaps remain pauses. Pending recovery needs a configured observable client and reviewed ownership before managed files can be changed. No event automatically reloads resources or changes the model-visible prompt/tool prefix; reload remains an explicit reviewed client action.

## Write coordination and disconnection

The service owns synchronization scheduling and execution, not every writer on the machine. Participating Pi clients hold their actual public file-mutation queues through apply and acknowledge release. A joining client waits to publish its attachment until the current reservation, including nested writes and release acknowledgements, ends; the next transaction includes its queues. This also applies to passive print/JSON startup. Attach waits remain cancellable without an idle timeout that could otherwise bypass this protection during a long apply; shutdown cancels the partial connection instead of waiting for admission. Pi core settings updates use a separate authoritative file lock, which the daemon must also hold. Creating an absent `settings.json` with a live Pi is refused because the Pi missing-file branch does not reread after acquiring its lock.

Protect the union of all registered live-PID sessions, including ambiguously disconnected and orderly retired clients. Retired clients cannot authorize work or hold back zero-client scheduling, but their protection survives another attach and daemon restart until confirmed PID exit. A contact timeout revokes work; it is not permission to overwrite that session or release an acquired mutation grant. An uncertain grant remains quarantined until explicit release or confirmed daemon exit. Unregistered editors, shell commands, older clients, and extensions remain independent writers; preimages, conditional publication, backups, and journal recovery are still required.

When a running daemon expires a Pi client's heartbeat (for example, during
computer sleep), the TUI or RPC client tries to reconnect to that same daemon
without reloading Pi. The next `/sync` command also checks contact before
submitting work. `/sync daemon status` reports `connected` only after the daemon
accepts the current participant's facts. An older daemon can stay reachable
without supporting this repair; a healthy CLI status alone does not confirm Pi
participation.

Reconnect does not replay a submitted operation or restart startup transfers.
If a write or file-queue release cannot be confirmed, preserve the journals and
use the existing recovery path before retrying a transfer. Reconnect does not
stop or restart the service, and it does not extend transfer or model permission.

## Diagnostics and rollback

If saving consent fails, that service instance blocks automatic work. Uncertain consent publication, failed revocation, or cleanup failure keeps the owner paused and retains evidence; automatic exit or implicit restart must not clear the barrier and restore an older persisted grant. Preserve the retained file, repair persistence, and revoke permission through the existing repair/revocation path before an explicit restart; a failed save does not prove the previous grant changed. Cleanup failure is not a successful exit.

Use `pi-sync-daemon status --root <agent-directory>` without starting a missing service. `stop` drains compatible work. `restart` must not replace an incompatible, unavailable live, or uncertain owner silently. The Pi client must report failure rather than fall back to in-process transfers. If the initial consent check blocked the update before a pending record was created, follow step 1 of [manual recovery](#ownership-and-upgrade); `repair-upgrade` cannot help in that case.

A successful CLI `status` handshake reports an owner-private, bounded lifecycle-log path. Only timestamps and lifecycle phases are retained; no request content, credentials, model output, or exception text is logged. This log is not transaction recovery evidence.

Before rollback:

1. Stop the daemon explicitly and verify owner exit.
2. Close all upgraded clients and retain settings, state, journals, and backups.
3. Reconcile pending or uncertain publication through the supported engine recovery path.
4. Check consent compatibility before rolling back. A repair can leave `daemon.json` larger than
   65,536 bytes because it keeps all other fields when revoking grants. Builds with the old
   65,536-byte limit cannot read that file. Preserve it and use a build that supports the larger
   file. Do not delete it or restore an older copy to make the rollback work.

Operation retries are instance-bound and deduplicated. An expired result or old instance requires journal reconciliation, not blind replay. A full bounded result ledger requires an explicit drained restart.

## Verification status

The following evidence records the earlier daemon extraction, including its former idle-persistence policy. It does not verify the new automatic-exit policy; that policy requires separate runtime verification. Native and production restrictions below remain unchanged.

Completed on disposable roots and synthetic loopback endpoints:

- `npm run format` and `npm run check`: builds, Biome, package boundaries, dependency compatibility, and workspace types.
- `npm test`: 1,035 passing files, one skipped file; 23,291 passing tests, 18 skipped, no failures or unhandled errors; the configured five-second case timeout is unchanged.
- Scoped package workflow and cold build-order regressions; the real Changeset raises the scoped dependency floor and plans a public daemon-first release using a simulated unpublished registry entry.
- Both package-workflow dry packs; inspected real daemon/client tarballs; a fresh independent install with the local daemon tarball and the public SDK resolved in that install scope.
- Standalone import, executable symlink/Help, start/API/stop, package-directory native Jiti loading, lazy `/sync help`, and survival after the installed Pi process exited.
- Production Git preparation without development tools: Kit and daemon runtime JavaScript, exact imports, executable CLI, source-entry Jiti Help, and daemon start/API/stop.
- Actual-daemon typed sync/selection decisions through both command and recovery routing; RPC resolution-menu cancellation without mutation; live-PID protection through detach/exit/pause/replacement gaps, unrelated attach, restart, and confirmed PID exit; parameterized child programs keep data outside executable source. Targeted old-policy negative controls failed, and both regression suites passed after the fixes were restored.
- Seventeen admission/cancellation regressions cover print/JSON/RPC joins during queue grant, apply, and release, nested targets, future cohort coverage, cancelled waiters/attachments, transport disconnection, request timeout policy, partial-connection pause/disposal, hook re-entry, and shutdown; releasing admission early makes twelve cases fail.
- Twenty new regressions cover external-root queue coordination and explicit Continuous retry. Real Pi clients with different session roots can pull into an existing or new external destination. A repaired authentication failure resumes after explicit sync. Authentication/storage/unknown failures retain nonempty calls and attempts; setup mismatch, stale or cancelled origins, busy clients, disabled policy, resolver disposal, and consent-publication failure remain guarded. Negative controls fail, and all 26 focused cases pass after restoration.
- Two actual Pi RPC clients sharing one owner; new/reload/fork/resume/exit; stable provider-visible prompt/message prefix and ordered tools; real loopback S3/WebDAV cancellation; actual Pi file queues and SettingsManager lock branches; native model resolution through command/startup/Continuous/retry/zero-client paths; stale reviews and durable grant revocation across restart.

The semantic audit used `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and both package instruction files. It covered cancellation/disposal/replacement, every owned process/task, callback generations and post-await freshness, settings read/write ordering and failure recovery, unknown/invalid-file preservation, conditional publication/journals, provider capability and post-auth validation, bounded IPC/logs, loading boundaries, and model-prefix stability. The README audit covered 39 active packages and 92 affected local links.

Intentional compatibility limits are explicit: there is no legacy in-process fallback; unsupported parent-only providers remain unavailable; print/JSON do not launch a service but protect sessions in an existing one; a cancelled SDK switch/fork stays paused until reload; arbitrary external writers are not covered by a universal filesystem compare-and-swap. Normal closed clients retain live-PID protection without blocking reviewed zero-client work. No package publication, tag, release dispatch, paid provider request, or production-storage action was performed.

### Heartbeat recovery verification

An isolated daemon clock and real Pi RPC clients reproduced the stuck first
command before the fix. Regression tests now verify same-owner, same-session
recovery with and without a command, and no replay or remote write after an
interrupted loopback WebDAV push. Daemon tests exercise admission, lifecycle
cancellation, legacy replies, committed work, and uncertain queue release.
The Jiti tests load the built extension and exercise its lazy command path.

Physical suspend and wake timing on target devices remains unverified. See
[External handoff](#external-handoff) before making a platform claim or
preparing a release. This change neither publishes a package nor authorizes
production cutover.

## Measured process cost

These are same-host observations on Linux with Node `v26.11.1`, not limits or statistically controlled performance claims. The baseline was reconstructed from archived commit `a01c1d75` after implementation, rather than measured before editing. Both Pi cases loaded generated Jiti entries through real offline RPC processes with the same installed parent SDK and synthetic loopback WebDAV/model endpoints. No production stores, credentials, or paid model calls were used.

| Observation | Archived in-process engine | Daemon client and service |
| --- | ---: | ---: |
| First Pi readiness, excluding explicit service adoption | 472 ms | 538 ms |
| Detached service launch and immediate fixture ownership review | Not applicable | 108 ms |
| Second Pi readiness | 485 ms | 533 ms |
| First push, including deferred imports | 123 ms | 488 ms |
| Unchanged sync | 49 ms | 84 ms |
| One synthetic conflict request and apply | 210 ms | 324 ms |
| Fresh one-Pi RSS | 140.9 MiB | Pi 151.5 + service 77.4 MiB |
| RSS during a model request | 162.1 MiB | Pi 153.8 + service 181.1 MiB |
| Two-Pi RSS after transfers | 163.2 + 161.9 MiB | Pi 153.9 + 146.3 + service 182.4 MiB |
| Aggregate CPU over a one-second idle sample after two seconds of settling | 0% | 3.0% |

A separately started unconfigured service reached readiness in 68 ms at 67.7 MiB RSS without importing the full Continuous/model engine graph. Eligible monitoring loads that graph lazily and rechecks every eligibility branch afterward. First transfer/model work loads more of the existing engine and public SDK. The extraction adds process/IPC cost; these samples do **not** show an aggregate memory or latency reduction. RSS sums can double-count shared pages and are not physical-memory measurements. Each conflict case made exactly one synthetic request. Content compatibility checks used SHA-256 `f34848ca92665c342abd5816c9e3eda0e82180671195362bcd0080544a3bc2ac` for `base` plus newline and `c81662749eb30a2c7f6b6b9b1a561a7b0be5cc115759b72442ddb476e7712751` for `remote` plus newline.

The archived previous engine also held its real operation lock in a separate process: reviewed new-owner handover refused the active lock, a declined review still refused an idle old process with no lock, and reviewed handover succeeded only after that process exited. Configuration bytes remained unchanged. This proves the observed-lock and explicit-review branches, not automatic discovery of every idle older process.

## External handoff

| Responsible role | Prerequisite and action | Expected result | Unverified behavior and restriction |
| --- | --- | --- | --- |
| npm/release account owner | Passing package gates and explicit approval; verify publication rights for `@narumitw/pi-sync-daemon` and dependency-first publication | The daemon resolves before the dependent Pi client is released | Scope permissions and first publication are not verified; no publication, visibility change, tags, or workflow dispatch without approval |
| Device operator | Verified builds and an isolated setup; suspend and wake the target device, then run `/sync daemon status` and `/sync status` in the same Pi session | Both commands work without reload; the daemon and session stay the same | Physical wake timing is not verified by clock-controlled tests; do not claim tested platforms without this check |
| Deployment operator | Verified cutover/recovery evidence and backups; close older Pi processes and authorize each real root | One recognized owner with unchanged compatible data | Only the explicitly approved checkout-service stop/restart was used for package-identity and runtime maintenance; no production-storage transfer or settings change was made, and no real-data cutover is included |
| Native platform maintainer | Prepared transport/process tests; run native Windows/macOS checks | Correct local transport, permissions, independent lifetime, and recovery | Native ACL/named-pipe, logout, and physical power-loss behavior remain unverified; do not advertise new unverified guarantees or silently remove previous support |
| Provider/storage account owner | Explicit cost/network authorization and isolated data; optional live smoke | Authorized dispatch/publication without exposed credentials | Entitlements and custom-provider/production behavior remain unverified; deterministic providers and loopback stores are the default |
