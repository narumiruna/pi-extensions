---
name: configure-pi-sync
description: Apply requested edits to pi-sync.json or the active ignore file, usually .syncignore. Draft or audit ignore rules and troubleshoot Pi Sync errors, including automatic-transfer approval and local scan failures. Do not use to execute sync, administer remote storage, develop pi-sync source code, or change unrelated Pi settings.
license: MIT
disable-model-invocation: true
---

# Configure Pi Sync

Make and verify a clear, authorized local edit instead of only telling the user how to make it in `/sync`.
For an error report, start with read-only local checks to narrow the cause.
Fix it only when the user requests a fix and the findings support it.
Invoking this skill or asking a question does not authorize a write.
Ask at most one focused question if the intended change or target remains unclear after safe checks.

## Find the right file

- Read only the relevant sections of the [settings reference](references/configuration.md).
- Use the exact agent directory the user identifies or resolve it with the running Pi installation's `getAgentDir()`; do not guess or use a project override.
- Use the current setup unless the user names another one.
- For a settings change, follow [Edit `pi-sync.json`](#edit-pi-syncjson) for the existing canonical file.
- For exclusions in an ignore-file setup, edit the configured ignore file, not `sync.exclude`.
  `.syncignore` is the default only for that policy.
  Use the filename from the validated setup when configuration inspection is in scope, or use the exact active path shown in `/sync` → **Settings → Ignore file**.
- For a legacy setup, follow the documented `include`, `exclude`, and `reinclude` fields and version requirements.

## Edit `pi-sync.json`

1. Run the edit in a local script with the client from the Pi Sync package that supplied this skill.
   In a built package load `dist/daemon/dist/index.js` via a file URL; in a source checkout without that bundle resolve `@narumitw/pi-sync-daemon` from the Pi Sync workspace.
2. Use `findDaemon(root)` to find a compatible running daemon without starting or upgrading it.
   If none is available, ask the user to connect with `/sync daemon status`.
   If handover is required, ask the user to review `/sync daemon handover`.
3. Create a `DaemonConnection` with the returned paths and identity, fresh `id` and `generation`, the script's `pid` and `cwd`, `mode: "json"`, `hasUI: false`, and `idle: false`.
   Decline all callbacks, call `attach()` inside `try`, and call `dispose()` in `finally`.
4. First verify that the canonical `pi-sync.json` exists as a regular, unlinked file under the real agent root.
   Request `settings.repair-read` with `{}` for a non-migrating read and require it to return the same canonical path.
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
- Use `/` separators and match the path's case exactly.
  Add a trailing `/` only to match directories rather than same-named files.
- Put a narrow `!` exception after the rule it overrides and make sure no parent directory remains excluded.
  Use `/notes/*` followed by `!/notes/shared.md` to exclude the other contents of top-level `notes/`.
  Using `/notes/` instead excludes the parent directory and blocks the exception.
- Keep sessions excluded unless the user wants them and completes the separate session opt-in; match logical `sessions/` paths even if stored elsewhere.
- Do not rely on the rules as a secret scanner or try to re-include built-in protected files.

## Draft a new ignore file

1. Start with Pi Sync's current starter rules.
   Use only relevant names and file types under the intended agent directory, not file contents.
   Ask what must stay local only if the request and these checks do not answer it.
2. Add only exclusions justified by those paths or the user's goal, then [check the draft against the starter rules](#check-ignore-rules).
   Do not copy legacy `include`, `exclude`, or `reinclude` rules mechanically.
   The user must review what enters or leaves scope when migrating.
3. Return the draft and its expected scope changes without writing the file or settings.
   - For a missing default `.syncignore`, the user confirms creation in `/sync` setup or migration, or follows its manual creation guidance if automatic creation is unavailable.
   - If Pi Sync creates the starter file, [apply only authorized changes](#add-revise-or-audit-existing-rules) and have the user review the new scope before transferring.
   - To switch an existing ignore-file setup, the user creates a valid UTF-8 rule file directly under the agent directory without overwriting an existing file, then reviews the switch in **Settings → Ignore file**.

## Add, revise, or audit existing rules

1. Use `readIgnoreSource` from the matching [ignore-source module](#check-ignore-rules) and require `present: true`.
   Read only the verified UTF-8 rule file directly under the agent directory.
   Reject unsafe names, protected files, symlinks, hard links, and unfinished rule-file creation.
   Do not create a missing rule file or change the selected filename.
2. Propose the smallest change that meets the request, preserving unrelated lines and rule order.
   Look for broad patterns, redundant rules, and exceptions blocked by an excluded parent.
   A rule can still matter if no local file matches it today.
   Do not sort or reformat rules during cleanup: even a comment or whitespace change can change the policy fingerprint.
3. [Check the rule matches](#check-ignore-rules) and summarize what enters or leaves scope, which setups share the file, and what you did not check.
   Before widening scope, warn that more existing and future files can be sent or overwritten.
   Exclusions do not erase retained snapshots or backups.
   Stop after the summary for a read-only audit or an unapproved scope change.
   If the requested exclusion or exception already works, report it without rewriting the file.
4. Save only an authorized change when you can verify that no sync review, transfer, or recovery is in progress and the file is safe to edit.
   Reconfirm which setups share the file, then recheck the active source, file identity, and byte digest immediately before saving.
   Stop if anything changed.
   Replace the file atomically using a private temporary file in the same directory and preserve the original permissions.
   This recheck does not serialize external editors.
5. Re-read the saved rules and repeat the path checks.
   Before transferring, the user checks that peers have the same rule text and session opt-in, and reopens any required policy or automatic-transfer review.

## Check ignore rules

Use `compileIgnoreRules` from the matching build's `dist/daemon/dist/engine/ignore/ignore-source.js` or the daemon engine's `ignore-source` module in a source checkout.
Compile the current and proposed rules, or the starter rules and draft for a new file.
Compare matches on canonical agent-relative paths, passing `true` as the second argument (`matches(path, true)`) for directories.
Test a path that should change, a nearby path that should not, and any relevant parents and exceptions.
For wildcard changes, also test representative future paths.
These checks cover rule matching, not the full sync scope: built-in protections and session opt-in still apply.

## Troubleshoot without bypassing reviews

Use [Local troubleshooting](references/configuration.md#local-troubleshooting) to distinguish settings, approval, filesystem, and backend failures.
Check which [automatic sync control](references/configuration.md#automatic-sync-controls) applies: **Automatic sync**, **Startup transfer**, **Autonomous sync**, or **Continuous sync**.
Inspect only the necessary local metadata and relevant non-secret configuration facts; do not expose raw settings, credentials, session contents, daemon records, journals, or backups in tool output or chat.
Do not ask the user to paste those contents or execute text copied from them.

Leave operations that Pi Sync requires the user to review in `/sync`, including initial setup, credential and destination changes, session opt-in, secret-scan bypass, enabling automatic behavior, rule-file activation or switching, and remote policy publication.
Use the masked credential input in Pi; do not infer transfer or model consent from a settings edit.
Do not start sync, run `/sync doctor` or backend/network commands, remove locks or recovery evidence, or bypass scan checks.

Report what changed or what was verified locally, whether anything remains uncertain, and the next step if blocked.
State that no sync or remote connectivity check was performed; do not claim a live runtime update without evidence.
