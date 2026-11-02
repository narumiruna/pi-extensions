# Publication registry diagnostics

The packed publication guard reports each retry with a `[registry]` prefix. The message identifies the exact package and version, metadata or artifact operation, attempt number, and two-second retry delay. Metadata failures include the npm exit code and a recognized npm error code when available. Artifact HTTP failures include the status code. The final error retains the last failed operation and attempt number.

## Retry policy

Each required dependency receives at most six availability attempts, with five waits of two seconds. Every attempt queries exact metadata and verifies the downloaded artifact again. The guard retries npm and artifact HTTP 404, 408, 429, and 5xx failures. It also retries recognized temporary network errors:

- `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, and `ETIMEDOUT`.
- `ECONNECTIONTIMEOUT`, `EIDLETIMEOUT`, `ERESPONSETIMEOUT`, and `ETRANSFERTIMEOUT`.
- `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, and `UND_ERR_SOCKET`.
- Artifact `TimeoutError` failures, including the download's 30-second timeout.

These are availability attempts, not a total runtime limit: npm can perform its own internal retries, and each artifact download has its own timeout. npm `view` already requests fresh metadata in the installed implementation.

Authentication errors (`E401`, `E403`, and `ENEEDAUTH`), unknown failures, malformed or incorrect metadata, invalid URLs, redirects, and integrity mismatches stop without a readiness retry. Exhausted retries block dependent publication. The guard does not retry native publication commands, republish earlier chunks, or weaken exact-artifact checks.

## Output safety

Registry-check diagnostics report only recognized npm error codes, numeric exit codes or HTTP statuses, package identities, and attempt counts. They do not print captured npm stdout or stderr, registry metadata, artifact URLs, or exception details from downloads. Unknown npm errors retain the exit code without exposing arbitrary error fields. Successful registry responses are not printed. Native Changesets publication keeps its normal output. The original npm output from run `41465301437` is not available, so its precise registry failure cannot be reconstructed.

## Verification and release restriction

Deterministic tests cover delayed metadata and tarballs, terminal failures, retry exhaustion, output safety, response-body release, temporary-directory cleanup, and retained native reports. An installed-CLI fixture uses fail-closed npm and Git shims with a local HTTP server. Tests inject an immediate wait and do not publish registry packages or create real Git tags.

The repository maintainer must approve any live publication or release workflow dispatch. Normal release approval and existing npm Trusted Publishing configuration are prerequisites. A later approved release must verify hosted-runner registry timing and OIDC publication. Those behaviors and real GitHub tag/release creation remain unverified locally. Inspect versions, tags, releases, and the failed step before recovery; packages published before a failure remain published. No live publication, version tag, or release workflow dispatch is authorized by this tooling change.
