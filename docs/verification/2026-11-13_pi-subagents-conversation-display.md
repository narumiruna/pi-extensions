# Subagents conversation display verification

Status: implementation verified. The change affects conversation tool rows and notifications only. It does not change the above-editor widget, settings, job execution, or model data.

## Display contract

All five main-agent tools have call and result renderers. Collapsed calls show an operation, target, and task or message preview when supplied. Results show job state, acknowledgement, or wait outcome. Inspection shows state counts and at most five job rows, ordered with failures, timeouts, and partial results first; hidden rows and expired retention entries have separate counts.

Completion notifications retain job identity, status, error, and limitation count when collapsed. Broker notifications identify the source job and request, distinguish requests from responses, and state whether a reply is needed. Expanded wait and completion results render decoded Markdown, with error and limitation text separate. Expanded broker messages retain their complete security envelope and plain-text body.

Valid structured details take precedence over conflicting or truncated JSON content. Missing or invalid details fall back to recognized serialized records or sanitized text. The renderers do not query current jobs or change recorded arguments, content, details, tool schemas, descriptions, active-tool order, prompt metadata, or delivery options.

Representative native output at 100 columns, without a bound expansion key:

```text
Subagent · Send · to job_demo
Main findings: review completed.
Request accepted · req_demo

Subagent · Inspect
2 jobs · 1 running · 1 failed
job_failed · failed
job_running · running

Subagent job completion
job_demo · failed · Child process exited with an error.
```

The original display used raw acknowledgement JSON and the first ten lines of inspection JSON. The new collapsed inspection does not spend its row budget on timestamps or JSON punctuation. A bound expansion action adds the host-formatted key hint.

## Acceptance evidence

| Check | Result |
| --- | --- |
| Focused renderer and generated runtime tests | 112 passed across `tool-renderers.test.ts`, `message-renderers.test.ts`, and `build-runtime.test.ts`. |
| Root verification | `npm run check` passed: builds, Biome, package boundaries, and all workspace typechecks. Existing schema-version and unrelated Sync lint diagnostics were informational, not failures. |
| Full tests | `npm test` passed without an affected-test base: 21,314 passed, zero failed, 34 skipped, 944 files, zero unhandled errors. |
| README audit | Fenced-code-aware required-heading audit passed for all 34 active extension READMEs; the new display section is separate from Quick start and widget documentation. |
| Package build and contents | Package build and `npm run package:pack -- subagents` passed. A real temporary 54-file tarball contains the generated entry, source renderer modules, README, changelog, and license, and excludes tests and node_modules. |
| Native conversation rendering | Built package loaded through Pi's Jiti loader. Native `ToolExecutionComponent` and `CustomMessageComponent` render readable summaries, decoded Markdown, and visible failure information. |
| HTML tool rendering | Pi's installed HTML tool renderer produced collapsed and expanded output for send, inspect, and wait; expanded wait content contains the decoded findings, not escaped newline literals. |
| Package-directory CLI smoke | `pi --mode rpc --no-extensions -e ./packages/pi-subagents` passed in an isolated agent directory: `get_state`, `/subagents` registration, and clean EOF shutdown. No model request was made. |
| Diff audit | `git diff --check` passed; widget, settings, execution, lifecycle, manifest, and lockfile files remain unchanged. |

The CLI smoke starts its completion deadline after the readiness response. Temporary agent directories and tarballs were removed. No image or binary artifact is committed.

## Semantic audit

The audit applies `docs/extension-conventions.md` and `docs/readme-conventions.md`.

- Tool failure uses the host's `context.isError`; a failed child remains a successful tool operation with an error-colored job outcome.
- A wait timeout explicitly states that the job was not cancelled; an execution timeout remains a distinct job state.
- Cancellation preserves an already-terminal outcome. Duplicate sends remain acknowledgements, not thrown tool errors.
- Valid details remain usable when model text is truncated. Unknown states, invalid payload fields, and non-envelope text retain a readable fallback rather than a fabricated outcome.
- Decoded identifiers, arguments, errors, limitations, results, and nested metadata strings are sanitized before layout. Structured display copies do not mutate payloads.
- Tests cover all seven states, incomplete arguments, pending results, errors, retention and row counts, duplicate acknowledgements, result-plus-error combinations, legacy records, conflicting or malformed payloads, and native Jiti composition.
- Renderer width, resize, and invalidation tests cover zero and narrow widths, wide and combining text, terminal controls, default/custom/multiple/unbound expansion keys, and older hosts without hint helpers.
- Raw payload equality and `convertToLlm()` equality are checked across rendering. Existing provider-prefix tests passed in the full suite.
- Components perform synchronous presentation only. No timer, input handler, task, session context capture, or resource ownership was added; cancellation and disposal policies remain with Pi and the existing runtime.
- The new Kit terminal-document subpath remains external and is explicitly allowed in the build graph. Interactive UI modules remain lazy; generated relative-import and lazy-boundary tests passed.

Pi owns the standard tool shell. With default padding, its minimum content cell can exceed a viewport below three columns; renderer-owned inner content is bounded. This host limitation is recorded in the README and an adjacent renderer comment. Native bounds tests cover widths where the host shell can fit, while renderer tests also cover zero through two columns.

A second independent read-only review job reached its execution timeout without a report. It is not counted as completed review evidence; the final audit above is the main agent's code and test review.

## External handoff

The maintainer can review subjective appearance after building and loading the local package in an interactive Pi terminal. Exercise send, multi-job inspection, a failed completion, and expansion of a Markdown result under the preferred theme. Expected behavior is a compact summary, visible job identity and state, and readable expanded content. Real interactive terminal appearance remains unverified because this execution environment prohibits opening an interactive TUI; native components, HTML rendering, and RPC package loading are verified. This visual check does not block agent-plan completion and does not authorize release.

No package was published, no tag or release workflow was created, and no user installation or settings were changed. Publication requires separate approval.
