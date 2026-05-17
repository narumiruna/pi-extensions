# pi-goal interruption research

This note investigates why `@narumitw/pi-goal` can lose momentum or continue at the
wrong time, and compares it with the native goal runtime in `third_party/codex`.

## Scope

Reviewed active code and docs only. Deprecated extensions are out of scope.

Primary sources:

- `extensions/pi-goal/src/goal.ts`
- Pi extension docs for `before_agent_start`, `agent_end`, `sendUserMessage`,
  `appendEntry`, `ctx.isIdle()`, and `ctx.hasPendingMessages()`
- `third_party/codex/codex-rs/core/src/goals.rs`
- `third_party/codex/codex-rs/core/src/context/goal_context.rs`
- `third_party/codex/codex-rs/core/src/context/turn_aborted.rs`
- `third_party/codex/codex-rs/core/templates/goals/*.md`
- `third_party/codex/codex-rs/tui/src/bottom_pane/pending_input_preview.rs`
- `third_party/codex/codex-rs/tui/src/chatwidget/input_queue.rs`

## Current `pi-goal` behavior

`pi-goal` is implemented entirely as a Pi extension:

1. `/goal <objective>` creates an in-memory `activeGoal`, persists it as a
   custom session entry, updates the statusline, and calls `pi.sendUserMessage()`
   with a kickoff prompt.
2. `before_agent_start` appends active-goal rules to the system prompt.
3. `goal_complete` marks the goal complete, clears persisted state, and returns
   `terminate: true`.
4. `agent_end` increments the goal iteration, updates usage, checks token
   budget, and sends a continuation prompt if the same goal id is still active.
5. Continuation delivery is delegated to Pi messaging:
   - if `ctx.isIdle()` is true, call `pi.sendUserMessage(prompt)`;
   - otherwise call `pi.sendUserMessage(prompt, { deliverAs: "followUp" })`.

This is small and idiomatic for an extension, but the continuation policy is not
owned by the agent runtime. That is the main source of fragility.

## Where interruptions can break `pi-goal`

### 1. User interrupt is not goal-aware

`pi-goal` has no explicit `turn_aborted` or `interrupt` event. If Pi surfaces an
aborted assistant message through normal turn/agent events, `agent_end` still has
enough information to send another continuation unless `pi-goal` separately
checks for aborted/error stop reasons.

Codex treats `TurnAbortReason::Interrupted` as a first-class runtime event. The
goal runtime accounts progress, clears the continuation turn id, and pauses the
active goal. That makes Esc/user interrupt mean "stop this goal loop for now",
not "immediately schedule another continuation".

### 2. Continuation is scheduled from `agent_end`, not from a runtime idle gate

`pi-goal` schedules the next turn from an extension `agent_end` handler. That
handler is downstream of the agent loop and does not own the runtime's active
turn reservation. Depending on exact event ordering, queued follow-ups,
compaction, retry, or other extension work can race with the continuation.

Codex separates "turn finished" from "maybe continue if idle". After a turn is
fully cleared, it calls a runtime-owned `MaybeContinueIfIdle` path. That path
first starts any pending non-goal work, then tries goal continuation only if the
session is still idle.

### 3. Pending user input is not prioritized

`pi-goal` does not check `ctx.hasPendingMessages()` before scheduling an
automatic continuation. A user follow-up, steering message, or another extension
message can be queued at the same boundary as the goal continuation.

Codex explicitly skips active-goal continuation when queued response items or
trigger-turn mailbox items are pending. User or inter-agent work wins over the
automatic goal loop.

### 4. No continuation lock or reserved continuation turn id

`pi-goal` guards against stale goals by comparing the goal id before sending, but
it does not keep a continuation lock or a reserved continuation turn id. Multiple
`agent_end`-like boundaries, reload/resume timing, or queued messages can still
produce duplicate or stale continuation pressure.

Codex has both a `continuation_lock` and a `continuation_turn_id`. It reserves an
active turn before injecting continuation input, re-reads the goal from state,
and clears the reservation if the goal changed or another turn appeared.

### 5. The continuation prompt is a visible user message

`pi-goal` continuation uses normal `sendUserMessage()`. This makes continuation
look like user input and subjects it to the same queue semantics as real user
messages.

Codex injects hidden user-context fragments wrapped in `<goal_context>`. The
model sees runtime-owned steering, but the UI and input queue can still treat
real user input separately.

### 6. Goal objective text is not escaped inside prompt delimiters

Codex escapes objective text before placing it inside XML-like tags in goal
prompts. `pi-goal` currently interpolates the objective directly into plain text
prompts. That is simpler, but a goal containing delimiter-like or instruction-like
text can make the continuation prompt less robust.

### 7. Budget handling happens only at turn end

`pi-goal` checks token budget in `agent_end`. Long turns with many tools can
exceed the budget substantially before the extension can react.

Codex accounts goal usage after tool completion and at turn finish. When the
budget is reached, it can inject a budget-limit steering item during the current
turn and mark the goal `budget_limited` once.

## Codex design points worth copying

### Runtime event dispatcher

Codex centralizes lifecycle policy behind `GoalRuntimeEvent`:

- `TurnStarted`
- `ToolCompleted`
- `ToolCompletedGoal`
- `TurnFinished`
- `MaybeContinueIfIdle`
- `TaskAborted`
- `ExternalMutationStarting`
- `ExternalSet`
- `ExternalClear`
- `ThreadResumed`

This keeps accounting, continuation, abort, resume, and external goal mutation
rules in one place.

### Interrupt means pause

On user interrupt, Codex accounts current progress and pauses the active goal.
It also records model-visible interrupted-turn context so future turns do not
assume commands or tools cleanly completed.

### Continuation is idle-only and lock-protected

Codex continuation is not just "send a follow-up". It:

1. checks that goals are enabled and the current mode allows goals;
2. checks no active turn exists;
3. checks no queued user or trigger-turn mailbox input exists;
4. reads the current persisted goal and requires `status == active`;
5. acquires a continuation lock;
6. reserves an active turn;
7. re-reads the goal before launch;
8. injects hidden goal context;
9. marks the generated turn id as the continuation turn.

### Hidden goal context

Codex continuation, budget-limit, and objective-update prompts are runtime-owned
hidden context fragments, not ordinary user messages. This preserves the user
queue as user intent while still giving the model persistent goal guidance.

### Completion audit prompt

The Codex continuation template strongly warns the model not to redefine the
goal into a smaller task, and requires evidence-based completion before calling
`update_goal` with status `complete`. `pi-goal` has similar rules, but Codex's
template is more explicit about requirement-by-requirement verification and
using the current worktree/external state as authoritative.

## Recommendations

### Extension-only improvements

These can be implemented inside `pi-goal` without Pi core changes:

1. **Detect aborted/error agent endings.** If the final assistant message has
   `stopReason: "aborted"`, pause the goal and do not auto-continue. If it has
   `stopReason: "error"`, consider pausing or requiring explicit `/goal resume`.
2. **Respect pending user work.** Before sending a continuation, check
   `ctx.hasPendingMessages()` and skip or delay goal continuation when user or
   extension messages are already queued.
3. **Add a continuation-pending guard.** Track goal id + iteration for a queued
   continuation so repeated end events cannot enqueue duplicates.
4. **Escape objective text in XML-like prompts.** If prompts use delimiters,
   escape `&`, `<`, and `>` like Codex does.
5. **Strengthen continuation prompts.** Borrow Codex's "current state is
   authoritative" and "completion audit" language.
6. **Document interruption semantics.** Make `/goal pause` and user interrupt
   behavior explicit in the README once implemented.

### Pi core improvements needed for Codex parity

Some Codex behavior cannot be faithfully reproduced by an extension alone:

1. **Abort lifecycle event.** Extensions need a first-class event carrying abort
   reason so goal-like extensions can distinguish user interrupt from normal
   completion.
2. **Runtime-owned continuation scheduling.** Pi needs an idle-only scheduling
   API with pending-input checks, a lock, and a turn reservation, rather than
   requiring extensions to call `sendUserMessage()` from `agent_end`.
3. **Hidden contextual input.** A hidden context-message API would let runtime
   steering reach the model without appearing as user-submitted text or fighting
   the normal user queue.
4. **Pending-input categories.** Codex's UI distinguishes pending steers,
   rejected steers, and queued follow-ups. Pi goal continuation would be safer if
   automatic continuation could be lower priority than all user-visible queues.
5. **Tool-boundary accounting hooks.** Budget-aware goals need accounting after
   tool completion, not only at agent end.

## Suggested next step

Implement the extension-only safety fixes first, especially abort/error detection
and pending-message checks. That should reduce the most visible "goal keeps going
after I interrupted it" and "goal races my next message" failures.

If goal mode is expected to match Codex long-term, move the continuation policy
into Pi core or add core APIs that let `pi-goal` request a locked, idle-only,
hidden-context continuation.
