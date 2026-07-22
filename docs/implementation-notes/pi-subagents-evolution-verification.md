# pi-subagents evolution verification

Date: 2026-07-11

> Historical verification record. On 2026-07-23, detached waiting was removed and completion delivery gained opt-in batched `auto-resume`; wait-based smoke details below describe the earlier tool surface.

## Release gates

The implementation is organized as independently reversible modules:

1. Runner hardening: `protocol.ts`, `limits.ts`, and `runner.ts`.
2. Stateful lifecycle: `registry.ts` and default-on registrations in `stateful.ts`.
3. Context and policy reporting: `context.ts` and `SingleResult.policy`.
4. Persistence/recovery: `persistence.ts`.
5. Inspection/core boundary: `/subagents:agents`, capability matrix, and core API proposal.

The existing `subagent` schema remains the compatibility path. Setting `stateful.enabled: false` removes all lifecycle tools without affecting batch calls; `stateful.transport` defaults to `subprocess` and provides the runtime rollback path. Persisted state is separate, versioned, and transport-neutral; older package versions ignore it.

## Automated evidence

- `npm run check`: passed; includes Biome, package-boundary checks, all workspace typechecks, and 293 tests.
- `just pack-subagents`: passed; dry-run tarball contained README, license, package metadata, and all 19 source modules, including `src/in-process-transport.ts` and the declared `src/subagents.ts` entrypoint.
- Process fixtures verified SIGTERM-resistant forced kill in about 54 ms with a 30 ms test grace period.
- Registry fixtures verified FIFO active-turn capacity, retained-agent capacity, wait timeout, interrupt/reuse, close, idle expiry, inert restoration, corruption quarantine, redaction, and deletion.

## Privacy and security review

Result: PASS for the documented default-on lifecycle and opt-in in-process transport boundaries.

- Persisted records are versioned, count/age/size bounded, written atomically with mode 0600, and contain no process IDs.
- `<private>` blocks and `[subagent-private]` lines are removed from transferred and persisted text; tests inspect the raw state file for excluded values.
- Corrupt and unsupported versions are quarantined; restored work is always inert and never resumes side effects.
- Project-local definitions require Pi project trust even when confirmation is disabled; interactive confirmation remains an additional guard.
- Tool allow-lists are not described as an OS sandbox. Unsupported approval, sandbox, and provider-header inheritance is exposed in result metadata and README warnings.
- Active/queued work is bounded, session shutdown drains queued work without starting it, and active process groups use tested TERM/KILL cleanup.

## Runtime smoke evidence

Executed from the repository root with the local package:

- Single: `pi -e ./extensions/pi-subagents -p ...` returned `SMOKE_OK`.
- Parallel plus chain: local Pi run returned `PARALLEL_CHAIN_OK`.
- Hard timeout (`timeoutMs: 1`): local Pi run returned `TIMEOUT_OK` after observing the timeout result.
- Default subprocess stateful spawn plus overlapping main-agent read returned `SUBPROCESS_STATEFUL_OK` from a temporary agent directory.
- In-process spawn, overlapping main work, wait, follow-up, second wait, and close returned `IN_PROCESS_STATEFUL_OK`; temporary config/auth copies were removed by a shell trap.
- Detached in-process spawn without wait/list/polling overlapped README inspection and workspace typecheck, consumed the automatic non-triggering completion, and returned `DETACHED_NOTIFICATION_OK`.
- Abort cleanup is covered by pre-aborted and mid-stream child integration tests that preserve partial output, plus registry and process-group termination fixtures; interactive Esc itself was not automated because it requires terminal input.

## Bounded acceptance thresholds

| Scenario | Threshold | Evidence |
| --- | --- | --- |
| One-shot result | Completes through local extension and returns exact worker text | `SMOKE_OK` runtime smoke |
| Four-way fan-out | Never exceeds four active workers | `mapWithConcurrencyLimit` constant plus concurrency contract tests |
| Stateful scheduling | FIFO and no more than configured active turns | registry fairness test |
| Follow-up | Reuses the same opaque ID and appends bounded history | registry lifecycle test |
| Wait timeout | Returns while worker remains queued/running | registry lifecycle test |
| Interrupt/reuse | Interrupted identity accepts a later follow-up | registry lifecycle test |
| Context selection | none/all/recent N; output at most 50 KiB | context and UTF-8 boundary tests |
| Reload/restore | No task auto-resumes; restored state is idle | persistence and restoration tests |
| Cleanup | SIGTERM then forced kill; fixture exits within 1 second | forced-kill test |

## Migration and downgrade

No existing settings or request fields are renamed. `stateful` remains an optional settings object; omission enables lifecycle tools with the subprocess transport, while `enabled: false` removes them. Unknown future state versions are quarantined instead of interpreted. Downgrade leaves the separate state directory untouched and harmless; users can clear it before downgrade with `/subagents:agents clear` when running the new version or remove `~/.pi/agent/pi-subagents-state/` manually after Pi exits.
