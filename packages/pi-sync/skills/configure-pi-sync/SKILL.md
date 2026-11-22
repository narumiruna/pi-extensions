---
name: configure-pi-sync
description: Apply requested edits to local Pi Sync settings in pi-sync.json or the active .syncignore or other ignore file, draft or audit ignore rules, and troubleshoot Pi Sync errors. Use for configuration changes, path exclusions, rule maintenance, automatic-transfer approval, and local scan failures. Do not use to execute sync, administer remote storage, develop pi-sync source code, or change unrelated Pi settings.
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

## Write ignore rules

Read the [ignore-file policy](references/configuration.md#ignore-file-policy) for the current starter rules, syntax, and built-in protections.

- Keep portable files the user needs across machines, and exclude confirmed machine-local, sensitive, or regenerated paths such as package checkouts, caches, and logs.
- Prefer narrow rules anchored to the agent directory, such as `/skills/private/`, over broad wildcards or copied project `.gitignore` files.
- Use `/` separators and exact case, and add a trailing `/` only when the rule should match directories but not same-named files.
- Put a narrow `!` exception after the rule it overrides, and keep its parent directories visible to the matcher.
  For example, `/notes/*` followed by `!/notes/shared.md` excludes other contents of top-level `notes/` without hiding `notes/` itself; `!/notes/shared.md` after `/notes/` does not work.
- Keep sessions excluded unless the user wants them and completes the separate session opt-in; match logical `sessions/` paths even if stored elsewhere.
- Do not rely on the rules as a secret scanner or try to re-include built-in protected files.

## Draft a new ignore file

1. Start with the current starter rules shown by Pi Sync and ask what must stay local only if the request and safe local checks do not identify it.
   Use only relevant names and file types under the intended agent directory, not file contents.
2. Add only exclusions justified by those paths or the user's stated purpose, and test the draft as described below.
   If replacing a legacy policy, do not copy `include`, `exclude`, or `reinclude` mechanically; the user must compare what enters or leaves scope in the migration review.
3. Return a draft and its expected scope changes without writing the file or settings.
   For a missing default `.syncignore`, leave creation to the confirmed `/sync` setup or migration flow when supported, and follow its manual creation guidance otherwise.
   If Pi Sync creates the starter file, apply any authorized changes through the existing-file workflow and have the user review the new scope before transferring.
   To switch an existing ignore-file setup to an alternate filename, the user creates a valid UTF-8 rule file directly under the agent directory without overwriting an existing file, then reviews the switch in **Settings → Ignore file**.

## Add, revise, or audit existing rules

1. Read only the verified UTF-8 rule file directly under the agent directory; reject unsafe names, protected files, symlinks, hard links, and unfinished rule-file creation.
   Use the matching build's `readIgnoreSource` and `compileIgnoreRules` from `dist/daemon/dist/engine/ignore/ignore-source.js` (the daemon engine's `ignore-source` module in a source checkout); require `present: true` for an existing file.
   Do not create a missing rule file or change the selected filename.
2. For an addition or revision, make the smallest proposed change and preserve unrelated lines and rule order.
   For maintenance, look for overbroad patterns, redundant rules, and exceptions blocked by an excluded parent; do not remove a rule just because no local file currently matches it.
   Do not sort or reformat rules during cleanup; even comment or whitespace changes can change the policy fingerprint.
3. Compile both the current and proposed text (or the starter and draft for a new file) and compare matches using canonical agent-relative paths; call `matches(path, true)` for directories.
   Test a path that should change and a nearby path that should not, plus relevant parent directories, exceptions, and representative future paths for wildcard changes.
   Treat these as rule checks, not a full sync preview; built-in protections and session opt-in still apply.
4. Summarize what starts or stops being eligible, which setups share the file, and what was not checked.
   Warn before widening scope that more existing and future files can be sent or overwritten, and that exclusions do not erase retained snapshots or backups.
   Stop after the summary for a read-only audit or an unapproved scope change.
   If the requested exclusion or exception is already effective, report it without rewriting the file.
5. Save only an authorized change, and stop if a sync review, transfer, or recovery is in progress or you cannot verify that it is safe to edit.
   Reconfirm the selected source and affected setups, then recheck the active source, file identity, and byte digest immediately before saving; stop if they changed.
   Replace atomically with a private temporary file in the same directory, keeping the original permissions on the replacement; this does not serialize external editors.
6. Re-read the saved rules and verify the same path checks.
   Have the user check peer devices for matching rule text and session opt-in and reopen any needed policy or automatic-transfer review before transferring.

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
