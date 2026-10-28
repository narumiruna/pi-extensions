# @narumitw/pi-typesafe-compact

## 0.1.2

### Patch Changes

- 1f1c293: Update React to 19.3.1, Langfuse to 6.0, and the TypeSafe SDK to 0.7 in their respective packages. Preserve trace-only input and output updates, metadata encoding, and root observation detection with Langfuse 6. Accept unreported TypeSafe token usage without rejecting valid answers.
- Updated dependencies [077137a]
- Updated dependencies [9f80b89]
- Updated dependencies [efc474c]
  - @narumitw/pi-tui-kit@0.66.0

## 0.1.1

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.1.0

### Minor Changes

- e2cf1ce: Add JEV-guided context selection before Pi's native compact function, with masked TypeSafe credential setup and portable retained history.

### Patch Changes

- 41e56cf: Reject invalid UTF-8 and race-replaced non-regular settings files, and include custom instructions in compact-request bounds.
