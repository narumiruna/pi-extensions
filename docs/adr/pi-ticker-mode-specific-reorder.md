# ADR: Use different reorder controls for TUI and RPC Ticker menus

## Status

Accepted.

## Context

The Kit multi-select screen does not support reordering a focused row in place.
RPC dialogs also cannot dispatch inline TUI key events.

## Decision

Use a dedicated TUI screen for inline reorder and keep Kit dialogs with explicit
move actions for RPC. Both routes use the same ordered ticker settings and save
flow; they do not promise identical input affordances. Reorder shortcuts are
additive: they must not take over configured navigation or native input actions.

## Consequences

The TUI owns the key precedence and must account for any earlier host listener,
not just the focused selector and input. The local shortcut check currently
misses some fullscreen collisions; see [#1983][issue].

[issue]: https://github.com/narumiruna/pi-extensions/issues/1983
