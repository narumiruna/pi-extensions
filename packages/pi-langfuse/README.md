# 🪢 pi-langfuse — Trace Pi Runs in Langfuse

[![npm](https://img.shields.io/npm/v/@narumitw/pi-langfuse)](https://www.npmjs.com/package/@narumitw/pi-langfuse) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Export Pi agent runs, model generations, retries, tools, compaction, usage, and timing to [Langfuse](https://langfuse.com/) through OpenTelemetry.

## ✨ Features

- Groups each settled agent run into one trace with indexed attempt spans for retries and queued continuations.
- Records bounded provider requests, final assistant output, model identity, time to first content, usage, known costs, and safe response diagnostics.
- Captures final tool inputs and outputs, progress timing, duration, failures, and structural compaction events.
- Adds session, context, Git branch, commit, and aggregate counters as searchable metadata.
- Supports metadata-only tracing when content capture is disabled.
- Reads credentials only from a private local settings file and redacts them from exported data.
- Batches exports without delaying normal completion and isolates its OpenTelemetry provider from other extensions.

## 📦 Install

```bash
pi install npm:@narumitw/pi-langfuse
```

Try the published package without installing it:

```bash
pi -e npm:@narumitw/pi-langfuse
```

Build and load a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-langfuse run build
pi -e ./packages/pi-langfuse
```

The package declares `dist/index.ts`, so Pi cannot load an unbuilt local checkout.
The installed Langfuse SDK dependencies require Node.js 20 or newer.
Pi extensions run with your user permissions.
Review this extension and its data-export behavior before installing it.

## 🚀 Quick start

Run `/langfuse`, choose **Set up Langfuse for this Pi agent directory**, enter your credentials, and restart Pi.
New agent runs are then traced with the saved content-capture and metadata settings.

## ⚙️ Settings

Run the interactive manager and choose **Set up Langfuse for this Pi agent directory** or **Update Langfuse for this Pi agent directory**:

```text
/langfuse
```

The setup flow prompts for the secret key, public key, and base URL in the same order Langfuse presents them.
Leave either key blank to preserve its existing value when updating a valid config.
Leave the base URL blank to use `https://us.cloud.langfuse.com`.
The first successful setup creates the file.
Within one Pi process, updates run in invocation order, reread the latest valid private document, preserve unknown fields, and save atomically with mode `0600`.
Malformed JSON or invalid recognized fields block writes until you repair the file.
Errors redact entered and stored credentials.
A failed save leaves the current session and previous file unchanged.

Configuration applies to the displayed Pi agent directory, not only the current conversation.
Restart every running Pi process after saving so later sessions use the new connection.
`/reload` is not sufficient because the isolated Langfuse runtime is initialized once per process.
In print or JSON mode, edit the file manually because the interactive manager is unavailable.

You can also create `<getAgentDir()>/pi-langfuse.json` (normally `~/.pi/agent/pi-langfuse.json`) manually.
This minimal example keeps prompts, responses, and tool content local:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://us.cloud.langfuse.com",
  "captureContent": false
}
```

`publicKey` and `secretKey` are required literal strings.
Environment-variable and command interpolation are intentionally unsupported.
`baseUrl` defaults to `https://us.cloud.langfuse.com`; regional and self-hosted HTTP or HTTPS endpoints are supported.
Prefer HTTPS because HTTP sends Langfuse credentials and trace content without transport encryption.

`environment`, `release`, and `userId` are optional Langfuse trace attributes.
An environment must match Langfuse's contract: at most 40 lowercase letters, numbers, hyphens, or underscores, and it cannot start with `langfuse`.
`userId` populates the Langfuse user dimension, which is what the Sessions and Traces views group by; Langfuse accepts at most 200 characters, and leaving it unset reports no user.
`captureContent` defaults to `true` when omitted.
Set it to `false` to trace only timing, model, usage, cost, status, and bounded diagnostic metadata.
In that mode, pi-langfuse does not export prompts, provider-request snapshots, responses, or tool content.

The extension automatically restricts an existing config file to mode `0600` and refuses to load credentials if that protection cannot be enforced.
You can also set it explicitly:

```bash
chmod 600 ~/.pi/agent/pi-langfuse.json
```

Changes to credentials, endpoint, environment, release, or `captureContent` require a Pi process restart.
Changes to `userId` apply to new sessions without restarting Pi.
The isolated OpenTelemetry tracer provider is initialized once per Pi process and used only for Langfuse.
It does not replace Pi's process-global provider or send Langfuse observations to another extension's exporter.

## 🔭 What is traced

Each trace has this observation hierarchy:

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
- additive input, output, cache-read, cache-write, and total token usage plus known positive input, output, cache-read, cache-write, and total cost buckets;
- non-additive `pi.usage.reasoning_tokens` and `pi.usage.cache_write_1h_tokens` in metadata so subsets are not double-counted.

The request snapshot is the payload visible to this handler, not a guaranteed final wire payload.
A later extension can still replace it.
Final assistant content is reconciled from `turn_end` and `agent_end` after message transformation.
A recovered sequence such as `429 -> 200` remains queryable in HTTP metadata but is not an error; the final assistant outcome decides generation severity.

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
It never records the summary, custom instructions, or message bodies.
Manual compaction outside an active agent trace is ignored; incomplete compaction closes as a warning at settlement or shutdown.

### Boundaries and export

Images and embedded base64 data URIs are represented without their payloads, including provider data URLs.
Opaque `thinkingSignature`, `textSignature`, and `thoughtSignature` continuity values are always removed.
Every captured input or output has one cumulative 64 KiB serialized UTF-8 budget, bounded object/array traversal, and deterministic truncation markers.
Langfuse credentials are masked again in the span processor before network export.

The root agent begins before the first agent loop and remains open across retries, overflow-compaction recovery, and queued continuations.
`agent_end` closes only the current attempt; `agent_settled` closes the root after no automatic work remains.
Activity that unexpectedly arrives without a submitted prompt gets a fallback root input labeled `[automatic continuation]`.
Session replacement, reload, quit, and a new unexpected prompt close all descendants defensively and idempotently.

At run start, the extension performs bounded, non-shell Git lookups in `ctx.cwd`.
A branch switch therefore applies to the next run.
Detached HEADs retain only commit/detached metadata and the `git:detached` tag.
Missing Git, non-repositories, timeouts, and lookup failures silently omit Git context without affecting tracing.

Completed observations are exported in batches while Pi remains live.
Neither `agent_end` nor `agent_settled` waits for Langfuse network I/O.
To wait for completed exports, run `/langfuse` and choose **Flush completed traces for this session**; quit shutdown also drains the provider.

## 💬 Commands

```text
/langfuse
```

The command opens one context-aware standard menu in TUI or RPC mode.
Its state lines show the current session's tracing state, endpoint, content-capture mode, initialization failure when applicable, and private configuration path.
It never displays credentials.
Escape closes the menu.
Credential and endpoint text inputs remain extension-owned because they enforce secret-preserving setup/update semantics rather than standard navigation.

Available actions depend on that state:

- **Flush completed traces for this session** appears first when tracing is active and waits for completed observations to export.
- **Set up Langfuse for this Pi agent directory** appears when no valid config was loaded.
- **Update Langfuse for this Pi agent directory** appears when a valid config exists.
- **Show setup and privacy help** explains the agent-directory scope, manual configuration path, and content-capture risk.

Connection actions state their agent-directory scope and per-process restart requirement before selection.
For compatibility, command arguments are ignored and cannot select or bypass a menu action.
Print and JSON modes reject the interactive command with an observable error that includes current tracing state and the manual configuration path.

## 🔒 Security and privacy

With content capture enabled, traces can contain user prompts, model responses, tool arguments, and tool results.
These may include source code, file contents, shell output, or other sensitive project data.
Review Langfuse retention and access controls before enabling the extension.

Metadata includes Git branch names, commit ids, working directory, session and leaf ids, the configured `userId`, model identity, usage, cost, aggregate counts, and allowlisted response-header values.
This metadata remains exported when `captureContent` is `false`.
Branch names and diagnostic header values can contain operational details.
A `userId` can identify you if you set it to an email address or real name.
Choose a pseudonymous value when that matters, or leave `userId` unset to export no user at all.

The built-in mask specifically protects Langfuse credentials; it is not a general secret scanner.
Set `"captureContent": false` in `pi-langfuse.json` when prompts, provider-request snapshots, responses, and tool content must remain local.
Compaction summaries, tool partial results, opaque continuation signatures, authorization headers, cookies, and unapproved response headers are never exported in either mode.

## 🗂️ Package layout

```text
packages/pi-langfuse/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── langfuse.ts                    # Tracing lifecycle and command
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, Langfuse, LLM observability, OpenTelemetry, tracing, generations, tool spans, token usage, AI agent monitoring.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
