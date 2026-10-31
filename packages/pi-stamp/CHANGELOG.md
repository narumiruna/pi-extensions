# @narumitw/pi-stamp

## 0.54.0

### Minor Changes

- ced6be5: Add a main-menu Presets action with Compact, Model, Usage, Cost, Abnormal, Detailed, and None starting points for assistant metadata and independent Settings controls for layout, model provenance, token fields, call cost, stop reasons, and opt-in debug data. Preserve legacy metadata settings on read and translate them on the next explicit save without changing unrelated settings. Require the TUI Kit fixes for bounded menus and readable settings values at narrow widths. Keep action-screen summaries concise, describe every main-menu action, and mark the current preset. Apply preset changes immediately to the original right-aligned transcript Stamp rows as the TUI cursor moves, without a separate preview block. When a Stamp has no saved metadata, recover ordinary display fields from its matching earlier assistant response on the active branch; preserve saved metadata and retain the result after confirmation. Never recover response content, IDs, diagnostics, or raw/current Thinking. Keep recording settings, saved entries, transcript expansion, and unrelated preferences unchanged. Save only after confirmation and retain an ordinary RPC selector without cursor previews.

## 0.53.0

### Minor Changes

- ec0db07: Add an opt-in output throughput setting that shows reported output tokens per creation-to-completion second on the existing stamp line, independently of response timing and assistant metadata. Preserve raw accounting inputs for later display and support compatible historical stamps.

## 0.52.0

### Minor Changes

- c045d50: Add opt-in elapsed time since the latest user message. Each non-tool-use assistant response records a fixed duration at completion, including tools and pauses, that remains unchanged across reload, resume, and tree navigation.

## 0.51.2

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.51.1

### Patch Changes

- bae6fea: Reuse bounded date-time formatters and memoized stamp rendering to prevent transcript redraws from causing severe native memory growth.

## 0.51.0

### Minor Changes

- c798497: Add an optional since-user cost total to final assistant stamps.

## 0.50.1

### Patch Changes

- 5372f87: Use the dependency-free Kit terminal-text sanitizer for display labels while retaining the existing persisted metadata normalization and lazy menu boundary.
- Updated dependencies [317f7bd]
  - @narumitw/pi-tui-kit@0.61.0

## 0.50.0

### Minor Changes

- 7a7521a: Add independent Settings controls for exact timelines, Thinking level provenance, and compact abnormal outcomes.
- 182d7c9: Add expansion-only exact timelines, effective Pi Thinking level provenance, and compact abnormal outcome labels.

### Patch Changes

- 430efc5: Load generated lazy chunks through Pi's Jiti runtime so `/stamp` resolves host-provided Pi peers.

## 0.49.6

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.49.5

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.49.4

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.
