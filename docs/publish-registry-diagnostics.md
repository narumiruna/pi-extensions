# Publication registry diagnostics

The packed publication guard reports retries with a `[registry]` prefix. Each report identifies the exact package and version, operation, attempt, elapsed time, remaining budget, and next wait. Operations are `query metadata`, `download tarball`, `read tarball body`, and `retry wait`. Metadata failures include the npm exit code and a recognized error code when available. Artifact HTTP failures include the status code. A deadline error retains the current operation and last safe availability failure.

## Readiness budget

Each required dependency has one fixed 30-second budget measured with a monotonic clock. Metadata queries, tarball fetches, body reads, and waits all consume it. Each retry queries exact metadata again and verifies the artifact. Attempts and phase changes do not reset the deadline. Retry waits are two seconds, capped by the remaining time.

Expiry aborts the shared signal passed to the metadata subprocess, fetch, body read, and wait. The guard checks the budget after awaited operations, so late success cannot permit consumer publication. A timeout is retryable only while budget remains; expiry itself is terminal.

This replaces the six-attempt policy. [Run 40103992769, attempt 1](https://github.com/narumiruna/pi-extensions/actions/runs/40103992769/attempts/1) reported successful Starship publication followed by six `query tarball URL` E404 failures from 14:53:36 to 14:53:48 UTC. That history does not establish that a ten-second wait window is sufficient. Thirty seconds is an initial bounded policy, not a verified registry propagation guarantee.

## Retry classes

The guard retries npm and artifact HTTP 404, 408, 429, and 5xx failures. Recognized temporary network codes are:

- `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, and `ETIMEDOUT`.
- `ECONNECTIONTIMEOUT`, `EIDLETIMEOUT`, `ERESPONSETIMEOUT`, and `ETRANSFERTIMEOUT`.
- `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, and `UND_ERR_SOCKET`.
- `TimeoutError`, including errors surfaced by a download, while the shared budget remains.

Authentication errors (`E401`, `E403`, and `ENEEDAUTH`), unknown failures, malformed or incorrect metadata, invalid URLs, redirects, and integrity mismatches stop without a readiness retry. Dependencies omitted from a fresh plan or represented by tag-only entries still require verified registry artifacts. The guard does not retry native publication commands, republish earlier chunks, or weaken exact-artifact checks.

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

The repository maintainer must approve any live publication, merge that starts release work, or release workflow dispatch. Normal release approval and existing npm Trusted Publishing configuration are prerequisites. Inspect versions, tags, releases, and the failed step before recovery; already-published packages remain published. Hosted-runner timing, the sufficiency of the 30-second budget, npm OIDC publication, and real GitHub tag/release creation remain unverified locally. POSIX process-group tests run locally on Linux; Windows descendant cleanup is not verified. No live publication, version tag, or release workflow dispatch is authorized by this tooling change.
