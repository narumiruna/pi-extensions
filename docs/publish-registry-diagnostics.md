# Publication registry diagnostics

The packed publication guard reports retries with a `[registry]` prefix. Each report identifies the exact package and version, operation, attempt, elapsed time, remaining budget, and next wait. Operations are `query metadata`, `download tarball`, `read tarball body`, and `retry wait`. Metadata failures include the npm exit code and a recognized error code when available. Artifact HTTP failures include the status code. A deadline error retains the current operation and last safe availability failure.

## Readiness budget

Each exact dependency version gets one fixed budget per check, measured with a monotonic clock:

| Check | Budget | Retry wait |
| --- | --- | --- |
| Read-only `verify-registry` job | Five minutes | Five seconds |
| Checks inside `publish-prerequisites`, `publish`, or the unsplit command | 30 seconds | Two seconds |

Metadata queries, downloads, body reads, and waits share the budget. Each retry queries exact metadata again and verifies the downloaded bytes. Attempts and operation changes do not reset the deadline. A wait never exceeds the remaining time.

Expiry aborts the shared signal passed to the metadata subprocess, fetch, body read, and wait. The guard checks the budget after awaited operations, so late success cannot permit consumer publication. A timeout is retryable only while budget remains; expiry itself is terminal.

In [run 45010061190, attempt 1](https://github.com/narumiruna/pi-extensions/actions/runs/45010061190/job/137170534598#step:6:1), Kit published but exact metadata returned E404 until the 30-second deadline. Five minutes is a bounded policy, not a registry propagation guarantee. If the gate expires on a temporary failure, [rerun the failed jobs](release-workflow.md#failures-and-recovery) with the original packed artifact rather than replaying successful prerequisite publication.

## Retry classes

The guard retries npm and artifact HTTP 404, 408, 429, and 5xx failures. Recognized temporary network codes are:

- `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, and `ETIMEDOUT`.
- `ECONNECTIONTIMEOUT`, `EIDLETIMEOUT`, `ERESPONSETIMEOUT`, and `ETRANSFERTIMEOUT`.
- `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, and `UND_ERR_SOCKET`.
- `TimeoutError`, including errors surfaced by a download, while the shared budget remains.

Authentication errors (`E401`, `E403`, and `ENEEDAUTH`), unknown failures, malformed or incorrect metadata, non-HTTP(S) URLs or URLs with credentials, redirects, and integrity mismatches stop without a readiness retry. Malformed integrity metadata blocks the download itself, even if the tarball is also unavailable. Dependencies omitted from a fresh plan or represented by tag-only entries still require verified registry artifacts. The guard does not retry native publication commands, republish earlier chunks, or weaken exact-artifact checks.

## Cleanup and limits

On POSIX systems, registry subprocesses run in an owned process group. Cancellation sends SIGTERM, then SIGKILL after a fixed one-second cleanup grace if processes remain. The helper waits for process and pipe closure, and retains escalation if the leader exits before its descendants. Normal registry completion also removes remaining group members. Windows uses direct-child termination; descendant cleanup has not been verified there.

During registry verification, scoped SIGINT and SIGTERM handlers abort the shared controller and stop consumers. The guard waits for query closure and staging cleanup, removes the handlers, then re-raises the original signal at the CLI boundary. Native publication retains normal signal handling. Shutdown cancellation is terminal and has a distinct diagnostic; it is not reported as deadline expiry. SIGKILL or other hard process termination cannot run JavaScript cleanup.

The termination grace is separate from readiness time. The budget is not a hard limit on total job runtime: process closure and OS scheduling can add cleanup time, each dependency has its own budget, and native Changesets publication is not timed by this guard. The guard releases its timers, listeners, unused response bodies, and staging on success or failure.

npm `view` already requests fresh metadata in the installed implementation. Its internal network retries remain subject to the guard's subprocess cancellation; they do not create another readiness budget.

## Output safety

Registry-check diagnostics report only recognized error codes, exit codes or HTTP statuses, package identities, operation names, and timing fields. They do not print captured npm stdout or stderr, registry metadata, artifact URLs, or provider exception details. Unknown failures omit arbitrary error fields. Successful registry responses are not printed. Native Changesets publication keeps its normal output.

The first attempt of [run 41465301437](https://github.com/narumiruna/pi-extensions/actions/runs/41465301437/attempts/1) did not retain its npm error code, so its precise cause cannot be reconstructed. Attempt 2 succeeded at the same main commit without either proposed retry fix. These records do not prove which registry or cache layer caused the original failure.

## Verification and release restriction

Deterministic tests cover delayed metadata and tarballs beyond the old retry window, mixed phases, exact deadline boundaries, stalled I/O, late success, terminal failures, output safety, and retained native reports. Controlled clocks and waits keep tests within the existing five-second timeout. An installed-CLI fixture uses fail-closed npm and Git shims. Local HTTP and Node child-process tests verify actual transport abort, signal delivery, process closure, escalation, resource cleanup, and CLI SIGINT/SIGTERM forwarding with preserved signal status without publication or real Git tags.

The repository maintainer must approve live publication, a merge that starts release work, or a release workflow dispatch. Hosted same-run artifact reuse across attempts, production npm propagation, OIDC provenance, and real GitHub tag/release writes remain unverified locally. On the next approved release, if the gate fails temporarily, confirm that **Re-run failed jobs** reuses the original artifact ID and does not repeat `pack` or `publish-prerequisites`. POSIX process-group tests run locally on Linux; Windows descendant cleanup is not verified.
