# pi-cbmem retrieval benchmark

This repository-only benchmark compares Pi without extension discovery against Pi with `npm:@narumitw/pi-cbmem` while requiring both arms to recover the same scored facts.

It measures information acquisition only.
It does not ask the agent to edit code or run tests.

## Compared invocations

The baseline is derived from:

```bash
pi -ne
```

The treatment is derived from:

```bash
pi -ne -e npm:@narumitw/pi-cbmem
```

The runner adds RPC mode, an ephemeral session, fixed model and thinking settings, disabled automatic retry and compaction, no discovered skills, prompts, themes, context files, or project resources, and a read-only tool allowlist.
Explicit resources from the treatment package still load even though ordinary discovery is disabled.

The baseline can use `read`, `grep`, `find`, and `ls` for same-evidence tasks.
The treatment can use those tools plus the non-mutating pi-cbmem tools.
Indexing, project deletion, ADR replacement, and trace ingestion are excluded from the active treatment tools.

## Studies

### Exact payload

The runner calls the local Codebase Memory CLI before measured trials and captures one deterministic JSON evidence packet.
The baseline receives that exact packet in its prompt and cannot call tools.
The treatment must call the specified pi-cbmem tool exactly once with exact arguments.
The treatment tool result must have the same SHA-256 as the baseline packet.

This study measures the package schemas, skill, model tool-call turn, subprocess bridge, and tool-result envelope around the same evidence text.
It does not claim that the full provider payload is identical between arms.

### Same evidence

Both arms inspect the same repository path and answer the same hidden exact-fact keys.
The baseline must not call a Codebase Memory tool.
The treatment must call at least one Codebase Memory tool and may use read-only Pi tools for source verification.
A run succeeds only when every expected fact matches and its method policy is satisfied.

This study measures whether graph retrieval can avoid irrelevant source context while preserving required-fact accuracy.

## Safe dry run

The command defaults to a provider-free plan:

```bash
just benchmark-cbmem
```

The dry run does not start Pi, invoke Codebase Memory, resolve the npm package, or contact a model provider.
It prints the paired order, command shapes, minimum provider-request count, and live prerequisites.

Filter one study with:

```bash
just benchmark-cbmem --kind exact-payload
just benchmark-cbmem --kind same-evidence
```

Run the deterministic self-test with:

```bash
node packages/pi-cbmem/benchmark/self-test.mjs
```

The benchmark self-test remains outside normal CI because this is a manual measurement workflow.

## Index prerequisite

Create or refresh a Codebase Memory index for the exact repository path before a live run.
The runner does not mutate the index.

For example:

```bash
printf '%s\n' "$(jq -nc --arg path "$PWD" '{repo_path:$path,mode:"full",persistence:true}')" \
  | ~/.local/bin/codebase-memory-mcp cli index_repository
```

List the resulting exact project name with:

```bash
printf '{}\n' | ~/.local/bin/codebase-memory-mcp cli list_projects
```

A live preflight rejects an index whose status is not `ready` or whose canonical root differs from `--repo`.
It also requires `--cbmem-bin` to resolve to the `~/.local/bin/codebase-memory-mcp` executable that the npm extension invokes.
The result records index status, root, node and edge counts, and a status-response hash.
The runner rechecks the Git commit, Git status, and index-status hash after the final trial and labels detected changes as `runtime-drift`.
The benchmark cannot prove index freshness from `index_status` alone, so an already stale graph can still cause treatment failures.

## Live run

Live execution requires explicit model, project, and estimated-cost guard options:

```bash
just benchmark-cbmem \
  --live \
  --model <provider/model> \
  --project <exact-indexed-project> \
  --runs 5 \
  --max-cost-usd <approved-amount> \
  --output packages/pi-cbmem/benchmark/results/<result>.json
```

Each task and arm runs once by default.
Use at least five runs per arm for a useful diagnostic sample.
The order alternates by repetition as baseline/treatment then treatment/baseline, producing ABBA across two repetitions.

The cost guard is checked between trials.
One in-flight trial can exceed the configured estimate.
Pi catalog cost is an estimate and can remain zero for subscription-backed providers.

## Cache regimes

`--cache-mode warm` keeps the benchmark system prefix stable across repetitions.
`--cache-mode cold` adds a deterministic per-task and repetition nonce to the system prompt.
The paired baseline and treatment receive the same nonce.
Provider caching remains provider-controlled, so always inspect reported `cacheRead` and `cacheWrite` tokens.

Run cold and warm studies separately:

```bash
just benchmark-cbmem --cache-mode cold
just benchmark-cbmem --cache-mode warm
```

## Metrics

Every trial records these fields:

| Metric | Meaning |
| --- | --- |
| `usage.input` | Provider-reported uncached input tokens. |
| `usage.cacheRead` | Provider-reported cached input tokens. |
| `usage.cacheWrite` | Provider-reported cache-write input tokens. |
| `usage.output` | Provider-reported generated tokens. |
| `usage.providerTokens` | Sum of input, cache read, cache write, and output tokens. |
| `startupMs` | Process spawn through RPC controls and package provenance resolution. |
| `agentWallMs` | Immediately before the prompt RPC command through `agent_settled`. |
| `processWallMs` | Process spawn through `agent_settled`. |
| `toolDurationSumMs` | Sum of completed tool-call durations. |
| `nonToolResidualMsApprox` | Agent wall time minus summed tool duration, clamped at zero. |
| `timeToFirstToolMs` | Prompt start to first tool execution. |
| `timeToEvidenceCompleteMs` | Prompt start to the first tool-result point containing every expected literal. |
| `turns` | Completed Pi turns. |
| `providerRequests` | Completed assistant messages with usage. |
| `requestUsage` | Provider-reported token and cost breakdown for each completed assistant request. |
| `toolResultBytes` | Model-visible text bytes returned by tools. |

`processWallMs` intentionally includes temporary npm resolution from `-e npm:@narumitw/pi-cbmem` because that is part of the requested CLI invocation.
`agentWallMs` separates retrieval behavior from most startup and package-resolution work.
`nonToolResidualMsApprox` is only a diagnostic remainder because parallel tool durations can overlap.

The primary token efficiency metric is:

```text
all provider tokens spent by an arm / successful runs in that arm
```

The report also preserves successful-run medians, median absolute deviations, P95 values, failure counts, exact fact scores, tool names, result hashes, and package version provenance.
Do not discard failed runs when interpreting token efficiency.

## Indexing amortization

Index creation is outside measured trial latency.
Supply a separately measured indexing duration and expected reuse count when amortized treatment latency matters:

```bash
just benchmark-cbmem \
  --indexing-ms <milliseconds> \
  --index-reuse-count <expected-tasks-sharing-index>
```

The report adds `indexingMs / indexReuseCount` to the successful treatment median process time.

## Suite format

The default suite is [`suites/pi-extensions.json`](./suites/pi-extensions.json).
It targets facts in this repository's pi-cbmem implementation.

A custom suite must provide a unique id, exact expected facts, and at least one task.
Exact-payload tasks also provide one pi-cbmem tool name and argument object.
Use `${project}` in tool arguments to substitute the live `--project` value.

Expected facts are hidden from prompts but remain in the suite and result for deterministic grading.
Do not use tasks whose expected values can be inferred from their ids alone.

## Interpretation

Treat results as diagnostic unless the suite, model, package version, Codebase Memory binary, repository commit, index, run count, cache regime, and execution protocol were locked before inspecting outcomes.

A practical adoption threshold can require all of the following:

- Required-fact success does not decline materially.
- Median provider tokens per successful run fall by at least 15%.
- Median agent wall time per successful run falls by at least 10%.
- P95 agent wall time does not develop an unacceptable tail.
- Amortized indexing cost remains acceptable for the expected reuse count.

Exact-payload treatment is expected to use more tokens and time because it adds tool definitions, a tool-call turn, a tool-result envelope, and a local subprocess.
Same-evidence treatment can win only when more selective retrieval offsets that fixed overhead.

## Privacy and cleanup

Live trials send prompts and retrieved repository content to the selected model provider.
The runner does not store raw assistant responses or raw tool results in the report.
It stores hashes, byte counts, exact grader values, tool names, tool arguments, usage, timing, and package provenance.

The runner uses `--no-session` and closes every RPC process after `agent_settled` or failure.
SIGINT, SIGTERM, and per-trial deadlines terminate the active subprocess.
The npm source is resolved by Pi using its normal temporary package behavior.

## Limits

- Hosted model behavior, provider load, and caching remain nondeterministic.
- The default suite is small and repository-specific.
- Exact string grading can reject semantically equivalent wording by design.
- Tool-result literal detection is a timing proxy and does not prove when the model internally recognized a fact.
- Summed tool duration can overlap when tools execute in parallel.
- The benchmark does not measure code-edit correctness, test execution, or long-session memory behavior.
