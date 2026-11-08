# Migrate to Pi Files

Pi Files replaces the repository's File Context and Edit Scope implementations with one owner. **Never load `pi-files` together with `pi-file-context` or `pi-edit-scope`.** Duplicate aliases, shortcuts, and guard handlers are not a coordination mechanism; load order cannot make co-loading safe.

Repository retirement is approved. This does not authorize first publication, npm visibility changes, tags, release workflow dispatch, or npm deprecation notices. The read-only `@narumitw/pi-files` metadata query returned `E404` during implementation; Pi Files is not yet published. Use the local build until a release is explicitly approved.

## Prepare

1. Stop the current run and clear pending messages before changing permissions or resources. Record the complete scope target list and whether scope is active or blocked.
2. Review the context queue. Submit or explicitly remove its snapshots before reload; they are intentionally in-memory only and are not migrated or restored from disk. Do not disable a restriction merely to perform migration.
3. Record loaded extension sources in both Pi install scopes. Use `pi list` and inspect personal `settings.json` under `getAgentDir()` (normally `~/.pi/agent`) and trusted project `.pi/settings.json`. Also check explicit `-e` arguments, source paths, repository resource filters, and auto-discovered extension files.
4. Preserve both existing user settings files and a copy of the verification session. Do not rename files, rewrite entry IDs, delete scope state, or remove notices to make recovery appear successful.

Extensions still run with full user permissions. The [native stock-tool boundary](../README.md#-security-and-privacy) is not expanded by the merge, and the user-controlled external editor remains outside the guard.

## Replace installed resources

Personal and project managed npm roots are separate installation scopes. Deduplication within one root does not uninstall or disable another scope's resources. Different source identities, copied files, or explicit CLI resources can still expose a predecessor. A root manifest change cannot remove those installations.

Remove or disable every predecessor resource **before loading the successor**, then reload or restart once the resource set is coherent. Removal changes package/resource registration, not extension-owned settings or session state.

For npm sources matching these examples, remove personal registrations:

```bash
pi remove npm:@narumitw/pi-file-context
pi remove npm:@narumitw/pi-edit-scope
```

From each affected project, remove project registrations independently:

```bash
pi remove --local npm:@narumitw/pi-file-context
pi remove --local npm:@narumitw/pi-edit-scope
```

Use the exact recorded source if an installation uses another path, Git source, or version specification. Do not assume these example commands cover a local copy, a package resource filter, or an explicit `-e` argument. Inspect both scopes after removal.

If a predecessor must remain installed for reference, disable all its extension resources instead. For a package declaration, an `extensions: []` filter loads none of that package's extensions. Apply filtering in the scope that owns the declaration and preserve unrelated resources. Remove old entrypoint selections from Git-repository filters; add `packages/pi-files/src/index.ts` if selecting the successor. Filters only narrow declared resources, so an old pinned repository revision without the successor must be updated first.

Move auto-discovered predecessor extension files outside discovery roots, remove their explicit resource paths, or disable them through Pi's resource configuration. Remove predecessor `-e` arguments from launch scripts. Do not use duplicate command suffixes, shortcut precedence, or one blocking guard to hide a still-loaded predecessor.

The current repository root manifest replaces both predecessor source entries with `./packages/pi-files/src/index.ts`. The archived trees under `deprecated/` are references, excluded from active workspaces and the default root entrypoint list. Installing this repository still enables its other declared extensions unless filtered.

## Build and load the local successor

From the repository root, with predecessor resources removed or disabled:

```bash
npm install
npm run build
pi -e ./packages/pi-files
```

The root build supplies Pi TUI Kit and generates the successor's `dist/index.ts`. Package-directory loading requires this build; its generated entry does not import back into `src`. Pi's bundled peers stay external. Local loading does not require a published Pi Files package, but dependency installation still requires registry access or an adequate npm cache; this is not a promise of an air-gapped install.

For later sessions, choose the intended registration scope:

1. Personal installation, from the repository root:

   ```bash
   pi install ./packages/pi-files
   ```

2. Project installation instead, from each affected project directory:

   ```bash
   pi install --local /absolute/path/to/pi-extensions/packages/pi-files
   ```

   Replace the example path with the built checkout path. The current directory selects which project receives the registration; it does not need to be the checkout.

Choose one intended registration rather than loading the same checkout by several paths. Restart Pi or run `/reload` after changing resources. Settings and durable scope restore; queued context does not. Do not send built-in `/reload` as an RPC prompt command, where it can become model input.

## What stays compatible

| Area | Preserved behavior |
| --- | --- |
| Commands | `/file-context [browse\|remove]` keeps the dedicated context workflow; `/edit-scope`, `/scope`, and their `off` routes keep the dedicated scope workflow. `/files` adds the common manager, `browse`, and `off`. |
| Context | Exact snapshots, order, limits, Git provenance, whole-file references, and one-time attachment retain their format. The `file-context-quotes` identity remains unchanged. Custom-triggered turns do not consume the queue. |
| Scope state | `scope-state`, `scope-contract`, and `scope-context-anchor`, snapshot version 1, original entry IDs, state references, and historical notice bytes remain unchanged. |
| Recovery | The active branch restores after reload, resume, fork, tree navigation, and compaction as applicable. Invalid or uncertain state stays blocked until repaired or explicitly ended. |
| Settings | `openShortcut` remains in `<getAgentDir()>/pi-file-context.json`; `showHiddenFiles` remains in `<getAgentDir()>/pi-scope.json`. Unknown fields and existing values are preserved. |
| Defaults | Browser shortcut is `ctrl+shift+x`; hidden scope discovery defaults to `false`. Settings remain user-only. |

The settings basenames and historical `Scope` / `/scope` notice text are deliberate compatibility exceptions. There is no `pi-files.json`, project settings migration, file renaming, or automatic legacy-file deletion. Do not copy values into Pi's core settings file. See [context settings](file-context-reference.md#settings) and [scope settings](edit-scope-reference.md#settings-and-persistence).

The new common Settings screen uses Pi's `SettingsList`. Only the reload-requiring shortcut action is blocked while context is queued; the hidden-file preference still applies immediately. Dedicated aliases keep their existing settings routes. A successful shortcut save remains saved if automatic reload fails; repair the reload problem and run `/reload` manually.

## Verify the transition

1. Confirm that only the successor owns these commands and the combined status widget. There must be no predecessor resource left loaded, even if no duplicate is visible.
2. Open `/files`, `/file-context`, `/edit-scope`, and `/scope` in TUI mode. Check the common manager and both dedicated workflows without changing the allowed set. Review Status for the same branch and full targets recorded before migration.
3. Confirm a restored active restriction still rejects unselected writes and unsupported tools. A blocked restriction must remain blocked; repair targets through scope management or explicitly end it only if that is the intended user action.
4. Queue a disposable snapshot and confirm this does not authorize its path. Review or remove it without changing scope. Confirm applying or ending scope does not consume context.
5. Check the two unchanged settings paths. Do not expect old queued snapshots to reappear after reload. Check current automated and manual evidence in [verification](verification.md).

Scope cancellation and run completion do not end restrictions. The explorer and checked-file picker keep distinct Tab, Enter, Escape, input, and paste behavior. There is no combined quote-and-authorize action. See the full [context reference](file-context-reference.md) and [scope reference](edit-scope-reference.md) for discovery, validation, security, and recovery limits.

## Rollback and recovery

Stop the run before rollback. Submit or remove queued context if needed, record the loaded sources, remove or disable Pi Files, restore the predecessor resources together, and reload **without co-loading guards**. Build predecessor resources if their package entrypoints require it. Restore the coherent repository layout and root manifest together through Git recovery when rolling back a checkout.

Retained settings basenames, version-1 scope entries, original entry IDs, and historical notice bytes permit predecessor restoration without rewriting the session. Use copied sessions to verify forward and reverse recovery. Do not delete state, change IDs, or discard anchors to recover unrestricted access. A failed or uncertain scope publication stays blocked until the user repairs the target set or explicitly ends the restriction. If restoration differs from the recorded branch state, stop guarded work and inspect recovery rather than bypassing it.

Registry unpublication, visibility changes, npm deprecation, tags, releases, and release workflow dispatch are not rollback steps authorized by this merge.
