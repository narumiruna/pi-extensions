# Pi Langfuse conversation span plan

## Goal

Group every complete Pi prompt-processing cycle in one Langfuse `pi.conversation` span. The span must start with the submitted prompt, remain open across all LLM/tool turns and automatic continuations, and end only when Pi reports `agent_settled`.

## Context

`pi-langfuse` currently creates a trace-level `pi.agent` observation and closes it at `agent_end`. Pi can emit another low-level agent run for automatic retry, overflow compaction recovery, or a queued continuation before the interaction is actually settled. Those runs therefore appear as separate trace groups, while Langfuse's observation list makes the turn, generation, and tool rows look scattered.

## Architecture

- `pi.conversation`: root Langfuse `span` and trace owner for one submitted prompt through the settled idle boundary.
- `pi.agent`: native `agent` child retained for semantic compatibility and as the parent of Pi turns.
- `pi.turn`: one child `span` for each LLM/tool loop turn.
- `pi.llm` and `pi.tool.*`: existing generation/tool children under the active turn.
- `agent_end`: reconcile the latest finalized assistant output only.
- `agent_settled`: close the conversation and all remaining observations without forcing network export.

## Non-Goals

- Do not change Langfuse credentials, configuration scope, content-capture policy, batching, or trace naming.
- Do not combine separate user prompts submitted after Pi has settled.
- Do not remove native agent, generation, or tool observation types.

## Plan

- [x] Add recorder and lifecycle regression coverage for the conversation span hierarchy and settled boundary; verified by 33 focused pi-langfuse tests.
- [x] Add `pi.conversation` as the root span while retaining `pi.agent` beneath it; verified by fake-backend and in-memory OpenTelemetry parentage assertions.
- [x] Move routine trace settlement from `agent_end` to `agent_settled`, preserving finalized output reconciliation and automatic-continuation fallback; verified by the two-run lifecycle and nonblocking-settlement tests.
- [x] Update runtime hierarchy assertions and the README's trace model/lifecycle documentation; verified by source inspection and package dry-run contents.
- [x] Run focused formatting/typechecks/tests, the repository CI-equivalent check, package dry run, and diff hygiene checks; verified by `npm run check` with 1,021 passing tests, `npm run pack:langfuse`, and `git diff --check`.

## Risks

- Closing on `agent_settled` keeps spans open longer than `agent_end`, but that is required to include retries, compaction recovery, and queued continuations in one interaction.
- The extra root observation duplicates some input/output metadata with `pi.agent`; retaining both preserves existing agent semantics while making the requested conversation boundary explicit.
- Interrupted sessions must still close the root span during session shutdown or when an unexpected new prompt starts.

## Completion Checklist

- [x] Every new user prompt creates exactly one root `pi.conversation` span.
- [x] `pi.agent`, all `pi.turn` spans, generations, and tools are descendants of that conversation span.
- [x] `agent_end` leaves the conversation open, and `agent_settled` closes it with the final output.
- [x] Automatic continuations before settlement remain in the same conversation span.
- [x] Existing privacy, batching, failure, and shutdown behavior remains covered and passing.
