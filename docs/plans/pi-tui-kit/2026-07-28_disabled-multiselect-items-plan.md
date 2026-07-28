# pi-tui-kit explained disabled multi-select items plan

## Goal

Make the existing disabled state on `@narumitw/pi-tui-kit` multi-select rows explicit and explainable,
so a consumer can disclose known but unavailable or policy-blocked choices without allowing them to
be toggled. Preserve stable identity, selection visibility, callback ordering, TUI/RPC parity, and
compatibility for all existing multi-select definitions.

## Context

Plan mode's tool catalog deliberately lists built-in tools that policy blocks, explains why they are
blocked, and refuses activation. `MenuMultiSelectItem` already inherits `disabled?: boolean` from the
shared item base, and the current TUI/RPC runtimes skip its toggle callback. The row, however, renders
like an enabled checkbox and has no dedicated reason, so users cannot tell why activation did nothing.
Omitting blocked tools would hide consequential policy information; modelling them as action rows
would lose checkbox semantics and weaken the domain model.

This feature is independent of the bounded viewport plan: one makes existing capability state
observable, while the other controls large-list presentation. Plan mode requires both before
migrating its tool selector.

## Architecture

- Retain the existing `disabled?: boolean` contract and add only optional `disabledReason` to
  `MenuMultiSelectItem`; omission remains source-compatible and no competing `enabled` field is
  introduced.
- Keep disabled rows focusable so keyboard and RPC users can inspect their description/reason, but
  render an explicit non-color marker and muted text and never invoke `onToggle` for them.
- Use the standard selected-item description area for the reason in TUI. In RPC, keep the item visible
  with an unambiguous unavailable label and return to the same screen without invoking domain code if
  the client selects it.
- Preserve the raw item id and payload; sanitize only displayed labels/reasons.
- Treat disabled-state changes as ordinary screen-state refreshes. Cursor identity remains on the
  stable id, selected state remains consumer-authoritative, and action handlers still revalidate
  domain policy before mutation.

## Non-Goals

- Encoding tool-risk policy, permissions, prerequisites, or confirmation behavior in the kit.
- Hiding disabled items, adding tooltips, or adding arbitrary row callbacks.
- Changing action-row enablement, settings items, or other screen kinds.

## Risks

- A disabled row can become enabled while an older render is open. Resolve current state and enabled
  status at activation time before dispatching a toggle.
- RPC dialogs do not expose native disabled choices. The adapter must make the state observable and
  no-op safely without creating an infinite automatic loop.
- Bulk consumer actions may accidentally include disabled ids. Document that the consumer remains
  authoritative and add examples that derive bulk sets from enabled rows only.

## Plan

- [ ] Add failing model/component/runtime tests for inherited `disabled` compatibility, focused
      disabled rows, textual reasons, Enter/Space no-op, refreshed disabled state, raw ids,
      sanitization, RPC visibility/no-op, and no `onToggle` calls for disabled rows.
- [ ] Extend `MenuMultiSelectItem` with `disabledReason` validation and implement explicit disabled
      rendering in TUI and RPC while preserving the existing activation guard, enabled-row callback
      serialization, and rollback behavior.
- [ ] Add a large-catalog integration fixture combining disabled rows with the bounded viewport so
      off-screen blocked choices, descriptions, paging, and cursor restoration compose correctly.
- [ ] Update the README API reference and example, including bulk-action guidance and the RPC
      representation.
- [ ] Run package/root checks, existing Chrome DevTools/Firecrawl tests, declarations inspection, and
      `just pack-tui-kit`; verify no existing consumer source change is required.
- [ ] Audit API compatibility, accessibility, sanitization, activation-time state, pending work,
      TUI/RPC modes, and package conventions before archiving.

## Completion Checklist

- [ ] Disabled rows are visible, focusable, explained, and impossible to toggle in TUI and RPC.
- [ ] Existing `disabled?: boolean` definitions stay source-compatible; no second enablement flag is
      introduced.
- [ ] Enabled rows retain current toggle, action, rollback, ordering, and cancellation semantics.
- [ ] Refreshed state and bounded viewport composition use stable ids without stale activation.
- [ ] Existing consumers compile and pass unchanged; checks, declarations, and pack inspection pass.
