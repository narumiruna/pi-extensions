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

The Pi client declares this service as a normal dependency; do not add it to `pi.extensions` or load it with `pi -e`. The npm package is `@narumitw/pi-sync-daemon`; the executable is `pi-sync-daemon`. For the previous package and executable names, see the [rename instructions](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#ownership-and-upgrade).

For a local checkout, run from the repository root:

```sh
npm install
npm --workspace @narumitw/pi-sync-daemon run build
```

The build emits JavaScript, declarations, and an executable under `dist/`. A global npm installation is not required for the Pi client to locate its dependency. Registry installation remains blocked until publication rights and the dependency-first release are approved.

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

Existing `pi-sync.json`, canonical `pi-sync/`, and legacy `.pisync/` remain in the selected agent directory. There is no second backend or credential configuration format. The daemon is the authoritative Pi Sync settings writer; stale reviews must reopen rather than overwrite a newer document.

Automatic, Autonomous, and Continuous defaults remain unchanged. Old permission for work while Pi is open does not permit work after the last client exits. `/sync daemon allow-after-exit` reviews that extra permission for the current setup and selected independently reproducible provider/model; `/sync daemon revoke-after-exit` revokes it. Setup changes invalidate the saved digest. Changes to an interactive client’s model, working directory, or session-directory binding revoke older unattended grants, including across restart. Print/JSON never launch a service; passive attachment to an existing service protects their sessions and pauses automatic work. Registered live PIDs keep the service alive, including passive, disconnected, publishing, and orderly retired clients. A valid explicit after-exit grant for the active setup keeps service lifetime under the existing fingerprint and binding rules; it does not expand transfer or model permission. Temporary provider or backend unavailability does not itself revoke that grant. Lifetime checks do not call a model, contact a provider or storage, or execute credential commands. There is no new setting, environment variable, or keep-alive flag.

## 🔒 Security and privacy

IPC uses a private root-bound Unix socket on POSIX or a user/root-bound named pipe on Windows. Requests negotiate protocol, instance, root, and a private capability token. Do not share runtime identity files. The service has the same filesystem and network permissions as your user.

Sync content, session conversations, storage credentials, and conflict evidence can be sensitive. Keep the existing secret scan, session inclusion review, exclusions, backups, and journals. A model receives isolated conflict evidence, not the parent conversation or tools. Parent-only provider registrations and runtime keys are not copied; unavailable capabilities preserve conflicts instead of selecting a fallback.

## 🚧 Limitations

A daemon does not lock every editor or shell command. Cooperating Pi clients reserve their actual public mutation queues; unregistered writers still require freshness checks and can cause safe refusal. Active sessions remain protected when contact is lost but their process is still alive. A heartbeat timeout is not proof of process exit.

Pi core's missing-`settings.json` write branch cannot be made safe with the existing file lock alone. The daemon refuses to create that file while a participating Pi is alive; create it through Pi first. Existing-file writes use the actual Pi settings-file lock.

Close or upgrade every old Pi process before reviewed handover. An absent operation lock does not prove an idle old process is absent. Native Windows/macOS process and permission guarantees require native evidence; see the retained [migration and release restrictions](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md).

## Recovery and development

Automatic exit first stops new automatic work, cancels cancellable work, and drains writes, queue-release acknowledgements, persistence, and owned callbacks before releasing ownership. It adds no final sync or model request. Uncertain consent publication, failed revocation, or cleanup failure keeps the owner paused with evidence retained; automatic restart must not restore an older grant. Repair persistence and use the existing revocation/repair path before explicit restart. The next eligible interactive client or explicit command can restart through singleton startup only after the old owner's exit is proven; print/JSON never launch a replacement.

Stop the service and verify owner exit before an in-place rebuild or rollback. Preserve pending
journals and backups. Rebuilding without changing the package version does not replace the running
owner. See the [daemon upgrade guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#ownership-and-upgrade) for package updates and manual recovery. Do not downgrade over pending/newer recovery evidence or restore old settings over newer bytes. Expired or old-instance operation IDs must reconcile existing journals rather than replay a possible commit. The bounded per-instance result ledger requires an explicit drained restart when full.

CLI `status` reports `recordedPid` from a validated identity file and `pid` only after a verified handshake. A pending upgrade has a separate `pendingUpgradePid`. `running: null` means the handshake failed, with or without a pending upgrade. Unknown status proves neither exit nor compatibility. Use diagnostics from an already available compatible version; if you cannot identify the owner, stop and preserve the records. Status does not expose the IPC token.

A verified handshake also reports the private lifecycle-log path. The log retains at most 8 KiB of timestamps and lifecycle phases, not exception text, credentials, model output, or sync content; older entries roll over. It is diagnostic evidence, not a recovery journal. Child stdio is detached and discarded.

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
