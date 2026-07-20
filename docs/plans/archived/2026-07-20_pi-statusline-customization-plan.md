## Goal

Make `@narumitw/pi-statusline` a configurable, single-renderer Tokyo Night footer driven only by `<getAgentDir()>/pi-statusline.json`, with atomic first-run defaults, structured segment text, transactional commands, and no classic preset or `PI_STATUSLINE_PRESET`.

## Architecture

- Normalize a canonical JSON document into field-level defaults for named palettes, density, separator, ordered and multiline segments, per-segment `prefix`/`suffix`, and extension icons.
- Preserve the existing legacy-filename migration, then atomically create a complete default document only when neither canonical nor legacy settings exist.
- Keep one Tokyo Night powerline renderer. Render segments in configured order as contiguous color blocks, using `prefix + dynamic value + suffix` and no format language.
- Use `/statusline settings|status|help`; settings edits validate the whole JSON document before atomic replacement and immediate runtime application.

## Non-Goals

- Do not retain classic/preset compatibility, read `PI_STATUSLINE_PRESET`, add project settings, arbitrary colors, labels, custom modules, or Starship grammar.
- Do not publish npm packages.

## Plan

- [x] Add failing settings tests for full/partial normalization, invalid fields, unknown preservation, environment independence, first-run creation, races, migration, and atomic failures; implemented the expanded settings model and persistence in `src/settings.ts`, then hardened invalid legacy migration, control text, and prototype-like icon keys.
- [x] Add failing renderer tests for configurable order/visibility, segment text, density, separators, named palettes, empty segments, and default-output compatibility; simplified types/renderers to one Tokyo Night path and removed classic, verified by renderer and existing regression tests.
- [x] Add failing command/lifecycle tests for `/statusline settings|status|help`, transactional application, non-TUI safety, first-run initialization, reload, and cleanup; implemented commands and mutable session configuration, verified by focused command/lifecycle tests and existing stale-session regressions.
- [x] Update package README and metadata-facing references to document the canonical JSON schema, first-run file, commands, accepted values, removed environment-variable interface, and conflict with `pi-starship`; verified against `DEFAULT_STATUSLINE_CONFIG` and package checks.
- [x] Run package formatting/typecheck, root tests/check, `just pack-statusline`, and a headless offline Pi RPC smoke; package check and `npm run check` passed with 842 tests, the 12-file tarball excludes tests/classic, and the smoke generated a 1,216-byte default config without publishing.

## Risks

- Existing `classic` users intentionally move to Tokyo Night with no compatibility alias.
- Atomic initialization must not overwrite malformed, unreadable, legacy, or concurrently created settings.
- Existing icon-only JSON and legacy migration must remain valid without freezing out new defaults.
- Configured segment order must not be silently regrouped by fixed block order.

## Completion Checklist

- [x] The only renderer is configurable Tokyo Night, verified by removal of the classic/preset source tree and passing renderer tests.
- [x] Canonical JSON initialization, validation, migration, preservation, and rollback are verified by focused settings tests and existing migration regressions.
- [x] Commands and lifecycle behavior are verified in TUI and non-TUI tests.
- [x] Removed interfaces have no active source or README references, verified by `rg` over `extensions/pi-statusline/src` and its README.
- [x] Package/root checks, 12-file dry-run packing, and isolated headless smoke pass with no npm publish.
