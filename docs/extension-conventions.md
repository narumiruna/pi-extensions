# Pi extension conventions

This guide defines the stable conventions for active extensions in this monorepo. It separates Pi
platform constraints from repository requirements and preferred product patterns so that review does
not confuse runtime correctness with local taste.

The Pi guidance was last reviewed against the latest published
`@earendil-works/pi-coding-agent` release, **0.81.1**, on **2026-07-23**:

- [Extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Package format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [TUI components](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)

Review this section when the repository updates its Pi dependencies or latest-release CI target.
The official documentation is authoritative for the latest Pi behavior, while the repository's
installed typings and tested runtime determine which APIs implementation code may rely on until its
Pi dependencies are updated.

## Authority and adoption

The key words **MUST**, **SHOULD**, and **MAY** describe requirement strength:

- **MUST** identifies a Pi constraint or repository requirement. Each such rule names its current
  verification method: `Validator`, `Test`, `Review`, or `Smoke`.
- **SHOULD** identifies the default design. A better product or compatibility reason may override it.
- **MAY** identifies an optional pattern.

New extensions follow the full guide. Existing extensions adopt the relevant section when that area
is changed: command work adopts command conventions, settings work follows the settings guide, and
package work adopts package conventions. A small unrelated change does not require a whole-package
migration.

Keep exceptions close to their owner. Explain a non-obvious deviation in the package README or an
adjacent code comment rather than in a central exception table. Pull-request discussion may provide
additional context, but it is not durable documentation.

## Official Pi conventions

This section summarizes constraints and broadly applicable recommendations from Pi's documentation;
it is not an API reference.

### Entrypoints and packages

- **MUST:** Export an extension factory as the entry module's default export. The factory receives an
  `ExtensionAPI` and registers the extension's hooks, commands, tools, or providers.
  **Verification:** `Smoke` by loading the declared entrypoint with Pi; `Test` when the package has a
  loader smoke test.
- **MUST:** Put third-party runtime libraries in `dependencies`. List Pi-bundled core packages
  imported at runtime—`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`—in `peerDependencies`
  with version `"*"`; do not rely on `devDependencies` being installed with a production package.
  **Verification:** `Review` of imports and package metadata, plus an npm pack dry run for dependency
  or publishing changes.
- **MUST:** Treat installed extension code as fully privileged and load only trusted sources.
  **Verification:** `Review` of installation documentation and any code-loading path.

A package may declare multiple entrypoints, but this repository deliberately uses one forwarding
entrypoint per active package as described below.

### Factory and lifecycle

- **MUST:** Keep factory evaluation free of session-owned background work. Start processes, servers,
  watchers, timers, and other long-lived resources from `session_start` or on first use, not while the
  module or factory is loading. **Verification:** `Review`; `Test` when the extension owns a resource
  lifecycle.
- **MUST:** Release session-owned resources during `session_shutdown`, and make cleanup safe after
  partial initialization or repeated calls. **Verification:** `Test` plus `Review` for every owned
  process, server, watcher, timer, widget, status, or temporary resource.
- **MUST:** Do not continue using an `ExtensionContext` captured from a replaced session or reloaded
  runtime. After awaiting `ctx.reload()`, return immediately from the old continuation.
  **Verification:** `Test` for delayed or reload-capable flows and `Review` of asynchronous callbacks.

Prefer plain data over a captured context in delayed callbacks. Scope generation guards, cancellation,
and cleanup to the session or request that owns the work.

### Commands, tools, and state

- **MUST:** Invoke command-only session replacement APIs from command handlers, where Pi exposes the
  required context. **Verification:** `Validator` through workspace typechecking and `Review` of
  session-changing flows.

Register slash commands with `pi.registerCommand()` and give them concise descriptions. Provide
argument completions when the command has known values, as described in the repository command
conventions below.
- **MUST:** Make tool failures observable by throwing rather than returning only an error-looking
  result, honor cancellation where the operation can be interrupted, and bound potentially large
  text output to Pi's documented 50 KB or 2,000-line limit. **Verification:** `Test` plus `Review` for
  each applicable failure, cancellation, and output path.
- **MUST:** Serialize file mutations that can target the same path, using Pi's
  `withFileMutationQueue()` where applicable. **Verification:** `Test` for concurrent mutation and
  `Review` of the write path.
- **MUST:** Persist fork-sensitive tool state in tool-result `details` or another session entry and
  rebuild it from the active branch on `session_start`. **Verification:** `Test` of restart and fork
  reconstruction for extensions that own session state.

Use `StringEnum` from `@earendil-works/pi-ai` for string-valued tool schema enums so tools remain
compatible with Google providers. Give tools explicit names in descriptions and prompt metadata.

### TUI and non-interactive modes

- **MUST:** Call `ctx.ui.custom()` only in TUI mode. Guard it with `ctx.mode === "tui"`, and use
  `ctx.hasUI` before UI methods that are unavailable in the current mode. Do not write ad hoc output
  that can corrupt JSON or RPC protocols. **Verification:** `Test` of supported non-TUI modes and
  `Review` of every custom UI entrypoint.
- **MUST:** Custom components must keep every rendered line within the supplied width, invalidate
  cached themed content, and request a render after interactive state changes. Components containing
  an `Input` or `Editor` must forward `Focusable.focused` to that child for IME support.
  **Verification:** `Test` for custom component rendering and input behavior plus `Review` against
  Pi's TUI contract.

Use the callback-provided theme and keybindings. Prefer Pi's `SelectList`, `SettingsList`, and
`BorderedLoader` over rebuilding equivalent controls. Escape should cancel or close transient UI,
and long-running interactive work should expose cancellation.

## Monorepo conventions

### Package layout and boundaries

- **MUST:** Keep active production packages under `extensions/<package>/`, experiments under
  `extensions/experimental/<package>/`, and deprecated references under `deprecated/<package>/`.
  **Verification:** `Review` of package locations and lifecycle moves.
- **MUST:** Give every active package a thin `src/index.ts` default-export forwarder and declare
  exactly `"pi": { "extensions": ["./src/index.ts"] }`; keep implementation in descriptive modules.
  **Verification:** `Validator` via `npm run check:boundaries`.
- **MUST:** Keep extension packages free of extension-to-extension dependencies.
  **Verification:** `Validator` via `npm run check:boundaries`.
- **MUST:** Keep each extension independently installable, with its own runtime dependencies and
  package metadata. **Verification:** `Review` of package metadata and a `Smoke` npm pack dry run for
  dependency or publishing changes.
- **MUST:** Keep package contents aligned with the manifest's `files` list and include required
  notices and licenses. **Verification:** `Smoke` with `npm pack --workspace <name> --dry-run --json`
  for package or publishing changes.

Use lowercase `pi-*` package directories and `@narumitw/pi-*` npm names. Keep packages small and
self-contained, add dependencies only for current runtime needs, and review source files over 1,000
lines for responsibility-based decomposition rather than mechanical splitting.

### Slash commands and menus

A command's default shape depends on its product role. A manager can be menu-first without being
menu-only:

- A multi-action manager extension **SHOULD** expose one primary slash command whose no-argument form
  opens a current-state menu. Do not mirror menu actions into textual subcommands by default.
- Add command arguments or subcommands only for a concrete need: the text is the primary payload,
  such as `/btw <question>` or `/goal <goal>`; a supported non-TUI, RPC, or automation workflow needs
  a deterministic route; an existing public interface requires compatibility; or the command is a
  frequent, single, unambiguous primary action.
- A passive extension MAY expose no command. A manager with none of those direct-route needs MAY be
  menu-only and reject all arguments explicitly.
- The primary command **SHOULD** usually derive from the unscoped package name by removing `pi-`.
  Preserve an established or clearer product name when compatibility or meaning outweighs symmetry.
- **MUST:** Treat every accepted argument or subcommand as a public interface: document its supported
  modes, provide `getArgumentCompletions` for known routes and values, reject unknown or trailing input
  instead of silently ignoring it, preserve applicable safety checks, and test every claimed TUI and
  non-TUI behavior. **Verification:** `Test` of exact direct-command routes and claimed modes plus
  `Review` of documentation, completion, compatibility, and safety behavior.
- **MUST:** Do not remove an established or documented route merely to make a manager menu-first.
  Preserve it as a compatibility route unless an explicitly approved breaking change includes its
  migration path, release documentation, and updated compatibility tests. **Verification:** `Test` of
  retained routes or intentionally changed behavior plus `Review` of breaking-change approval,
  migration, and release documentation.
- A main menu **SHOULD** show current state and the most relevant next actions. Prioritize current
  session context and label cross-provider, cross-workspace, destructive, or externally visible
  effects explicitly.
- Destructive actions **SHOULD** show an exact summary and ask for confirmation. Cancellation should
  leave state unchanged.

- **MUST:** Provide safe behavior in every non-TUI mode a command can receive: execute a direct
  operation, expose status/help through a channel supported by that mode, or reject before entering
  TUI-only work. Claim a mode as supported only when its result or rejection is observable there.
  `ctx.hasUI` is true in TUI and RPC modes, where `ctx.ui.notify()` is observable, and false in print
  and JSON modes, where UI methods are no-ops; a notify-only path therefore does not provide a print
  or JSON result. **Verification:** `Test` for each claimed command mode plus `Review` of every
  unsupported-mode fallback.

Use `ctx.ui.select()` for a small action menu. Use `SelectList` for richer selection and
`SettingsList` for editable settings; do not repeatedly reopen `ctx.ui.select()` after each toggle,
because that resets navigation state.

### Settings

[`docs/extension-settings.md`](extension-settings.md) owns settings names, paths, precedence, project
trust, validation, persistence, migration, secrets, interactive UI, and settings-specific tests.

- **MUST:** Read and follow that guide when adding or changing extension-owned settings, including
  their commands or UI. **Verification:** `Review` against its applicable sections and verification
  checklist.
- **MUST:** Do not register a generic `/settings` command that competes with Pi's built-in command.
  **Verification:** `Review` of registered command names.

A configurable manager extension **SHOULD** expose Settings, Status, and Help as actions in its
no-argument menu. It MAY add documented direct routes for those actions only when one of the concrete
needs in the command section applies. Keep `config` only as a compatibility alias or when it describes
a distinct setup workflow.

### Status and persistent UI

- **MUST:** Use a stable package-specific key for statuses or widgets, clear the exact key that was
  set, and clear session-owned UI on shutdown, replacement, and failed initialization.
  **Verification:** `Test` of lifecycle cleanup and `Review` of key ownership.

A repository-owned status key **SHOULD** use `<extension-id>` for one aggregated status or
`<extension-id>:<stable-slot>` when independently owned statuses must coexist. Derive the lowercase
kebab-case extension id from the unscoped package basename by removing `pi-`; for example,
`@narumitw/pi-sync` uses `sync`. Keep transient state, tool-call ids, and other changing values in the
status text rather than the key. A stable slot identifies a long-lived channel such as
`lsp:typescript`, not an activity such as `sync:pushing`.

This grammar is an author convention, not Pi enforcement: `ctx.ui.setStatus()` accepts any string,
Pi exposes no package owner for a status, and two extensions using the same key overwrite each other
before a custom footer receives the status map. `pi-statusline` must therefore continue accepting
arbitrary third-party raw keys; exact raw-key matching is its reliable interoperability contract,
while namespace wildcards and installed-package aliases are convenience fallbacks only.

Status values **SHOULD** be text-only and activity-based: show active work, retry, or a condition that
needs attention, not a permanent `ready`, `configured`, or `on`. Keep icon mapping and suppression in
`pi-statusline` so visual policy remains centralized. Concurrent work sharing one status key should
restore the latest remaining activity rather than letting one completion clear its siblings.

### Documentation and verification

Package READMEs **SHOULD** remain practical and scannable: capabilities, installation, usage,
commands/tools/settings, operational behavior, package layout, keywords, and license. Apply these
shared presentation conventions:

- Write user-facing prose in English and retain the package's emoji title plus npm, Pi extension, and
  license badges.
- When applicable, use the established section labels and emojis: `✨ Features`, `📦 Install`,
  `🚀 Quick start`, `⚙️ Settings`, `💬 Commands`, `🗂️ Package layout`, `🔎 Keywords`, and
  `📄 License`. Additional sections may use a concise, semantically relevant emoji.
- Keep `## 🗂️ Package layout`, `## 🔎 Keywords`, and `## 📄 License` in active package READMEs.
  During a readability pass, reorganize or condense technical reference material instead of silently
  removing supported capabilities, compatibility guidance, or these standard sections.
- For another package in this monorepo, prefer stable absolute links to its GitHub package directory
  and npm page so links work from both GitHub and npm. Describe borrowed syntax as "inspired" unless
  compatibility is actually guaranteed.

Document the applicable persistent npm install, temporary npm execution, and local checkout commands.
Include security, privacy, precedence, persistence, failure, or lifecycle details when users need them
to use the extension safely.

- **MUST:** Add or update deterministic tests for changed behavior when practical; when a behavior
  requires a real Pi runtime or external service, record and run the smallest representative smoke
  instead. **Verification:** `Test` through root `npm test`, `Smoke` for the stated runtime path, and
  `Review` of any intentionally untested behavior.
- **MUST:** Run the repository CI-equivalent gate before completing a change, and add an npm pack dry
  run or local Pi load when package metadata or runtime loading changed. **Verification:** `Validator`
  via `npm run check`; applicable `Smoke` evidence in the change handoff.

Do not create a validator merely because a convention is written down. Add one when a new or touched
area has a stable, low-false-positive rule that can be checked without encoding product semantics in
fragile regular expressions. Until then, label the real verification method honestly.

## New extension checklist

- [ ] Place the package in the correct active or experimental directory and keep it independently
      installable.
- [ ] Add the thin `src/index.ts` forwarder and canonical `pi.extensions` manifest entry.
- [ ] Separate factory registration from session-owned startup and idempotent shutdown cleanup.
- [ ] Choose the primary command and no-argument behavior from the extension's product role; use a
      menu-first manager unless a concrete reason supports another shape, and add direct routes only
      for concrete payload, automation, compatibility, or frequent-action needs.
- [ ] Document accepted command routes and modes, complete known values, reject unknown or trailing
      input, preserve safety checks, and test each claimed execution mode.
- [ ] Follow `docs/extension-settings.md` for every user or project setting.
- [ ] Bound tool output, cancellation, state persistence, and file mutation where applicable.
- [ ] Document installation, behavior, settings, security, limitations, and source responsibilities.
- [ ] Add deterministic tests and run `npm run check`.
- [ ] Inspect `npm pack --workspace <name> --dry-run --json` and load the declared entrypoint with Pi.

## Touched-area checklist

- [ ] Identify which sections the change touches; do not expand an unrelated change into a full
      package migration.
- [ ] Apply every relevant MUST and review SHOULD deviations near their owning package.
- [ ] For command-surface changes, preserve established routes or explicitly own an approved breaking
      migration, and test every claimed execution mode.
- [ ] Update focused tests and run the verification method named by each relevant MUST.
- [ ] Run `npm run check`; add pack or Pi runtime smokes when metadata or loading changed.
- [ ] Report any skipped check, accepted exception, or follow-up validator opportunity in the change
      handoff.
