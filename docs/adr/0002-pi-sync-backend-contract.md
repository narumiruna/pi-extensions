# ADR: pi-sync backend contract and publication safety

## Status

Accepted. The contract is implemented by the S3/R2, WebDAV, and Git backends.

## Context

Pi Sync must apply one collection, review, conflict, backup, rollback, and lifecycle policy across
storage systems with different consistency mechanisms. Storage-specific code must not decide which
local files to collect, whether a pull is safe, how user confirmation works, or how rollback changes
local state.

A remote write can fail before publication, conflict with another writer, or lose its response after
the active head changed. Treating all failures as ordinary errors would either risk overwrite or
misreport a committed mutation as absent.

## Decision

### Ownership boundary

`SyncBackend` owns remote persistence mechanics:

- a secret-free backend identity and destination summary;
- publication capability;
- active-head discovery;
- immutable snapshot retrieval;
- expected-head publication;
- history projection; and
- backend diagnostics.

Orchestration owns local and product policy:

- included-content collection and validation;
- secret/session checks;
- status/diff and user confirmation;
- local backup, transactional apply, and journal recovery;
- conflict choice and force review;
- rollback as a newly published head; and
- command, menu, cancellation, replacement, and shutdown behavior.

Backend selection occurs only after a complete version 3 storage connection and sync setup have been
validated and normalized.

### Distinct identity values

The following values are intentionally not interchangeable:

- **backend identity**: a secret-free canonical identity for one normalized backend destination;
- **snapshot ID (`snapshotId`)**: backend-neutral logical identifier carried in validated snapshot
  metadata; it is generated independently of file content and is not a content digest;
- **snapshot reference (`snapshotRef`)**: immutable backend-owned locator used to read one
  publication; and
- **revision**: opaque backend/identity-scoped active-head concurrency token.

Only the producing backend compares or decodes a revision. Orchestration may persist it and ask the
same backend whether two revisions match, but must not infer an ETag, commit, object path, or content
id from it.

### Expected-head publication

Every publication receives an explicit expected state:

```ts
type ExpectedRemoteHead =
  | { kind: "missing" }
  | { kind: "revision"; revision: string };
```

A backend must reject a visible mismatch before the active-head commit. `--force` does not bypass
this contract: orchestration re-reads remote state after the user's force review and publishes
against that newly observed missing/revision value. A second writer can still win after review.
Lease-protected Git and verified conditional WebDAV expose that race as conflict/unknown; S3/R2
returns conflict/unknown only for races it observes. Its non-atomic pointer update can let one
successfully verified publication be superseded by a concurrent writer that publishes afterward.

Immutable snapshot staging may occur before the active-head mutation. Orphan immutable objects are
safe and may be diagnosed or cleaned later; they are not an active publication.

### Commit boundary and cancellation

`PublishSnapshotOptions.onCommit` marks the backend's active-head commit boundary immediately before
the mutation that can make a candidate current.

- Before that boundary, caller cancellation is authoritative and must stop preparation, probes, and
  staging without changing the active head.
- At and after the boundary, the backend uses an independent bounded completion signal to determine
  the outcome. It must not report clean cancellation merely because the caller disappeared.
- A successful active-head mutation followed by auxiliary history or local-state failure is reported
  as published with a warning/error that describes the remaining recovery work.

Backends classify concurrent or ambiguous outcomes with:

- `SyncBackendConflictError`, which can carry an observed current head, phase, and whether the
  candidate may have been active; or
- `SyncBackendPublicationOutcomeUnknownError` when bounded verification/reconciliation cannot
  establish the current head.

Those optional conflict fields report only what a backend established. Current WebDAV 412 handling
returns the best-effort current head but does not assert that the candidate was active; its phase and
candidate-activity defaults are therefore not proof of the HTTP boundary.

### Backend capabilities

| Backend | Capability | Active-head protection |
| --- | --- | --- |
| S3/R2 | `read-check-write-verify` | Re-read expected head, write pointer, then verify; no atomic generic S3 compare-and-swap is claimed |
| WebDAV | `conditional-required` until proven, then `atomic-conditional` | Strong ETag plus live probes proving stale `If-Match` and existing-resource `If-None-Match` rejection |
| Git | `lease-protected` | Exact expected-ref `--force-with-lease`, including missing-ref creation |

Capability descriptions are user-visible diagnostics, not promises stronger than the implementation.

## WebDAV publication policy

### Transport and credentials

WebDAV uses bounded `GET`, `PUT`, `MKCOL`, `PROPFIND`, and probe `DELETE` operations. Paths are built
from encoded segments. Response/error bodies, request time, and redirects are bounded. Authenticated
redirects are followed only within the same origin; ambiguous or cross-origin redirects fail before
credentials can be forwarded.

Basic authentication is allowed only over HTTPS, except loopback deterministic tests. Embedded URL
credentials, query strings, and fragments are rejected. Username/password remain in private
`pi-sync.json`; destinations, revisions, diagnostics, and errors are redacted and terminal-safe.

### Immutable staging and active pointer

WebDAV retains immutable snapshot bundles and a small active `latest.json` pointer:

- immutable bundle creation uses `If-None-Match: *`;
- an existing immutable object is accepted only after its encoded bytes are verified identical;
- a missing active pointer uses `If-None-Match: *`; and
- an existing active pointer uses `If-Match` with the strong ETag retained in the opaque revision.

The conditional `latest.json` PUT is the active-head commit boundary. A 412 response is a typed
conflict with a best-effort current-head read. Any other PUT transport failure is reported as outcome
unknown. After a successful PUT, an independent bounded GET verifies success or reports an
after-commit conflict/outcome unknown.

### Capability probes and fail-closed behavior

A server is writable only after an isolated unpredictable probe proves all of the following:

1. a GET after initial creation returns the expected bytes and a strong ETag;
2. stale `If-Match` is rejected without changing the bytes;
3. `If-None-Match: *` is rejected for the existing resource without changing the bytes; and
4. replacement with the observed ETag succeeds, after which GET returns the new bytes and a distinct
   strong ETag.

Probe cleanup runs in `finally` and cleanup failures remain visible and redacted. Capability is
revalidated for publication rather than assumed from server branding. When ordinary reads succeed
but strong-ETag/precondition proof fails, reads remain available while publication fails before the
active pointer changes. Authentication or permission failures may make reads unavailable as well.
There is no weak-write fallback and no `LOCK`/`UNLOCK` protocol.

Vendor interoperability is represented by deterministic protocol fixtures; no claim is made that a
brand or deployment is safe without the live capability result.

## Backend-specific consequences

### S3/R2

S3/R2 keeps its existing immutable bundles and pointer/history wire format. Because generic object
stores do not expose a portable atomic pointer compare-and-swap here, Pi Sync performs
read-check-write-verify and reports its weaker capability. Simultaneous writers can still create an
ambiguous interval, so status review and unknown-outcome handling remain required.

### Git

Git maps the immutable reference and revision to commit/ref identity and protects the active branch
with an exact lease. Its strict complete-tree representation and process/cache boundary are recorded
in `docs/adr/0001-pi-sync-git-backend.md`.

## Consequences

### Positive

- Orchestration can remain backend-neutral without flattening real consistency differences.
- Force, rollback, cancellation, conflict, and unknown-outcome behavior share one contract.
- WebDAV never silently degrades to an unsafe mutable-pointer write.
- Snapshot IDs remain backend-neutral while references and revisions stay backend-owned.

### Negative

- S3/R2 cannot claim the atomic publication semantics available to verified WebDAV and Git; a
  publication can verify successfully and later be superseded by a concurrent pointer write.
- WebDAV deployments with weak or noncompliant conditional behavior are read-only.
- A post-commit transport failure may require status/doctor recovery because unknown is an honest
  terminal result.
- Immutable staging can leave unreachable objects after pre-publication failures.

## Verification

- Shared contract: `packages/pi-sync/test/backend-contract-suite.ts` and each
  `*-backend-contract.test.ts`.
- Orchestration and lifecycle: `backend-orchestration.test.ts`, `backend-lifecycle.test.ts`, and
  `publication.test.ts`.
- WebDAV transport/capability: `webdav-client.test.ts`, `webdav-backend.test.ts`, and
  `webdav-routes.test.ts`.
- Git lease/reconciliation: Git backend, runner, route, and config tests.
- S3/R2 compatibility and ambiguity: S3 backend, client-safety, publication, and state-revision tests.
