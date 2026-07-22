# Pi Langfuse Observability Plan

## Goal

Make each user-initiated Pi run a single, accurately classified Langfuse trace across retries,
compaction, and queued continuations, then enrich its agent, attempt, turn, generation, and tool
observations with bounded debugging data that Pi 0.80.10 exposes reliably.

## Context

- The implementation branch started after `pi.conversation` had been added as a compatibility root
  wrapper; retain it so saved filters keep working while adding attempts beneath `pi.agent`.
- `agent_end` previously left the compatibility root open but did not model each low-level loop as a
  distinct attempt. Pi 0.80.10 emits `agent_settled` only after automatic retries, compaction
  recovery, and queued continuations finish.
- A generation is marked `ERROR` on the first HTTP status at or above 400. Providers such as Codex
  can later return 200 in the same transport retry loop, leaving a successful generation with stale
  error severity.
- Generation observations currently omit request input, time to first output, model parameters,
  provider response identifiers, HTTP attempt history, and detailed cost buckets.
- The package uses an isolated OpenTelemetry provider, native Langfuse observation types, bounded
  content capture, and one private `pi-langfuse.json` connection/settings file. Those boundaries
  should remain intact.

## Architecture

Target hierarchy:

```text
pi.trace
└─ pi.conversation                  SPAN; compatibility wrapper retained from current main
   └─ pi.agent                      AGENT; starts before the run, ends at agent_settled
      ├─ pi.attempt                 SPAN; one per agent_start / agent_end pair
      │  └─ pi.turn                SPAN
      │     ├─ pi.llm              GENERATION
      │     └─ pi.tool.<tool-name> TOOL
      ├─ pi.compaction             SPAN; only while an agent trace is active
      └─ pi.attempt                 later retry or continuation
```

Ownership and state:

- `TraceRecorder` owns root/attempt/turn/generation/tool/compaction lifecycle state and root
  aggregate counters.
- `langfuse.ts` translates Pi lifecycle events into recorder calls and supplies dynamic Pi context;
  it must not wait for export during normal agent settlement.
- `runtime.ts` remains the Langfuse/OpenTelemetry adapter. Extend its attribute types only for
  Langfuse-native fields such as `completionStartTime`, `modelParameters`, and `version`.
- HTTP response history is accumulated per generation. Final assistant outcome decides `ERROR`;
  a recovered transport failure remains visible in metadata without making the successful
  generation an error.
- The payload seen by `before_provider_request` is the best available request snapshot, not a
  guaranteed post-all-extension payload. Capture it only under the existing content policy and
  label its stage explicitly.
- Use first-class Langfuse fields for session, tags, model, model parameters, usage, cost, version,
  and completion start time. Use metadata for Pi-specific correlation and aggregate fields.

Proposed schema additions:

- Root/trace: `pi.trace.schema_version`, start/end leaf IDs and context usage, final outcome and stop
  reason, attempt/turn/generation/tool/tool-error/compaction/recovered-error counts.
- Attempt: `pi.attempt.index`, final outcome, and stop reason; add a reason only when Pi exposes it
  reliably, such as a known post-compaction attempt.
- Generation: request payload stage, requested provider/model/API/thinking level, response model and
  response ID, ordered HTTP status codes, final status, attempt/retry count, allowlisted request and
  rate-limit response headers, TTFT, complete known cost buckets, and non-additive token breakdowns
  such as reasoning/cache-write-1h in metadata.
- Tool: final execution input from `tool_execution_start`, progress-update count, time to first
  progress, final error flag, and existing bounded result output.
- Compaction: reason, `willRetry`, `fromExtension`, token/entry counts, and reported usage/cost when
  available; never capture the summary text solely for this observation.

## Non-Goals

- Adding custom tags, `userId`, static user metadata, project overrides, or a new settings UI. Those
  require a separate product decision under `docs/extension-settings.md`.
- Treating full cwd, Git branch/commit, session file paths, or OS identity as tags.
- Claiming that `before_provider_request` is the final wire payload or mutating provider headers for
  trace correlation.
- Capturing every streaming token, tool partial result, all response headers, diagnostic stacks, or
  compaction summaries.
- Creating standalone traces for manual compaction or tree navigation while no agent trace is active.
- Adding Langfuse scores without a reliable user-feedback or evaluation signal.

## Assumptions

- Pi 0.80.10 is the supported lifecycle contract; `agent_start`, `agent_end`, `agent_settled`,
  `message_update`, `session_before_compact`, and `session_compact` are available.
- A high-level run that recovers after one or more failed attempts is successful at the root. Failed
  attempt spans remain errors and root metadata reports recovery counts.
- `aborted`, `length`, and interrupted lifecycle closures are warnings; a final model/tool failure is
  an error; an ordinary successful run is default severity.
- Existing trace and observation names are a compatibility surface for saved Langfuse filters and
  will not be renamed.
- Opaque `thinkingSignature`, `textSignature`, and `thoughtSignature` values have no useful human
  debugging value and should never be exported, even when content capture is enabled.

## Risks

- Moving root closure to `agent_settled` can leave observations open if a lifecycle is interrupted;
  `session_shutdown`, a replacement `before_agent_start`, and defensive recorder close paths must
  remain bounded and idempotent.
- Adding an attempt parent changes observation depth and may affect dashboards that assumed turns
  were direct root children; preserve names and document the schema version change.
- Captured provider payloads may be changed by a later extension and can be large or sensitive;
  preserve the 64 KiB sanitizer budget, mark the capture stage, and retain metadata-only behavior
  when `captureContent` is false.
- Provider headers may contain credentials or cookies; use a case-insensitive allowlist and test that
  unrecognized headers never enter exported attributes.
- Token subsets must not be added as independent usage buckets when that would double-count totals;
  keep `reasoning` and `cacheWrite1h` as metadata unless exclusive buckets are computed correctly.

## Plan

- [x] Split `extensions/pi-langfuse/test/langfuse.test.ts` into cohesive config, command, recorder,
  extension, sanitizer, and runtime test files without changing behavior, so the existing test file
  does not grow during this work; verified the moved 35-test baseline with `npm test` (1,040 passing
  tests), package typecheck, focused Biome, and `git diff --check`.
- [x] Change `TraceRecorder` and `extensions/pi-langfuse/src/langfuse.ts` so `before_agent_start`
  opens the root/`pi.agent`, `agent_start` opens an indexed `pi.attempt`, `agent_end` reconciles the
  last assistant message and closes only that attempt, and `agent_settled` closes the root; verified
  two low-level loops in one trace plus interruption and shutdown exactly-once closure tests.
- [x] Add per-generation HTTP response accumulation in `extensions/pi-langfuse/src/tracing.ts` so a
  `429 -> 200` transport retry exports ordered statuses, final status, and retry count without stale
  `ERROR`, while a final HTTP/model failure remains `ERROR`; verified recovered, terminal,
  repeated-success, no-response, lifecycle-hook, and native in-memory exporter paths.
- [x] Add trace schema versioning, root outcome propagation, start/end session leaf and context-usage
  snapshots, and aggregate attempt/turn/generation/tool/error/compaction/recovery counts to the root
  agent and trace metadata; verified success, recovered success, final error, aborted,
  length-limited, and interrupted outcomes without new high-cardinality tags.
- [x] Enrich `pi.llm` in `extensions/pi-langfuse/src/tracing.ts` and its hooks with the bounded
  `before_provider_request` input snapshot and stage marker, requested model/provider/API/thinking
  parameters, response model/ID, allowlisted diagnostic headers, first real output delta as
  `completionStartTime`, and all known Pi cost buckets; verified content-disabled capture, later
  final-message reconciliation, aliases, non-additive subsets, header rejection, and native export.
- [x] Enrich `pi.tool.*` by recording final execution args at `tool_execution_start` and only progress
  count/time-to-first-progress at `tool_execution_update`, while retaining transformed final output
  and error status at `tool_execution_end`; verified successful, failed, cancelled/abrupt,
  duplicate-ID, parallel, and no-progress executions without partial-result content.
- [x] Add one active `pi.compaction` sibling span from `session_before_compact` through
  `session_compact`, recording reason, retry flag, source, bounded structural counts, and available
  usage/cost, and close incomplete compactions defensively at settlement/shutdown; verified manual,
  threshold, overflow-retry, extension-provided, cancelled/incomplete, and no-active-root cases.
- [x] Harden exported metadata in `extensions/pi-langfuse/src/sanitizer.ts` and configuration
  validation in `extensions/pi-langfuse/src/config.ts` by stripping opaque Pi content signatures and
  enforcing Langfuse's environment syntax/length contract; verified ordinary content,
  metadata-only capture, invalid environments, and documented boundary values.
- [x] Update `extensions/pi-langfuse/README.md` to document the settled trace/attempt hierarchy,
  schema-version compatibility note, exact new fields, provider-payload stage limitation, HTTP and
  compaction semantics, TTFT/cost behavior, environment validation, and privacy/data-volume
  boundaries; verified documented fields against source assertions and removed obsolete payload and
  continuation claims.
- [x] Run `npm run check`, inspect `git diff --check` and `git status --short`, and manually audit the
  in-memory exported span tree/attributes against this plan's Architecture and Risks; verified
  focused Biome/typecheck and 46 tests, `npm run check` with 1,051 passing tests,
  `npm run pack:langfuse` including all five source modules, a 61-field README assertion audit, native
  in-memory parentage/attribute/metadata-retention assertions, lifecycle warning severity, duplicate
  tool-ID quarantine, and a diff limited to pi-langfuse plus this plan.

## Completion Checklist

- [x] One user-initiated Pi run produces one root trace through retries, compaction recovery, queued
  continuations, and final settlement.
- [x] Every root, attempt, turn, generation, tool, and active compaction observation closes exactly
  once on success, failure, interruption, replacement, reload, and quit.
- [x] Recovered provider responses are not false errors, while terminal provider/model/tool failures
  remain queryable as errors with bounded diagnostic metadata.
- [x] Generation observations expose TTFT, requested/response identity, safe HTTP correlation,
  request capture stage, token usage, and known cost detail without double-counting or leaking
  unapproved headers.
- [x] Root metadata provides finite run outcome and aggregate/session/context correlation without
  placing high-cardinality values in tags.
- [x] Opaque continuation signatures and compaction/partial streaming content are not exported.
- [x] README behavior, privacy guidance, configuration constraints, and tests agree with the final
  implementation.
- [x] `npm run check` passes and the final diff is limited to `extensions/pi-langfuse/**` plus this
  plan; verified the archive target was unused before moving this completed plan.
