# pi-tui-kit bounded multi-select plan

## Goal

Add a width- and height-bounded multi-select viewport with selected-row descriptions to
`@narumitw/pi-tui-kit`, so extensions can migrate tool permission catalogs without rendering every
registered tool at once. Preserve existing toggle/action semantics, stable cursor restoration,
ordered persistence callbacks, optimistic rollback, TUI/RPC adaptation, and source compatibility for
small existing consumers.

## Context

The current `multiSelect` component renders every toggle and action row. Page Up and Page Down jump to
the first or last row, and item descriptions declared by the shared item base type are not rendered.
This is acceptable for the current Chrome DevTools and Firecrawl catalogs, but Plan mode and Subagents
can expose an unbounded set of registered tools. Migrating those selectors directly would create
unbounded terminal height and hide source/risk details in long labels.

## Architecture

- Add an optional validated `viewportSize` to `MultiSelectScreen`, with a conservative default that
  leaves current small screens unchanged.
- Render a contiguous viewport centered around the selected row when possible, include textual
  position/scroll information when rows are omitted, and keep bulk action rows in the same stable id
  sequence.
- Render the selected item's optional sanitized description below the viewport, width-wrapped and
  non-color-dependent.
- Make Up/Down wrap as today. Define Page Up/Page Down as bounded viewport movement while retaining a
  deterministic first/last route through repeated paging; document the behavior and update injected
  keybinding tests.
- Preserve cursor identity across dynamic item insertion/removal through the existing navigator and
  `selectedItemId`, including when the remembered item is outside the first viewport.
- Keep RPC as a flat sequence of unique dialog choices; viewport size affects only TUI rendering.

## Non-Goals

- Search/filter input, arbitrary virtual lists, mouse scrolling, sorting, drag reordering, or grouped
  tree controls.
- Plan-mode or Subagents policy, persistence, tool discovery, labels, or confirmations.
- Changing action, settings, or detail screen layouts.

## Risks

- Off-by-one viewport math can hide the selected row or misreport position after dynamic changes.
- Changing Page Up/Page Down may surprise existing consumers. Cover the old small-list case and
  document the bounded-list behavior explicitly.
- Descriptions may contain terminal controls or very long source paths; reuse `safeMenuText()` and
  ANSI-aware width bounds without changing raw action payloads.
- Pending toggles can settle after the item leaves the viewport; rollback must still update the
  correct stable id and request a render.

## Plan

- [ ] Add failing model/component tests for invalid viewport sizes, long catalogs, first/middle/last
      viewport placement, selected descriptions, narrow widths, paging, dynamic item changes, stable
      selected ids, pending rollback off-screen, and unchanged small-list rendering.
- [ ] Extend the public multi-select type/model validation with optional `viewportSize` and implement
      bounded rendering, position text, and selected descriptions in `screen-components.ts`; verify
      the focused tests pass without changing RPC row identity.
- [ ] Add runtime tests for TUI navigation across viewport boundaries, Back/Close while work is
      pending, dynamic state refresh with cursor restoration, and equivalent RPC toggle/bulk actions.
- [ ] Update the README public API and multi-select example, including the TUI-only viewport behavior
      and guidance for large tool catalogs.
- [ ] Run package checks, root tests, root CI-equivalent checks, existing Chrome DevTools/Firecrawl
      consumer tests, and `just pack-tui-kit`; inspect declarations and tarball contents.
- [ ] Audit public API compatibility, width bounds, keybindings, cancellation, pending work,
      sanitization, and package conventions before archiving.

## Completion Checklist

- [ ] Large multi-select catalogs render within the configured/default viewport at narrow and wide
      widths, with the selected row always visible.
- [ ] Selected descriptions and scroll position are textual, sanitized, and width-safe.
- [ ] Stable ids, toggles, bulk actions, rollback, pending drain, Back/Close, and RPC behavior remain
      correct.
- [ ] Existing small consumers remain source-compatible and visually equivalent apart from documented
      injected-key paging behavior.
- [ ] Package/root checks, pilot tests, declarations, and pack inspection pass.
