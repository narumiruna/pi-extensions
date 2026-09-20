# @narumitw/pi-github-pr

## 0.49.8

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.49.7

### Patch Changes

- 36a5ad5: Honor Pi's effective terminal capabilities when rendering pull request hyperlinks and RGB footer colors.

## 0.49.6

### Patch Changes

- 71179ed: Start the initial pull request refresh in the background so GitHub CLI calls no longer delay Pi session startup.

## 0.49.5

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.49.4

### Patch Changes

- c7c4852: Keep the last successful pull request status visible when an agent turn is aborted.
