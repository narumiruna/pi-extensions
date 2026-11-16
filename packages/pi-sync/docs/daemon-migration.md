# Daemon migration and release restrictions

This daemon extraction is experimental. Deterministic Linux verification passed, but publication and production cutover remain separate, unauthorized actions. Keep the restrictions below until their owners complete the required checks.

## Ownership and upgrade

The non-extension npm package is `@narumitw/sync-daemon`; its executable remains `sync-daemon`. The namespace change affects npm identity and imports only, not IPC names or settings/state formats. The existing Pi extension remains `@narumitw/pi-sync`, with `/sync` as its user interface. Pi starts or connects to one detached service per canonical agent directory; ordinary Pi shutdown does not stop it. No OS service or supervisor is installed.

Stop the service before updating its package or rebuilding a local checkout: a surviving Node process can otherwise combine cached code with newly loaded modules from the replaced directory. A compatible protocol handshake does not upgrade the running implementation; restart explicitly after installation.

Before the first daemon-owned transfer, close or upgrade every older Pi process and review `/sync daemon handover`. The existing operation lock excludes observed transfers, but an idle older client cannot be detected from an absent lock. Older binaries cannot be made to honor a new handover record retroactively. Do not run an old and new engine as interchangeable writers.

Backend formats, `pi-sync.json`, `pi-sync/`, `.pisync/`, backups, and journals remain owned by the extracted engine. Legacy directory migration remains explicit. Coexisting or unsafe state roots must be reconciled without merging or deleting evidence automatically.

## Lifetime is not consent

Old Continuous consent was limited to an open Pi session. Existing Automatic, Autonomous, and Continuous defaults stay unchanged. The service may remain alive with no clients, but this alone does not authorize a transfer or model request.

`/sync daemon allow-after-exit` reviews extra unattended permission for the current setup and selected standalone-capable model. `/sync daemon revoke-after-exit` stops new unattended work. Setup changes invalidate the persisted digest. Interactive model, working-directory, or session-directory changes durably revoke older grants; returning to the old binding or restarting does not restore them. Independent model availability is checked through public Pi SDK APIs; private extension registrations and parent runtime credentials are not transferred.

Headless print/JSON startup never launches a persistent service. It passively attaches to an existing one to protect its session and pause automatic work. Orderly closed clients retain live-PID file protection without remaining active participants; ambiguous disconnections and replacement gaps remain pauses. Pending recovery needs a configured observable client and reviewed ownership before managed files can be changed. No event automatically reloads resources or changes the model-visible prompt/tool prefix; reload remains an explicit reviewed client action.

## Write coordination and disconnection

The service owns synchronization scheduling and execution, not every writer on the machine. Participating Pi clients hold their actual public file-mutation queues through apply and acknowledge release. A joining client waits to publish its attachment until the current reservation, including nested writes and release acknowledgements, ends; the next transaction includes its queues. This also applies to passive print/JSON startup. Attach waits remain cancellable without an idle timeout that could otherwise bypass this protection during a long apply; shutdown cancels the partial connection instead of waiting for admission. Pi core settings updates use a separate authoritative file lock, which the daemon must also hold. Creating an absent `settings.json` with a live Pi is refused because the Pi missing-file branch does not reread after acquiring its lock.

Protect the union of all registered live-PID sessions, including ambiguously disconnected and orderly retired clients. Retired clients cannot authorize work or hold back zero-client scheduling, but their protection survives another attach and daemon restart until confirmed PID exit. A contact timeout revokes work; it is not permission to overwrite that session or release an acquired mutation grant. An uncertain grant remains quarantined until explicit release or confirmed daemon exit. Unregistered editors, shell commands, older clients, and extensions remain independent writers; preimages, conditional publication, backups, and journal recovery are still required.

## Diagnostics and rollback

If saving consent fails, that service instance blocks automatic work. Preserve the retained file, repair persistence, and revoke permission before an explicit restart; a failed save does not prove the previous grant changed.

Use `sync-daemon status --root <agent-directory>` without starting a missing service. `stop` drains compatible work. `restart` must not replace an incompatible, unavailable live, or uncertain owner silently. The Pi client must report failure rather than fall back to in-process transfers.

CLI `status` includes an owner-private, bounded lifecycle-log path. Only timestamps and lifecycle phases are retained; no request content, credentials, model output, or exception text is logged. This log is not transaction recovery evidence.

Before rollback:

1. Stop the daemon explicitly and verify owner exit.
2. Close all upgraded clients and retain settings, state, journals, and backups.
3. Reconcile pending or uncertain publication through the supported engine recovery path.
4. Only then consider a compatible code/package rollback; do not blindly restore old local or remote bytes.

Operation retries are instance-bound and deduplicated. An expired result or old instance requires journal reconciliation, not blind replay. A full bounded result ledger requires an explicit drained restart.

## Verification status

Completed on disposable roots and synthetic loopback endpoints:

- `npm run format` and `npm run check`: builds, Biome, package boundaries, dependency compatibility, and workspace types.
- `npm test`: 1,033 passing files, one skipped file; 23,271 passing tests, 18 skipped, no failures or unhandled errors; the configured five-second case timeout is unchanged.
- Scoped package workflow and cold build-order regressions; the real Changeset raises the scoped dependency floor and plans a public daemon-first release using a simulated unpublished registry entry.
- Both package-workflow dry packs; inspected real daemon/client tarballs; a fresh independent install with the local daemon tarball and the public SDK resolved in that install scope.
- Standalone import, executable symlink/Help, start/API/stop, package-directory native Jiti loading, lazy `/sync help`, and survival after the installed Pi process exited.
- Production Git preparation without development tools: Kit and daemon runtime JavaScript, exact imports, executable CLI, source-entry Jiti Help, and daemon start/API/stop.
- Actual-daemon typed sync/selection decisions through both command and recovery routing; RPC resolution-menu cancellation without mutation; live-PID protection through detach/exit/pause/replacement gaps, unrelated attach, restart, and confirmed PID exit; parameterized child programs keep data outside executable source. Targeted old-policy negative controls failed, and both regression suites passed after the fixes were restored.
- Seventeen admission/cancellation regressions cover print/JSON/RPC joins during queue grant, apply, and release, nested targets, future cohort coverage, cancelled waiters/attachments, transport disconnection, request timeout policy, partial-connection pause/disposal, hook re-entry, and shutdown; releasing admission early makes twelve cases fail.
- Two actual Pi RPC clients sharing one owner; new/reload/fork/resume/exit; stable provider-visible prompt/message prefix and ordered tools; real loopback S3/WebDAV cancellation; actual Pi file queues and SettingsManager lock branches; native model resolution through command/startup/Continuous/retry/zero-client paths; stale reviews and durable grant revocation across restart.

The semantic audit used `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and both package instruction files. It covered cancellation/disposal/replacement, every owned process/task, callback generations and post-await freshness, settings read/write ordering and failure recovery, unknown/invalid-file preservation, conditional publication/journals, provider capability and post-auth validation, bounded IPC/logs, loading boundaries, and model-prefix stability. The README audit covered 39 active packages and 92 affected local links.

Intentional compatibility limits are explicit: there is no legacy in-process fallback; unsupported parent-only providers remain unavailable; print/JSON do not launch a service but protect sessions in an existing one; a cancelled SDK switch/fork stays paused until reload; arbitrary external writers are not covered by a universal filesystem compare-and-swap. Normal closed clients retain live-PID protection without blocking reviewed zero-client work. No package publication, tag, release dispatch, paid provider request, or production-storage action was performed.

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
| npm/release account owner | Passing package gates and explicit approval; verify publication rights for `@narumitw/sync-daemon` and dependency-first publication | The daemon resolves before the dependent Pi client is released | Scope permissions and first publication are not verified; no publication, visibility change, tags, or workflow dispatch without approval |
| Deployment operator | Verified cutover/recovery evidence and backups; close older Pi processes and authorize each real root | One recognized owner with unchanged compatible data | Only the explicitly approved checkout-service stop/restart was performed for package-identity maintenance; credentials, remotes, and managed data were not inspected or edited, and no real-data cutover is included |
| Native platform maintainer | Prepared transport/process tests; run native Windows/macOS checks | Correct local transport, permissions, independent lifetime, and recovery | Native ACL/named-pipe, logout, and physical power-loss behavior remain unverified; do not advertise new unverified guarantees or silently remove previous support |
| Provider/storage account owner | Explicit cost/network authorization and isolated data; optional live smoke | Authorized dispatch/publication without exposed credentials | Entitlements and custom-provider/production behavior remain unverified; deterministic providers and loopback stores are the default |
