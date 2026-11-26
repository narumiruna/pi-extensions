# Daemon migration and release restrictions

The daemon migration is experimental. Publication and production cutover require separate approval. Keep the restrictions below until their owners complete the required checks.

## Daemon CLI

The Pi Sync npm package includes its own daemon build and does not install a `pi-sync-daemon` command. With only Pi Sync installed, use Node.js 22.19.0 or later to run the bundled CLI:

```sh
node "/path/to/installed/pi-sync/dist/daemon/dist/cli.js" status --root "/path/to/agent-directory"
```

Use the directory containing the installed Pi Sync `package.json` and the exact agent directory used by Pi. For a repository or Git source install, run `node packages/pi-sync-daemon/dist/cli.js` from the repository root after daemon runtime preparation, with the same action and `--root` arguments.

If you installed the [standalone daemon package](https://www.npmjs.com/package/@narumitw/pi-sync-daemon), use `pi-sync-daemon status --root "/path/to/agent-directory"` instead. The standalone package and executable replaced `@narumitw/sync-daemon` and `sync-daemon`; the old executable name is not an alias. Neither the rename nor the bundled distribution changes IPC names, authorization digests, settings, or state formats.

## Ownership and upgrade

The daemon remains a separate process. Pi uses one detached service per canonical agent directory and does not install an OS service. Updating the standalone package does not update the build bundled in Pi Sync. To get a newer bundled daemon, install a Pi Sync release that includes it.

After an update, start Pi or use `/reload`. The next eligible interactive connection checks the daemon version and capabilities, not the Pi Sync version. An owner that does not report retirement of Autonomous and Continuous sync cannot receive sync work from the new client, even if it has the same version or is newer. Use the stop and exit checks below if such an owner is not automatically replaced. Protection-only attachment does not stop older clients or their owner. An older owner that supports guarded upgrades refuses to stop while reviews, jobs, or queue releases are active. Finish the work and use `/reload` again if the update is deferred. If Continuous sync keeps the old owner busy, close the other Pi sessions on that root and try again. A retained after-exit grant on any setup blocks replacement.

For an older or unversioned owner that does not support guarded upgrades, wait for all sync work to finish and close the Pi sessions that could submit more work. Run `restart --root <agent-directory>` using the [daemon CLI](#daemon-cli) from the intended build, then start Pi or use `/reload`. This is the one-time upgrade step for a legacy owner: it cannot check for new work before accepting a manual stop.

The replacement starts only after the old owner releases its identity and lock and its exit is verified. Pi reports the new version after it attaches to the expected build. `/sync daemon status` shows both builds and any known blocker without starting or replacing the owner. Other open sessions retain their registered file protection and can `/reload` to attach to the new instance. If a guarded upgrade is deferred, Pi registers the open session file for protection without joining the old owner's sync work. On a legacy owner, Pi uses a protection-only connection; it cannot submit sync work. The restart does not transfer data, replay a request, change settings, or grant consent. Startup transfer retains its authorization checks. Retiring Autonomous and Continuous sync does not stop an older process until it is drained and exits. Print, JSON, and shutdown paths do not replace an older owner.

Manual recovery:

1. Revoke all retained unattended grants before updating. `/sync daemon revoke-after-exit` applies
   only to the active setup. For each setup with a retained grant, make it active, run the command,
   and confirm revocation. If the upgraded client blocks on consent before creating a pending
   upgrade record, use an already available compatible Pi client to revoke each grant from the
   still-running owner.
   Without a pending record, `repair-upgrade` returns `repaired: false` and does not revoke permission.
   If no compatible client is available or revocation fails, stop here and preserve the consent,
   identity, and recovery files.
2. Run `status --root <agent-directory>` using the [daemon CLI](#daemon-cli).
   - A verified `pid` identifies the owner that answered the handshake. Record it before stopping
     that owner. Check `pendingUpgradePid` for any pending owner, even if `running` is `false` or `null`.
   - `running: null` means the handshake failed, even if there is no pending upgrade. `recordedPid`
     comes from the validated identity file and is only a lead. Unknown status does not prove exit
     or compatibility. Use diagnostics from an already available compatible version to identify the
     owner. If you cannot identify it, stop here and preserve the records.

   To stop an identified, running owner, use `stop --root <agent-directory>` from a compatible
   bundled or standalone CLI. This works even if the old executable was removed. If the old
   executable is still installed and compatible, you can use `sync-daemon stop --root <agent-directory>` instead.
3. Check the recorded PID in the operating system. On macOS or Linux, use `ps -p <pid> -o pid,args`.
   On Windows, look up the PID in Task Manager's **Details** tab. A successful `stop` confirms
   identity release, not process exit. Wait for the old process to exit. If exit is uncertain, do
   not force a second owner or delete recovery files.
4. If a pending upgrade still blocks restart after exit, close other Pi sessions for that root.
   Run `repair-upgrade --root <agent-directory>` with the daemon CLI. It verifies exit, revokes all
   retained after-exit grants for that root, and moves the upgrade record and any stale identity
   to the private archive path it reports. It does not start a daemon or transfer data. If repair
   fails, keep the records. Do not edit or delete them to force startup.
5. Use `/reload`, then `/sync daemon status`. Review after-exit permission again if you need it.

Stop the service before rebuilding the files it runs from in place. For a separately built checkout, `/sync daemon status`
compares the loaded daemon build with the running owner. The build ID identifies compiled engine code; it does not order
builds. A missing ID means the match is unverified, and different IDs at the same version do not trigger an automatic restart.
To switch explicitly, close or reload other Pi clients as appropriate and run `restart --root <agent-directory>` with the
[daemon CLI](#daemon-cli) from the intended build. It uses the same guarded drain, refuses to downgrade a newer owner,
and does not bypass retained unattended permission or pending recovery. Then load that Pi Sync build and use
`/sync daemon status` to verify the match.

Before the first daemon-owned transfer, close or upgrade every older Pi process and review `/sync daemon handover`. The existing operation lock excludes observed transfers, but an idle older client cannot be detected from an absent lock. Older binaries cannot be made to honor a new handover record retroactively. Do not run an old and new engine as interchangeable writers.

Backend formats, `pi-sync.json`, `pi-sync/`, `.pisync/`, backups, and journals remain owned by the extracted engine. Legacy directory migration remains explicit. Coexisting or unsafe state roots must be reconciled without merging or deleting evidence automatically.

Before enabling [transfer size limits](../skills/configure-pi-sync/references/configuration.md#transfer-size-limits), make sure the running owner supports both saving and enforcing the limits. A healthy `status` handshake alone does not establish that support. If an old owner remains after an update or an in-place rebuild, use the exit checks above before reloading Pi. Upgrade or close all older clients using that agent directory. Enabling a limit requires version 9 for the entire local settings document, which older processes refuse. It does not change the IPC protocol or remote snapshots.

## Lifetime is not consent

Autonomous and Continuous sync are retired. When no registered live client PID remains for that canonical root, a fixed 30-second grace period starts. Explicit CLI start without clients follows the same policy. Live passive, disconnected, publishing, and orderly retired PIDs keep the owner alive; detach, heartbeat loss, and an empty active-participant list do not prove process exit. `/reload`, `/new`, fork, and resume retain protection while their Pi process lives. A client arriving before shutdown becomes final cancels automatic exit. No new setting, environment variable, or keep-alive flag is added.

After grace, stop new automatic work, cancel cancellable work, and drain committed writes, monitor work, mutation-queue releases, persistence, and owned callbacks before releasing ownership. Closing adds no final sync or model request and preserves journals, backups, request accounting, and existing transfer permissions. The next eligible interactive client or explicit command can use singleton startup only after the old owner's exit is proven. Print/JSON never launch a replacement.

The new daemon does not honor retained after-exit grants. `/sync daemon allow-after-exit` reports retirement; `/sync daemon revoke-after-exit` remains available to clear a retained grant. Follow [Ownership and upgrade](#ownership-and-upgrade) if an old owner is still running or a grant blocks the upgrade. Before a downgrade, review and disable legacy automation preferences and clear grants; older builds can still read and act on preserved settings.

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

Ordinary reconnect does not replay a submitted operation or restart startup transfers.
If Pi releases a file queue but the local acknowledgement is lost in transit,
it retries that acknowledgement with the same daemon. Brief retries stay
quiet; longer retries show `sync recovering` when sync status is enabled.
If a background release remains unconfirmed during a command, Pi reports it
after the command finishes.
A release acknowledgement alone does not confirm that a transfer succeeded.
For the manager's explicit **Push to remote** and **Pull from remote** actions, the client first resolves the original job with the same daemon. On an eligible file-queue failure it can then drain that exact owner and reconnect after verifying exit. It never repeats a verified result. It can resume after a proven pre-write failure only once and only when the original setup and source/destination evidence still match. It does not restart an owner that still has other live participating Pi clients, pending work, or unresolved consent or upgrade state. A missing result or conflicting evidence is not permission to replay. If recovery stops after a verified transfer, Pi Sync reports the restore point to the active session. If `/sync daemon status` is blocked by recovery, run it after recovery finishes. This path does not extend transfer or model permission.

## Recover from uncertain daemon cleanup

A pending ignore-rule adoption journal requires the compatible release; the new daemon does not replay it. Use the [manual recovery guide](../skills/configure-pi-sync/references/configuration.md#retired-ignore-file-policy).

**Stop daemon for recovery…** in `/sync` remains a diagnostic fallback when automatic recovery cannot verify cleanup or daemon cleanup blocks initialization. In TUI or RPC, `/sync daemon recover` opens the same
review without starting or upgrading the daemon. The review identifies the
agent directory and PID before requesting permission to stop work for every
Pi session attached to that daemon.

1. Confirm only if the displayed owner is the one you want to stop. Wait for
   Pi Sync to confirm that the daemon exited. Closing the prompt before approval
   does not stop the daemon. After approval, cancellation can leave a stop in
   progress. Reopen the review instead of assuming the daemon is still running
   or has exited.
2. After exit is confirmed, use `/reload` and open `/sync`. If an old operation
   lock remains, follow **Restore sync access…** after verifying that no other
   sync can be active. A replacement does not make an interrupted transfer
   successful: inspect the sync state and reconcile any pending journal before
   retrying a transfer.
3. If the owner cannot be identified or drained, keep the locks, journals, and
   backups. Use the [daemon CLI](#daemon-cli) and the exit checks in
   [manual recovery](#ownership-and-upgrade). If retained unattended permission
   blocks the stop, follow that guide; the in-Pi flow does not revoke permission.

The recovery command does not remove an operation lock or change settings,
consent, or remote data. It does not restart the daemon, reload Pi, or replay an
interrupted operation. Normal startup policy applies again on a separate
`/reload`.

## Diagnostics and rollback

For retired `.syncignore` settings, snapshots, or pending recovery, use `/skill:configure-pi-sync` or the [manual recovery guide](../skills/configure-pi-sync/references/configuration.md#retired-ignore-file-policy). The new daemon does not convert or replay retired records.

If saving consent fails, that service instance blocks automatic work. Uncertain consent publication, failed revocation, or cleanup failure keeps the owner paused and retains evidence; automatic exit or implicit restart must not clear the barrier and restore an older persisted grant. Preserve the retained file, repair persistence, and revoke permission through the existing repair/revocation path before an explicit restart; a failed save does not prove the previous grant changed. Cleanup failure is not a successful exit.

Use the [daemon CLI](#daemon-cli) `status` command without starting a missing service. `stop` drains compatible work. `restart` must not replace an incompatible, unavailable live, or uncertain owner silently. The Pi client must report failure rather than fall back to in-process transfers. If the initial consent check blocked the update before a pending record was created, follow step 1 of [manual recovery](#ownership-and-upgrade); `repair-upgrade` cannot help in that case.

A successful CLI `status` handshake reports an owner-private, bounded lifecycle-log path. Only timestamps and lifecycle phases are retained; no request content, credentials, model output, or exception text is logged. The original cleanup error can distinguish a Pi file-queue acknowledgement from a Pi settings-lock release failure; the generic recovery error means that later work is blocked, not that another release failed. This log is not transaction recovery evidence. It is separate from the [Debug mode log](../skills/configure-pi-sync/references/configuration.md#shared-log) and remains available independently of that preference.

Before rollback:

1. Stop the daemon explicitly and verify owner exit.
2. Close all upgraded clients and retain settings, state, journals, and backups. Archive `pi-sync.log` outside the agent directory before downgrading to a build that may not protect it from sync.
3. Reconcile pending or uncertain publication through the supported engine recovery path.
4. Check consent compatibility before rolling back. A repair can leave `daemon.json` larger than
   65,536 bytes because it keeps all other fields when revoking grants. Builds with the old
   65,536-byte limit cannot read that file. Preserve it and use a build that supports the larger
   file. Do not delete it or restore an older copy to make the rollback work.
5. Check settings compatibility. Version 9 remains after both transfer limits are cleared. Keep a
   compatible owner; do not relabel the document as version 8 or replace it with older bytes to
   bypass the check. Keep journals and backups and verify the local and remote snapshot IDs before
   retrying uncertain work.

Operation retries are instance-bound and deduplicated. An expired result or old instance requires journal reconciliation, not blind replay. A full bounded result ledger requires an explicit drained restart.

## Verification status

The following evidence records the earlier daemon extraction, including its former idle-persistence policy and npm dependency on the standalone daemon. It does not verify the bundled npm artifact or the automatic-exit policy; those require separate runtime verification. Native and production restrictions below remain unchanged.

Completed on disposable roots and synthetic loopback endpoints:

- `npm run format` and `npm run check`: builds, Biome, package boundaries, dependency compatibility, and workspace types.
- `npm test`: 1,035 passing files, one skipped file; 23,291 passing tests, 18 skipped, no failures or unhandled errors; the configured five-second case timeout is unchanged.
- Scoped package workflow and cold build-order regressions; release planning for the former runtime dependency against a simulated registry.
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
| npm/release account owner | Passing package gates and explicit approval; verify publication rights for each selected package, the embedded daemon version in the Pi Sync tarball, and the required Kit artifact | Pi Sync publishes without waiting for a standalone daemon artifact; standalone daemon releases stay independent | No publication, visibility change, tags, or workflow dispatch without approval |
| Device operator | Verified builds and an isolated setup; suspend and wake the target device, then run `/sync daemon status` and `/sync status` in the same Pi session | Both commands work without reload; the daemon and session stay the same | Physical wake timing is not verified by clock-controlled tests; do not claim tested platforms without this check |
| Deployment operator | Verified cutover/recovery evidence and backups; close older Pi processes and authorize each real root | One recognized owner with unchanged compatible data | Only the explicitly approved checkout-service stop/restart was used for package-identity and runtime maintenance; no production-storage transfer or settings change was made, and no real-data cutover is included |
| Native platform maintainer | Prepared transport/process tests; run native Windows/macOS checks | Correct local transport, permissions, independent lifetime, and recovery | Native ACL/named-pipe, logout, and physical power-loss behavior remain unverified; do not advertise new unverified guarantees or silently remove previous support |
| Provider/storage account owner | Explicit cost/network authorization and isolated data; optional live smoke | Authorized dispatch/publication without exposed credentials | Entitlements and custom-provider/production behavior remain unverified; deterministic providers and loopback stores are the default |
