# @narumitw/pi-typesafe-search

## 0.1.2

### Patch Changes

- 1f1c293: Update React to 19.3.1, Langfuse to 6.0, and the TypeSafe SDK to 0.7 in their respective packages. Preserve trace-only input and output updates, metadata encoding, and root observation detection with Langfuse 6. Accept unreported TypeSafe token usage without rejecting valid answers.

## 0.1.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.1.0

### Minor Changes

- 7513a67: Add SQLite FTS5 workspace search with TypeSafe Jev semantic screening and reranking.

### Patch Changes

- f6772fc: Harden search cancellation, concurrent index recovery, stale snapshot handling, path fidelity, and terminal-safe output.
