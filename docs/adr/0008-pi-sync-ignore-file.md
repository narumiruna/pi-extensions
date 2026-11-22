# ADR: Pi Sync ignore file

## Status

Activation candidate. The contract below does not establish release readiness. Enable the production capability only with passing activation gates for the built Pi client and daemon. In-app rule-file saves are out of scope.

## Context

Pi Sync currently stores content rules in each setup in `pi-sync.json`. Selected-path setups use `sync.include` and may use `sync.exclude`; agent-directory setups use `sync.exclude` and `sync.reinclude`. Managing paths through those arrays and separate menu editors makes common changes harder than editing one text file. Replacing an allowlist with an ignore file can also expand the set of files sent to a remote, so an upgrade must not switch existing setups silently.

## Decision

### Settings and defaults

Use a single `.gitignore`-style file for path selection in new and migrated setups. Sync starts with eligible files under Pi's active agent directory (normally `~/.pi/agent/`) and skips paths matched by the rules. Keep `pi-sync.json` for setup and storage settings, not the rules themselves.

The per-setup `sync.ignoreFile` field names the local file. Omit it to use `.syncignore`, or set it to another filename in the agent directory. For example, this is a fragment of a setup's `sync` object, not a complete settings document:

```json
{
  "ignoreFile": ".work.syncignore"
}
```

Only a single safe filename is accepted: no directory separators, traversal, absolute paths, or collision with protected files. Read and edit only regular files under the agent directory; do not follow symlinks or read a linked alias of another file. Setups share the default file unless they name different files. There are no project overrides or nested ignore files.

When the user confirms a new setup or migration, Pi Sync attempts to create a missing `.syncignore` on Linux, macOS, and Windows. If automatic creation is unavailable on the filesystem, show the exact file path and starter rules. Ask the user to create a regular UTF-8 file there, then reopen the policy review. Do not save the setup or policy until the file is ready and the user confirms. Opening Pi Sync, reading settings, and upgrading a legacy setup do not create the file. Read-only previews can use these starter rules in memory while the default file is absent:

```gitignore
/npm/
/sessions/
/auth.json
/truth.json
```

The leading `/` anchors each rule to the agent directory. Never overwrite a pre-existing file during initialization. An existing file, even an empty one, replaces the starter rules unless there is an unfinished creation record. Write and flush the creation record before opening the absent path exclusively, then flush and verify the resulting file before clearing the record. Use a verified directory handle when it can address child files; otherwise check the canonical directory and file identities around path-based operations. Flush directory metadata where supported. Where it cannot be flushed, this protects against process interruption, not physical power loss. If the exclusive open reports a competing file, preserve that file and clear only the verified record from this attempt. After a crash, the record may not establish who opened the target. Keep that evidence and stop work that depends on the file until it is verified or repaired. Do not activate the new setup or policy while creation is incomplete. If the user cancels after the exclusive open succeeds, finish and verify the starter write before reporting cancellation. The verified starter may remain, but the settings stay unchanged. If verification fails, retain the creation record. If an explicitly selected alternative is missing, or the selected file is unreadable, unsafe, invalid UTF-8, or over the supported size limit, stop the operation and show which file to fix. Do not fall back to a broader scope.

`auth.json` and Pi's actual `trust.json` remain protected independently of these rules. `truth.json` is the requested default exclusion, not an alternative name for Pi's trust file. Keep the engine's other hard protections, including Pi Sync settings and state. Keep `.syncignore` and configured alternative ignore files local and out of snapshot payloads. Rules cannot bypass any hard protection. Sessions still require separate opt-in; opting in while `/sessions/` remains in the file does not sync sessions.

### Rule semantics

Use Git ignore pattern semantics for one root file: comments, blank lines, `*`, `?`, ranges, `**`, trailing `/` for directories, and `!` for ordered exceptions. Use `/` as the path separator and match case-sensitively on every device. The last applicable rule wins, but an exception cannot restore a child under an ignored parent. For example, to skip private skill files except one root-level file in that folder:

```gitignore
/skills/private/*
!/skills/private/shared.md
```

Pi Sync rejects an escaped `/` separator. Use `private/note.txt` instead of Git's `private\/note.txt`.

Users who sync sessions match their logical `sessions/` paths even if Pi stores those files elsewhere. Ignore rules apply to collection, previews, push, pull, merge, rollback, and automatic work. An ignored local path is not overwritten or deleted; replacing an ancestor is refused if that would remove an ignored descendant. New publications omit ignored paths, but retained snapshots and backups are not erased. Review the selected files before transferring: an ignore file is not a secret scanner.

### Menu and skill

- **`/sync` → Settings → Ignore file** shows the active filename and lets the user choose a different, existing file. Validate it before saving the pointer. This row does not create files.
- Edit existing rule files manually. Show the configured path in Settings, including RPC guidance, and warn that manual edits apply to every setup using the file. Do not show an editor or save dialog.
- Legacy setups keep their existing path controls. Keep **Compare sync policies** as a read-only comparison and a way into the existing reviewed resolution flow; do not add a slash-command route.
- The bundled `configure-pi-sync` skill may make a scoped edit only when explicitly requested and the active local rule file is known. Otherwise ask for the filename shown in Settings or give guidance. Do not read or write private settings or remote data. Explain scope expansion and retained history.

The Pi client owns presentation; the daemon owns validation and settings persistence. Keep in-app rule saves disabled until the daemon can atomically replace the rule file only if it still matches the reviewed source. A file check followed by rename cannot protect against external editors, including skill-driven file edits, because they do not share the daemon lock. Until then, show the existing rule file path for manual editing. Re-read rules for subsequent operations and invalidate pending reviews when either the selected filename or the source bytes change. Saving rules or changing the filename never initiates a transfer by itself.

### Compatibility and migration

- Read existing setups and snapshots with their original semantics until migration. Do not drop old JSON fields, enable directory-wide sync, or reinterpret old globs on upgrade.
- After upgrading to a release that enables ignore files, show a prompt the first time the user opens the `/sync` manager in TUI mode with an eligible legacy setup. Offer **Review migration now** and **Not now**. The first choice opens the existing migration review for the current setup; only confirmation in that review may migrate it. **Not now** keeps the old policy and suppresses the prompt for that setup across reloads and restarts. Dismissing the prompt without a choice keeps the old policy and leaves the prompt eligible on the next manager open. Do not prompt at Pi startup or during background sync. Keep **Settings → Migrate to ignore file…** available for an explicit migration later.
- Show which currently visible local and remote paths would enter or leave scope and warn that a directory-wide policy also applies to files created later. Legacy selected paths and `reinclude` patterns do not always translate exactly; require the user to review the new rules rather than promise a lossless conversion. Preserve the old settings until the new file and settings can be validated. Do not overwrite an existing shared ignore file as a side effect of migrating one setup.
- Keep the existing daemon settings installation and replacement mechanism: private same-directory temporary file and rename under the shared lock, with current-source validation and unknown-field preservation. First setup can save an absent document through this writer. Reviewed migration and switching require existing canonical `pi-sync.json` and do not promote `pi-sync.local.json`. The lock does not serialize noncooperating external writers.
- Version 8 settings can hold legacy and ignore-file setups. Upgrade peers before the first version 6 snapshot publication; older readers refuse unsupported formats without applying them. Publish a versioned fingerprint of the ordered rule policy and session opt-in, not the local filename or rule text. The fingerprint still compares intentions when no matching files exist, but it cannot reconstruct remote rules. Devices reconcile differing rules locally or use the existing reviewed local-policy publication flow; do not silently adopt remote rules.
- Saving, migrating, switching a rule file, or editing rules neither starts nor authorizes transfer. Keep authoritative policy mismatches and legacy-to-new transitions out of automatic transfers until the user reviews an explicit direction. `--yes` cannot bypass policy review. An absent default can inform preview but cannot authorize transfer. Bind operation reviews, automatic authorization, and recovery to the policy used to plan them, and check for stale rules before apply or publication. If the policy changes while recovery is pending, keep the recovery evidence and stop instead of replaying under different rules.

## Consequences

One editable file replaces path arrays and their editors. A setup can use its own file without putting rules next to credentials. The trade-off is that rules are local: the remote can detect a mismatch but cannot populate a new device's ignore file. Migration requires a review because the default scope is broader than a selected-path setup.

## Recovery

Until settings commit, the old policy is authoritative. A verified starter or private settings backup can remain after a late failure. Preserve creation markers, journals, backups, consent records, and the exact local rule source when evidence is uncertain. Recover with the compatible daemon and the originating setup; a changed source is not permission to replay or discard a journal. After a version 6 publication, a package downgrade alone is not rollback. Stop incompatible clients and verify daemon exit before a separately reviewed restoration of compatible settings and remote state. Do not bypass recovery by changing the remote head or deleting history.

## Verification required for activation

| Area | Evidence required |
| --- | --- |
| Patterns and defaults | Table-driven cases checked against Git, including root anchoring, directory-only rules, comments, exceptions, parent pruning, and case behavior. Test missing default, empty file, custom filename, unsafe files, and session and credential protections. |
| Settings and menu | Test no write on load, automatic creation after confirmation on supported platforms, manual-required guidance and reviewed retry, no overwrite of a concurrent creation, and refusal to use a partially written file after restart. Distinguish native and deterministic evidence. Verify Settings path guidance in TUI and RPC without an editor or save dialog. Test invalid settings and unknown-field preservation. Test the first-open migration prompt, persistent **Not now**, dismissal and cancelled review, no prompt at startup or in non-TUI modes, and unchanged sync policy until confirmed. |
| Engine and compatibility | Test that a legacy setup is unchanged before migration, mixed versions refuse unsupported policy, and policy mismatch or an edit after review blocks mutation. Verify protected paths across collection, transfer, rollback, automatic work, and recovery; check wire metadata on Git, WebDAV, and S3. |
| Skill and release | Validate skill format and discovery; exercise guidance, explicit file-edit scope, and refusal to touch credentials or run transfers. Run `npm run check`, `npm test`, README validation, and both package pack checks. Exercise a built Pi/Jiti and daemon round trip with separate agent roots and a loopback destination, including scope, cancellation, changed rules, and incompatible readers. Check Git, WebDAV, and S3 behavior and inspect the payload. No readiness claim without evidence from the activation candidate. |

## Related decisions

- [Pi Sync v3 settings model](0003-pi-sync-v3-settings-model.md) — existing setup and connection ownership.
- [Portable included-content policy](0004-pi-sync-portable-selection-policy.md) — existing snapshot comparison and adoption behavior.
- [Pi Sync daemon ownership and safety contract](../../packages/pi-sync-daemon/docs/architecture.md) — settings authority and apply safety.
