# ADR: Show callable tools and keep keyboard access to the widget

## Status

Accepted.

## Context

A tool can be callable through a codemode script without being active. Pi also
reports MCP tools configured for codemode with the runtime exposure
`deferred`. Using only the active set or filtering on just one of those
exposures would omit callable tools.

## Decision

Include both `codemode` and `deferred` tools alongside active tools. Use the
existing `/tool` manager as the keyboard route to expand the summary instead
of adding a command or changing tool availability.

Use the Kit widget as the width boundary: it normalizes the width before the
body callback wraps rows and clips output that cannot fit, including an
individual glyph wider than the row.

## Consequences

The display is not a count of model-active tools alone. Opening the manager can
expand the widget without changing settings or exposing any tool.
