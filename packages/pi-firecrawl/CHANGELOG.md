# @narumitw/pi-firecrawl

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
