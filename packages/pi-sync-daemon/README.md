# 🔄 @narumitw/pi-sync-daemon — A local synchronization owner

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sync-daemon)](https://www.npmjs.com/package/@narumitw/pi-sync-daemon)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`@narumitw/pi-sync-daemon` runs the existing Pi Sync engine in a separate Node.js process. Pi remains the interface for setup, exact reviews, commands, and live-session integration.

> **Experimental and not release-ready.** Complete the migration and verification gates before using this checkout with real data. This change does not publish the package or verify npm scope permissions. Installation runs code with your user permissions.

## ✨ Features

- One authenticated local owner per canonical agent directory, shared by multiple Pi clients.
- Existing Git, WebDAV, S3, and Cloudflare R2 engine formats and recovery evidence.
- Separate process lifetime, transfer permission, and isolated-model permission.
- Explicit lifecycle control without an OS service, supervisor, database, or public TCP listener.

## 📦 Install

Use Node.js 22.19.0 or later. The [Pi Sync npm package](https://www.npmjs.com/package/@narumitw/pi-sync) includes its own daemon build, so you do not need to install this standalone package to use Pi Sync. To install the standalone CLI:

```sh
npm install --global @narumitw/pi-sync-daemon
```

To try the standalone CLI without installing it globally:

```sh
npm exec --package=@narumitw/pi-sync-daemon -- pi-sync-daemon --help
```

This package is not an extension; do not add it to `pi.extensions` or load it with `pi -e`. See the [daemon CLI guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#daemon-cli) for the previous executable name and for running the copy bundled with Pi Sync.

For a local checkout, run from the repository root:

```sh
npm install
npm --workspace @narumitw/pi-sync-daemon run build
```

The build emits JavaScript, declarations, and the executable `dist/cli.js`.

## 🚀 Quick start

Use an existing disposable directory for the first smoke:

```sh
mkdir -p /tmp/my-pi-sync-daemon-smoke
node packages/pi-sync-daemon/dist/cli.js start --root /tmp/my-pi-sync-daemon-smoke
node packages/pi-sync-daemon/dist/cli.js status --root /tmp/my-pi-sync-daemon-smoke
node packages/pi-sync-daemon/dist/cli.js stop --root /tmp/my-pi-sync-daemon-smoke
```

`start` reuses a compatible owner on the same or a newer build. It stops an older owner and waits
for it to exit before launching the new build, unless the stop cannot be verified or unattended
permission needs review. Connecting alone does not configure a backend or authorize transfers. Use the Pi client's reviewed setup flow for synchronization.

## 💬 Commands

`pi-sync-daemon <start|status|stop|restart|repair-upgrade|serve> --root <agent-directory>` uses an explicit root. `status`, `stop`, and `repair-upgrade` never launch a service. `restart` drains the compatible owner before replacement; an incompatible or unreachable live owner fails closed. `serve` is the internal foreground launch target, not an OS registration command. Use `repair-upgrade` only for a blocked, pending upgrade. It verifies the old owner's exit, revokes all retained unattended grants for the root, and archives the recovery records.

Pi starts the service only after configured interactive synchronization is needed or an explicit setup/command authorizes it. Closing Pi detaches that client; the daemon owns the shared lifetime decision. After no registered live client PID remains for that canonical root, a fixed 30-second grace period starts unless a valid after-exit grant keeps the service running. Explicit CLI `start` without clients follows the same rule. A client arriving before shutdown becomes final cancels automatic exit. `/new`, `/reload`, fork, and resume retain protection while their Pi process is alive. Use `/sync daemon` for status, reviewed old-process handover, and setup-bound unattended authorization.

## ⚙️ Settings

Existing `pi-sync.json`, canonical `pi-sync/`, and legacy `.pisync/` remain in the selected agent directory. There is no second backend or credential configuration format. The daemon is the authoritative Pi Sync settings writer; stale reviews must reopen rather than overwrite a newer document. Settings version 7 and snapshot version 5 support [agent-directory scope](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/skills/configure-pi-sync/references/configuration.md#agent-directory-scope). Older clients must refuse these formats, and existing selected-path setups do not change scope automatically.

Automatic, Autonomous, and Continuous defaults remain unchanged. Old permission for work while Pi is open does not permit work after the last client exits. `/sync daemon allow-after-exit` reviews that extra permission for the current setup and selected independently reproducible provider/model; `/sync daemon revoke-after-exit` revokes it. Setup changes invalidate the saved digest. Changes to an interactive client’s model, working directory, or session-directory binding revoke older unattended grants, including across restart. Print/JSON never launch a service; passive attachment to an existing service protects their sessions and pauses automatic work. Registered live PIDs keep the service alive, including passive, disconnected, publishing, and orderly retired clients. A valid explicit after-exit grant for the active setup keeps service lifetime under the existing fingerprint and binding rules; it does not expand transfer or model permission. Temporary provider or backend unavailability does not itself revoke that grant. Lifetime checks do not call a model, contact a provider or storage, or execute credential commands. There is no new setting, environment variable, or keep-alive flag.

### Debug mode

The daemon reads the top-level `debug` boolean in `pi-sync.json` for its agent directory (`--root` in the CLI). It defaults to `false`. Use **/sync → Settings → Debug mode** in Pi or edit the settings file. The daemon applies the validated value at its next owner, job, or Continuous sync cycle boundary; no restart is needed.

When enabled, the owner appends selected lifecycle, startup timing, job, and Continuous sync records to the private `<agent-directory>/pi-sync.log`. This includes already-authorized work after Pi exits but grants no new permission. Repeated successful unchanged polls do not add records. Filter the JSON lines by `source` to isolate `pi-sync-daemon` records from `pi-sync` client records.

The file is local-only. Records omit raw errors, credentials, addresses, paths, synced contents, and model data. Logging is best effort, not a recovery journal. Turning it off leaves existing records in place; retention is manual. See the [Pi Sync Debug mode reference](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/skills/configure-pi-sync/references/configuration.md#debug-mode) for cleanup and older snapshots.

## 🔒 Security and privacy

IPC uses a private root-bound Unix socket on POSIX or a user/root-bound named pipe on Windows. Requests negotiate protocol, instance, root, and a private capability token. Do not share runtime identity files. The service has the same filesystem and network permissions as your user.

Sync content, session conversations, storage credentials, and conflict evidence can be sensitive. Keep the existing secret scan, session inclusion review, exclusions, backups, and journals. A model receives isolated conflict evidence, not the parent conversation or tools. Parent-only provider registrations and runtime keys are not copied; unavailable capabilities preserve conflicts instead of selecting a fallback.

## 🚧 Limitations

Autonomous conflict resolution requires the host and daemon to agree on the full model definition and independent authentication source. If the daemon rejects a model, align the Pi host and daemon’s bundled catalogs or verify a model with the same definition and auth source on both. Matching IDs alone are not enough. This check does not affect ordinary sync without model resolution.

A daemon does not lock every editor or shell command. Cooperating Pi clients reserve their actual public mutation queues; unregistered writers still require freshness checks and can cause safe refusal. Active sessions remain protected when contact is lost but their process is still alive. A heartbeat timeout is not proof of process exit.

Pi core's missing-`settings.json` write branch cannot be made safe with the existing file lock alone. The daemon refuses to create that file while a participating Pi is alive; create it through Pi first. Existing-file writes use the actual Pi settings-file lock.

Close or upgrade every old Pi process before reviewed handover. An absent operation lock does not prove an idle old process is absent. Native Windows/macOS process and permission guarantees require native evidence; see the retained [migration and release restrictions](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md).

## Recovery and development

Automatic exit first stops new automatic work, cancels cancellable work, and drains writes, queue-release acknowledgements, persistence, and owned callbacks before releasing ownership. It adds no final sync or model request. Uncertain consent publication, failed revocation, or cleanup failure keeps the owner paused with evidence retained; automatic restart must not restore an older grant. Repair persistence and use the existing revocation/repair path before explicit restart. The next eligible interactive client or explicit command can restart through singleton startup only after the old owner's exit is proven; print/JSON never launch a replacement.

The standalone package is versioned and released independently. Updating it does not change the daemon bundled in an installed Pi Sync package. Update Pi Sync to get a newer bundled build.

Stop the service and verify owner exit before an in-place rebuild or rollback. Preserve pending
journals and backups. Rebuilding without changing the package version does not replace the running
owner. See the [daemon upgrade guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#ownership-and-upgrade) for package updates and manual recovery. Do not downgrade over pending/newer recovery evidence or restore old settings over newer bytes. Expired or old-instance operation IDs must reconcile existing journals rather than replay a possible commit. The bounded per-instance result ledger requires an explicit drained restart when full.

CLI `status` reports `recordedPid` from a validated identity file and `pid` only after a verified handshake. A pending upgrade has a separate `pendingUpgradePid`. `running: null` means the handshake failed, with or without a pending upgrade. Unknown status proves neither exit nor compatibility. Use diagnostics from an already available compatible version; if you cannot identify the owner, stop and preserve the records. Status does not expose the IPC token.

Pi Sync's manager can recover eligible file-queue failures in the original Push or Pull action. It does not replay a verified or uncertain write. If automatic recovery cannot verify cleanup, `/sync daemon recover` remains available to review and stop the existing daemon. The client library exposes `inspectDaemonRecovery(root)` and `stopDaemonForRecovery(target)` for that flow. Inspection does not start the daemon. A successful stop verifies identity release and process exit without starting a replacement. Keep recovery evidence and follow the [cleanup recovery guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#recover-from-uncertain-daemon-cleanup) if the stop cannot be verified.

A verified handshake also reports the private operational `lifecycle.log` path. This log is separate from `pi-sync.log` and is not controlled by Debug mode. It retains at most 8 KiB of timestamps and lifecycle phases, not exception text, credentials, model output, or sync content; older entries roll over. It is diagnostic evidence, not a recovery journal. Child stdio is detached and discarded.

The source-linked [architecture and safety contract](docs/architecture.md) defines ownership, resolver capability checks, write coordination, and the decision matrix. It distinguishes required checks from completed evidence.

## 🗂️ Package layout

- `src/`: lightweight public client, Node CLI, private IPC, service host, and extracted engine.
- `dist/`: emitted JavaScript and declarations published to npm.
- `docs/`: architecture, protocol, ownership, and safety guidance.
- `test/`: deterministic API, process, provider, and failure tests; not published.

## 🔎 Keywords

Pi, synchronization, daemon, local IPC, TypeScript, Git, WebDAV, S3, Cloudflare R2, conflict resolution.

## 📄 License

[MIT](LICENSE).
