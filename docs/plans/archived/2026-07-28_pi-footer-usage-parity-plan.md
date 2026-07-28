## Goal

Bring `pi-statusline` and `pi-starship` closer to Pi's native footer usage display while keeping the
existing `context` names and using only the public Pi 0.82.1 extension API.

Success means both extensions expose cumulative cache reads/writes, the latest assistant cache-hit
rate, and the current subscription marker; both use native one-decimal context percentages, and
`pi-statusline` also renders native-style context `percentage/window` by default. Input, output, cache, and cost totals use the same session-entry scope as Pi's
native footer.

## Context

GitHub issue [#447](https://github.com/narumiruna/pi-extensions/issues/447) requests a configurable
`cache` module for `pi-starship`, and its follow-up requests equivalent support in `pi-statusline`.
The current extensions sum only assistant messages on the active branch, while Pi's native footer
sums all session entries with usage: assistant messages, usage-bearing tool results, compactions, and
branch summaries. Pi computes `CH` from the latest assistant message rather than from cumulative
cache totals.

Pi exposes the required usage through `ctx.sessionManager`, context data through
`ctx.getContextUsage()`, and OAuth state through `ctx.modelRegistry.isUsingOAuth()`. It does not expose
the current `autoCompactionEnabled` value through `ExtensionContext`, so reliable `(auto)` parity is
outside this plan.

Applicable convention areas are custom footer rendering, settings validation and menus,
documentation, and deterministic tests. No command routes, persistence protocol, dependencies,
package metadata, background tasks, or session-owned resources need to change.

## Architecture

- Give each independently installable extension a package-local, synchronous usage summarizer. Do
  not introduce an extension-to-extension dependency merely to share this small policy.
- Summarize `ctx.sessionManager.getEntries()` in append order, matching the native footer:
  assistant usage contributes totals and replaces the latest cache-hit rate; tool-result,
  compaction, and branch-summary usage contributes totals without replacing that rate.
- Calculate the latest rate as
  `cacheRead / (input + cacheRead + cacheWrite) * 100` when the latest assistant prompt total is
  positive. Keep cumulative `cacheRead` and `cacheWrite` independent from that latest rate.
- Derive subscription state synchronously from the current model:
  `provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model)`. Treat the displayed cost as
  Pi's usage cost, not proof of an amount billed under a subscription.
- Keep footer rendering pure and synchronous. The new values come from immutable session/model data
  already available during render; no file reads, subprocesses, network calls, watchers, timers, or
  new lifecycle cleanup are introduced.
- Keep `pi-statusline`'s `context` segment and `pi-starship`'s `context` module names unchanged.

### pi-statusline presentation

- Add a `cache` segment in the runtime block. Hide it when cumulative cache read and write are both
  zero; otherwise render available native tokens in `R… W… CH…` order, omitting each unavailable
  value.
- Give `cache` the default presentation prefix `📦 `, named-preset runtime colors, and responsive
  retention immediately below `provider` and above `tokens`.
- Keep the zero-config `balanced` profile unchanged. Add `cache` after `tokens` in `detailed`, and
  expose it in the existing Custom layout screen through the catalog-derived segment list.
- Render `context` as one-decimal `percentage/window` (for example `2.4%/272k`), using `?` when the
  percentage is unknown and the active model's context window as fallback when the usage snapshot
  lacks it.
- Append ` (sub)` to the configured `cost` segment value when the current model is subscription
  backed.

### pi-starship presentation

- Add a catalog-owned `cache` module after `tokens` and before `cost`, with `$rate`, `$read`, and
  `$write` plus the standard `$symbol` and `$style` behavior.
- Keep `[cache].disabled = true` by default. Include `$cache` in the built-in root format so setting
  only `disabled = false` activates it for users who otherwise inherit the built-in layout; custom
  root formats must still reference `$cache` or `$all` according to normal pi-starship semantics.
- Return no cache module values when cumulative cache activity is zero so explicit references,
  conditional groups, and `$all` do not leave an empty styled block. Preserve `$read`/`$write` for
  custom formats even when a latest rate is unavailable.
- Add `$subscription` to the `cost` module. It resolves to `(sub)` or empty, and the default cost
  format shows it conditionally without changing API-key output.
- Retain the existing `[context]` module and its `$percentage`, `$tokens`, and `$window` variables;
  use native one-decimal percentage precision and document how to opt into `percentage/window`
  without renaming it to `[context_usage]`.

## Non-Goals

- Reading Pi settings to guess auto-compaction state or displaying `(auto)`. This remains blocked on
  a public Pi extension API and should not be approximated with potentially stale file settings.
- Renaming `context` to `context_usage` or adding a compatibility alias.
- Combining cache tokens into the existing input/output token totals; `input`, `cacheRead`, and
  `cacheWrite` remain distinct Pi usage fields.
- Changing the zero-config `pi-statusline` information level or enabling pi-starship cache output by
  default.
- Adding provider-specific cache calculations when a provider reports no cache usage.

## Assumptions

- Native parity means all persisted session entries, including entries on abandoned branches,
  because that is what Pi's current footer uses. Existing extension token and cost totals will
  intentionally change from active-branch assistant-only totals.
- Existing user documents remain authoritative: adding a recognized segment/module does not insert
  it into an explicitly saved custom layout, except when the user selects the updated Detailed
  profile or enables/references the new module.
- Existing count formatting remains extension-owned unless a focused parity test proves a material
  mismatch; this work does not broadly rename `m`/`M` suffixes.

## Risks

- Changing the aggregation scope can increase displayed token and cost totals for branched sessions
  or sessions with summarization/tool-owned LLM usage. Documentation and tests must make this
  intentional semantic change explicit.
- A cache segment can consume substantial width. It must participate in responsive removal and must
  disappear completely when idle so balanced or multiline layouts do not gain blank blocks/rows.
- A last assistant message with zero prompt usage can make `CH` unavailable even when cumulative
  `R`/`W` values exist. Tests must keep cumulative and latest-message semantics separate.
- Adding `cache` to recognized settings changes validation of that formerly unknown name. Existing
  malformed-file protection, unknown-field preservation, atomic saves, and rollback behavior must
  remain untouched and continue passing their current suites.

## Plan

- [x] Add failing package-local usage-summary tests for `pi-statusline` and `pi-starship` covering
  assistant, usage-bearing tool result, compaction, and branch-summary totals; abandoned-branch/all-
  entry scope; latest-message `CH`; cumulative `R`/`W`; zero prompt usage; and no cache activity, then
  implement the smallest synchronous summarizers under each package's `src/` and verify the red/green
  cycle with `npm test`.
- [x] Replace the assistant-only aggregation in `extensions/pi-statusline/src/render.ts` and
  `extensions/pi-starship/src/pi-starship.ts` with their package-local summaries so tokens, cache, and
  cost share one native-aligned source of truth; add lifecycle/render fixtures proving tool and
  summary usage is counted exactly once and active-branch-only expectations are intentionally gone.
- [x] Add `cache` to pi-statusline's segment types, default `segmentText`, preset block mapping,
  renderer, responsive priority, and Detailed information profile; verify settings normalization,
  first-save/default-document shape, Custom layout availability, named/custom palette behavior,
  profile inference, empty-segment suppression, multiline row collapse, and narrow-width removal in
  `extensions/pi-statusline/test/`.
- [x] Change pi-statusline's `context` renderer to native-style one-decimal
  `percentage/contextWindow` with unknown and model-window fallback cases, and append ` (sub)` to cost
  for OAuth and `kimi-coding` models; extend `test/support.ts` with a deterministic
  `modelRegistry.isUsingOAuth()` mock and verify API-key, OAuth, Kimi, missing-model, post-compaction
  unknown-context, and responsive-width cases.
- [x] Create `extensions/pi-starship/src/modules/cache.ts`, extend the runtime snapshot, register the
  module after `tokens`, include disabled `$cache` reachability in the built-in root format, and give
  context `$percentage` native one-decimal precision; verify catalog order, default-disabled behavior,
  explicit enablement, `$all`, no-activity hiding, latest-rate formatting, cumulative `$read`/`$write`,
  context `percentage/window`, custom symbol/style/format, and invalid TOML diagnostics in
  `extensions/pi-starship/test/config.test.ts` and `modules.test.ts`.
- [x] Extend pi-starship's `cost` module with conditional `$subscription` output and populate the
  runtime snapshot through the public OAuth check plus the Kimi special case; verify unchanged API-
  key output, OAuth/Kimi `(sub)` output, zero-cost subscription output, and custom cost formats through
  module and lifecycle tests.
- [x] Update `extensions/pi-statusline/README.md` and `extensions/pi-starship/README.md` with cache
  semantics and ordering, the latest-message hit-rate formula, all-entry totals, subscription-cost
  caveat, configuration examples, updated segment/module variables and defaults, responsive priority,
  and the explicit limitation that `(auto)` is unavailable through Pi's extension API; verify the
  documented names remain `context`, `[context]`, and `$context`.
- [x] Audit the final diff against `docs/extension-conventions.md` and
  `docs/extension-settings.md`: confirm render purity and width bounds, no new lifecycle resources,
  side-effect-free settings loads, malformed-file protection, unknown-field preservation, atomic
  save/rollback behavior, command-mode behavior, and unchanged package boundaries; record any
  accepted deviation or unverified path in the handoff.
- [x] Run focused workspace checks (`npm run check --workspace @narumitw/pi-statusline` and
  `npm run check --workspace @narumitw/pi-starship`), root tests (`npm test`), and the CI-equivalent
  `npm run check`; leave any failed or unavailable check open with its exact evidence.
- [x] Run `just pack-statusline` and `just pack-starship`, inspect both dry-run manifests for intended
  source/docs/license contents and no generated or unrelated files, then run non-interactive Pi load
  smokes for both declared entrypoints. Record the footer's interactive visual smoke as unverified
  unless a maintainer performs it, because automated execution must not open a TUI.

## Execution Evidence

- TDD red states were observed for missing `usage.ts`, the absent `cache` segment/module, and
  Starship's prior integer-only context percentage (`2%` instead of `2.4%`).
- Focused compiled suites passed for both packages: 214 statusline/starship tests together, plus the
  final 16-test Starship module rerun after the custom style assertion.
- `npm run check --workspace @narumitw/pi-statusline` and
  `npm run check --workspace @narumitw/pi-starship` passed with Biome and TypeScript.
- `npm test` and the CI-equivalent `npm run check` each passed all 1,777 tests.
- `just pack-statusline` inspected 26 intended files, including `src/usage.ts`; `just pack-starship`
  inspected 56 intended files, including `src/usage.ts` and `src/modules/cache.ts`.
- Isolated non-interactive Pi load smokes completed for both declared entrypoints with
  `--no-extensions -e <package> --list-models` and temporary agent directories.
- Final convention/settings review found no deviation: rendering remains synchronous and width-
  bounded, no lifecycle resources or command routes changed, settings persistence paths are
  untouched, and existing malformed-file/rollback/session lifecycle suites remain green.
- Interactive visual TUI smoke remains intentionally unrun because automated commands must not open
  a TUI; deterministic footer render, responsive-width, lifecycle, and entrypoint smokes cover the
  changed behavior.

## Completion Checklist

- [x] Both extensions count input, output, cache read/write, and cost from the same usage-bearing
  session entries as Pi's native footer, proven by mixed-entry and branching fixtures.
- [x] Both extensions distinguish cumulative cache activity from the latest assistant cache-hit rate
  and hide cache output when no cache activity exists.
- [x] pi-statusline exposes `cache` in Detailed/Custom layouts, renders `context` as
  `percentage/window`, marks subscription cost, and still fits every tested terminal width.
- [x] pi-starship accepts `[cache]`, exposes `$rate`/`$read`/`$write`, keeps it disabled by default,
  and exposes conditional `$subscription` from `[cost]` without changing existing `[context]` names.
- [x] Existing settings files remain valid and are not rewritten merely by loading; malformed-file,
  unknown-field, atomic-write, rollback, preview, cancellation, session replacement, and shutdown
  tests remain green.
- [x] Both English READMEs document behavior, defaults, formula, configuration, scope change,
  subscription caveat, and the intentionally unsupported `(auto)` marker.
- [x] `npm test`, `npm run check`, `just pack-statusline`, and `just pack-starship` pass with inspected
  output; any skipped runtime visual smoke is explicitly reported.
