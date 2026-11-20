# 🪢 pi-otel — Export Pi Traces with OpenTelemetry

[![npm](https://img.shields.io/npm/v/@narumitw/pi-otel)](https://www.npmjs.com/package/@narumitw/pi-otel) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Export Pi coding-agent and durable conversation traces to an OpenTelemetry collector or [Langfuse](https://langfuse.com/).

## ✨ Features

- Exports to a custom OTLP/HTTP endpoint or directly to Langfuse with its existing trace format.
- Groups each settled agent run into one trace with indexed attempt spans for retries and queued continuations.
- Records bounded provider requests, final assistant output, model identity, time to first content, usage, known costs, and safe response diagnostics.
- Captures final tool inputs and outputs, progress timing, duration, failures, and structural compaction events.
- Adds session, context, Git branch, commit, and aggregate counters as searchable metadata.
- Supports metadata-only tracing when content capture is disabled.
- Keeps the default extension's credentials in a private local settings file and redacts them from exported data.
- Supports multiple concurrent Pi sessions through one process-owned runtime without sharing session trace state.
- Provides an opt-in public `/durable` adapter for committed submissions, model generations and tool activity without `AgentSession`.
- Batches exports without delaying normal completion and isolates its OpenTelemetry provider from other extensions.

## 📦 Install

Until the first npm release, use the local checkout instructions below. Once published, install with:

```bash
pi install npm:@narumitw/pi-otel
```

Try the published package without installing it:

```bash
pi -e npm:@narumitw/pi-otel
```

Build and load a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-otel run build
pi -e ./packages/pi-otel
```

The package declares `dist/index.ts`, so Pi cannot load an unbuilt local checkout.
Supported Pi runtimes require Node.js >=22.19.0.
The durable adapter targets experimental Pi durable APIs within the peer ranges in [`package.json`](./package.json); review its [compatibility and upgrade checks](./docs/durable.md#compatibility) before enabling or upgrading it.
Pi extensions run with your user permissions. Review the [data-export behavior](#-security-and-privacy) before enabling tracing.

If you already use `pi-langfuse`, uninstall it before loading `pi-otel` to avoid duplicate tracing and slash commands.
Existing Langfuse settings still work; see [Settings](#-settings). Host applications can change their import paths to `@narumitw/pi-otel` or `@narumitw/pi-otel/durable` without renaming their Langfuse factories.

## 🚀 Quick start

Start an OpenTelemetry Collector with the OTLP HTTP receiver enabled. Save this as `~/.pi/agent/pi-otel.json`:

```json
{
  "backend": "otlp",
  "endpoint": "http://localhost:4318/v1/traces"
}
```

Restart Pi, run a prompt, then use `/otel` → **Flush completed traces for this session** to send completed traces to the collector. Model and tool metadata are exported; prompts, replies, and tool contents stay local by default.

For Langfuse instead, use `/otel` → **Set up Langfuse for this Pi agent directory** and restart Pi, or keep your existing `pi-langfuse.json`.

## 🧩 Host application embedding

A host that manages multiple Pi sessions can share one process-level runtime and create one tracing controller for each session:

```ts
import { DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import {
  createLangfuseRuntime,
  createPiLangfuseSession,
} from "@narumitw/pi-otel";

const runtime = await createLangfuseRuntime({
  config: { environment: "production" },
  // publicKey, secretKey, baseUrl, and release may come from standard Langfuse env vars.
});

const tracing = createPiLangfuseSession(runtime, {
  traceName: "support-agent",
  sessionId: hostSessionId,
  userId: accountId,
  tags: ["support"],
  metadata: { tenant: tenantId },
  captureContent: false,
  onTraceId: (traceId) => correlateTrace(hostSessionId, traceId),
});

const resourceLoader = new DefaultResourceLoader({
  ...hostResourceOptions,
  noExtensions: true, // Keep auto-discovered extensions out of this controlled host session.
  extensionFactories: [{ name: "langfuse", factory: tracing.extension }],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  ...hostSessionOptions,
  resourceLoader,
});
await session.bindExtensions({});

tracing.setRequestId(incomingRequestId); // Applies to the next root trace only.
await session.prompt(userPrompt);

// When this session ends:
await tracing.dispose();
session.dispose();

// Once, after every hosted session has been disposed:
await runtime.shutdown();
```

Create the runtime once per process, create a separate controller per Pi `AgentSession`, and explicitly dispose the controller because `AgentSession.dispose()` does not emit Pi's `session_shutdown` event.
The controller's extension factory may be reused when that session's resource loader reloads, but it must not be attached to another active `AgentSession`.
Controller disposal ends only that session's open observations; it never flushes or shuts down the shared exporter.
`runtime.shutdown()` rejects new work, disposes any remaining controllers, flushes, and shuts down the provider once.
Both operations are idempotent.

Do not also auto-load this package's default extension into a session that uses `tracing.extension`, or that session will be traced twice.
Each process supports one active export connection. A conflicting connection requires a restart instead of replacing the active provider.

For a generic OTLP receiver, import `createOtelRuntime` from the same package (or from `/durable` for a durable host) and call it with `{ endpoint, headers, serviceName }`.
Pass that runtime to the same session or durable observer factory. Only `endpoint` is required; use explicit options, not environment variables, to configure the OTLP connection.
Set `captureContent: false` on embedded observers for metadata-only tracing; the default extension's JSON settings do not configure those observers.

`createLangfuseRuntime()` resolves fields in this order: `config`, the supplied `env` object (or `process.env`), then defaults.
It supports `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `LANGFUSE_TRACING_ENVIRONMENT`, and `LANGFUSE_RELEASE`.
Pass `env: false` to disable these lookups. The default extension resolves these fields only from its settings file.

`setRequestId()` snapshots `pi.request.id` when the next root trace starts; changing or clearing it never rewrites an active trace.
`traceName` changes the trace-name attribute without changing span names or hierarchy.
`onTraceId` runs once after each root is created, including automatic-continuation roots, and callback errors are intentionally ignored so host code cannot corrupt tracing cleanup.
Custom metadata is sanitized, bounded, and exported even when `captureContent` is `false`; package-owned `pi.*` fields cannot be overridden.
Treat custom metadata, tags, session IDs, user IDs, request IDs, and trace names as exported data.

## 🧱 Durable host applications

**Experimental:** use the dedicated public export with Pi durable and Chord versions that satisfy the package's declared peer ranges, plus compatible Pi AI.
Install those host dependencies explicitly; the durable entry does not require or load coding-agent registration.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createLangfuseRuntime,
  createPiLangfuseDurableConversation,
} from "@narumitw/pi-otel/durable";

const runtime = await createLangfuseRuntime(); // Standard Langfuse credentials/environment.
const tracing = await createPiLangfuseDurableConversation(runtime, {
  harness, // Existing, authorized host-owned Harness.
  conversationId: conversation.id,
  context: BACKGROUND_CONTEXT,
  sessionId: hostConversationId,
  userId: accountId,
  applicationId: "support-service",
  captureContent: false,
});
const submission = await conversation.submit({
  type: "input", content: userPrompt, requestId: incomingRequestId,
}, executionContext);
const result = await submission.wait(executionContext); // Host execution responsibility.
await tracing.observeSubmission(submission.id); // Optional committed-status reconciliation.
await tracing.dispose(); // Observation only; does not abort work or close the Harness.
// After every controller using this shared runtime has ended:
await runtime.shutdown();
```

Create one observer per conversation and retain submission IDs for explicit reconciliation after gaps.
Late attachment and overflow provide snapshots, not complete event replay; interrupted observations are marked uncertain.
Tracing never resumes paused recovery or controls execution, and capture bounds never change execution data.
See the installed [durable API guide](./docs/durable.md) for the compatibility matrix, ownership, per-request correlation, privacy projections, recovery semantics and limitations.
The host remains responsible for authorization, storage, execution cancellation/recovery, callback-owned work and shared-runtime shutdown.

## ⚙️ Settings

Settings apply to the Pi agent directory, not a project or an individual conversation. Edit `<getAgentDir()>/pi-otel.json` (normally `~/.pi/agent/pi-otel.json`).
If that file is absent, `pi-otel` reads a legacy `pi-langfuse.json` in the same directory without copying or deleting it.
An existing `pi-otel.json` always wins, even if invalid; repair it to re-enable tracing.
To edit a legacy setup with `/otel`, move the file to `pi-otel.json` first, without overwriting an existing file.

Keep the file private (`chmod 600 ~/.pi/agent/pi-otel.json`). The extension enforces mode `0600` and refuses to load the file if it cannot do so.
Restart each Pi process to change the backend, endpoint, credentials, or service name; `/reload` cannot replace the process-owned exporter.
The extension reads `captureContent` and `userId` again at session start. If set, `userId` is exported and must be a non-empty string of at most 200 characters.

### OTLP collector

Use `"backend": "otlp"` with the full HTTP or HTTPS traces URL, including the receiver path (usually `/v1/traces`).
The exporter sends OTLP/HTTP protobuf, not gRPC. The URL must not contain credentials, a query, or a fragment.
Optional `serviceName` defaults to `pi`. Optional `headers` is an object of literal header names and values, for example `{"Authorization": "Bearer YOUR_TOKEN"}`.
Header names are case-insensitive and cannot be duplicated or override transport headers such as `Content-Type`.
The exporter does not inherit ambient `OTEL_EXPORTER_OTLP_*` connection settings. `captureContent` defaults to `false`.

### Langfuse

Use `"backend": "langfuse"` or omit `backend` as in existing settings. Choose the Langfuse setup action in `/otel`, or save the literal keys manually:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://us.cloud.langfuse.com",
  "captureContent": false
}
```

`publicKey` and `secretKey` are required. `baseUrl` defaults to `https://us.cloud.langfuse.com`; regional and self-hosted HTTP or HTTPS endpoints are supported.
Optional `environment` is at most 40 lowercase letters, numbers, hyphens, or underscores and cannot start with `langfuse`; `release` is an optional string.
Changes to `environment` or `release` also require a restart. For compatibility, `captureContent` defaults to `true` in Langfuse mode; set it to `false` to keep raw content local.

The setup flow leaves saved keys unchanged if you submit an empty key field. A blank base URL selects the default. Saves run in order within one Pi process, preserve unknown fields, and publish atomically. Invalid settings block writes; a failed save leaves the previous file and current session unchanged.

Use Langfuse Cloud or self-hosted Langfuse >=4.59.0 for [v4 OTLP ingestion](https://langfuse.com/integrations/native/opentelemetry). Compression defaults to `gzip` after checking `LANGFUSE_OTEL_COMPRESSION`, `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION`, and `OTEL_EXPORTER_OTLP_COMPRESSION` in order for a valid `gzip` or `none` value.

## 🔭 What is traced

Both backends preserve the same run, attempt, turn, generation, tool, and compaction hierarchy. Langfuse keeps its existing `langfuse.*` ingestion attributes. A generic receiver gets standard OTLP spans with `service.name`, OpenTelemetry error status, and Pi attributes under `pi.observation.*` and `pi.trace.*`.

```text
pi.trace
└── pi.agent (agent: submitted prompt until Pi fully settles)
    ├── pi.attempt (span: one agent_start/agent_end pair)
    │   └── pi.turn (span)
    │       ├── pi.llm (generation)
    │       └── pi.tool.<tool-name> (tool)
    ├── pi.compaction (span, only while the trace is active)
    └── pi.attempt ...
```

All observations and the trace use schema version `2`.
Schema version 2 adds indexed `pi.attempt` observations and active `pi.compaction` spans beneath the root agent.

### Trace and attempt fields

The trace and root `pi.agent` retain the submitted prompt, final assistant output, Pi session id, working directory, mode, initial provider/model, and optional Git context.
Root metadata includes:

- `pi.trace.schema_version`, `pi.trace.outcome`, and `pi.trace.stop_reason`;
- `pi.trace.attempt_count`, `pi.trace.turn_count`, `pi.trace.generation_count`, `pi.trace.tool_count`, `pi.trace.tool_error_count`, `pi.trace.compaction_count`, and `pi.trace.recovered_error_count`;
- `pi.trace.start_leaf_id`, `pi.trace.end_leaf_id`, `pi.trace.start_context_tokens`, `pi.trace.end_context_tokens`, `pi.trace.start_context_window`, `pi.trace.end_context_window`, `pi.trace.start_context_percent`, and `pi.trace.end_context_percent` when Pi knows them;
- `pi.git.branch`, `pi.git.commit`, and `pi.git.detached`, plus a `branch:<branch-name>` tag or `git:detached` tag.

Outcomes are `success`, `recovered_success`, `error`, `aborted`, `length`, or `interrupted`.
`pi.trace.recovered_error_count` includes recovered provider responses, tool failures handled by a later generation, and failed attempts followed by final success.
Errors use Langfuse `ERROR`; aborts, output limits, shutdown, replacement, and other interruption closures use `WARNING`.
High-cardinality correlation values stay in metadata rather than tags.

Each `pi.attempt` records `pi.attempt.index`, final `pi.attempt.outcome`, and `pi.attempt.stop_reason`.
An attempt immediately following overflow compaction also sets `pi.attempt.reason` to `post_compaction`.
Failed attempts remain errors even when a later attempt makes the root a recovered success.

### Generation fields

Each `pi.llm` generation records:

- a bounded input snapshot from this extension's `before_provider_request` handler and `pi.request.payload_stage` set to `before_provider_request`;
- `pi.request.provider`, `pi.request.model`, `pi.request.api`, and `pi.request.thinking_level`, with thinking level also exported through Langfuse-native model parameters;
- the Langfuse-native response model plus `pi.response.provider`, `pi.response.api`, `pi.response.model`, and `pi.response.id` when Pi reports them;
- Langfuse-native `completionStartTime` from the first non-empty text, thinking, or tool-call delta;
- ordered `http.response.status_codes`, final `http.response.status_code`, `http.response.attempt_count`, and `http.response.retry_count`;
- allowlisted `http.response.headers`: request ids, `cf-ray`, `retry-after`, and the supported OpenAI/Anthropic rate-limit headers.
  Authorization, cookies, and unrecognized headers are never exported;
- additive input, output, cache-read, cache-write, and total token usage plus known positive component costs and the best available total cost;
- non-additive `pi.usage.reasoning_tokens` and `pi.usage.cache_write_1h_tokens` in metadata so subsets are not double-counted.

A finite zero total is exported only when Pi reports `cost.totalFromProvider === true`, even when catalog-estimated component costs are positive.
Neither adapter replaces the total with the sum of component estimates.
When provenance is absent or false, zero cost buckets remain omitted to preserve the existing unknown-pricing fallback.
Boolean provenance is exported as `pi.usage.cost.total_from_provider` metadata, not as a numeric cost bucket; absent or invalid provenance stays omitted.
The durable adapter uses the same metadata key for assistant and nested-tool usage, while retaining its existing non-negative cost buckets, including zero totals regardless of provenance.

The request snapshot is the payload visible to this handler, not a guaranteed final wire payload.
A later extension can still replace it.
Final assistant content is reconciled from `turn_end` and `agent_end` after message transformation.
A recovered sequence such as `429 -> 200` remains queryable in HTTP metadata but is not an error; the final assistant outcome decides generation severity.
A provider request becomes a `pi.llm` generation only when Pi emits an assistant lifecycle event.
Cache-warming requests emit provider hooks without that lifecycle, so they are excluded instead of becoming orphaned or interrupted ordinary generations.
Dedicated cache-warm observations are deferred until Pi exposes a deterministic request-kind and completion signal.

### Tool and compaction fields

A `pi.tool.<tool-name>` observation starts with raw `tool_execution_start` arguments as a fallback for calls that never execute, including calls blocked during `tool_call`.
For executed calls, it uses the `tool_result` input as authoritative after all argument mutations.
It captures final transformed output from `tool_execution_end`, final error state, `pi.tool.progress_update_count`, and `pi.tool.time_to_first_progress_ms` when progress occurs.
An unrecovered tool failure also makes the attempt and root errors.
Existing `pi.tool.call_id` and `pi.tool.name` correlation fields remain.
`tool_execution_update` partial-result bodies are never captured.
Duplicate, parallel, failed, no-progress, and interrupted tools are closed independently.

An active `pi.compaction` records its reason, retry state, source, token count, message counts, branch-entry count, and split-turn state.
The exported field names are `pi.compaction.reason`, `pi.compaction.will_retry`, `pi.compaction.from_extension`, `pi.compaction.tokens_before`, `pi.compaction.messages_to_summarize`, `pi.compaction.turn_prefix_messages`, `pi.compaction.branch_entries`, and `pi.compaction.is_split_turn`.
It adds `pi.compaction.read_file_count`, `pi.compaction.modified_file_count`, and `pi.compaction.usage.*` / `pi.compaction.cost.*` when Pi reports them.
Compaction costs use the same zero-total rules as generations and export boolean provenance as `pi.compaction.cost.total_from_provider` metadata.
It never records the summary, custom instructions, or message bodies.
Manual compaction outside an active agent trace is ignored; incomplete compaction closes as a warning at settlement or shutdown.

### Boundaries and export

Images and embedded base64 data URIs are represented without their payloads, including provider data URLs.
Opaque `thinkingSignature`, `textSignature`, and `thoughtSignature` continuity values are always removed.
Every captured input or output has one cumulative 64 KiB serialized UTF-8 budget, bounded object/array traversal, and deterministic truncation markers.
The OpenTelemetry backend masks configured export credentials before writing span attributes.
Trace and observation fields, such as output and usage, take priority if there is too much metadata to export.

The root agent begins before the first agent loop and remains open across retries, overflow-compaction recovery, and queued continuations.
`agent_end` closes only the current attempt; `agent_settled` closes the root after no automatic work remains.
Activity that unexpectedly arrives without a submitted prompt gets a fallback root input labeled `[automatic continuation]`.
Session replacement, reload, quit, and a new unexpected prompt close all descendants defensively and idempotently.

At run start, the extension performs bounded, non-shell Git lookups in `ctx.cwd`.
A branch switch therefore applies to the next run.
Detached HEADs retain only commit/detached metadata and the `git:detached` tag.
Missing Git, non-repositories, timeouts, and lookup failures silently omit Git context without affecting tracing.

Completed observations are exported in batches while Pi remains live.
Neither `agent_end` nor `agent_settled` waits for exporter network I/O.
Quit shutdown drains the provider.

## 💬 Commands

- `/otel` shows tracing status, the settings path, and privacy help. Use its setup action for Langfuse or edit the displayed settings file for a generic OTLP receiver. When tracing is active, choose **Flush completed traces for this session** to send completed spans to the configured endpoint. No arguments are accepted.
- `/langfuse` is deprecated. It warns you to use `/otel`, then opens the same menu and ignores arguments. This does not deprecate the Langfuse backend or its settings.

Both commands can open menus in TUI and RPC mode. Print and JSON modes reject them with the current status and settings path.

## 🔒 Security and privacy

With content capture enabled, traces can contain user prompts, model responses, tool arguments, and tool results.
These may include source code, file contents, shell output, or other sensitive project data.
Review the destination's retention and access controls before enabling the extension. Use HTTPS for remote receivers because HTTP does not encrypt credentials or trace data.

Metadata includes Git branch names, commit ids, working directory, session and leaf ids, the configured `userId`, model identity, usage, cost, aggregate counts, and allowlisted response-header values.
This metadata remains exported when `captureContent` is `false`.
Branch names and diagnostic header values can contain operational details.
A `userId` can identify you if you set it to an email address or real name.
Choose a pseudonymous value when that matters, or leave `userId` unset to export no user at all.

The built-in mask protects configured export credentials but is not a general secret scanner.
Set `"captureContent": false` when prompts, provider-request snapshots, responses, and tool content must stay local. Turn it on only for trusted receivers.
Compaction summaries, tool partial results, opaque continuation signatures, authorization headers, cookies, and unapproved response headers are never exported in either mode.

## 🗂️ Package layout

```text
packages/pi-otel/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin default and public entrypoint
│   ├── otel.ts                        # Default settings and command adapter
│   ├── pi-session.ts                  # Per-session Pi lifecycle controller
│   ├── durable.ts                     # Public durable observer entrypoint
│   ├── runtime-core.ts                # Process-runtime ownership
│   ├── runtime.ts                     # Lazy OpenTelemetry exporters and span mapping
│   └── tracing.ts                     # Schema-v2 observation recorder
├── docs/durable.md                    # Durable API, compatibility and privacy contract
├── dist/                              # Generated Node, declaration, and Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated extension runtime is built from `src/index.ts`; the Node library also builds `src/durable.ts` as a separate public entry.
Neither generated runtime imports back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, Langfuse, LLM observability, OpenTelemetry, tracing, generations, tool spans, token usage, AI agent monitoring.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
