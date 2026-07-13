## Goal

Harden PR #201 so `pi-langfuse` coexists with other Pi extensions, never adds Langfuse network latency to normal agent completion, bounds each exported payload globally, and uses Langfuse-native observation semantics. Success means the extension keeps its JSON-only credential policy, all local checks pass, and the PR checks remain green.

## Context

The current extension already follows repository package conventions: isolated workspace package, deferred startup in `session_start`, cleanup in `session_shutdown`, private `pi-langfuse.json`, command autocomplete, package docs, and tests. Review found three merge-blocking risks: global OpenTelemetry provider registration, awaited `forceFlush()` on every `agent_end`, and per-value limits without a total trace-content budget. Lower-risk consistency work remains around observation types, command guidance, and runtime test coverage.

## Architecture

- `src/runtime.ts` owns an isolated Langfuse tracer provider and exporter lifecycle without registering a process-global OpenTelemetry provider.
- `src/tracing.ts` owns trace state, Langfuse observation types, and one cumulative UTF-8 content budget per captured input/output value.
- `src/langfuse.ts` maps Pi lifecycle events without awaiting routine exports; only explicit flush and shutdown paths wait for export completion.
- `src/config.ts` remains the sole JSON configuration boundary. Credentials stay literal in `pi-langfuse.json`; `.env` and Langfuse credential environment variables remain unsupported.

## Non-Goals

- Do not add `.env` or environment-variable credential fallback.
- Do not add a general-purpose secret scanner; retain exact Langfuse-key masking and the documented privacy warning.
- Do not migrate or rewrite previously exported Langfuse traces.
- Do not add interactive secret entry unless Pi exposes a masked-input API; provide config/help guidance instead of echoing tokens in a normal input dialog.

## Assumptions

- Langfuse v4's `setLangfuseTracerProvider()` remains the supported way to select an isolated provider.
- Node.js 20+ remains acceptable because the current Langfuse dependencies already require it.
- HTTP self-hosted Langfuse endpoints remain supported, with the existing HTTPS safety warning.

## Plan

- [x] Add failing runtime tests for coexistence with a pre-registered OpenTelemetry provider, one-time initialization across reloads, changed-config rejection, idempotent shutdown, and parent/child export through an in-memory exporter; verified by the Langfuse runtime tests.
- [x] Replace `NodeSDK.start()` global registration in `extensions/pi-langfuse/src/runtime.ts` with an isolated tracer provider selected through Langfuse's provider API, and make provider/exporter factories injectable for deterministic tests; verified by the in-memory exporter and global-provider assertions.
- [x] Update runtime dependencies in `extensions/pi-langfuse/package.json` and `package-lock.json` to list every directly imported OpenTelemetry package and remove `@opentelemetry/sdk-node`; verified by workspace typecheck and `just pack-langfuse`.
- [x] Add lifecycle tests proving `agent_end` closes trace state without calling `forceFlush()`, `/langfuse flush` still waits for completed exports, and `session_shutdown` drains and shuts down exactly once; verified by the root test suite.
- [x] Remove awaited routine export from the `agent_end` handler in `extensions/pi-langfuse/src/langfuse.ts`; explicit flush and shutdown remain awaited.
- [x] Add sanitizer tests for many object keys, nested arrays, multibyte UTF-8 strings, repeated references, circular values, provider data URLs, and oversized tool details; verified by deterministic size and marker assertions.
- [x] Replace independent string/array-only bounds in `extensions/pi-langfuse/src/tracing.ts` with a cumulative UTF-8 byte budget plus bounded object/array traversal; verified by `Buffer.byteLength(JSON.stringify(value), "utf8")` assertions.
- [x] Emit `pi.agent` as Langfuse `agent`, `pi.llm` as `generation`, and `pi.tool.*` as `tool`; verified by fake-backend and in-memory exporter parentage tests.
- [x] Add `/langfuse help` and `/langfuse config` completions and credential-free guidance; verified by command tests.
- [x] Expand configuration and lifecycle tests for missing/malformed files, permission repair, disabled content capture, URL normalization, and initialization failure; verified by the root test suite.
- [x] Update `extensions/pi-langfuse/README.md` for isolated tracing, batching, payload budgets, native observation types, finalized provider/assistant data, normalized tool inputs, and command guidance.
- [x] Capture generation input from the serialized provider payload after context filters; verified by lifecycle regression coverage.
- [x] Export only finite positive known costs using Langfuse's `total` bucket; verified by zero and positive cost assertions.
- [x] Reconcile finalized assistant messages from `turn_end` and `agent_end`; verified by transformed-output and retryable-error tests.
- [x] Update tool spans with normalized `tool_result.input` and finalized `tool_execution_end` output; verified by an edit-argument normalization regression test.
- [x] Run repository and packaging gates and update PR #201; verified by 376 passing tests, tracked-file Biome checks, boundary checks, workspace typechecks, `just pack-langfuse`, zero production audit vulnerabilities, and green Pi 0.79.10/latest checks on commit `03f61a0`.

## Risks

- An isolated provider may require replacing `@opentelemetry/sdk-node` with lower-level trace packages; keep direct dependencies explicit so npm package installs do not rely on transitive imports.
- Removing per-run forced flush delays visibility by the configured batch interval, but avoids blocking Pi; explicit flush and shutdown preserve deterministic delivery when needed.
- A global byte budget can reduce trace detail for very large conversations or tool results; truncation markers and metadata must make this visible rather than silently dropping content.
- Langfuse export failures may be logged internally instead of rejected by `forceFlush()`; tests should distinguish errors the extension can report from exporter diagnostics it cannot intercept.

## Completion Checklist

- [x] OpenTelemetry coexistence is verified by an automated test showing an existing global provider is untouched while Langfuse observations reach an in-memory exporter.
- [x] Normal `agent_end` latency is independent of Langfuse export latency, verified by the pending-flush lifecycle test.
- [x] Every captured input/output is globally bounded, verified by UTF-8 serialized-byte assertions for adversarial nested payloads.
- [x] Agent, generation, and tool observations use native Langfuse types with correct parentage, verified by unit and in-memory exporter assertions.
- [x] JSON-only credential handling remains intact, verified by config and secret-redaction tests with no environment fallback.
- [x] Config/help/status behavior is documented and covered by autocomplete, non-interactive, and secret-redaction tests.
- [x] Repository verification passed with tracked-file Biome checks, boundary checks, workspace typechecks, 376 tests, `just pack-langfuse`, `npm audit --omit=dev`, and `git diff --check`.
- [x] PR #201 contains commits `3be2d7d` and `03f61a0`; both GitHub Pi-version checks succeeded and all 10 review threads are resolved.
