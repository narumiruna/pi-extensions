# Pi Subagents Four-Arm Benchmark Protocol v2

## Purpose

This protocol compares direct parent execution, v1 blocking orchestration, v1 detached orchestration, and v2 bounded jobs under one matched harness.

It supersedes the two-arm live protocol for replacement decisions but keeps the v1 protocol and result as historical evidence.

Synchronous read-only consultation remains a separate capability comparison because `subagent_consult` is neither v1 blocking orchestration nor v1 detached execution.

## Arms

| Arm | Loaded extension | Required topology |
| --- | --- | --- |
| `parent-only` | None | Complete the workload directly with Pi core tools and make no subagent call. |
| `v1-sync` | `pi-subagents` sync-only surface | Call blocking `subagent` exactly once and wait for its result. |
| `v1-async` | `pi-subagents` compatibility surface | Use `subagent_spawn` once per child and `subagent_await` once per child. |
| `v2-job` | `pi-subagents-v2` | Use `subagent-v2-start` once per child and `subagent-v2-wait` once per child. |

The v1 async arm needs the compatibility surface because the async-only surface intentionally omits blocking `subagent_await`.

The larger visible v1 async tool surface is a product difference that Pi cannot hide for one benchmark trial.

## Workloads

| Workload | Scope | Acceptance evidence |
| --- | --- | --- |
| `single-research` | Recover three exact facts from three files. | Three exact path, symbol, and value rubric items. |
| `parallel-research` | Recover four facts from two independent scopes. | Four exact path, symbol, and value rubric items. |
| `security-review` | Identify three planted security defects and safe replacements. | Three exact operation and defect rubric items. |
| `worker-fix` | Repair two functions and verify the fixture. | Three report rubric items plus evaluator-owned `node --test`. |

The v1 sync parallel workload uses one blocking `subagent` call with two tasks and no aggregator.

The async arms start two jobs and join each job exactly once.

The parent-only arm reads both scopes directly.

## Matched controls

Every four-arm instance receives a fresh generated fixture with the same fixture identifier and initial bytes.

The protocol fixes the parent model, child model, thinking level, task information, child agent definitions, child tool allow-lists, parent resource policy, deadline, retry count, and evaluator.

The work deadline starts only after Pi RPC acknowledges `get_state` readiness.

Trials run serially, and arm order rotates by workload and repetition.

Retries are disabled.

Pi sampling seeds are unavailable, so generations are not seed-matched.

The parent-only arm uses fewer model calls and is a strong direct baseline rather than an equal-inference-budget baseline.

No equal-budget best-of-N arm is included in this diagnostic protocol.

## Success rule

A trial succeeds only when the final answer satisfies the complete fixed rubric, uses exactly its assigned topology, observes every required child result before the final marker, avoids premature finalization, and passes mutation verification when applicable.

A parent-only final marker counts as its direct completion boundary because no child result exists.

Any extra subagent topology tool, missing join, timed-out join, invalid marker, partial rubric, or failed fixture test makes the trial unsuccessful.

## Metrics

The report keeps success rate, mean evidence score, topology compliance, completion coverage, readiness latency, work latency, terminal outcomes, and parent-visible session cost separate.

Readiness includes core and selected extension loading from the tested source entrypoint.

Parent-visible cost is not comparable across arms because call counts differ and v2 does not propagate child subprocess usage into parent session statistics.

The report sets both `costComparable` and `equalInferenceBudget` to `false`.

One repetition per workload is diagnostic and has no useful confidence interval.

A replacement or default decision requires preregistered repeated trials, uniform total provider usage, broader repository tasks, and paired uncertainty intervals.

## Commands

The active repository no longer contains the historical `pi-subagents-v2` package.

Check out the historical v2 source separately and pass its entrypoint with `--v2-extension` when reproducing this protocol.

Preview sixteen trials without making a provider request:

```bash
just benchmark-subagent-capabilities \
  --job-version v2 \
  --v2-extension /path/to/pi-subagents-v2/src/index.ts \
  --model provider/model
```

Run one diagnostic repetition:

```bash
just benchmark-subagent-capabilities \
  --job-version v2 \
  --v2-extension /path/to/pi-subagents-v2/src/index.ts \
  --run \
  --thinking low \
  --model provider/model \
  --output /tmp/pi-subagents-four-arm-v2.json
```

If an external runner deadline stops a compatible partial run, continue only its missing trials:

```bash
just benchmark-subagent-capabilities \
  --job-version v2 \
  --v2-extension /path/to/pi-subagents-v2/src/index.ts \
  --run \
  --resume \
  --thinking low \
  --model provider/model \
  --output /tmp/pi-subagents-four-arm-v2.json
```

Resume rejects a changed protocol version, model, thinking level, repetition count, deadline, readiness deadline, or trial order.

Run five repetitions only after reviewing provider budget and the diagnostic result:

```bash
just benchmark-subagent-capabilities \
  --job-version v2 \
  --v2-extension /path/to/pi-subagents-v2/src/index.ts \
  --run \
  --repetitions 5 \
  --thinking low \
  --model provider/model \
  --output /tmp/pi-subagents-four-arm-v2-confirmatory.json
```

## Privacy and cleanup

The runner copies only supported Pi authentication files into private temporary agent directories.

Persisted evidence keeps bounded RPC responses, lifecycle boundaries, and non-user `message_end` records.

It removes streaming deltas, duplicate user prompts, reasoning blocks, and reasoning signatures before persistence.

It redacts common credential fields, bearer values, API-key patterns, private blocks, and home-directory paths.

Every trial removes its generated fixture and isolated agent directory during normal completion, deadline failure, or runner signal cleanup.
