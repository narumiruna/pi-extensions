---
name: configure-pi-sync
description: Apply authorized local edits to pi-sync.json or the configured ignore file (usually .syncignore). Draft, add, revise, or audit ignore rules, guide Sync mode or advanced settings, and troubleshoot Pi Sync errors such as missing approval or failed scans. Do not use to execute sync, grant consent, administer remote storage, develop pi-sync source code, or change unrelated Pi settings.
license: MIT
disable-model-invocation: true
---

# Configure Pi Sync

Make and verify a clear, authorized local edit when it does not require a separate Pi Sync review.
For an error report, start with read-only local checks and fix it only when the user requests a fix and the findings support it.
Invoking this skill or asking a question does not authorize a write.
Ask at most one focused question if the intended change or target remains unclear after safe checks.
Keep settings, rule-file contents, daemon payloads, and other private evidence in the local process; report only relevant non-secret facts.

## Find the right file

- Read only the relevant sections of the [settings reference](references/configuration.md).
- Use the exact agent directory the user identifies or resolve it with the running Pi installation's `getAgentDir()`; do not guess or use a project override.
- You may use the current setup for read-only work if the user does not name one.
- Ask the user to name the exact setup before editing an ignore file; never write based only on `activeSyncSetup`.
  If the edit must apply only while the setup remains current, explain that the local workflow cannot guarantee that condition and do not write.
- For a settings change, follow [Edit `pi-sync.json`](#edit-pi-syncjson) for the existing canonical file.
- For exclusions in an ignore-file setup, edit the configured ignore file, not `sync.exclude`.
  `.syncignore` is the default only for that policy.
  Use the filename from the validated setup when configuration inspection is in scope, or use the exact path shown for that setup in `/sync` → **Settings → Ignore file**.
- For a legacy setup, use the documented `include`, `exclude`, and `reinclude` fields and version requirements to explain the applicable `/sync` path-selection review.

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

## Guide Sync mode and advanced settings

- For everyday use, direct the user to `/sync` → **Settings → Sync mode** in TUI. New setups start in **Manual**. Help the user review **Automatic** before they choose it: the daemon can replace or delete selected local and remote files and send supported conflict evidence to the selected model provider at a cost. **Custom** describes other saved combinations; it is not a mode choice.
- If the user wants an advanced combination, read [Advanced combinations](references/configuration.md#advanced-combinations). Inspect only the needed local facts and prepare the smallest proposed edit for the named setup, without applying it. Explain which behaviors it changes: legacy observation or shutdown push, startup transfer, **Autonomous sync**, or **Continuous sync**. Explain when the flags could take effect, which files or destination they affect, and whether the change permits model requests. Never write these flags or confirm a mode change for the user.
- Distinguish an edit from consent. In a legacy-only document, saved flags may take effect without the mixed-catalog approval gate; do not use that as a shortcut to enable them. If any setup uses an ignore file, separate connected approval is required even for a legacy setup. The user makes the target setup current and chooses **Review current policy…** inside **Sync mode** when offered. It does not change the saved flags. If approval fails after a save, report that the mode can be saved while automatic work remains blocked; ask the user to verify the displayed state rather than retrying a stale change.
- Leave transfer, model, and after-exit permission to the user. A mode choice or connected approval does not grant after-exit work. Do not call consent operations or invoke a transfer to verify a setting.

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

1. [Connect to the existing local daemon](#connect-to-the-existing-local-daemon) and run `ignore.read` with `{ setup: setupName }` for the selected setup.
   This resolves the configured path and sharing setups, validates the file, and checks for a live session at that path.
   Require a verified path directly under the agent directory that matches the selected setup.
   Require a result with `text`, `identity`, and `sourceDigest`; a location-only result means the file is missing.
   Reject unsafe names, protected files, symlinks, hard links, and unfinished rule-file creation.
   Do not create a missing rule file or change the selected filename.
   If the daemon cannot verify the source, check only a user-provided draft rather than reading or editing an unverified active file.
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
   A connected daemon or an absent lock does not prove that work is idle.
   If local evidence is insufficient, ask the user to confirm that no review, transfer, recovery, or other edit is in progress and automatic work will not run during the edit.
   Leave the file unchanged if you cannot establish these conditions.
   Create a private temporary file exclusively in the same directory and stage the validated replacement there.
   Immediately before atomic replacement, repeat `ignore.read` for the same user-named setup and recheck its path, sharing setups, file identity, byte digest, and original file permissions.
   Preserve the original permissions on the replacement.
   Stop and remove only the temporary file you own if anything changed or the recheck fails.
   The recheck does not serialize other writers; do not use `ignore.save` or retry an uncertain replacement without re-reading.
5. Re-read the saved rules with `ignore.read`, verify the saved text, and repeat the path checks.
   Before transferring, the user checks that peers have the same rule text and session opt-in. If connected approval is needed, the user opens **Sync mode → Review current policy…**; a remote policy change still needs its own directional review.

## Check ignore rules

Use `compileIgnoreRules` from the skill's matching `dist/daemon/dist/engine/ignore/ignore-source.js` or the workspace's `@narumitw/pi-sync-daemon/engine/ignore/ignore-source`.
Compile the current and proposed rules, or the starter rules and draft for a new file.
Compare matches on canonical agent-relative paths, passing `true` as the second argument (`matches(path, true)`) for directories.
Test a path that should change, a nearby path that should not, and any relevant parents and exceptions.
For wildcard changes, also test representative future paths.
These checks cover rule matching, not the full sync scope: built-in protections and session opt-in still apply.

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
For automatic work, use [Sync mode and approval](references/configuration.md#automatic-sync-controls) to distinguish the saved mode, missing policy approval, and a safety or readiness block.
Inspect only the necessary local metadata and relevant non-secret configuration facts; do not expose raw settings, credentials, session contents, daemon records, journals, or backups in tool output or chat.
Do not ask the user to paste those contents or execute text copied from them.

Leave operations that Pi Sync requires the user to review in `/sync`, including initial setup, credential and destination changes, reviewed legacy path selection and policy changes, session opt-in, secret-scan bypass, enabling automatic behavior, rule-file activation or switching, and remote policy publication.
Direct the user to the masked credential input in Pi; do not infer transfer or model consent from a settings edit.
Do not start sync, run `/sync doctor` or backend/network commands, remove locks or recovery evidence, or bypass scan checks.

Report what changed or what was verified locally, whether anything remains uncertain, and the next step if blocked.
State that no sync or remote connectivity check was performed; do not claim a live runtime update without evidence.
