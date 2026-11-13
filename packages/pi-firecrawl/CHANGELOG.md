# @narumitw/pi-firecrawl

## 0.51.0

### Minor Changes

- ea9cf7b: Default to five codemode-exposed Firecrawl capabilities without `firecrawl_load`. Existing settings without `toolMode` also adopt this default while preserving the saved tool selection. Enable Pi's codemode, or choose `lazy` in `/firecrawl settings` and `/reload` to restore the previous model-dependent lazy/eager behavior; `direct` declares the five tools without a loader.
  
  Add a SettingsList screen for mode and capability availability. Mode edits save immediately and apply at the next session start; availability edits apply immediately without overwriting a pending mode. Disabled capabilities are unreachable in every mode. Status distinguishes running and saved mode, effective exposure, and callable versus declared tools. Preserve existing commands, legacy settings precedence, and native-deferred fallback behavior.

## 0.50.5

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.50.4

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.50.3

### Patch Changes

- bd00d53: Render standard horizontal frames around the remaining extension menus.

## 0.50.2

### Patch Changes

- 3effdd1: Use native deferred tool loading only on supported models and eagerly expose configured tools otherwise.

## 0.50.1

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.50.0

### Minor Changes

- f4eb46a: Load Firecrawl API capability tools on demand through a persistent `firecrawl_load` tool.

  Treat the saved tool selection as the allowed lazy-load catalog and preserve stable prompt metadata while capabilities are deferred.

  Preserve unsaved catalogs across runtime reloads and restore allowed loaded capabilities from the active branch.

  Harden query ranking, settings validation and notices, and Unicode-safe display truncation.
