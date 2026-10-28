# Continuous sync verification

This record describes implementation evidence and test scope. The [settings reference](settings.md#experimental-continuous-sync) owns user-facing behavior, limits and recovery.

Later recovery classification, deadline propagation, confirmed-refusal retry, and read-only allowance/capacity diagnostics are documented in [Agent and Continuous sync recovery boundaries](agent-continuous-hardening.md). Historical verification below describes the original implementation.

## Boundaries and semantic audit

The change is confined to Pi Sync and its Changeset. It adds no dependency, provider, public command, interval setting, environment variable, Pi core change or dependency on another extension. Continuous sync is a separate experimental opt-in; Agent mode alone retains its existing behavior.

Applicable guides are root and package `AGENTS.md`, `docs/extension-conventions.md`, `docs/extension-settings.md` and `docs/readme-conventions.md`. The final diff audit covered their touched-area and verification checklists:

| Area | Audit and evidence |
| --- | --- |
| Lifecycle | No factory-owned watcher or timer. Work is keyed by `sessionManager`. Startup recovery remains an awaited barrier, including after Help. Foreground/agent work, replacement, reload and shutdown abort and drain owned work. Authorization checks also run during active requests when watching is unavailable. Lifecycle and scheduling tests assert released claims, leases, watchers and timers. |
| Ownership | Atomic guard creation, renewal, stale takeover, malformed records, future clocks, partial publication, replacement and process exit were checked against the installed `proper-lockfile` implementation. Cleanup fences both its asynchronous release and native synchronous exit path by guard identity and owner token. Separate-process tests cover contention, abrupt exit, takeover and successor preservation. |
| Settings | Existing ordered cross-process atomic writes remain authoritative. Consent binds the setup/connection; tests cover stale review, unknown fields, invalid files, failed save, retry and cancellation after publication. Disabling either prerequisite stops monitoring; saved and effective values remain distinct. |
| Transfer | Existing operation locks, current-session protection, snapshots, revision checks, conditional publication and journal recovery remain in use. Background ownership is checked before disclosure and mutation. Pending journals are reconciled before capability checks for a new transfer; uncertain publication is not blindly repeated. |
| Cost and privacy | Reservations sample time under the accounting lock, precede the public registry dispatch boundary and survive restart, crash, state-directory migration and owner handoff. Inconsistent window/candidate counts fail closed. Unknown outcomes consume reservations. Cached candidates cross fresh evidence checks. Private records contain safe metadata and hashes, not raw credentials, provider payloads, reasoning or duplicate conflict text. |
| Prefix stability | The parent system prompt, ordered tools and conversation prefix are unchanged. The existing isolated, tool-free child contract is unchanged; scheduler timestamps/status do not enter model-visible messages. No intentional parent-prefix transition is added. |
| UI | Existing Pi/Kit menus and confirmation reviews are reused. Tests cover RPC consent, cancellation and a 40-cell Settings screen with non-default navigation/confirmation/cancellation keys. Added status fields are safe categories, bounded dates and validated PIDs. Print/JSON create no continuous resources. |
| Packaging | Generated import checks retain the lazy boundary, validate emitted relative paths and keep Pi peers external. Jiti tests exercise command, one-shot startup and continuous resolution. Package-directory RPC and archive checks are described below. |

### Lock order and migration

Acquisition takes state-directory access, attempts the scheduler lease without waiting, and uses a short operation lock to publish ownership. A standby never waits for election while holding an operation lock.

Once elected, an idle owner retains the renewable scheduler lease, not the exclusive legacy migration guard. Each transfer/private-state mutation takes migration access before its operation/backend/cache locks. Idle metadata reads are fenced by the held lease and ownership checks. Inference retains required state access and its resolver claim, but releases the operation lock. Resolver and lease cleanup do not acquire that lock.

Migration never waits for a scheduler: a live lease causes a deferred result. A separate-process legacy-state test proves that an idle owner does not block foreground state access. Accounting binds to the canonical agent root, so moving the state directory does not grant new requests. Paused/lost owners remain fenced by guard identity, generation and token checks.

### Detection and failure decisions

Native watching is a hint, not authority. Missing/replaced paths, unsupported recursive watching and errors retain periodic fallback. Unknown event names are ignored because they can refer to private writes; the periodic scan covers them without a self-trigger loop. Filtering reuses the snapshot deny policy. The normal inspector supplies its existing snapshot fingerprint rather than making a duplicate full scan.

S3/WebDAV HTTP status, bounded Retry-After, network cause codes, timeout types and lock error codes provide explicit retry decisions. WebDAV retains a safe category before redaction. Structured synchronous model transport failures are preserved through the SDK boundary. Opaque assistant/Git errors are not guessed from text and remain blocked.

Unknown, authentication and storage failures require a relevant configuration change or explicit retry. Malformed local settings/scheduler records have a bounded local repair check, without remote/model work. Unsafe/refused evidence is re-inspected but not repeatedly resolved when unchanged. Partial progress retains unresolved groups as a stable block; restart tests prove that settled evidence causes no further inference, baseline changes or warning repetition.

The rolling model window does not prevent read-only checks, conflict-free progress or journal recovery. Full/invalid accounting blocks new requests rather than pruning spent evidence. These are request bounds, not a currency cap or an exactly-once billing guarantee.

## Deterministic verification

The new `test/continuous-*.test.ts` files cover consent/settings, typed failures, leases and native exit, durable accounting, lifecycle ownership, detection/debounce, fallback, deadlines, restart/backoff, refusal/partial deduplication, journal recovery, explicit retry routing and Status reads. Existing Agent mode, backend, settings, session-protection and recovery tests also pass. Every Vitest test retains the normal 5,000 ms limit. Settings tests check that On and Off saves report the saved state, including consent on enablement and non-default navigation keys.

Authorization regression tests also replace settings or the selected model after inspection, both before `syncBoth` reads settings and between its read and `mergeSync` initialization. Sixteen cases cover Continuous sync disablement, Agent mode disablement while Startup transfer stays enabled, credential replacement, and model replacement, with conflict-free and conflicting content. Watcher hints are suppressed and scheduler time does not advance. Each stale cycle must abort without a provider reservation, dispatch, publication, local apply, baseline change, or retained lease/claim. Fresh transfer settings are checked against the cycle's configuration; the periodic guard remains responsible for cancelling active requests.

The convergence fixture uses four real child processes across three agent directories and one conditional loopback WebDAV backend. Two processes share one replica and elect one scheduler. Local and remote-only edits converge without manual commands. A server-observed outage recovers automatically, and an idle standby takes over after the owner exits. Child IPC barriers wait for each cycle to finish before advancing simulated time; deadlines start after readiness, not during child import.

Final verification:

| Check | Result |
| --- | --- |
| `npm run check` | Builds, Biome, package boundaries and workspace typechecks passed. Existing informational lint notices remain. |
| `npm test` | 637 files passed, one skipped; 9,206 tests passed, two skipped. |
| Continuous regression suite | 99 tests across 12 files, included in the full gate; all 16 authorization regression cases failed before the fix and passed afterward. |
| Generated Jiti/build tests | Command, startup and continuous paths passed against conditional loopback storage. |
| README heading audit | Required headings/order checked across all 36 active package READMEs. |
| Package build, RPC and archive | Passed as described below. |

## CLI, package and load checks

The required package build and dry-run pack use:

```sh
npm --workspace @narumitw/pi-sync run build --if-present
npm run package:pack -- sync
```

An actual temporary archive is produced with `npm pack --workspace @narumitw/pi-sync --pack-destination <temporary-directory>`. Inspection checks its built entrypoint, lazy chunks, source and installed documentation, and excludes private state, tests and `node_modules`. No package publication, visibility change, tag or release workflow is performed.

A disposable agent directory loads the built package through non-interactive RPC with extensions, MCP, skills, templates and context discovery disabled, offline mode, and an explicit `-e ./packages/pi-sync`. The default-Off smoke checks command discovery, manager/Settings navigation, unchanged settings bytes and orderly exit without provider work.

`test/continuous-cli-smoke.ts` is a standalone smoke compiled by the test build. It prepares only synthetic text and a loopback conditional backend, waits for CLI readiness, then verifies automatic publication without a manual sync command. The durable provider count remains zero and the lease is absent after orderly exit. It does not open a TUI or contact a production storage/model service.

Separate-process load samples compare main commit `76ac610e` with Continuous sync Off, using the same installed dependencies and disposable agent directories after one discarded warmup:

| Build | Module import samples (ms) | RPC first-response samples (ms) |
| --- | --- | --- |
| Main baseline | 501, 482, 475 | 214, 194, 203 |
| Continuous sync Off | 503, 490, 494 | 221, 217, 214 |

These host-specific samples include cold-process module evaluation. They establish no timing threshold or performance improvement. Generated-graph tests separately prove that the scheduler/resolver remain lazy.

## Limits and unverified paths

No new live provider request was needed. The earlier Agent mode provider smoke is not evidence for this scheduler, and these fixtures do not measure semantic model accuracy. Production Git/S3/WebDAV services, provider-specific opaque errors, Windows and Android were not live-tested here; deterministic fallback/contract tests do not establish live-platform support.

All participating Pi processes must be upgraded before enablement. Older clients do not implement continuous election/accounting. The lease does not exclude arbitrary editors or writers in other processes, and the change adds no atomic local compare-and-swap or lossless live-session guarantee. Unsupported conflicts, uncertain journals and invalid private evidence retain review barriers. Private accounting remains retained and bounded; filling its limit requires repair rather than an automatic reset.
