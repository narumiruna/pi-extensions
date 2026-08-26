# @narumitw/pi-firecrawl

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
