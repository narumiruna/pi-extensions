# Pi extension conventions

This guide defines the stable conventions for active extensions in this monorepo. It separates Pi
platform constraints from repository requirements and preferred product patterns so that review does
not confuse runtime correctness with local taste.

The Pi guidance was last reviewed against the latest published
`@earendil-works/pi-coding-agent` release, **0.81.1**, on **2026-07-23**:

- [Extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Package format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [TUI components](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)

Review this section when the repository updates its Pi dependencies or latest-release CI target.
The official Pi documentation wins if this summary becomes stale.

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
- **MUST:** Put runtime libraries in `dependencies`; list Pi packages imported at runtime in
  `peerDependencies` with version `"*"`; do not rely on `devDependencies` being installed with a
  production package. **Verification:** `Review` of imports and package metadata, plus an npm pack
  dry run for dependency or publishing changes.
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
  **Verification:** `Validator` via `npm run check:boundaries` and `Review` for lifecycle moves.
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

A command's default shape depends on its product role:

- A multi-action extension **SHOULD** expose one primary slash command. Invoking it without arguments
  should open a current-state menu, while direct subcommands remain available for predictable and
  non-interactive use.
- A text-first command such as `/btw <question>`, a single-purpose action, or a passive extension MAY
  use a different shape or expose no command.
- The primary command **SHOULD** usually derive from the unscoped package name by removing `pi-`.
  Preserve an established or clearer product name when compatibility or meaning outweighs symmetry.
- Known subcommands, modes, and flags **SHOULD** provide `getArgumentCompletions`. Unknown arguments
  should produce a clear warning and usage guidance rather than silently selecting another action.
- A main menu **SHOULD** show current state and the most relevant next actions. Prioritize current
  session context and label cross-provider, cross-workspace, destructive, or externally visible
  effects explicitly.
- Destructive actions **SHOULD** show an exact summary and ask for confirmation. Cancellation should
  leave state unchanged.

- **MUST:** Provide a safe non-TUI result for every command that can run outside the TUI: execute a
  direct operation, return status/help through a supported UI channel, or clearly reject the mode.
  **Verification:** `Test` for supported command modes plus `Review` of the fallback.

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

A configurable extension **SHOULD** provide `/<command> settings`, `/<command> status`, and
`/<command> help`. A small no-argument main menu may link to those direct entrypoints. Keep `config`
only as a compatibility alias or when it describes a distinct setup workflow.

### Status and persistent UI

- **MUST:** Use a stable package-specific key for statuses or widgets and clear session-owned UI on
  shutdown, replacement, and failed initialization. **Verification:** `Test` of lifecycle cleanup and
  `Review` of key ownership.

Status values **SHOULD** be text-only and activity-based: show active work, retry, or a condition that
needs attention, not a permanent `ready`, `configured`, or `on`. Keep icon mapping and suppression in
`pi-statusline` so visual policy remains centralized. Concurrent work sharing one status key should
restore the latest remaining activity rather than letting one completion clear its siblings.

### Documentation and verification

Package READMEs **SHOULD** remain practical and scannable: capabilities, installation, usage,
commands/tools/settings, operational behavior, package layout, keywords, and license. Document the
applicable persistent npm install, temporary npm execution, and local checkout commands. Include
security, privacy, precedence, persistence, failure, or lifecycle details when users need them to use
the extension safely.

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
- [ ] Choose the primary command and no-argument behavior from the extension's product role; add
      completions for known arguments and a safe non-TUI path.
- [ ] Follow `docs/extension-settings.md` for every user or project setting.
- [ ] Bound tool output, cancellation, state persistence, and file mutation where applicable.
- [ ] Document installation, behavior, settings, security, limitations, and source responsibilities.
- [ ] Add deterministic tests and run `npm run check`.
- [ ] Inspect `npm pack --workspace <name> --dry-run --json` and load the declared entrypoint with Pi.

## Touched-area checklist

- [ ] Identify which sections the change touches; do not expand an unrelated change into a full
      package migration.
- [ ] Apply every relevant MUST and review SHOULD deviations near their owning package.
- [ ] Update focused tests and run the verification method named by each relevant MUST.
- [ ] Run `npm run check`; add pack or Pi runtime smokes when metadata or loading changed.
- [ ] Report any skipped check, accepted exception, or follow-up validator opportunity in the change
      handoff.
