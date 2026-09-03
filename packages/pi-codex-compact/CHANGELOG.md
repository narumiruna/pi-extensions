# @narumitw/pi-codex-compact

## 0.52.0

### Minor Changes

- ac74542: Add Remote V2 and unary Responses Compact routing for OpenAI Codex, OpenAI, Azure OpenAI, and compatible custom providers while preserving existing checkpoints.

## 0.51.3

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.51.2

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.51.1

### Patch Changes

- dadebf1: Clarify that Remote V2 eligibility comes from the active model's `openai-codex-responses` API declaration.

## 0.51.0

### Minor Changes

- 9645603: Detect remote compaction support from the active model's `openai-codex-responses` API capability instead of its provider name, while preserving exact model-ID checkpoint replay across persisted summary wording versions.

## 0.50.2

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.50.1

### Patch Changes

- f16abec: Preserve Codex Remote V2 replay and repeated compaction after session resume when Pi interleaves older compaction summaries with the newest checkpoint's retained messages.

## 0.50.0

### Minor Changes

- 26e91f9: Promote the extension to stable, include it in root Git installations, and remove its experimental startup warning.
