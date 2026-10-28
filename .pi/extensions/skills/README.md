# pi-skills

Manage local skill bundles and model invocation from `/skills`. This project-local extension uses Pi TUI Kit for menus, settings, selection, previews, tasks, and TUI/RPC adaptation. Pi still owns skill discovery, project trust, filtering, and name-collision precedence.

## Setup

From the repository root:

```sh
npm install
npm --workspace @narumitw/pi-tui-kit run build
```

Pi discovers `.pi/extensions/skills/index.ts` after project trust is granted. In an existing session, run `/reload`. To load only this extension explicitly in an interactive terminal:

```sh
pi --no-extensions -e ./.pi/extensions/skills/index.ts
```

This is not a separately published package. It needs the repository's installed dependencies and built Kit workspace. It does not depend on another extension.

## Commands

1. `/skills` opens Manage skills, Add from GitHub, Remove skills, Move skills, Scan custom directory, Help, and Close.
2. `/skills add` asks for a public GitHub repository.
3. `/skills add narumiruna/skills` discovers repository skills directly.
4. `/skills remove` selects exact local paths for permanent removal.
5. `/skills move` selects local skills and their destination.

An add source accepts `owner/repo` or an exact `https://github.com/owner/repo` URL. Ref suffixes, `.git` URLs, extra URL segments, credentials, unknown routes, and trailing arguments are rejected. Remove and move do not accept a name argument because names can occur at several paths.

These commands require Pi TUI or an RPC client with extension dialogs. Print and JSON modes reject them before network or mutation work. RPC uses Kit's dialog fallback, including full identifying paths in selection labels; it does not display custom terminal components.

## Model invocation

Open `/skills` → Manage skills → select a skill → Model invocation, inspect Source file and Writes target in the scrollable review, choose Open invocation setting, then change Model invocation:

1. `automatic`: remove the native `disable-model-invocation` field and use Pi's default model discovery.
2. `manual only`: write `disable-model-invocation: true` to hide the skill from Pi's advertised catalog. Explicit `/skill:name` commands still work. This setting is not an access-control boundary: a model that already knows the file path can still read it.

Invocation availability follows `ctx.getSystemPromptOptions().skills`, not a separate loader. Manage skills combines that native loaded list with the disk inventory, including manual-only, package, ancestor, linked, and standalone Markdown sources. Only currently loaded entries enable Model invocation. Loaded-only entries cannot Move or Remove bundles. Pi keeps its discovery, filtering, and collision precedence. Newly installed or externally registered skills become loaded only after reload.

Rows show the skill name, invocation mode or Not loaded, and scope without repeating model-facing instructions. Selected-item details show the complete source path, source, active mode, warnings, and bundle restrictions. Full descriptions remain searchable. RPC labels include mode and complete identifying skill-file paths because RPC choices do not display secondary descriptions.

Active describes Pi's current loaded catalog. Saved appears after inspecting the source file or completing a save. If the saved mode differs from the active mode, the row shows Reload pending and the main menu offers Reload now, including for differences already present on disk. Returning to the active value clears the row marker; reload remains available after a completed write. These UI values never modify native loaded skill objects.

Changes save immediately to the selected source file; Escape does not undo a save. The scrollable review exposes the complete canonical write target, including long paths, before enabling a change; it remains accessible on constrained terminals. Unlike bundle Move and Remove, invocation settings intentionally allow edits through loaded symlinks and to package-provided files. User/shared edits can affect other projects or agents that read the same file. Package updates can overwrite edits. Files that are hard-linked, non-regular, invalid UTF-8, or larger than 64 MiB are not editable. Malformed frontmatter, non-simple owned booleans, unsupported key layouts, and changed files or targets block saves rather than being normalized or overwritten.

Only the native top-level field is changed. Other frontmatter, body bytes, BOM, newline style, POSIX mode, owner, and group are preserved. A save fails if ownership or mode cannot be preserved. Atomic replacement does not copy extended ACLs or other extended attributes; edit files that depend on those attributes manually. Pi validates the candidate before an atomic temporary-file-plus-rename publication. Complete transactions share the bundle tree queue and Pi's canonical file mutation queue. A failed pre-publication save leaves the original file and displayed value unchanged; select the skill again after a stale-file error. Other Pi processes and arbitrary external edits are not locked.

After a save, the manager refreshes its disk inventory so later bundle actions do not use stale fingerprints. If that refresh fails, the saved setting remains saved and the stale inventory is cleared; reopen `/skills` before managing bundles. Return to the main menu and choose Reload now to refresh Pi's catalog, or Close without reload to keep the current resource snapshot. No prompt, message, or active tool changes occur merely from opening the settings or saving a file. Reload is the explicit catalog transition and does not erase instructions already in the conversation.

There is no new JSON settings file, project override layer, command alias, or dependency on the user-level `skill-settings` extension. Existing frontmatter settings need no migration. The predecessor remains available; it is not removed or disabled. This new entrypoint is project-local and loads only after project trust.

## Add

The default branch is resolved to one commit. Discovery searches recursively below `skills/`, including category directories such as `skills/default/` and `skills/optional/`. A directory with `SKILL.md` ends discovery for that subtree. No `skills/` directory, a truncated tree, or an incomplete response is an error.

Search and multi-select the desired skills, then choose a destination. Selection starts empty. Filtering does not change checked IDs. Preview selected skills opens read-only source views. Returning retains selected IDs; Kit owns cursor and search behavior. The repository-input flow has a Find skills action, and destination selection has a Prepare review action, so lengthy work uses Kit's cancellable task presentation.

The final review shows the repository, commit, exact paths, skipped items, native validation warnings, name conflicts in scanned locations, and any native settings change. Only Apply changes publishes bundles.

Each installation is an independent directory snapshot with the original basename, bytes, executable bits, supporting files, and applicable license notices. Repository/ancestor notices are retained under a collision-free `.pi-skills-notices` directory inside the installed bundle. Files referenced outside a selected skill directory are not copied or rewritten. There is no automatic update or provenance registry.

Pi's public loader validates metadata and complete bundles, including native ignore files. Malformed declared skill files and missing descriptions cannot be installed. Native warning-only metadata remains warning-only; a name/directory mismatch alone does not block installation.

## Locations and native settings

The default choices are:

1. Project (Pi): `<cwd>/<CONFIG_DIR_NAME>/skills`, normally `./.pi/skills`; initial selection.
2. User (Pi): `<getAgentDir()>/skills`, normally `~/.pi/agent/skills`.
3. Project (Shared): `<cwd>/.agents/skills`.
4. User (Shared): `~/.agents/skills`.
5. Custom directory: a manually entered skill-container directory.

Project means Pi's current working directory, not the repository root. Shared locations can also be discovered by compatible agents. They are not Pi-only storage. The extension never silently installs into an ancestor's skill location. Missing destinations are created only after confirmation.

A custom path has three loading choices:

1. Register for project: append a concrete path to the project Pi `skills` array.
2. Register for user: append an absolute path to the user Pi `skills` array; this affects other projects.
3. Copy only: leave settings unchanged; Pi might not discover the result.

Custom registration is part of the final review. Project-relative paths are relative to the project `.pi` directory and use a `./` prefix to preserve literal path identity. Native scope-specific arrays, filters, and unrelated fields are preserved. Malformed or invalid existing settings block registration. Registration checks its preview snapshot again, awaits native persistence, and reports retained write errors without displaying document content. Cancellation can arrive after a native write completed; an unconfirmed registration result does not imply that the write was rolled back. Inspect native settings before retrying.

Only native Pi resource settings are written; there is no extension settings file or separate loader. Disabling the extension leaves installed skills and custom registrations intact. Removing the last child does not remove its container registration.

## Manage, remove, and move

Manage skills uses one searchable choice list. Selecting a skill opens Model invocation, Move, Remove, Copy directory path, and Back actions, not a `SKILL.md` detail page. Model invocation requires a native loaded entry; Move and Remove require an eligible scanned bundle. The action menu shows scope, exact file path, warnings, and bundle restrictions. Back returns to the previous selected row. Protected skills stay selectable without gaining bundle mutation rights. The top-level Remove and Move actions remain available for multi-selection; per-skill bundle actions use the same preparation and final confirmation.

Copy directory path is TUI-only and uses Pi's public clipboard helper; RPC shows the unavailable reason and never invokes that helper. It sends the exact raw directory path, including characters hidden by the terminal preview. For a standalone Markdown skill, it copies the enclosing directory. Copy does not edit files, run the skill, or close the action menu. Pi's clipboard API has no abort signal: accepted writes can finish after cancellation, while the flow drains the work and suppresses stale feedback. A successful dispatch does not prove that a remote terminal accepted OSC 52 clipboard content. Physical clipboard delivery remains part of the terminal handoff.

The disk inventory covers the four supported roots and concrete configured custom roots. Manage skills also retains every native loaded skill, including sources outside that inventory. Scan custom directory can inspect another container, including a previous Copy only destination. Entries join only by normalized absolute skill-file path, never by name or inferred canonical target. Overlapping inventory roots retain the first scanned entry and its bundle restrictions; single-skill and bulk operations use that entry only once. Distinct aliases remain separate rows; only the exact native loaded path enables invocation settings. Name conflicts are warnings rather than a replacement policy. Pi keeps its own discovery precedence.

Remove confirms an exact list of directories and deletes complete selected bundles, never their container or unrelated siblings. Locally malformed `SKILL.md` directories remain visible and removable. Removal is permanent; it does not erase skill instructions already present in the conversation.

Move confirms each source-to-destination mapping. Safe same-filesystem moves use rename. Cross-filesystem moves, and moves that need custom registration, stage and verify a complete copy before source removal. The source is retained if verification or required registration fails. A registration failure stops the remaining batch; there is no automatic settings retry. Source-deletion failure reports Copied; source retained, or explicitly reports incomplete recovery with the surviving paths when recovery itself fails.

Existing destinations are skipped. There is no overwrite, merge, force, or rename feature. Equal or overlapping source/destination trees are rejected. Stale files, replaced containers, path escapes, and unsupported copy entries are rejected.

For bundle Move and Remove, symlinked roots and linked skills, standalone Markdown skills, ancestor roots, and package caches are read-only. Linked aliases can be inspected, but bundle operations never mutate their targets. Model invocation is a separate source-file setting with the explicit target review described above. A bundle containing symlinks or hard-linked files cannot be moved; removal never follows a linked target. Native glob/filter entries and file resources are not treated as writable container roots.

## Safety and cancellation

Review unfamiliar skills and their supporting programs before installation. Skills can later direct an agent to run commands or access files. Installation and validation do not execute repository programs or install dependencies. GitHub access is public-only, carries no credentials, verifies downloaded bytes against the pinned Git tree, rejects redirects and unsafe file types/paths, and does not retry rate-limit or permission failures.

Fixed limits bound requests, response bodies, candidates, files, bytes, recursion, and parallel work. The limits are internal constants, not settings. GitHub operations have a deadline; local inventory and mutation snapshots are bounded. Validation data and publication staging are cleaned up on normal completion and failure. Staging stays outside discovered skill roots.

For bundle operations, cancellation before final confirmation changes no installed bundles or native resource registrations. Invocation settings save immediately and are not rolled back by cancellation. After batch application starts, cancellation stops subsequent items after the current safe filesystem step. Completed items remain completed. A partially failed recursive deletion drains missing-entry recovery even after cancellation or session invalidation, using captured filesystem authorization rather than the old Pi context. Recovery rechecks path and root identity and never overwrites existing data. If recovery I/O also fails, the result identifies incomplete recovery and any verified destination; inspect those paths before retrying.

The extension owns one flow per session manager. It aborts and drains owned work on disposal, session replacement, reload, and shutdown. Overlapping tree operations and native file changes are serialized within this process. Separate Pi processes and arbitrary external filesystem edits are not locked; concurrent cross-process mutation is unsupported. Snapshot checks detect changes at defined boundaries, not every possible adversarial race.

Each completed batch reports installed, removed, moved, skipped, failed, and source-retained items separately. Reload now is offered after changes; Close without reload preserves the current resource snapshot. An explicit reload changes the skill catalog and can change the model-visible prompt prefix. Ordinary manager UI does not change prompts, messages, or active tools.

## Verification

Run the extension-local checks from the repository root after building Kit:

```sh
npm exec -- tsc -p .pi/extensions/skills/tsconfig.json
npm exec -- biome check .pi/extensions/skills --error-on-warnings
npm exec -- vitest run --config .pi/extensions/skills/vitest.config.ts
node .pi/extensions/skills/test/runtime-smoke.mjs
node .pi/extensions/skills/test/headless-smoke.mjs
npm run check
npm test
```

Root checks do not automatically discover this local test suite. Tests and smokes use temporary directories, injected failures, mocked GitHub transport, Kit public harnesses, and Pi's Jiti resource loader. The RPC smoke uses isolated agent/home directories, no credentials, and no model requests; it verifies explicit loading, trusted-project auto-discovery, lazy menu loading, per-skill actions, actual removal, command-triggered reload, and ordinary message-prefix stability.

See [verification and terminal handoff](./verification.md) for completed evidence, intentional limits, and remaining physical-terminal checks.

## Files

`index.ts` forwards registration to `skills-extension.ts`. `command.ts` owns argument grammar. `menu.ts` owns Kit screens and operation drafts. `github.ts` owns remote snapshots and bounded downloads. `metadata.ts` delegates validation to Pi. `locations.ts` owns targets and native path registration. `filesystem.ts` owns inventory, snapshots, and safe per-skill bundle operations. `managed-skills.ts` joins disk and loaded entries without granting bundle permissions. `invocation.ts` owns loaded-skill settings snapshots and atomic saves; `frontmatter.ts` changes only the native invocation field. `mutation-queue.ts` serializes tree operations and metadata edits. `types.ts` defines contracts; `invariant.ts` checks required operation data. Tests, isolated runtime smokes, and their local configuration stay inside this directory.
