# Migrate to Pi Files

`/files` is the only slash command registered by Pi Files. Use the route mapping below when upgrading. If migrating from the standalone File Context or Edit Scope extensions, also follow the resource replacement instructions: **never load `pi-files` together with `pi-file-context` or `pi-edit-scope`.** Duplicate shortcuts and guard handlers are not a coordination mechanism; load order cannot make co-loading safe.

## Replace removed commands

| Removed route | Use instead |
| --- | --- |
| `/file-context` | `/files` |
| `/file-context browse` | `/files browse` or the unchanged configured browser shortcut |
| `/file-context remove` | `/files` → **Review queued context** → open a snapshot → **Remove from next prompt**. This does not delete the file. |
| `/edit-scope`, `/scope` | `/files` → **Manage edit scope** |
| `/edit-scope off`, `/scope off` | `/files off` or **End restriction** in scope management |

There are no compatibility aliases, with or without arguments. Pi can treat an unregistered slash name as ordinary prompt text. Update launch scripts, shortcuts that submit command text, and saved instructions before reloading. Do not submit the removed commands to test removal; inspect the command list instead. If already using Pi Files, follow **Prepare**, then update or rebuild and reload the one Pi Files resource you already use.

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

The root build supplies Pi TUI Kit and generates the successor's `dist/index.ts`. Package-directory loading requires this build; its generated entry does not import back into `src`. Pi's bundled peers stay external. For npm installation, see the [README](../README.md#-install). A local build does not require downloading Pi Files itself, but installing dependencies still requires registry access or an adequate npm cache.

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
| Workflows | Context browsing and its shortcut, exact snapshot review/removal, and scope management keep their actions. Scope and queued context remain independent. |
| Context | Exact snapshots, order, limits, Git provenance, whole-file references, and one-time attachment retain their format. The `file-context-quotes` identity remains unchanged. Custom-triggered turns do not consume the queue. |
| Scope state | `scope-state`, `scope-contract`, and `scope-context-anchor` keep their identities. Scope snapshots stay at version 1; original entry IDs, state references, and version-1 notice and anchor bytes are preserved. |
| Recovery | The active branch restores after reload, resume, fork, tree navigation, and compaction as applicable. Invalid or uncertain state stays blocked until repaired or explicitly ended. |
| Settings | `openShortcut` remains in `<getAgentDir()>/pi-file-context.json`; `showHiddenFiles` remains in `<getAgentDir()>/pi-scope.json`. Unknown fields and existing values are preserved. |
| Defaults | Browser shortcut is `ctrl+shift+x`; hidden scope discovery defaults to `false`. Settings remain user-only. |

The settings basenames are deliberate compatibility exceptions. There is no `pi-files.json`, project settings migration, file renaming, or automatic legacy-file deletion. Do not copy values into Pi's core settings file. See [context settings](file-context-reference.md#settings) and [scope settings](edit-scope-reference.md#settings-and-persistence).

The common Settings screen still blocks only the reload-requiring shortcut action while context is queued; the hidden-file preference applies immediately. A successful shortcut save remains saved if automatic reload fails; repair the reload problem and run `/reload` manually.

Historical version-1 notices can still mention `/scope`; those bytes are not live instructions. Pi Files does not rewrite them. Live active and blocked notices use version 2 and point to `/files` and `/files off`. When a retained version-1 notice is still current for an active or blocked restriction, Pi Files appends one version-2 correction at the conversation tail, leaving the earlier notice in place. An unchanged inactive notice needs no correction. See [model notice compatibility](edit-scope-reference.md#session-and-model-contract-compatibility).

## Verify the transition

1. Inspect the command list (for example, RPC `get_commands` in an isolated load) and confirm that Pi Files registers only `files`. Do not submit removed names. Confirm no predecessor resource remains loaded, even if no duplicate is visible.
2. Open `/files` in TUI mode. Check browsing, context review, and **Manage edit scope** without changing the allowed set. Review Status for the same branch and full targets recorded before migration.
3. Confirm a restored active restriction still rejects unselected writes and unsupported tools. A blocked restriction must remain blocked; repair targets through scope management or explicitly end it only if that is the intended user action.
4. Queue a disposable snapshot and confirm this does not authorize its path. Review or remove it without changing scope. Confirm applying or ending scope does not consume context.
5. Check the two unchanged settings paths. Do not expect old queued snapshots to reappear after reload. Check current automated and manual evidence in [verification](verification.md).

Scope cancellation and run completion do not end restrictions. The explorer and checked-file picker keep distinct Tab, Enter, Escape, input, and paste behavior. There is no combined quote-and-authorize action. See the full [context reference](file-context-reference.md) and [scope reference](edit-scope-reference.md) for discovery, validation, security, and recovery limits.

## Rollback and recovery

Stop the run, submit or remove queued context if needed, and record the loaded sources, branch state, and full allowed target set. To roll back only the command change, load one previous built Pi Files revision instead of the current revision. Confirm the old routes are listed by that runtime and use a copied session to confirm that the same version-1 scope snapshot restores, including whether scope was active or blocked. The older runtime may not understand version-2 notices or anchors. Check that it publishes its own current notice when needed; exact model-visible placement of newer notices is not guaranteed after downgrade.

To roll back the original package merge instead, remove or disable Pi Files and restore both predecessor resources before reload. Build them if their entrypoints require it. When rolling back a checkout, restore the coherent repository layout and root manifest together through Git recovery. **Never co-load current and previous revision guards or Pi Files and its predecessors.**

Keep both settings files and the original session entries intact. Do not delete state, change IDs, discard anchors, or end a restriction as a recovery shortcut. A failed or uncertain state stays blocked until the user repairs the target set or explicitly ends the restriction. If restoration differs from the recorded branch state, stop guarded editing and inspect recovery rather than bypassing it.

Registry unpublication, visibility changes, npm deprecation, tags, releases, and release workflow dispatch are not rollback steps.
