# Historical research: Codex compaction mechanism

Research snapshot: 2026-08-03.

Status: Historical and intentionally pinned to one Codex revision.
Use the current Codex source for present behavior because provider selection, retained context, media budgeting, and context-window state have continued to evolve.

## Scope and authority

This note describes the implementation in the `~/workspace/codex` checkout at:

- commit `bb5054fe47abe73ecbbd454751066a28c89f4bb9`;
- commit subject `Capture rollout budget units from response usage (#36641)`.

The pinned Codex source revision remains authoritative for this historical note.
Unless otherwise stated, source paths below are relative to `~/workspace/codex/codex-rs` at that revision.
The main implementation surfaces were:

- `~/workspace/codex/codex-rs/core/src/session/turn.rs`;
- `~/workspace/codex/codex-rs/core/src/tasks/compact.rs`;
- `~/workspace/codex/codex-rs/core/src/compact.rs`;
- `~/workspace/codex/codex-rs/core/src/compact_remote.rs`;
- `~/workspace/codex/codex-rs/core/src/compact_remote_v2.rs`;
- `~/workspace/codex/codex-rs/core/src/session/mod.rs`;
- `~/workspace/codex/codex-rs/core/src/session/rollout_reconstruction.rs`.

This is an internal historical implementation note, not a current-version guide or a claim about every Codex release or the hosted backend's undocumented internals.
Later Codex revisions added material changes, including provider-capability selection with Amazon Bedrock Remote V2 support, richer retained-content metadata, and revised image budgeting.
All external Codex source paths, line numbers, provider claims, limits, and lifecycle details below apply only to the pinned commit; the final Pi extension section is maintained separately.

## Executive summary

Codex compaction is not merely "ask a model for a summary and append it." It establishes a new,
persisted context-window checkpoint:

1. detect a manual or automatic compaction trigger;
2. run pre-compaction lifecycle hooks;
3. select token-budget reset, remote V2, legacy remote, or local summarization;
4. construct a bounded replacement history;
5. advance the context-window generation and UUID chain;
6. replace the live model history;
7. persist the exact replacement history so resume and fork can replay it;
8. restore the appropriate turn/world-state baseline;
9. emit completion lifecycle and post-compaction hooks.

The core invariant is that the history installed in memory and the history stored in the rollout are
the same replacement checkpoint. Summary generation is only one way to produce that checkpoint.

## Terminology

| Term | Meaning in the implementation |
| --- | --- |
| Active history | The `ContextManager` history currently sent to the model. |
| Replacement history | The bounded `Vec<ResponseItem>` that replaces active history after successful compaction. |
| Context window | One generation of active history between compactions. It has a monotonic number and UUID identity. |
| Local compaction | A normal Responses inference asks the current model for a plaintext handoff summary. |
| Legacy remote compaction | The client calls `POST responses/compact`, and the server returns replacement items. |
| Remote compaction V2 | A normal Responses stream receives a `compaction_trigger` and returns one opaque `compaction` item. |
| Initial context | Canonical developer/system/environment/world-state material rebuilt from the current session. |
| Pre-turn compaction | Compaction before context updates and the incoming user message are recorded. |
| Mid-turn compaction | Inline compaction while the model/tool loop still needs another sampling request. |
| Standalone compaction | User-requested `/compact` represented as its own session task. |

## End-to-end control flow

```text
manual /compact
or pre-turn threshold/model transition
or mid-turn threshold/new-context request
              |
              v
        PreCompact hooks
              |
              v
      select implementation
      +-------------------------------+
      | token-budget reset            |
      | remote compaction V2          |
      | legacy responses/compact      |
      | local Responses summarization |
      +-------------------------------+
              |
              v
      build replacement history
              |
              v
      advance context-window identity
              |
              v
      replace live history
      persist CompactedItem
      persist world/turn baseline
              |
              v
      ContextCompaction completed
        PostCompact hooks
```

The implementation-selection order is significant:

1. the experimental `TokenBudget` feature overrides every summarizing implementation;
2. a provider that supports remote compaction uses remote V2 when that feature is enabled;
3. otherwise a remote-capable provider uses legacy `responses/compact`;
4. non-remote providers use local summarization.

See `CompactTask::run` in `core/src/tasks/compact.rs:25-82` and `run_auto_compact` in
`core/src/session/turn.rs:1147-1223`.

## Entry points

### Manual compact

The TUI slash command eventually submits `Op::Compact`. App-server exposes the asynchronous
`thread/compact/start` request, which loads the thread, submits `Op::Compact`, and returns an empty
start response. Completion is observed through subsequent lifecycle notifications rather than the
request response itself.

Relevant paths:

- `protocol/src/protocol.rs:656` defines `Op::Compact`;
- `core/src/session/handlers.rs:453-460` creates `CompactTask`;
- `app-server/src/request_processors/thread_processor.rs:1876-1887` handles
  `thread/compact/start`;
- `tui/src/app_server_session.rs:1127-1140` invokes the app-server request.

Standalone local and remote compaction emit a `TurnStarted` event because they own a separate task
boundary.

### Automatic pre-turn compact

`run_turn` calls `run_pre_sampling_compact` before it records current context updates or the new user
input. This check can compact for:

- exhausted automatic-compaction budget;
- exhausted effective context window;
- changed model compaction compatibility hash;
- downshift to a smaller context-window model that cannot safely accept the existing context.

Relevant code:

- `core/src/session/turn.rs:158-177` calls the pre-sampling check;
- `core/src/session/turn.rs:981-1011` checks the token limit;
- `core/src/session/turn.rs:1049-1144` handles model transitions.

A source TODO at `core/src/session/turn.rs:158-161` documents a known gap: this check does not yet
estimate the context diffs, full context reinjection, and user input that are about to be added. A
large incoming turn may therefore cross the threshold after the pre-turn decision.

### Automatic mid-turn compact

After every sampling response, Codex gathers:

- whether the model needs a tool/continuation request;
- whether user steering is pending;
- current active and scoped token usage;
- whether a tool requested a new context window.

It compacts immediately only when more work is required:

```rust
let should_roll_over = needs_follow_up
    && (sess.take_new_context_window_request().await || token_limit_reached);
```

See `core/src/session/turn.rs:376-454`.

This gate avoids paying for compaction at the end of an otherwise completed turn. If the completed
turn crosses the threshold, the next real user turn handles it in the pre-turn phase.

Pending steering is deliberately not drained into the compaction request. After mid-turn
compaction, Codex first resumes the model/tool continuation when required, then delivers queued
steering at the appropriate later request boundary. The state comments are at
`core/src/session/turn.rs:260-268`; integration coverage is in
`core/tests/suite/pending_input.rs:953-1251`.

## Token threshold and context-window accounting

### Default limit

`ModelInfo::auto_compact_token_limit` derives a default of 90% of the resolved model context window.
An explicit model/config limit is clamped to that 90% value when a context window is known:

```text
derived_limit = resolved_context_window * 0.9
effective_auto_limit = min(configured_limit, derived_limit)
```

See `protocol/src/openai_models.rs:413-418` and `:459-470`.

A root `model_auto_compact_token_limit` override is copied into the resolved `ModelInfo` by
`models-manager/src/model_info.rs:22-38`.

### Effective hard cap

The hard context limit used by a turn is the resolved context window multiplied by the model's
`effective_context_window_percent`:

- `core/src/session/turn_context.rs:220-228`.

The post-sampling status forces compaction when either the buffered automatic limit or this effective
hard cap is reached. See `core/src/session/context_window.rs:54-80`.

### Limit scopes

`model_auto_compact_token_limit_scope` has two modes:

- `total`: charge the entire active context against the limit;
- `body_after_prefix`: charge only growth after the carried prefix for the current compact window.

The enum is defined in `protocol/src/config_types.rs:23-37`. Scope calculation is in
`core/src/session/context_window.rs:24-50`.

For `body_after_prefix`, `AutoCompactWindow` tracks an absolute prefill-input baseline. The first
server-observed input usage wins over a local estimate; later body usage is:

```text
active_context_tokens - prefill_input_tokens
```

The baseline and one-shot reminder flags reset when advancing to a new compact window. See
`core/src/state/auto_compact_window.rs:33-115`.

### Model transitions

Codex persists the previous turn's model slug and optional `comp_hash`. Before the next sampling
request it prefers compacting with the previous model when:

1. both old and new models provide a `comp_hash` and the hashes differ; or
2. the model changed to one with a smaller context window and existing usage is too large.

A missing hash does not trigger compatibility compaction. If previous-model compaction fails with a
model-sensitive request, capacity, context, quota, overload, internal-server, or retry-limit error,
Codex may retry using the current model. The fallback is available only when using the Codex backend,
the provider is OpenAI, and the model actually changed.

Relevant code:

- `core/src/session/turn.rs:1013-1144`;
- `core/src/compact_model_fallback.rs:8-31`.

If the fallback also fails, the original previous-model error is retained as the operation result;
telemetry separately records whether fallback succeeded.

## Implementation A: local plaintext summarization

### Prompt

Local compaction uses `config.compact_prompt`, falling back to the workspace prompt in
`prompts/templates/compact/prompt.md`:

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that
will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

The prompt is synthesized as a user input and added only to the cloned history used for the compact
request. It is not treated as a real user turn in the final replacement history.

See `core/src/compact.rs:112-142` and `:241-274`.

### Sampling and retries

Local compaction uses the ordinary Responses streaming path with:

- the cloned conversation as input;
- normal base instructions;
- the turn's model, reasoning effort, reasoning-summary mode, and service tier;
- no rollout inference trace for the local compaction stream.

`drain_to_completed` records completed output items and waits for `response.completed`. It also
updates rate limits, server-reasoning state, raw response usage, and session token usage.

Failure handling in `core/src/compact.rs:275-341` is:

- interruption or explicit turn abort returns immediately;
- session budget exhaustion emits an error without retry;
- context-window overflow removes one oldest prompt item and retries while more than one item
  remains;
- other stream errors retry with provider backoff up to `stream_max_retries`;
- retries reuse one `ModelClientSession` so sticky routing and websocket incremental state survive.

### Extracting the summary

After a successful stream, Codex obtains the last assistant message recorded for the compact turn.
It prefixes that text with `prompts/templates/compact/summary_prefix.md`:

```text
Another language model started to solve this problem and produced a summary of its thinking process.
You also have access to the state of the tools that were used by that language model. Use this to
build on the work that has already been done and avoid duplicating work. Here is the summary produced
by the other language model, use the information in this summary to assist with your own analysis:
```

The complete prefixed summary is encoded as a user-role `ResponseItem::Message`. Existing compaction
summaries are recognized by that prefix and excluded when collecting real user messages, preventing
summary-as-user duplication across repeated local compactions.

See `core/src/compact.rs:343-359` and `:531-552`.

### Local replacement shape

The replacement history contains:

1. a bounded suffix of original real user messages;
2. the prefixed summary as the final user-role message;
3. initial context only when the compaction phase requires immediate reinjection.

User-message retention is newest-first under an approximate 20,000-token aggregate budget. If the
oldest retained message only partially fits, that message is token-truncated. Selected messages are
then restored to chronological order. Images, assistant messages, reasoning, tool calls, and tool
outputs are not directly retained; important information from them survives only through the model's
summary.

See `COMPACT_USER_MESSAGE_MAX_TOKENS` and `build_compacted_history_with_limit` in
`core/src/compact.rs:57` and `:593-660`.

This path is intentionally lossy. It emits a user warning that long threads and repeated compactions
can reduce accuracy.

## Implementation B: legacy remote `responses/compact`

### Provider selection

Remote compaction is used for OpenAI and Azure Responses providers. Provider detection is in
`model-provider-info/src/lib.rs:422-424`.

When `RemoteCompactionV2` is disabled, Codex uses the legacy unary endpoint:

```text
POST responses/compact
```

The endpoint implementation is in `codex-api/src/endpoint/compact.rs:18-82`.

### Request shape

The canonical payload contains:

- `model`;
- `input` history;
- fully resolved base `instructions`;
- optional tools;
- `parallel_tool_calls`;
- optional reasoning controls;
- optional service tier;
- optional prompt-cache key;
- optional text controls.

See `codex-api/src/common.rs:26-45` and `core/src/client.rs:550-638`.

The request also carries installation, originator, session, thread, compatibility, window, optional
attestation, Responses Lite, and compaction metadata headers. During inline compaction it can retain
the server's `x-codex-turn-state` value so subsequent requests in the same turn stay consistent.

For API-key authentication, the legacy compact attempt deliberately omits configured service tier;
other authentication modes can pass it through. See `core/src/compact_remote_request.rs:70-89`.

`compact_prompt` is not sent as a special summarization instruction on this route. The hosted
compaction endpoint owns the compaction behavior; the request carries ordinary resolved base
instructions.

### Pre-request output shrinking

Before calling the endpoint, Codex estimates whether base instructions plus history exceed the
effective context window. While traversing the newest suffix, it can rewrite:

- `FunctionCallOutput` and `CustomToolCallOutput` bodies to
  `Output exceeded the available model context and was truncated`;
- `ToolSearchOutput` to retain execution metadata but drop returned tool definitions.

Rewriting stops once the estimate fits or a non-rewritable suffix item is reached. This is a bounded
pre-compaction survival mechanism, not the final semantic compaction. See
`core/src/compact_remote.rs:365-465`.

### Server output processing

The endpoint returns `output: Vec<ResponseItem>`, treated as candidate replacement history. Before
installation, `process_compacted_history` filters it:

- developer messages are dropped to avoid stale or duplicated instructions;
- user-role wrappers that do not parse as a real `UserMessage` or `HookPrompt` are dropped;
- assistant and agent messages are kept;
- `Compaction` and `ContextCompaction` items are kept;
- reasoning, tool calls, tool outputs, image generation, unknown items, and request-only
  `CompactionTrigger` items are dropped.

Fresh canonical context is then injected only when required by the phase. See
`core/src/compact_remote.rs:302-363`.

## Implementation C: remote compaction V2

### Status and transport

`RemoteCompactionV2` is marked stable and default-enabled in
`features/src/lib.rs:1450-1456`. It is therefore the normal path for remote-capable OpenAI/Azure
providers in this revision.

Unlike legacy remote compaction, V2 does not call `responses/compact`. It reuses a normal Responses
stream and appends exactly one request-control item to the prompt:

```json
{ "type": "compaction_trigger" }
```

See `core/src/compact_remote_v2_attempt.rs:70-82` and
`protocol/src/models.rs:1030-1031`.

The prompt still includes current base instructions, model-visible tool specifications, parallel-tool
support, model/reasoning settings, service tier, window metadata, and the current history.

### Response contract

The stream collector waits for `response.completed` and requires exactly one completed
`ResponseItem::Compaction` output. That item contains opaque `encrypted_content`:

```json
{
  "type": "compaction",
  "encrypted_content": "..."
}
```

Other output items may appear but do not replace the required compaction item. Zero or multiple
compaction items produce a fatal validation error. A stream closing before `response.completed` is
also an error.

See `core/src/compact_remote_v2.rs:385-440` and `protocol/src/models.rs:1020-1029`.

The client does not decode the opaque summary. It persists and sends the item back in later model
requests, leaving semantic recovery to the backend.

### Retry behavior

V2 uses normal Responses retry classification but caps transport retries at two, even when the
provider allows more. It reuses the current turn's `ModelClientSession` for inline compaction; a
standalone compact creates and retains an owned session until lifecycle completion.

See `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES` and
`run_remote_compaction_request_v2` in `core/src/compact_remote_v2.rs:60` and `:333-383`.

### V2 replacement shape

After receiving the opaque compaction item, the client locally constructs replacement history from:

1. bounded retained messages from the pre-compaction prompt;
2. the new opaque compaction item as the final item;
3. phase-dependent canonical initial context.

Candidate retention first permits:

- user/developer/system role messages;
- non-final `AgentMessage` items no larger than 10,000 estimated tokens.

The shared remote-output filter then removes developer/system/context wrappers. In practice the
installed retained suffix consists primarily of real user messages, hook prompts, and bounded
non-final agent/collaboration messages. Standard assistant final messages, reasoning, tool calls,
tool outputs, and old compaction items are not retained directly.

The retained text budget is approximately 64,000 tokens, newest first. The oldest partially fitting
message can be token-truncated. Input images and audio are preserved with a minimum one-token budget
charge for otherwise text-free messages; retained input images are counted for analytics.

See:

- `core/src/compact_remote_v2.rs:55-60` for limits;
- `:442-497` for item eligibility;
- `:499-580` for reverse truncation and media preservation.

The request-only `compaction_trigger` is popped before retention and is never durable history. See
`core/src/compact_remote_v2_attempt.rs:123-133`.

### Usage and tracing

A successful V2 response publishes `RawResponseCompleted`, records rollout-budget usage, and captures:

- input tokens before compaction;
- summary output tokens;
- cached input tokens;
- prompt-cache write tokens;
- retained image count.

The rollout trace records both the request attempt and the checkpoint installation, joining them to
the UI compaction item ID. See `core/src/compact_remote_v2.rs:270-307`.

## Implementation D: experimental token-budget reset

`TokenBudget` is under development and default-disabled in `features/src/lib.rs:1336-1342`.
When enabled, it takes precedence over local and remote summarization.

Compaction in this mode does not call a model or remote compact endpoint. It:

1. captures the current step and world state;
2. emits the normal context-compaction lifecycle item;
3. advances the context window;
4. builds fresh canonical initial context;
5. installs that context as replacement history.

See `core/src/compact_token_budget.rs:20-92` and `Session::start_new_context_window` in
`core/src/session/mod.rs:3634-3663`.

The surrounding token-budget feature can inject a one-shot reminder and a model-provided fallback
prompt before the buffered hard rollover. This gives the model an opportunity to write durable notes
before the later summary-free reset. The fallback buffer is reserved only when such a prompt exists.
See `core/src/session/token_budget.rs:54-113` and `core/src/session/context_window.rs:65-79`.

Manual compact in this mode resets immediately rather than asking for a summary.

## Initial-context reinjection

Compaction must preserve two competing requirements:

1. current developer/environment/world-state context must not be lost;
2. the compaction summary or opaque compaction item must remain at the model-trained history boundary.

`InitialContextInjection` makes this explicit:

- `DoNotInject` for standalone/manual and pre-turn compaction;
- `BeforeLastUserMessage` for mid-turn compaction.

See `core/src/compact.rs:60-72`.

### Standalone and pre-turn

These phases install the compacted history without initial context and clear the reference-context
item. The next normal turn sees that the reference is absent and appends a full, freshly rendered
initial context after the compaction checkpoint before adding normal turn input.

This avoids compacting stale developer/environment fragments and guarantees that the next user turn
uses current session state.

### Mid-turn

The model must resume immediately without waiting for a new user turn, so Codex builds canonical
initial context from the exact `StepContext` and `WorldState` used by the current turn. It inserts
that context:

1. before the last real user or non-final agent message, when present;
2. otherwise before the textual summary;
3. otherwise before the last remote compaction item;
4. otherwise at the end.

This keeps the local summary or remote compaction item last. The corresponding `TurnContextItem` and
full world-state baseline are persisted so resume/fork can reproduce the same boundary.

See `build_compaction_initial_context` and
`insert_initial_context_before_last_real_user_or_summary` in `core/src/compact.rs:87-105` and
`:554-591`.

## Installing and persisting the checkpoint

All summarizing implementations converge on `Session::replace_compacted_history` in
`core/src/session/mod.rs:3236-3280`.

The method:

1. assigns IDs to replacement items that do not already have one;
2. builds a `CompactedItem` containing the exact replacement history;
3. updates live `SessionState` history and its reference-context item;
4. installs a full world-state baseline when supplied;
5. persists `RolloutItem::Compacted`;
6. persists the world-state snapshot after the checkpoint;
7. persists the reference `TurnContextItem` after the snapshot;
8. queues `SessionStartSource::Compact` for the next session-start hook boundary.

The order makes the compacted checkpoint the durable semantic boundary before later baseline
records. Disk persistence is not described as a multi-record transaction, but the rollout stores the
same replacement item vector that was installed into live history.

After replacement, implementations recompute local token usage against the new history.

## Context-window identity

`AutoCompactWindow` tracks:

- a monotonic `window_number`;
- UUIDv7 `first_window_id`;
- optional UUIDv7 `previous_window_id`;
- UUIDv7 current `window_id`;
- prefill usage for scoped accounting;
- one-shot reminder/fallback flags;
- an explicit pending new-context request.

On advance:

- `window_number` increments with saturation;
- current UUID becomes `previous_window_id`;
- a fresh UUIDv7 becomes current;
- reminder, fallback, and pending-request state reset.

See `core/src/state/auto_compact_window.rs:8-99`.

`Session::current_window_id` separately exposes the request/cache header identity as
`<thread-id>:<window-number>`. The persisted UUID chain provides stronger durable lineage. See
`core/src/session/mod.rs:3613-3623`.

## Resume, fork, and rollback semantics

`CompactedItem` persists:

- plaintext `message` for local or legacy compatibility;
- optional exact `replacement_history`;
- window number and UUID lineage.

See `protocol/src/protocol.rs:3241-3257`.

During reconstruction, the newest applicable compaction with `replacement_history` becomes the base
history verbatim; later rollout items are replayed on top. This avoids re-running summary generation
and keeps resumed model input aligned with the original live checkpoint. See
`core/src/session/rollout_reconstruction.rs:318-346`.

Legacy rollouts without `replacement_history` are still supported. Reconstruction re-collects user
messages and rebuilds a local-style compacted history from the old `message` field, clears the
reference context, and accepts a temporarily less ideal prompt shape. See
`core/src/session/rollout_reconstruction.rs:347-381`.

Rollback and fork logic must treat compaction as a history reset rather than a normal appended
message. Existing integration coverage is concentrated in:

- `core/tests/suite/compact_resume_fork.rs`;
- `core/src/session/rollout_reconstruction_tests.rs`;
- `core/src/agent/control_tests.rs`.

## Lifecycle, hooks, and cancellation

All implementations run `PreCompact` before modifying history. A supported stop decision returns
`TurnAborted`. Successful compaction runs `PostCompact` after the checkpoint is installed. See
`core/src/hook_runtime.rs:400-469`.

A post-compact stop does not roll the history back: installation has already happened. It aborts the
surrounding operation after recording the completed compact state.

The user-visible lifecycle item is `TurnItem::ContextCompaction`:

1. emit item started;
2. perform and install compaction;
3. emit item completed.

Remote implementations use the same item ID as the rollout compaction trace join key. In this
revision, the older `EventMsg::ContextCompacted` protocol variant remains defined but the core
compaction paths use item-started/item-completed lifecycle events.

Automatic compaction propagates failure into the current turn so it cannot continue indefinitely
with an exhausted context. Remote and local implementations emit structured errors for non-abort
failures. `CompactTask` propagates `TurnAborted`; other standalone errors have already been surfaced
as events and the task returns without a model answer.

## Failure and retry matrix

| Path | Failure | Behavior |
| --- | --- | --- |
| Any | PreCompact stop | Return `TurnAborted`; do not install replacement history. |
| Any successful install | PostCompact stop | Keep installed checkpoint; abort surrounding operation. |
| Local | Context-window exceeded | Remove oldest compact prompt item and retry while more than one remains. |
| Local | Retryable stream error | Provider backoff up to `stream_max_retries`. |
| Local | Session budget exhausted | Emit error and fail without stream retry. |
| Legacy remote | Oversized recent tool outputs | Rewrite a bounded trailing output suffix before endpoint call. |
| Remote V2 | Retryable stream failure | Responses retry handling, capped at two retries. |
| Remote V2 | Missing/multiple compaction items | Fatal validation error; do not install checkpoint. |
| Remote V2 | Stream closes before completed | Stream error; do not install checkpoint. |
| Previous-model remote compact | Model-sensitive failure | Optionally retry once using current-model step context. |
| Automatic compact | Non-abort failure | Emit turn error lifecycle and stop the current continuation. |

## Configuration and feature controls

| Surface | Effect | Important caveat |
| --- | --- | --- |
| `model_auto_compact_token_limit` | Overrides model automatic threshold before the 90% clamp. | Does not override the effective context hard cap. |
| `model_auto_compact_token_limit_scope` | Chooses `total` or `body_after_prefix`. | Prefix baseline is window-specific and refreshed from usage. |
| `compact_prompt` | Replaces the local summarization prompt. | Remote compaction does not use it as a dedicated summary prompt. |
| `experimental_compact_prompt_file` | Loads a local compact prompt from a file. | Only used when no higher-precedence compact prompt exists. |
| `features.remote_compaction_v2` | Chooses V2 over legacy remote compaction. | Stable and default-enabled in the researched revision. |
| `features.token_budget` | Replaces summary compaction with a fresh context reset. | Under development and default-disabled. |
| Model `comp_hash` | Declares compatibility of compacted model configurations. | A missing hash does not trigger model-switch compaction. |
| Model context metadata | Supplies context window, effective percent, and default threshold. | Config overrides are resolved through the models manager. |

Configuration fields are declared around `core/src/config/mod.rs:632-710` and
`config/src/config_toml.rs:163-239`.

## Observable protocol and analytics surfaces

Compaction is visible through:

- standalone `TurnStarted` for manual compact;
- `ContextCompaction` item started/completed events;
- raw response completion usage for local and V2 requests;
- warning events on local compaction;
- error events on failed compaction;
- hook started/completed events;
- request metadata identifying trigger, reason, implementation, and phase;
- context-window request headers and persisted lineage;
- analytics status, duration, before/after tokens, summary tokens, cache usage, and retained images.

Analytics classify:

- trigger: manual or auto;
- reason: user requested, context limit, model downshift, or `comp_hash` change;
- phase: standalone turn, pre-turn, or mid-turn;
- implementation: normal Responses, `responses/compact`, or Responses compaction V2;
- status: completed, interrupted, or failed.

See `core/src/compact.rs:400-506`, `core/src/responses_metadata.rs`, and
`analytics/src/events.rs:813-844`.

## Important behavioral consequences

### Compact is lossy even when the checkpoint is exact

Persistence exactly reproduces the selected replacement history, but selection itself is lossy:

- local compact delegates semantic retention to a plaintext model summary;
- legacy remote delegates selection to the compact endpoint and filters its output;
- V2 retains bounded recent messages plus an opaque backend summary;
- token-budget reset relies on prior reminders/notes rather than a summary operation.

The exact checkpoint guarantee should not be confused with lossless conversation recovery.

### Current context is rebuilt, not trusted from compact output

Remote-produced developer and context wrappers are intentionally discarded. Codex rebuilds
canonical context from current session state to avoid stale instructions, stale cwd/environment,
duplicated policy, or mismatched world-state baselines.

### Mid-turn compaction is a continuation protocol

It is not equivalent to a manual `/compact`. It must preserve the exact current step, defer steering,
keep the summary/opaque compaction item at the trained boundary, and make the next model request
without a new user turn.

### Prompt-cache identity follows window boundaries

Compaction advances a window generation used in request metadata and headers. Replacing history
necessarily changes the model-visible prefix; explicit generations keep usage, tracing, and cache
behavior attributable to the correct pre- or post-compaction window.

### Custom local prompts do not provide remote parity

A configuration that changes `compact_prompt` can materially alter local summary quality but does
not redefine the hosted legacy or V2 remote compaction protocol. Tests comparing local and remote
must account for that ownership difference.

## Verification map in the Codex checkout suite

| Behavior | Existing source coverage |
| --- | --- |
| Manual and automatic local compact | `core/tests/suite/compact.rs` |
| Legacy remote endpoint and output processing | `core/tests/suite/compact_remote.rs` |
| Local/remote/V2 parity expectations | `core/tests/suite/compact_remote_parity.rs` |
| Manual app-server API lifecycle | `app-server/tests/suite/v2/compaction.rs` |
| Pending steering across mid-turn compact | `core/tests/suite/pending_input.rs` |
| Resume, fork, and rollback | `core/tests/suite/compact_resume_fork.rs` |
| Request window identity across compact | `core/tests/suite/window_headers.rs` |
| Context replacement helpers | `core/src/compact_tests.rs` |
| V2 collector and retention bounds | inline tests in `core/src/compact_remote_v2.rs` |
| Token-budget reset behavior | `core/tests/suite/token_budget.rs` |
| Rollout reconstruction compatibility | `core/src/session/rollout_reconstruction_tests.rs` |

This research pass inspected implementation and existing tests but did not modify or execute the
`~/workspace/codex` code.

## Design lessons for Pi extensions and other agents

The transferable design is the checkpoint protocol rather than any one summary prompt:

1. **Separate pre-turn, mid-turn, and standalone semantics.** They have different input ordering and
   context reinjection requirements.
2. **Persist the exact replacement history.** Persisting only summary text cannot guarantee resume
   parity when retained messages, opaque items, and context placement also matter.
3. **Treat pending input as concurrent state.** Do not accidentally summarize steering that arrived
   after the compaction boundary or deliver it before the old continuation resumes.
4. **Rebuild canonical policy/environment context.** Do not trust model-produced copies of mutable
   system or developer state.
5. **Bound every retained channel.** Summary text, user suffixes, agent messages, media, and fallback
   prompts all need explicit caps.
6. **Track context-window identity.** Generation and lineage make retries, usage, caches, tracing,
   resume, and rollback auditable.
7. **Validate remote outputs before installation.** A malformed compact response must not partially
   replace live history.
8. **Keep installation distinct from generation.** Generation may retry or fall back; installation is
   the semantic point at which the new checkpoint becomes live.
9. **Do not infer losslessness from persistence.** An exactly replayable summary checkpoint can still
   omit critical task state, so long conversations and repeated compactions remain accuracy risks.

## Current protocol addendum

Research date: 2026-09-03.

The current `~/workspace/codex` checkout at commit `36984da4` retains both remote protocols:

- `codex-api/src/endpoint/compact.rs` implements unary `POST responses/compact`;
- `core/src/compact_remote_v2_attempt.rs` appends `ResponseItem::CompactionTrigger {}` to a normal Responses request;
- `model-provider/src/provider.rs` marks OpenAI and Azure Responses providers as Remote V2-capable;
- `features/src/lib.rs` keeps `remote_compaction_v2` stable and enabled by default.

The installed OpenAI SDK `6.40.0` also publishes the official `responses.compact()` client plus
`ResponseCompactParams`, `CompactedResponse`, `ResponseCompactionItem`, and
`ResponseInputItem.CompactionTrigger` types. Its unary response contract returns retained user
messages followed by one opaque compaction item and includes compaction usage. This official OpenAI
surface is distinct from undocumented Codex-backend metadata, headers, and lifecycle behavior.

The installed Pi provider interface has no first-class compact method. It does expose public
`onPayload`, injected `fetch`, credentials, provider headers and environment, timeout, retry, and
cancellation options. Deterministic adapter tests verify that the built-in Codex, OpenAI, and Azure
Responses adapters each expose one HTTP Responses request and accept a compaction-only or synthetic
completed SSE response. That public bridge is the supported package boundary; custom adapters that
do not honor it fail closed to Pi-native compaction.

## Current Pi extension boundary

The external Codex research above remains pinned, while this section describes the maintained repository extension boundary and must be reconciled when that package changes.

This repository contains
[`packages/pi-codex-compact`](../../packages/pi-codex-compact/README.md), a stable Pi extension that
supports `openai-codex-responses`, `openai-responses`, and `azure-openai-responses`. It selects Remote
V2 or unary Responses Compact automatically and permits an explicit protocol choice:

- expand a prior compatible checkpoint in the provider-built input;
- either append one final `compaction_trigger` to a normal Responses SSE request or rewrite the same-origin `/responses` request to unary `/responses/compact`;
- validate one bounded opaque `compaction` item and protocol-approved retained user messages;
- persist a version 2 checkpoint while reading version 1 Codex checkpoints without rewriting sessions;
- identify the fallback summary from the active entry's persisted `CompactionEntry.summary` rather than regenerated prose;
- collapse that summary and its fingerprint-verified kept suffix to one deterministic marker;
- replace that marker with bounded remote replacement history in `before_provider_request`;
- fall back to native Pi compaction for unsupported APIs or remote failure.

The package deliberately keeps Pi's threshold, `/compact`, overflow retry, append-only session tree,
and `CompactionEntry` publication. A TUI control menu, opened with `/codex-compact`, provides
manual compaction and writes bounded user options to `pi-codex-compact.json`.

This is payload replay, not full Codex-core parity. A pure Pi extension cannot own Codex's context
window generations, summary-free token-budget reset, exact pre-turn and mid-turn continuation state,
pending-input boundary, provider `comp_hash` compatibility checks, request lineage headers, or
prompt-cache window identity. Pi's public `getAllTools()` metadata also omits the optional
`constrainedSampling` field, so Remote V2 can preserve exposed tool order and schema fields but not
that field. Checkpoint replay requires the exact model ID and API label; stored provider provenance
does not gate replay. Full resume history also requires the extension and a working route for that
API and protocol.
