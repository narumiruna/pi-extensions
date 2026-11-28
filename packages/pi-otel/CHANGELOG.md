# @narumitw/pi-otel

Versions through 0.54.3 were released as `@narumitw/pi-langfuse`.

## 0.55.4

### Patch Changes

- Updated dependencies [3cbbbc5]
  - @narumitw/pi-tui-kit@0.73.0

## 0.55.3

### Patch Changes

- Updated dependencies [1d22c5f]
  - @narumitw/pi-tui-kit@0.72.0

## 0.55.2

### Patch Changes

- 648e3ab: Reuse the context usage snapshot when an automatic continuation opens a new trace at turn start, avoiding a second history scan without changing trace metadata.
- Updated dependencies [1cbb470]
  - @narumitw/pi-tui-kit@0.71.0

## 0.55.1

### Patch Changes

- bb79479: Align the Sync daemon's model SDK with Pi 1.6. Keep pi-otel's Durable tracing compatible with Pi 1.6 and its parked tool states without exporting additional trace data.

## 0.55.0

### Minor Changes

- 350ac5c: Rename the tracing extension to `pi-otel` and add OTLP/HTTP protobuf export to custom collectors. Generic export keeps prompts, model replies, tool content, and free-form provider errors local by default. OTLP custom headers require HTTPS or a loopback IP. Existing Langfuse settings and trace attributes remain supported.
  
  Use `/otel` for all tracing controls, including Langfuse setup. `/langfuse` is deprecated and warns users to switch to `/otel` while still opening the same menu. Uninstall the old `pi-langfuse` package before loading `pi-otel` to avoid duplicate tracing.

## 0.54.3

### Patch Changes

- ed7ea5a: Replace the Langfuse JavaScript SDK with OpenTelemetry's official tracing and OTLP HTTP packages. Keep the existing Pi settings and Langfuse trace schema.
- 25eef0a: Update the runtime libraries for AgentFS shell execution, Langfuse trace export, Starship pattern matching, subagent ignore rules, and sync daemon XML parsing and glob matching.

## 0.54.2

### Patch Changes

- Updated dependencies [cf7b63d]
  - @narumitw/pi-tui-kit@0.70.0

## 0.54.1

### Patch Changes

- 45401e4: Update runtime dependencies within supported peer dependency ranges.

## 0.54.0

### Minor Changes

- 5120d4d: Support Pi durable and Chord 1.5 through their public synchronous observers. Replace the removed event stream with ordered, bounded committed delivery, retain final tool arguments and submission correlation, and join observation cancellation and shutdown without controlling execution. Preserve committed-only privacy filtering, snapshot recovery, and continue/afterRun boundaries. Raise the experimental durable and Chord peer floors to the supported runtime contract.

### Patch Changes

- 0339567: Bound Git metadata queries and omit incomplete branch or commit output from traces.
- 811b195: Retain provider-confirmed zero totals in live generation costs and compaction metadata without replacing them with estimated component sums. Export cost provenance as metadata and preserve the unknown-zero fallback.
- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- bed3e2b: Preserve boolean cost-total provenance in durable assistant and nested-tool trace metadata without changing numeric costs or zero-cost rules.
- Updated dependencies [54f2700]
- Updated dependencies [6c76ef1]
  - @narumitw/pi-tui-kit@0.69.0

## 0.53.3

### Patch Changes

- fa69a68: Keep OpenTelemetry dependencies compatible with the tracing SDK by bounding the API below 1.10 and declaring the matching OTLP exporter base directly. This prevents runtime import failures from the incompatible exporter release line.

## 0.53.2

### Patch Changes

- 4a266d6: Update the Turso database dependency to 0.8.3 and the Langfuse runtime dependencies to 6.0.1.

## 0.53.1

### Patch Changes

- 1f1c293: Update React to 19.3.1, Langfuse to 6.0, and the TypeSafe SDK to 0.7 in their respective packages. Preserve trace-only input and output updates, metadata encoding, and root observation detection with Langfuse 6. Accept unreported TypeSafe token usage without rejecting valid answers.
- Updated dependencies [077137a]
- Updated dependencies [9f80b89]
- Updated dependencies [efc474c]
  - @narumitw/pi-tui-kit@0.66.0

## 0.53.0

### Minor Changes

- 1dabb0b: Upgrade the experimental durable adapter contract to pi-durable 1.2.0 and Chord ^1.2.0. Update durable tool test results to the public `output` field and keep compatibility guidance aligned with the tested host versions.

### Patch Changes

- fe6e621: Support Pi's user and custom `before_agent_start` events, capturing custom message content with existing trace sanitization.

## 0.52.0

### Minor Changes

- 9fe3ecc: Add an experimental public `/durable` integration for pi-durable 1.0.4, reusing the existing Langfuse runtime and tracing core without loading coding-agent registration. Trace committed submission outcomes, generation content and usage, and tool activity with isolated host correlation, fail-open observer cleanup and explicit snapshot/resynchronization semantics. Preserve existing coding-agent exports and behavior, and make shared-runtime shutdown idempotent under reentrant host callbacks.

## 0.51.2

### Patch Changes

- 2246daa: Update runtime dependencies for D-Bus, peer networking, and tracing.

## 0.51.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.51.0

### Minor Changes

- 2e1031d: Add public process-level Langfuse runtime and per-session Pi tracing controller APIs for safely tracing multiple concurrent sessions in one host process.

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.50.6

### Patch Changes

- d365daa: Publish the updated Langfuse tracing and OpenTelemetry runtime dependency ranges.
- Updated dependencies [d365daa]
  - @narumitw/pi-tui-kit@0.63.1

## 0.50.5

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.50.4

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.50.3

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.50.2

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.50.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.50.0

### Minor Changes

- 1086433: Add an optional `userId` setting to `pi-langfuse.json` and stamp it on every observation so Langfuse attributes traces and sessions to a user.

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.49.4

### Patch Changes

- 1e630c1: Stamp the Langfuse session ID on every observation and apply session updates so session-level token and cost totals include generations.
- Updated dependencies [11bdf1e]
  - @narumitw/pi-tui-kit@0.54.1
