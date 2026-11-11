# @narumitw/pi-typesafe

## 0.1.3

### Patch Changes

- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- 5120d4d: Preserve TypeBox enum inference for direct imports and Pi's extension loader without changing provider-visible schemas or validation rules. Import Notes schemas from TypeBox, declare its host-provided peer, and complete Worktree's command result contract for the updated Pi APIs.

## 0.1.2

### Patch Changes

- 1f1c293: Update React to 19.3.1, Langfuse to 6.0, and the TypeSafe SDK to 0.7 in their respective packages. Preserve trace-only input and output updates, metadata encoding, and root observation detection with Langfuse 6. Accept unreported TypeSafe token usage without rejecting valid answers.

## 0.1.1

### Patch Changes

- afec31b: Use the official TypeSafe JavaScript SDK for direct TypeSafe requests while retaining the opt-in OpenRouter transport, strict response validation, bounded I/O, cancellation, and disabled automatic retries.

## 0.1.0

### Minor Changes

- 7baa014: Add a Pi extension with a `typesafe_question` tool that exposes typed Jev decisions through TypeSafe's official API, offers an experimental OpenRouter fallback enabled through package-owned settings, and bundles a TypeSafe skill with local design, integration, migration, and cookbook references.

### Patch Changes

- ab0d1bf: Restrict malformed-settings lifecycle diagnostics to print and JSON modes so unsupported headless contexts continue with defaults.
