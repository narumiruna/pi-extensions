# Pi Langfuse Trace Flattening Plan

## Goal

Remove the redundant `pi.conversation` observation so each Langfuse trace starts directly at the native `pi.agent` observation while preserving attempt, turn, generation, tool, compaction, lifecycle, and trace metadata behavior.

## Context

`pi.conversation` and `pi.agent` cover the same submitted-prompt-to-settlement lifetime. The package is new, so there is no established saved-filter compatibility requirement that justifies keeping both observations.

## Architecture

```text
pi.trace
└─ pi.agent
   ├─ pi.attempt
   │  └─ pi.turn
   │     ├─ pi.llm
   │     └─ pi.tool.<tool-name>
   └─ pi.compaction
```

`pi.agent` owns the trace update calls and remains open through retries, compaction recovery, and queued continuations until `agent_settled`.

## Plan

- [x] Change recorder tests to require `pi.agent` as the root observation with no `pi.conversation`; verified the focused test failed with four observations instead of three, then passed after the recorder change.
- [x] Simplify `TraceRecorder` to make `pi.agent` the sole root observation and preserve child parentage, final metadata, outcomes, and exactly-once closure; verified all 46 pi-langfuse recorder, extension, and native-runtime tests pass.
- [x] Update the README hierarchy and lifecycle descriptions to remove the unsupported compatibility claim; verified `pi.conversation` no longer appears under `extensions/pi-langfuse`.
- [x] Run `npm run check`, `npm run pack:langfuse`, `git diff --check`, and inspect the final diff; verified 1,052 tests pass, the dry-run package contains the five source modules plus README/license/metadata, and the diff is clean and limited to this plan and pi-langfuse.

## Completion Checklist

- [x] A completed run exports `pi.agent` directly beneath `pi.trace`, without a `pi.conversation` observation.
- [x] Attempts, turns, generations, tools, and compactions retain their intended parentage and lifecycle behavior.
- [x] Trace-level input, output, session, tags, metadata, schema version, and outcome remain exported from `pi.agent`.
- [x] Tests, README, and package contents agree with the flattened hierarchy.
