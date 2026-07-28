# Remaining pi-tui-kit migrations plan

## Goal

Coordinate migration of every active or experimental extension that still owns a standard action,
detail, settings, or multi-select menu to `@narumitw/pi-tui-kit`, while leaving genuinely specialized
editors, previews, overlays, confirmations, and one-off prompts extension-owned. Execute each package
through its linked package-specific plan so command, mode, settings, lifecycle, and safety behavior
remain independently verifiable.

## Context

The active workspace contains 22 extensions. `pi-chrome-devtools` and `pi-firecrawl` already depend on
`@narumitw/pi-tui-kit`. `pi-sync` has a saved migration plan at
`docs/plans/pi-tui-kit/2026-07-28_pi-sync-tui-kit-migration-plan.md`.

### Migration plans

| Package | Standard surface to migrate | Plan |
| --- | --- | --- |
| `pi-accounts` | account manager and provider/account choices | `2026-07-28_pi-accounts-tui-kit-migration-plan.md` |
| `pi-caffeinate` | controls and mode menu | `2026-07-28_pi-caffeinate-tui-kit-migration-plan.md` |
| `pi-goal` | goal manager, queue, settings, limit choices | `2026-07-28_pi-goal-tui-kit-migration-plan.md` |
| `pi-google-genai` | persistent tool multi-select | `2026-07-28_pi-google-genai-tui-kit-migration-plan.md` |
| `pi-image-drop` | main/status/help/settings/limits standard screens | `2026-07-28_pi-image-drop-tui-kit-migration-plan.md` |
| `pi-langfuse` | context-aware tracing controls | `2026-07-28_pi-langfuse-tui-kit-migration-plan.md` |
| `pi-plan-mode` | command and settled ready menus plus tool multi-select | `2026-07-28_pi-plan-mode-tui-kit-migration-plan.md` |
| `pi-starship` | main/advanced/detail/help standard navigation | `2026-07-28_pi-starship-tui-kit-migration-plan.md` |
| `pi-statusline` | main/advanced standard navigation | `2026-07-28_pi-statusline-tui-kit-migration-plan.md` |
| `pi-subagents` | manager, settings, agent lists, and tool draft | `2026-07-28_pi-subagents-tui-kit-migration-plan.md` |
| `pi-sync` | manager, resources, settings, Included Content | `2026-07-28_pi-sync-tui-kit-migration-plan.md` |
| `pi-usage` | usage actions and provider selection | `2026-07-28_pi-usage-tui-kit-migration-plan.md` |
| `pi-worktree` | current-state action menu | `2026-07-28_pi-worktree-tui-kit-migration-plan.md` |
| experimental `pi-jupyter` | current-state menu, notebook picker, help | `2026-07-28_pi-jupyter-tui-kit-migration-plan.md` |
| experimental `pi-webui` | current-state menu, detail, settings | `2026-07-28_pi-webui-tui-kit-migration-plan.md` |

### No migration planned

- `pi-btw` is a specialized side-thread workspace with editor preservation, transcript paging,
  exact line/character selection, and editable bring-to-main previews. Its small action selectors are
  coupled to that custom workspace and remain extension-owned under the kit ownership boundary.
- `pi-github-pr`, `pi-lsp`, and `pi-retry` do not own a standard interactive manager/menu surface.
- Experimental `pi-file-context` is a specialized fuzzy file explorer, Git/history viewer, and line
  range selector rather than a standard action/detail/settings/multi-select flow.

Three shared features are required before the lifecycle/large-catalog migrations:

- typed support for menus launched from `ExtensionContext` lifecycle handlers, planned in
  `docs/plans/pi-tui-kit/2026-07-28_extension-context-plan.md` and required by Plan mode;
- a bounded multi-select viewport with selected-row descriptions, planned in
  `docs/plans/pi-tui-kit/2026-07-28_bounded-multiselect-plan.md` and required by Plan mode and
  Subagents;
- disabled multi-select rows that disclose blocked choices without toggling them, planned in
  `docs/plans/pi-tui-kit/2026-07-28_disabled-multiselect-items-plan.md` and required by Plan mode.

Other migrations use the current kit API and must not add package-specific hooks to the library.

## Architecture

- Keep one independently installable runtime dependency per migrated extension using the repository's
  pre-1 `<1` compatibility range.
- Migrate standard screen rendering and navigation only. Keep settings files, persistence, domain
  state, confirmations, secret input, specialized components, operation loaders, and session policy
  in the consuming extension.
- Require every `runMenu()` call to receive the extension's session/request signal and an ownership
  guard. Add a package-local controller only where the existing lifecycle has no abortable menu owner.
- Preserve established direct routes, completions, TUI/RPC/print/JSON behavior, and package docs.
  A migration may fix a touched mode path that currently relies on no-op UI output, but it must add an
  explicit compatibility test and document the observable rejection or fallback.
- Execute packages independently. Do not combine unrelated migrations into one implementation PR;
  shared kit work lands and passes first, followed by consumers that require it.

## Non-Goals

- Forcing specialized editors, sortable layouts, previews, overlays, masked inputs, or transactional
  persistence into generic kit abstractions.
- Redesigning approved product information architecture while replacing rendering/navigation code.
- Removing direct routes or changing settings, credentials, state, remote data, tool names, or
  lifecycle semantics.
- Migrating deprecated packages under `deprecated/`.

## Risks

- Shared-library defects affect every consumer; land the context-generic feature with direct contract
  tests before Plan mode consumes it.
- Label-driven legacy tests can hide identity collisions. Migrated screens must use stable ids and
  retain raw domain mappings separately from sanitized labels.
- Generic busy actions can conflict with extension-owned commit boundaries or loaders. Keep those
  specialized flows outside `busyLabel` unless their signals and cancellation semantics match.
- RPC adaptation can accidentally expand a TUI-only settings mutation surface. Preserve each
  package's documented mode contract explicitly.
- Large migrations can obscure lifecycle regressions. Use one package plan and focused diff at a time.

## Plan

- [ ] Implement and verify `docs/plans/pi-tui-kit/2026-07-28_extension-context-plan.md` before starting
      `pi-plan-mode`; evidence must include backwards-compatible type fixtures, runtime lifecycle
      tests, package checks, and a pack inspection.
- [ ] Implement and verify `docs/plans/pi-tui-kit/2026-07-28_bounded-multiselect-plan.md` before migrating the
      Plan mode or Subagents tool catalogs; evidence must include bounded rendering, dynamic cursor,
      pending rollback, pilot compatibility, package checks, and a pack inspection.
- [ ] Implement and verify `docs/plans/pi-tui-kit/2026-07-28_disabled-multiselect-items-plan.md` before
      migrating the Plan mode tool catalog; evidence must cover TUI/RPC no-op behavior, dynamic
      enablement, bounded composition, pilot compatibility, package checks, and pack inspection.
- [ ] Execute the production extension migration plans independently, keeping each package's focused
      tests, CI-equivalent checks, pack inspection, and runtime smoke recorded in that plan before it
      is archived.
- [ ] Execute the experimental `pi-jupyter` and `pi-webui` plans with their runtime warning, shared
      versioning, browser/overlay boundaries, generated assets, and experimental documentation intact.
- [ ] After all package plans complete, rescan active manifests and source for standard menu loops,
      direct `SettingsList`/`SelectList` wrappers, and `ctx.ui.select()` loops; classify every remaining
      occurrence as one-off/specialized or migrate it through a new bounded follow-up plan.
- [ ] Run `npm run check`, inspect every migrated package with its `pack:*` dry run, and verify the
      dependency/publish ordering lists `pi-tui-kit` before all changed consumers.

## Completion Checklist

- [ ] Every package in the migration table has completed and archived its package-specific plan.
- [ ] The shared ExtensionContext feature is complete before Plan mode consumes it.
- [ ] The bounded multi-select feature is complete before Plan mode or Subagents consumes it.
- [ ] Disabled multi-select items are complete before Plan mode consumes them.
- [ ] `pi-chrome-devtools` and `pi-firecrawl` remain passing reference consumers.
- [ ] Every remaining non-kit UI occurrence has a reviewed specialized/one-off rationale recorded in
      this inventory or its owning package documentation.
- [ ] Root checks, package previews, runtime smokes, and the final conventions audit pass without an
      unexplained mode, lifecycle, settings, or publishing deviation.
