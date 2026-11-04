# @narumitw/pi-github-pr

## 0.49.10

### Patch Changes

- 0339567: Bound Git HEAD and GitHub CLI query output, reject incomplete paths and JSON, and report query output overflow without misclassifying it as a timeout.
- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.

## 0.49.9

### Patch Changes

- 9d3e0d7: Unreference passive refresh, debounce, expiry, and background startup timers so they do not keep the host process alive when other work has stopped. Keep normal cancellation and resource cleanup unchanged.

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
