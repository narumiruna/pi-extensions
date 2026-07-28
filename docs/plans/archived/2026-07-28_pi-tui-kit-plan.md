# Pi TUI Kit Library Plan

## Goal

Add a publishable `packages/pi-tui-kit` workspace named
`@narumitw/pi-tui-kit` so new Pi extensions can declare typed, dynamic screens and actions
while the library owns standard menu rendering, navigation, mode handling, cancellation, disposal,
and stale-continuation protection. Prove the public contract by migrating the duplicated Chrome
DevTools and Firecrawl manager/tool-selection menus without changing their established commands,
settings files, active-tool policy, or non-TUI behavior.

## Context

- Active extensions currently repeat `ctx.ui.select()` or `ctx.ui.custom()` loops, `SelectList` and
  `SettingsList` themes, Back/Close handling, width bounding, cursor retention, render invalidation,
  persistence waiting, and mode fallbacks.
- `extensions/pi-chrome-devtools/src/tool-selector.ts` and
  `extensions/pi-firecrawl/src/tool-selector.ts` are especially close implementations, and
  `extensions/pi-google-genai/src/google-genai.ts` carries the same persistent tool-selection
  interaction and transaction shape.
- `extensions/pi-plan-mode/src/selector-ui.ts`, `extensions/pi-image-drop/src/menu.ts`,
  `extensions/pi-starship/src/commands.ts`, `experimental/pi-webui/src/menu.ts`, and
  `experimental/pi-jupyter/src/jupyter-menu.ts` contain additional proven pieces of the intended
  screen, navigation, and component contracts.
- The archived persistent-selector plan records a repository-wide invariant that in-place toggle
  menus retain their cursor and serialize saves. The new library should own that invariant once.
- Pi already provides `SelectList`, `SettingsList`, `BorderedLoader`, theme helpers, and injected
  keybindings. The library should compose those controls where their public contracts support the
  required behavior and keep any necessary adapter local.
- Node rejects direct TypeScript loading from `node_modules` with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; this runtime library therefore needs generated JavaScript
  and declarations rather than publishing TypeScript-only exports.
- Repository workspace, boundary, test, version, pack, and publication tooling currently assumes
  publishable workspaces live only under `extensions/*` or `experimental/*`.

## Architecture

### Package boundary

- Place the reusable library at `packages/pi-tui-kit` with package name
  `@narumitw/pi-tui-kit` and no `pi` manifest or extension entrypoint.
- Publish generated ESM and declarations from `dist/`; keep authored TypeScript under `src/` and
  exclude tests and build caches from the tarball.
- Depend on Pi runtime packages through `peerDependencies` with `"*"` and repository-pinned
  `devDependencies`, following the same single-module-identity rules as extension packages.
- Let extension packages consume the library as a normal runtime dependency. Use a pre-1 compatible
  range bounded below `1`, and require any future consumer of a newly added API to raise its minimum
  version explicitly.

### Ownership

`@narumitw/pi-tui-kit` owns:

- the typed `defineMenu()` and `runMenu()` public contract;
- screen-stack navigation, stable per-screen selection by item id, Back, Close, Stay, Refresh, and
  explicit screen transitions;
- standard `actions`, `detail`, `settings`, and `multiSelect` screen presentation;
- optional cancellable busy presentation for asynchronous actions;
- TUI-only `ctx.ui.custom()` entry, dialog-capable RPC adaptation where supported, and a typed
  unsupported-mode handoff for extension-owned print/JSON behavior;
- callback-provided theme and keybinding use, terminal-control sanitization, visible-cell width
  bounding, invalidation, and render requests;
- menu-run and action cancellation, component disposal, pending settings-change draining, and an
  extension-provided `isCurrent()` guard checked after every await before navigation, rendering, or
  callbacks continue;
- ordered settings callbacks and displayed-value rollback based on an explicit handler outcome,
  without owning settings files.

Each extension continues to own:

- command parsing, completions, established direct routes, and mode-specific public behavior;
- domain state and dynamic labels, descriptions, summaries, and action availability;
- settings schema, loading, validation, persistence, atomic publication, concurrency scope, runtime
  application, and rollback;
- exact destructive-action previews and confirmation policy;
- session-generation state and the `isCurrent()` implementation;
- specialized controls such as sortable statusline layouts, editors, previews, and overlays.

### Public model

- A screen factory receives the latest extension-owned snapshot and returns plain screen data.
- An action item either navigates to another declared screen or names an action handler; the library
  rejects ambiguous items that try to do both.
- An action handler receives the Pi context, an abort signal, current snapshot, selected item/value,
  and navigation helpers, then returns a typed transition. It does not render components directly.
- The runtime reloads the snapshot at explicit refresh boundaries and after successful mutating
  actions, then rebuilds the current screen while restoring selection by stable id when possible.
- Screen and action identifiers are generic string types so missing screens, missing actions, and
  invalid transitions fail during TypeScript checking.

### Data and control flow

1. The extension command calls `runMenu(ctx, definition, adapter)` only for its menu route.
2. The runtime checks mode support and creates one menu-run abort controller.
3. The adapter supplies the latest state snapshot; the current screen factory returns plain data.
4. The library renders the appropriate Pi component and translates input into a navigation or
   activation event.
5. Navigation updates the screen stack internally. A domain action runs through the adapter with an
   action-scoped signal and optional loader.
6. After each await, the runtime verifies the menu signal and extension `isCurrent()` guard before
   applying a transition, refreshing state, notifying through an extension callback, or reopening a
   screen.
7. Close, Ctrl+C, disposal, unsupported-mode exit, or stale ownership aborts owned work and prevents
   later continuations from using the captured context.

## Tech Stack

- TypeScript with NodeNext/ES2022 and a package-local emitting build configuration.
- `@earendil-works/pi-coding-agent` for extension contexts, theme helpers, and `BorderedLoader`.
- `@earendil-works/pi-tui` for `SelectList`, width utilities, components, and keybindings.
- Node's built-in test runner through the repository compile-and-run harness.
- Biome and the existing root `npm run check` gate.

## Non-Goals

- Migrating every existing extension in the first change.
- Registering slash commands or replacing extension-owned direct-command parsing.
- Owning settings documents, credentials, migrations, project trust, or persistence locks.
- Defining one visual layout for specialized previews, sortable lists, editors, forms, or overlays.
- Reimplementing Pi's existing TUI controls or adding another UI framework dependency.
- Removing established routes, changing settings paths or schemas, or changing tool names and active
  tool semantics in the pilot extensions.
- Publishing to npm as part of implementation; publication remains an explicitly approved release
  action after local and CI evidence passes.

## Assumptions

- The initial public API may evolve while the package remains pre-1, but versions accepted by the
  initial `<1` consumer range remain backward compatible. Shared major bumps advance internal
  workspace upper bounds so newly published consumers admit their matching library major.
- Standard action/detail/settings/multi-select screens cover the common manager-extension path;
  extensions with genuinely specialized interaction may continue using Pi components directly.
- Chrome DevTools and Firecrawl are sufficient production pilots for the first package release;
  broader migrations require separate evidence and plans.

## Risks

- **Framework overreach:** A wide callback-heavy API would move rather than hide complexity. Keep
  screen data plain, transitions finite, and settings/domain policy outside the package; reject
  options introduced only for one pilot.
- **Shared blast radius:** A navigation or lifecycle defect would affect multiple extensions. Cover
  the package contract directly and retain extension integration tests before deleting local paths.
- **Lifecycle leaks:** Closing a screen while state loading, an action, or a save is pending can leave
  work running or use a stale context. Abort owned work on every exit/disposal path and revalidate
  after every await.
- **Mode divergence:** `custom()` is unavailable outside TUI, while RPC dialogs and print/JSON output
  differ. Keep adapters explicit and test every claimed mode without emitting ad hoc protocol output.
- **Settings corruption:** Generic displayed-value handling must not pretend to own persistence.
  Require extension handlers to return committed/rejected outcomes and preserve each extension's
  existing serialization, malformed-file protection, unknown-field preservation, and rollback.
- **Build races:** Root checks currently run in parallel, while consumers need generated `dist` at
  runtime. Add one deterministic package-build prerequisite for clean-checkout tests and checks rather
  than letting parallel gates race to generate the same files.
- **Publication ordering:** A newly published extension must not become temporarily uninstallable
  because its library dependency is unpublished. Select publishable workspaces in dependency order,
  with lexical ordering only between unrelated packages.
- **Boundary false positives:** The current `@narumitw/pi-*` regular expression treats the proposed
  library as another extension. Classify forbidden dependencies from actual active extension
  manifests instead of weakening the no extension-to-extension rule.

## Rollback / Recovery

- Before publication, rollback removes the pilot dependencies and restores their prior local menu
  modules; no user data or settings migration is involved.
- After publication, released versions cannot be reused. A package defect is fixed forward with a new
  compatible library version; pilot extensions can pin or restore local menu code in a subsequent
  release if necessary.
- Keep pilot settings paths, formats, and command routes unchanged so code rollback never requires
  settings recovery.
- If automated dependency ordering cannot be proven, stop before release rather than publishing a
  dependent extension ahead of the library.

## Plan

- [x] Add failing repository-script fixtures in `test/repository-scripts.test.ts` and
      `test/publish-workspaces.test.ts` for a publishable `packages/*` library, active-extension-only
      dependency rejection, shared version/Pi-version discovery, release-workflow staging, changed
      package selection, and dependency-before-consumer publication order. Evidence: the first
      `npm test` run failed the four expected package-root, Pi-version, publish-order, and boundary
      assumptions while the other 1,722 tests passed.

- [x] Update `package.json`, `scripts/bump-shared-version.mjs`,
      `scripts/list-publish-workspaces.mjs`, `scripts/set-pi-version.mjs`,
      `scripts/check-extension-boundaries.mjs`, `.github/workflows/bump-version.yml`, the publish
      workflow summary wording, and applicable `justfile` recipes so libraries under `packages/*`
      build, typecheck, version, pack, and publish without being treated as Pi extensions. Evidence:
      `npm test` passes all 1,726 tests, including library discovery, extension-only boundaries, and
      dependency-before-consumer ordering.

- [x] Add a deterministic clean-checkout library build prerequisite to the root check/test workflow
      so generated runtime files exist before compiled extension tests import workspace libraries and
      parallel gates never race the same output. Evidence: after deleting
      `packages/pi-tui-kit/dist`, `npm test` rebuilt the package first and passed all 1,739
      tests.

- [x] Scaffold `packages/pi-tui-kit/package.json`, `tsconfig.json`,
      `tsconfig.build.json`, `src/index.ts`, `README.md`, `LICENSE`, and `test/` with ESM `dist`
      exports, generated declarations, Pi peer dependencies, pinned development dependencies, a
      package-local build/check command, and a `files` allowlist. Evidence:
      `npm --workspace @narumitw/pi-tui-kit run build` generated `index.js` and `index.d.ts`,
      and a package-name dynamic import returned the expected API marker.

- [x] Add failing package contract tests for typed screen/action references, root and nested
      navigation, stable selection restoration, Back versus Close, dynamic snapshot refresh, unknown
      action/screen rejection, and side-effect-free cancellation. Evidence: the red run failed to
      compile on the missing model/navigator exports and their contextual state types.

- [x] Implement the pure typed menu model and navigator in focused modules under
      `packages/pi-tui-kit/src/`, including finite transitions, screen-stack state, stable
      item ids, and snapshot refresh boundaries without importing extension-specific state.
      Evidence: the focused compiled `menu-model.test.js` suite passes 3/3 and all authored modules
      remain below 200 lines.

- [x] Add failing component tests for `actions`, `detail`, `settings`, and `multiSelect` screens at
      20, 40, 80, and 120 columns, remapped keybindings, theme invalidation, C0/C1 terminal input,
      non-color labels, cursor retention, ordered settings callbacks, rejected-change display
      rollback, and close-after-pending-save behavior. Evidence: the red run failed to compile only on
      the absent `screen-components.js` module and its callback types.

- [x] Implement the standard screen adapters with Pi's `SelectList` and width/theme utilities; use a
      local settings adapter because the installed `SettingsList` cannot initialize its cursor,
      enforce disabled rows, or expose search focus. Evidence: the focused component suite covers all
      four screen kinds, 20/40/80/120-column bounds, remapped keys, invalidation, settings rollback,
      and multi-select cursor retention.

- [x] Add failing runtime tests for TUI-only custom UI entry, RPC dialog adaptation, print/JSON
      unsupported handoff, action loader cancellation, component disposal, stale `isCurrent()` after
      state/action/save awaits, repeated close calls, and rejected action recovery. Evidence: the red
      run failed to compile on the absent `runMenu` runtime and result types.

- [x] Implement `defineMenu()` and `runMenu()` orchestration with menu/action abort controllers,
      optional cancellable `BorderedLoader` presentation, mode guards, extension-provided error and
      unsupported-mode callbacks, pending-change draining, idempotent disposal, and post-await
      ownership checks. Evidence: the focused runtime suite passes 5/5 and the clean-build root suite
      passes all 1,739 tests without unhandled rejections.

- [x] Add or strengthen Chrome DevTools and Firecrawl characterization tests for every behavior the
      pilot migration must preserve—command routes/completions, TUI and RPC dispatch, stable toggled
      cursor, unrelated active-tool preservation, rapid-save ordering, failed-save rollback,
      shutdown invalidation, cancellation, status/help wording, and narrow-width rendering. Evidence:
      the focused red run passed 51 existing compatibility tests and failed only the two new
      20-column selector bounds against the duplicated local renderers.

- [x] Migrate `extensions/pi-chrome-devtools` to declare its main and tool-selection screens/actions
      through `@narumitw/pi-tui-kit`, leaving settings persistence, status/help construction,
      active-tool transactions, session generation, and direct commands extension-owned. Evidence:
      the local custom/dialog selector loops were removed; the focused pilot suite passes, including
      dynamic count refresh, narrow widths, cursor retention, RPC adaptation, saves, and lifecycle
      cases; its workspace typecheck passes.

- [x] Migrate `extensions/pi-firecrawl` through the same public library contract without importing
      Chrome-specific code or sharing extension-owned state, preserving API-key warning levels and
      existing settings/tool semantics. Evidence: the superseded custom/dialog selector loops were
      removed; its focused characterization/integration suite and workspace typecheck pass.

- [x] Add `@narumitw/pi-tui-kit` as a runtime dependency of both pilot manifests with the
      current-major `<1` compatibility bound and regenerate the lockfile; shared major bumps advance
      internal workspace bounds automatically. Evidence: scoped `npm ls` for the library and both
      pilots resolves one deduplicated workspace helper and Pi `0.82.1` peers; the pilot pack
      inventories contain source and dependency metadata without bundled Pi packages.

- [x] Document the package's screen/action mental model, complete API, lifecycle and mode contract,
      settings-ownership boundary, specialized-UI escape guidance, installation, package layout,
      compatibility policy, and minimal new-extension example in
      `packages/pi-tui-kit/README.md`. Evidence: `test/readme-usage.ts` mirrors and typechecks
      the complete example against the exported API, and the packed README accompanies declarations.

- [x] Update `docs/extension-conventions.md`, `AGENTS.md`, root workspace documentation, and relevant
      command/pack references so new manager extensions prefer `@narumitw/pi-tui-kit` for the
      standard path while direct Pi controls remain allowed for tiny or specialized interactions.
      The guidance keeps commands, persistence, confirmations, and specialized UI extension-owned
      and retains independently installable extension boundaries.

- [x] Run `npm --workspace @narumitw/pi-tui-kit run check`, the pilot workspace typechecks,
      `npm run check:boundaries`, and the CI-equivalent `npm run check`. Evidence: the 14-file library
      check, both pilot typechecks, the boundary validator (1 library, 22 extensions), Biome (559
      files), all workspace typechecks, clean generated build, and all 1,746 tests passed.

- [x] Run dry-run packs for `@narumitw/pi-tui-kit`, Chrome DevTools, and Firecrawl and inspect
      their contents. Evidence: the library has 15 files limited to `dist` ESM/declarations,
      package metadata, README, and license; Chrome has 14 intended source/docs/metadata files;
      Firecrawl has 10. A clean project installed all three tarballs with deduplicated Pi `0.82.1`
      peers, imported the library from plain JavaScript, typechecked a TypeScript consumer, and loaded
      each pilot via offline non-interactive `pi --list-models`; interactive behavior is covered by
      focused TUI/RPC harness tests rather than a manual terminal smoke.

- [x] Audit the final diff against `docs/extension-conventions.md`,
      `docs/extension-settings.md`, Pi's TUI/package contracts, and this plan's ownership boundary.
      Evidence: settings transactions, file formats, direct routes, status/help copy, active-tool
      policy, and session generations remain pilot-owned; source search finds no custom/select loop in
      either migrated main/selector module; only the two planned pilots import the library; TUI uses
      callback theme/keybindings and width bounds; RPC and non-UI paths remain explicit.

## Completion Checklist

- [x] `packages/pi-tui-kit` is a publishable non-extension workspace with reproducible ESM and
      declaration output, correct peer/runtime metadata, focused tests, README, and license.
- [x] A new manager extension can define dynamic action/detail/settings/multi-select screens and
      action handlers without implementing its own render loop, navigation stack, keybindings,
      width handling, cancellation, disposal, or stale-continuation checks.
- [x] The public API keeps domain state, direct commands, confirmations, and settings persistence in
      the consuming extension and does not become a pass-through callback framework.
- [x] Chrome DevTools and Firecrawl use the shared contract, retain all established command,
      settings, tool, lifecycle, and mode behavior, and contain no superseded local menu engine.
- [x] Package boundaries still forbid extension-to-extension imports while permitting the helper
      library, and all workspaces remain independently installable.
- [x] Shared versioning, latest-Pi testing, release selection, and npm publication include
      `packages/*`, with dependencies published before consumers and private/deprecated workspaces
      still excluded.
- [x] Component and runtime tests prove bounded rendering, callback-provided theme/keybindings,
      Back/Close behavior, stable selection, settings callback ordering/rollback, TUI/RPC/non-UI
      handling, cancellation, disposal, and post-await stale guards.
- [x] Package checks, pilot typechecks, boundary validation, `npm run check`, three dry-run packs, and
      clean packed-tarball Pi load smokes have recorded passing evidence with no known required work
      remaining.
- [x] Documentation and repository instructions make the shared menu path the default for new
      manager extensions while preserving justified direct Pi-component escape hatches.
- [x] After every item is complete, move this plan to
      `docs/plans/archived/2026-07-28_pi-tui-kit-plan.md` without overwriting an existing
      archive.
