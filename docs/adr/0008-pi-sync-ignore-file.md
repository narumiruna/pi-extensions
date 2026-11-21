# ADR: Pi Sync ignore file

## Status

Proposed. This document describes future behavior, not the current settings or commands.

## Context

Pi Sync currently stores content rules in each setup in `pi-sync.json`. Selected-path setups use `sync.include` and may use `sync.exclude`; agent-directory setups use `sync.exclude` and `sync.reinclude`. Managing paths through those arrays and separate menu editors makes common changes harder than editing one text file. Replacing an allowlist with an ignore file can also expand the set of files sent to a remote, so an upgrade must not switch existing setups silently.

## Decision

### Settings and defaults

Use a single `.gitignore`-style file for path selection in new and migrated setups. Sync starts with eligible files under Pi's active agent directory (normally `~/.pi/agent/`) and skips paths matched by the rules. Keep `pi-sync.json` for setup and storage settings, not the rules themselves.

The proposed per-setup `sync.ignoreFile` field names the local file. Omit it to use `.syncignore`, or set it to another filename in the agent directory. For example, this is a fragment of a setup's `sync` object, not a complete settings document:

```json
{
  "ignoreFile": ".work.syncignore"
}
```

Only a single safe filename is accepted: no directory separators, traversal, absolute paths, or collision with protected files. Read and edit only regular files under the agent directory; do not follow symlinks or read a linked alias of another file. Setups share the default file unless they name different files. There are no project overrides or nested ignore files.

If the default file is absent, use these rules without creating a file on read. An explicit editor save can create the file with these starter rules:

```gitignore
/npm/
/sessions/
/auth.json
/truth.json
```

The leading `/` anchors each rule to the agent directory. An existing file, even an empty one, replaces the starter rules. If an explicitly selected alternative is missing, or the selected file is unreadable, unsafe, invalid UTF-8, or over the supported size limit, stop the operation and show which file to fix. Do not fall back to a broader scope.

`auth.json` and Pi's actual `trust.json` remain protected independently of these rules. `truth.json` is the requested default exclusion, not an alternative name for Pi's trust file. Keep the engine's other hard protections, including Pi Sync settings and state. Keep `.syncignore` and configured alternative ignore files local and out of snapshot payloads. Rules cannot bypass any hard protection. Sessions still require separate opt-in; opting in while `/sessions/` remains in the file does not sync sessions.

### Rule semantics

Use Git ignore pattern semantics for one root file: comments, blank lines, `*`, `?`, ranges, `**`, trailing `/` for directories, and `!` for ordered exceptions. Use `/` as the path separator and match case-sensitively on every device. The last applicable rule wins, but an exception cannot restore a child under an ignored parent. For example, to skip private skill files except one root-level file in that folder:

```gitignore
/skills/private/*
!/skills/private/shared.md
```

Users who sync sessions match their logical `sessions/` paths even if Pi stores those files elsewhere. Ignore rules apply to collection, previews, push, pull, merge, rollback, and automatic work. An ignored local path is not overwritten or deleted; replacing an ancestor is refused if that would remove an ignored descendant. New publications omit ignored paths, but retained snapshots and backups are not erased. Review the selected files before transferring: an ignore file is not a secret scanner.

### Menu and skill

- **`/sync` → Settings → Ignore file** shows the active filename and changes which file the current setup uses. Validate the candidate file before saving the pointer. A user entering a new name can create its starter file first, after explicit confirmation.
- **`/sync` → Settings → Edit ignore rules…** opens the file in Pi's multiline editor. Show the path and warn if other setups use it. Save only after explicit confirmation; cancellation leaves the file unchanged. Show a stale-edit error if the file changed since opening. In non-TUI modes, do not open an editor; RPC can show the path for manual editing.
- Remove **Included paths**, **Excluded paths**, and the legacy rule editor from normal settings. Keep **Compare sync policies** as a read-only comparison and a way into the existing reviewed resolution flow; do not add a new slash-command route.
- Update the bundled `configure-pi-sync` skill to direct path changes to the active ignore file, not JSON arrays. Allow a scoped edit of that text file only when the user explicitly asks for it and the active filename is known; otherwise ask for the filename or direct the user to the editor. Do not read private `pi-sync.json` to discover the filename, change JSON settings, or start a transfer. Explain any scope expansion and the retained-history limitation.

The Pi client owns presentation; the daemon owns validation and persistence for menu saves. Serialize daemon saves and atomically replace the file only if it still matches the reviewed source. External editors, including skill-driven file edits, do not share that lock. Re-read rules for subsequent operations and invalidate pending reviews when either the selected filename or the source bytes change. Saving rules or changing the filename never initiates a transfer by itself.

### Compatibility and migration

- Read existing setups and snapshots with their original semantics until migration. Do not drop old JSON fields, enable directory-wide sync, or reinterpret old globs on upgrade. In the new menu, offer an explicit migration path rather than restoring the removed array editors.
- Show which currently visible local and remote paths would enter or leave scope and warn that a directory-wide policy also applies to files created later. Legacy selected paths and `reinclude` patterns do not always translate exactly; require the user to review the new rules rather than promise a lossless conversion. Preserve the old settings until the new file and settings can be validated. Do not overwrite an existing shared ignore file as a side effect of migrating one setup.
- Use a new settings and snapshot-policy format for migrated setups. Reject unsupported new formats on older clients. In the proposed wire format, publish a versioned fingerprint of the ordered rule policy and session opt-in, not the local filename or rule text. The fingerprint still compares intentions when no matching files exist, but it cannot reconstruct remote rules. Devices reconcile differing rules locally or use the existing reviewed local-policy publication flow; do not silently adopt remote rules.
- Keep authoritative policy mismatches and legacy-to-new transitions out of automatic transfers until the user reviews an explicit direction. Bind operation reviews, automatic authorization, and recovery to the policy used to plan them, and check for stale rules before apply or publication. If the policy changes while recovery is pending, keep the recovery evidence and stop instead of replaying under different rules.

## Consequences

One editable file replaces path arrays and their editors. A setup can use its own file without putting rules next to credentials. The trade-off is that rules are local: the remote can detect a mismatch but cannot populate a new device's ignore file. Migration requires a review because the default scope is broader than a selected-path setup.

## Verification for implementation

| Area | Evidence required |
| --- | --- |
| Patterns and defaults | Table-driven cases checked against Git, including root anchoring, directory-only rules, comments, exceptions, parent pruning, and case behavior. Test missing default, empty file, custom filename, unsafe files, and session and credential protections. |
| Settings and menu | Test no write on load, explicit creation, two setups sharing a file, stale saves, invalid settings, unknown-field preservation, atomic-write failure, and unchanged state on cancellation, disposal, or session replacement. Verify native TUI editing and non-TUI fallback without adding a new command route. |
| Engine and compatibility | Test that a legacy setup is unchanged before migration, mixed versions refuse unsupported policy, and policy mismatch or an edit after review blocks mutation. Verify protected paths across collection, transfer, rollback, automatic work, and recovery; check wire metadata on Git, WebDAV, and S3. |
| Skill and release | Validate skill format and discovery; exercise guidance, explicit file-edit scope, and refusal to touch credentials or run transfers. Update the package README and skill reference when behavior ships. Run `npm run check`, `npm test`, and an isolated Pi package-load smoke. |

## Related decisions

- [Pi Sync v3 settings model](0003-pi-sync-v3-settings-model.md) — existing setup and connection ownership.
- [Portable included-content policy](0004-pi-sync-portable-selection-policy.md) — existing snapshot comparison and adoption behavior.
- [Pi Sync daemon ownership and safety contract](../../packages/pi-sync-daemon/docs/architecture.md) — settings authority and apply safety.
