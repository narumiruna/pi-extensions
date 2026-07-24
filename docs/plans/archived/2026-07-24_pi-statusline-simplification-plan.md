# pi-statusline simplification plan

## Goal

Make `@narumitw/pi-statusline` feel like an opinionated, zero-configuration footer that is attractive,
useful, and predictable at common terminal widths, while preserving existing settings files and public
`/statusline settings|status|help` routes.

## Context

- The default footer currently enables 11 segments, including decorative and persistent idle content.
- `src/powerline.ts` truncates the completed row from the right, so narrow terminals can retain
  `brand` and `provider` while hiding later consequential information such as context usage and cost.
- The primary menu exposes a segment layout editor with visibility, ordering, move mode, and manual
  line breaks. Together with per-segment colors/text, density, separators, and status-icon matching,
  this makes the package feel closer to a statusline builder than a curated statusline.
- `pi-starship` already owns the fully configurable format/style use case. `pi-statusline` should
  differentiate itself through good defaults and shallow choices rather than another format grammar.
- Runtime installation is already modest: the package has no production dependencies, and Git work
  is cached outside footer rendering. This plan targets product and maintenance weight, not an
  unverified performance problem.

## Architecture

- Keep `src/render.ts` responsible for producing semantic segments and activity state.
- Add a small information-profile module that maps `minimal`, `balanced`, and `detailed` choices to
  existing `segments` arrays; do not add another persisted settings field. Infer the current profile
  from the effective segment array and report `custom` when it does not match a profile.
- Keep `src/powerline.ts` responsible for styling, but fit each configured row by segment priority
  before final truncation. Preserve configured order and explicit `line_break` boundaries among the
  segments that remain visible.
- Keep the current settings parser, atomic persistence, palette presets, extension statuses, and
  compatibility routes. Place arbitrary layout and JSON editing behind a labeled Advanced submenu.

## Non-Goals

- Removing or renaming existing JSON fields, segment names, palette names, or compatibility routes.
- Replacing `pi-starship` or adding a new format/style language.
- Adding project settings, environment overrides, dependencies, telemetry, or terminal-width
  persistence.
- Removing the existing custom segment editor in this compatibility-focused iteration.
- Changing the current first-start settings-file creation or legacy-file migration behavior.

## Assumptions

- This iteration is backward compatible: existing valid `pi-statusline.json` documents continue to
  load and save without migration.
- The curated `balanced` profile becomes the default for newly created/default configurations;
  existing explicit `segments` arrays remain unchanged.
- Activity is contextual: the tools segment appears while the model is streaming or tools are active,
  and disappears when idle instead of retaining `idle` or the last completed tool.
- Responsive fitting protects primary and safety information ahead of decorative/supporting data.
  The exact priority table will be encoded in tests and documented rather than exposed as another
  user setting.

## Risks

- Responsive omission can surprise users who expect every configured segment at every width. Mitigate
  this by preserving wide-layout output, explicit row boundaries, and configured order, and by
  documenting the narrow-width policy.
- Mapping profiles directly to `segments` means selecting a profile intentionally replaces a custom
  layout. Show the exact profile contents before applying and leave cancellation non-mutating.
- Simplifying the default document changes new-user output. Cover built-in defaults separately from
  user-authored settings so existing files are not silently rewritten.
- Moving controls under Advanced can reduce discoverability for expert users. Keep a labeled shallow
  path and retain direct `/statusline settings` compatibility.

## Rollback / Recovery

- The implementation must not rewrite existing settings on startup; only an explicit menu action may
  save a profile or custom-layout change.
- Each interactive save continues using the existing atomic save/apply/rollback path. A failed save or
  runtime application restores the previous document and effective configuration.
- If responsive fitting causes an unacceptable regression, it can be reverted independently without
  changing persisted settings because no responsive policy is stored in JSON.

## Plan

- [x] Add focused tests in `extensions/pi-statusline/test/renderer.test.ts` and
  `extensions/pi-statusline/test/statusline.test.ts` for widths representative of narrow, normal, and
  wide terminals; require every line to fit, wide rows to preserve all configured segments, narrow
  rows to retain model/location/context and active safety/status information before decorative data,
  and explicit `line_break` boundaries to remain stable. Evidence: focused renderer/statusline runs
  passed 44 tests across 15–120-column cases and explicit multiline layouts.
- [x] Add `extensions/pi-statusline/src/information-profiles.ts` defining `minimal`, `balanced`, and
  `detailed` segment arrays plus profile inference; verify exact profile membership, deterministic
  order, and `custom` inference with focused unit tests. Evidence: the focused compiled
  `information-profiles.test.js` run passed 2 tests.
- [x] Change the built-in/default `segments` in `extensions/pi-statusline/src/settings.ts` to the
  balanced profile without changing normalization or existing user documents; verify missing-file,
  first-start document creation, and explicit legacy/custom segment tests distinguish new defaults
  from preserved user settings. Evidence: focused settings and lifecycle-settings runs passed 22
  tests, including first-start creation and explicit settings preservation.
- [x] Refactor activity state in `extensions/pi-statusline/src/render.ts` and
  `extensions/pi-statusline/src/statusline.ts` so `tools` renders only during streaming or active tool
  execution and no longer stores or displays idle/last-completed state; verify streaming, parallel
  tools, completion, agent end, session replacement, and shutdown transitions. Evidence: the focused
  statusline run passed 28 tests, including a new full activity/session lifecycle test.
- [x] Implement priority-based row fitting in `extensions/pi-statusline/src/powerline.ts` (or a focused
  helper module) that repeatedly renders and removes the lowest-priority configured segment until the
  row fits, preserving order and recomputing block transitions; verify ANSI-aware width, custom
  palettes, single oversized segments, empty rows, and all existing line-break behavior. Evidence:
  responsive tests first failed under right-edge clipping, then the focused renderer/statusline run
  passed all 44 tests with ANSI-aware fitting and existing palette/line-break coverage.
- [x] Simplify `extensions/pi-statusline/src/commands.ts` so the main menu presents current Appearance,
  Information level, Advanced, Status, and Help; add a profile picker that previews the exact segment
  set and saves only on confirmation, and move Custom layout plus Edit settings JSON into one shallow
  Advanced submenu while retaining existing direct subcommands. Evidence: focused command tests show
  the five-item primary menu, exact profile preview, shallow Advanced/Back flow, and retained routes.
- [x] Update command tests in `extensions/pi-statusline/test/commands.test.ts` for profile inference,
  profile replacement confirmation/cancellation, Advanced navigation and return paths, immediate
  atomic application, rollback on failure, narrow rendering, and unchanged non-TUI/direct-route
  behavior. Evidence: the focused compiled command suite passed all 20 tests, including the new
  profile, Advanced/Back, failure, existing narrow custom-layout, RPC, and compatibility cases.
- [x] Rewrite the opening, Features, Configuration, Segments, Commands, and Git/activity sections of
  `extensions/pi-statusline/README.md` around zero-config use, the three information levels,
  responsive priority, and contextual activity; retain a clearly labeled Advanced reference for every
  backward-compatible JSON capability and keep the `pi-starship` product boundary explicit. Evidence:
  the README now leads with zero-config use, profiles, width policy, and contextual activity, with
  separate Advanced appearance/layout/icon references and an explicit pi-starship boundary.
- [x] Audit the simplified surface against `docs/extension-conventions.md` and
  `docs/extension-settings.md`; verify the command remains menu-first, Advanced is labeled and shallow,
  cancellation preserves state, no destructive/default action is introduced, non-TUI routes remain
  observable, and all rendered lines remain within callback width. Evidence: command tests cover the
  primary/Advanced/Back hierarchy, cancel/failure rollback, RPC/direct routes, and 20-column UI; footer
  tests cover 15–120 columns, and package/root checks passed all UI and boundary validators.
- [x] Run focused package checks with
  `npm run check --workspace @narumitw/pi-statusline` and the relevant compiled statusline tests, then
  run the repository CI-equivalent `npm run check`; record any unavailable check rather than marking
  it complete. Evidence: package Biome/typecheck passed, the focused compiled statusline suite passed
  89 tests, and the root CI-equivalent passed all 1,197 tests.
- [x] Run `just pack-statusline` and inspect the dry-run tarball for the declared entrypoint, all source
  modules (including the new profile module), README, and LICENSE, with no test or generated settings
  artifacts included. Evidence: the final dry run produced 25 files/31.0 kB, including `src/index.ts`,
  `src/information-profiles.ts`, all preset/runtime sources, README, and LICENSE, with no tests or
  generated settings.

## Completion Checklist

- [x] New users receive the balanced curated layout without editing JSON; existing settings files and
  established command routes remain compatible. Verified by settings/lifecycle and route tests.
- [x] Minimal, balanced, detailed, and custom layouts are recognizable from the menu, and selecting a
  profile is explicit, cancellable, atomically saved, and immediately applied. Verified by profile and
  command tests.
- [x] Narrow footers preserve primary/safety information instead of blindly clipping the configured
  right edge, while wide and explicit multiline layouts remain predictable. Verified at 15–120
  columns with ANSI-width assertions.
- [x] Idle and last-completed tool text no longer consume permanent footer space; streaming and active
  tools remain visible at the relevant time. Verified across agent/tool/session lifecycle tests.
- [x] Advanced palette, layout, text, separator, density, and status-icon capabilities remain reachable
  and documented without dominating the primary workflow. Verified by menu tests and README review.
- [x] `npm run check` passes, `just pack-statusline` contains only intended publish files, and no
  unrelated repository files are modified. Verified by the 1,197-test root gate, boundary check,
  25-file pack dry run, `git diff --check`, and changed-path audit.
