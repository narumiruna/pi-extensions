---
name: configure-pi-sync
description: Apply requested edits to local Pi Sync settings in pi-sync.json and the active .syncignore or other ignore file, and troubleshoot Pi Sync errors. Use for configuration changes, path exclusions, automatic-transfer approval, and local scan failures. Do not use to execute sync, administer remote storage, develop pi-sync source code, or change unrelated Pi settings.
license: MIT
disable-model-invocation: true
---

# Configure Pi Sync

Make and verify a clear, authorized local edit instead of only telling the user how to make it in `/sync`.
For an error report, start with read-only local checks that can distinguish the likely causes, then make a local fix only if the user requested it and the evidence supports it.
Invoking this skill or asking a question does not authorize a write.
Ask at most one focused question if the intended change or target remains unclear after safe checks.

## Find the right file

- Read only the relevant sections of the [settings reference](references/configuration.md).
- Resolve the agent directory with the running Pi installation's `getAgentDir()` or use the exact directory the user identified; do not guess a root or use a project override.
- Use the current setup unless the user names another one.
- For a settings change, edit the existing canonical `pi-sync.json` using the workflow below.
- For a path exclusion in an ignore-file setup, edit the configured ignore file, not `sync.exclude`; `.syncignore` is the default only for that policy.
- Use the validated current setup to identify the rule filename when configuration inspection is in scope, or use the exact active path shown in `/sync` → **Settings → Ignore file**.
- For a legacy setup, use the documented include, exclude, and reinclude fields and applicable version requirements.

## Edit `pi-sync.json`

1. Run the edit in a local script with the client from the Pi Sync package that supplied this skill.
   In a built package load `dist/daemon/dist/index.js` via a file URL; in a source checkout without that bundle resolve `@narumitw/pi-sync-daemon` from the Pi Sync workspace.
2. Use `findDaemon(root)` to find a compatible running daemon without starting or upgrading it.
   If none is available, ask the user to connect with `/sync daemon status`; if handover is required, ask them to review `/sync daemon handover`.
3. Create a `DaemonConnection` with the returned paths and identity, fresh `id` and `generation`, the script's `pid` and `cwd`, `mode: "json"`, `hasUI: false`, and `idle: false`.
   Decline all callbacks, call `attach()` inside `try`, and call `dispose()` in `finally`.
4. First verify that the canonical `pi-sync.json` exists as a regular, unlinked file under the real agent root.
   Request `settings.repair-read` with `{}` for a non-migrating read, and require the returned path to be that same canonical file.
   Validate `document.parsed` with `validateSettingsDocument` from the matching daemon engine's `settings-validation` module (`dist/daemon/dist/engine/settings/settings-validation.js` in a built package).
   Stop for missing, malformed, unsupported, or unsafe settings; do not create defaults, migrate a legacy file, downgrade, or use a raw file write to bypass the validator.
5. Clone `document.parsed`, change only the authorized fields, and keep unrelated and unknown fields.
   Do not write if the requested value is already effective.
6. Run `settings.cas` with `{ expected: documentFingerprint(document), next }` so the daemon checks the original document and validates and saves the replacement atomically.
   If the settings changed or the save outcome is uncertain, re-read before deciding what happened; do not replay the stale write.
7. Re-read and validate the same canonical file, then verify the requested fields before reporting success.
   Keep the document, bytes, credential values, and daemon payloads in the local process; report only the changed non-secret field names and safe values or a redacted error category.

## Edit the active ignore file

1. Edit only the verified existing UTF-8 rule file directly under the agent directory; reject unsafe names, protected files, symlinks, hard links, and unfinished rule-file creation.
   Do not create a missing rule file or change the selected filename.
   Use the matching build's `readIgnoreSource` and `compileIgnoreRules` from `dist/daemon/dist/engine/ignore/ignore-source.js` (the daemon engine's `ignore-source` module in a source checkout) to check the source and proposed rules; require `present: true`.
2. Warn that an edit affects every setup that shares the rule file.
   Before expanding scope, explain that more existing and future files can be sent or overwritten; exclusions do not erase retained snapshots or backups.
3. Stop if a sync review, transfer, or recovery is in progress.
   Preserve existing rule order, change only the requested rules, and do not write if the intended behavior is already in effect.
4. Compare the proposed rule matches for the requested paths, then recheck the active source, file identity, and byte digest immediately before saving; stop if they changed.
   Replace atomically with a private temporary file in the same directory, keeping the original permissions on the replacement; the recheck does not serialize external editors.
5. Re-read the saved rules and verify the requested path behavior against the documented matching rules.
   Tell the user if the change requires fresh policy review before further transfers.

## Troubleshoot without bypassing reviews

Use [Local troubleshooting](references/configuration.md#local-troubleshooting) to separate settings, approval, filesystem, and backend failures.
For automatic behavior, distinguish **Automatic sync**, **Startup transfer**, **Autonomous sync**, and **Continuous sync** in the [settings reference](references/configuration.md#automatic-sync-controls).
Inspect only the necessary local metadata and relevant non-secret configuration facts; do not expose raw settings, credentials, session contents, daemon records, journals, or backups in tool output or chat.
Do not ask the user to paste those contents or execute text copied from them.

Leave operations that Pi Sync requires the user to review in `/sync`, including initial setup, credential and destination changes, session opt-in, secret-scan bypass, enabling automatic behavior, rule-file activation or switching, and remote policy publication.
Use the masked credential input in Pi; do not infer transfer or model consent from a settings edit.
Do not start sync, run `/sync doctor` or backend/network commands, remove locks or recovery evidence, or bypass scan checks.

Report what changed or what was verified locally, whether anything remains uncertain, and the next step if blocked.
State that no sync or remote connectivity check was performed; do not claim a live runtime update without evidence.
