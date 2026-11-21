# ADR: Use confirmed cache-warm usage in the cache hit monitor

## Status

Accepted.

## Context

Pi's public extension API provides a mutable cache-warming decision hook, but
not a warm-completion event. A decision can change, and an approved warm may
fail. Inferring completion from that hook or elapsed time can count a request
that did not finish.

## Decision

Rebuild from persisted active-branch usage when the session starts, the tree or
compaction changes, the agent settles, or the user shows the widget. Count warm
usage in totals, not as a conversational sample.

At the presentation boundary, keep the full report, including the calculation
formula, for RPC. In TUI, use the widget divider for the request summary and
leave the body for the latest model and metrics. Give the Kit widget the
wrapping callback so it can normalize invalid and fractional widths before
wrapping and bound the finished rows.

## Consequences

Totals use confirmed records. A warm that finishes while Pi is idle and the
widget is visible may not appear until the next reconciliation.
