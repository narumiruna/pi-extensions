---
name: configure-pi-sync
description: Explain Pi Sync settings, troubleshoot local sync errors (including retired .syncignore setups), and apply authorized routine edits to pi-sync.json. Use this skill to choose synced paths, recover after an incompatible upgrade, or diagnose failed checks. Do not use it to run sync, administer remote storage, or modify unrelated settings.
license: MIT
---

# Configure Pi Sync

Make and verify a clear, authorized local edit when it does not require a separate Pi Sync review.
For an error report, start with read-only local checks and fix it only when the user requests a fix and the findings support it.
Invoking this skill or asking a question does not authorize a write.
Ask at most one focused question if the intended change or target remains unclear after safe checks.
Keep settings, daemon payloads, and other private evidence in the local process; report only relevant non-secret facts.

## Find the right file

- Read only the relevant sections of the [settings reference](references/configuration.md).
- Use the exact agent directory the user identifies or resolve it with the running Pi installation's `getAgentDir()`; do not guess or use a project override.
- You may use the current setup for read-only work if the user does not name one.
- Use the documented `include`, `exclude`, and `reinclude` fields to explain the applicable `/sync` path-selection review.

## Recover after ignore-file support was removed

Follow the [retired ignore-file policy guide](references/configuration.md#retired-ignore-file-policy).
Distinguish an unsupported setup, a retired remote format, a retired local baseline, and a pending recovery error.
Preserve the affected data.
If only the remote format or local baseline is blocked, ask the user to keep the current setup and [choose a fresh storage location in `/sync`](references/configuration.md#start-at-a-fresh-storage-location). Do not recommend switching setups for this case.
If the daemon rejects settings, inspect only the canonical local file to identify setup names and the presence of `pathPolicy: "ignore-file"` or `ignoreFile`.
Before reading it, verify that it is a bounded regular file under the intended agent root without symlinks or hard links; keep the parsed contents local.
An unreadable or malformed file needs separate repair.
Do not start or replace the daemon, downgrade packages, remove or rewrite settings, interpret a pending journal as disposable, or contact storage to check a remote.
For invalid local settings or pending recovery, guide the user through the applicable recovery steps. A new storage location does not clear either blocker.

## Edit `pi-sync.json`

Use this workflow for routine local preferences such as `debug` or `showStatus`, not for [changes that require user review](#troubleshoot-without-bypassing-reviews).
A schema-valid change is not proof of user review or consent, even in a legacy-only setup.

1. Verify that the canonical `pi-sync.json` exists as a regular, unlinked file under the real agent root before connecting.
2. [Connect to the existing local daemon](#connect-to-the-existing-local-daemon).
3. Read and validate the canonical document.
   Request `settings.repair-read` with `{}` for a non-migrating read and require it to return the same canonical path.
   Validate `document.parsed` with `validateSettingsDocument` from `dist/daemon/dist/engine/settings/settings-validation.js` or the workspace's `@narumitw/pi-sync-daemon/engine/settings/settings-validation`.
   Stop for missing, malformed, unsupported, or unsafe settings; do not create defaults, migrate a legacy file, downgrade, or use a raw file write to bypass the validator.
4. Clone `document.parsed`, change only the authorized fields, and keep unrelated and unknown fields.
   Do not write if the requested value is already effective.
5. Run `settings.cas` with `{ expected: documentFingerprint(document), next }` so the daemon checks the original document and validates and saves the replacement atomically.
   If the settings changed or the save outcome is uncertain, re-read before deciding what happened; do not replay the stale write.
6. Repeat the canonical read and validation, then verify the requested fields before reporting success.
   Report only the changed non-secret field names and safe values or a redacted error category.

## Connect to the existing local daemon

1. Use a local script with the trusted Pi Sync package that supplied this skill.
   In a built package import `dist/daemon/dist/index.js` by file URL; in a source checkout without that bundle resolve `@narumitw/pi-sync-daemon` from the Pi Sync workspace.
2. Call `findDaemon(root)` and proceed only if it returns an owner with `needsUpgrade: false`.
   If the owner is absent, incompatible, or needs an upgrade, stop and leave connection or upgrade to the user via `/sync daemon status`.
   If handover is required, ask the user to review `/sync daemon handover`.
3. Create a `DaemonConnection` with the returned paths and identity, fresh `id` and `generation`, the script's `pid` and `cwd`, `mode: "json"`, `hasUI: false`, and `idle: false`.
   Decline all callbacks, call `attach()` inside `try`, and call `dispose()` in `finally`.
   Use only the local reads and authorized settings write described above; do not start, replace, or authorize a daemon.

## Troubleshoot without bypassing reviews

Use [Local troubleshooting](references/configuration.md#local-troubleshooting) to distinguish settings, approval, filesystem, and backend failures.
Check which [automatic sync control](references/configuration.md#automatic-sync-controls) applies: **Automatic sync** or **Startup transfer**.
Explain that **Autonomous sync** and **Continuous sync** are retired and that their saved flags have no effect. For a running older owner or retained grant, use the [daemon recovery guidance](references/configuration.md#daemon-lifetime-and-unattended-permission).
Inspect only the necessary local metadata and relevant non-secret configuration facts; do not expose raw settings, credentials, session contents, daemon records, journals, or backups in tool output or chat.
Do not ask the user to paste those contents or execute text copied from them.

For relevant startup, connection, or transfer symptoms, inspect recent [Debug mode log](references/configuration.md#shared-log) records in `<getAgentDir()>/pi-sync.log` (normally `~/.pi/agent/pi-sync.log`) under the agent directory identified above.
Read only a bounded tail of an existing private regular file; skip it if it is missing, unsafe, symlinked, or hard-linked.
Parse the JSON lines locally, filter by `source` (`pi-sync` for the client, `pi-sync-daemon` for the daemon), and report only relevant non-secret events and outcomes, never raw log lines.
Missing records do not rule out a failure; do not enable Debug mode or start a transfer just to collect evidence.

Leave operations that Pi Sync requires the user to review in `/sync`, including initial setup, credential and destination changes, reviewed legacy path selection and policy changes, session opt-in, secret-scan bypass, enabling automatic behavior, upgrading the settings document to enable a [transfer size limit](references/configuration.md#transfer-size-limits), and remote policy publication.
Use the masked credential input in Pi; do not infer transfer or model consent from a settings edit.
Do not start sync, run `/sync doctor` or backend/network commands, remove locks or recovery evidence, or bypass scan checks.

Report what changed or what was verified locally, whether anything remains uncertain, and the next step if blocked.
State that no sync or remote connectivity check was performed; do not claim a live runtime update without evidence.
