# Upstream durable recovery evidence

`durable-upstream.test.ts` verifies upstream behavior, not the proposed reusable-agent runtime. Production integration remains blocked on host checks before recovery. In particular, missing selected capabilities do not block execution, and recovered tool intent skips `beforeTool`.

## Environment and scope

Inspected installed `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord`: all resolve to `1.2.0`. Tests ran on Node `26.11.1`; durable declares Node `>=22.19.0`. Its README explicitly marks the API **Experimental** and subject to change without notice.

Only the new test and this note are owned by this task. They do not import the parallel durable fixture or change production code, settings, metadata, or entrypoints. All requests use a synthetic provider. Storage directories are temporary and outside the repository.

Reviewed `AGENTS.md`, the validation plan, `docs/extension-conventions.md`, and `docs/extension-settings.md`. Applicable MUST rules are resource cleanup, cancellation, visible failures, serialized persistence, trusted code and explicit capabilities, public APIs, and deterministic verification (`Test`, `Review`). No settings or UI rules require implementation changes.

## Public API map

| Purpose | Public API |
| --- | --- |
| Define application state and work | `defineDoc`, `defineTask`, `defineExtension`, `createRegistry` |
| Open and observe | `Harness.open`, `root`, `inspect`, `getTask`, `snapshot`, `Conversation.context` |
| Admit model input | `Conversation.submit`; `Submission.wait`, `Harness.submission` |
| Create a task checkpoint without starting work | `Conversation.commit` with `Tx.createTask` |
| Start recovery | `Harness.resume`; waiting or submitting also starts scheduling |
| Cancel work | `Harness.abortTask`; this method alone does **not** start scheduling |
| Suspend and release | `Harness.close`; unfinished work remains recoverable |
| Storage | Root `MemoryStorage`; exported `storage/jsonl/node` adapter with `fsync: true` |

`Tx.createSubmission` is a raw persistence operation, not normal admission. These tests never use it. Runtime imports use only public exports. Installed implementation files were read for branch evidence, never imported or edited.

## Tested branches

| Case | Evidence |
| --- | --- |
| Missing task definition | `inspect` reports `blocked/missing_task`; input, checkpoint, and document survive; registry installation alone wakes the enabled scheduler and completes once. |
| Incompatible definitions | Stored version newer than installed reports `task_too_old`. Newer installed definition without migration reports `migration_failed`; the scheduler reports the missing migration. Neither executes or changes the checkpoint. Reinstalling the stored version permits completion. |
| Explicit task abort | With a definition, abort marks work but leaves scheduling paused. With a missing definition, the tested childless task is immediately `orphaned/missing_task`. Waiting explicitly enables scheduling. |
| Failed commit | Injected failure rejects its caller with the original error; a pending submission wait and later calls receive `SessionFailed` with that cause. The active tool receives cancellation; `closed` reports failure and `onReport` reports once. Reopen retains document, transcript, submission identity, and task checkpoints. Only `running` changes to `pending`; `waiting` stays `waiting`. |
| JSONL torn tail | For main, task, and document files, an incomplete final line without newline is truncated. Confirmed task/document records remain usable and the task completes after installation. |
| JSONL corruption | For all three file classes, a newline-terminated malformed JSON line rejects open with `JsonlCorruptionError`. File bytes and names remain intact in these cases. |
| Missing capabilities | Reopen with the selected extension absent returns empty extensions/tools. Restoring its name without its selected tool still omits that tool. Stored selections remain unchanged; a new request succeeds without a report. |
| Missing model | Unconfigured model, missing provider, and missing model ID settle input as `unanswered/no_model`, with no provider request. The Harness can run a subsequent repaired submission. |
| Request recovery failures | Reopen a committed `request` checkpoint with missing provider/model: `unanswered/no_model`. Missing auth or a throwing API-key resolver: `unanswered/model_error`, with diagnostic detail and no provider execution. Task and submission identities remain inspectable; committed transcript prefix is retained. |
| Provider stream error | A synthetic `401 Unauthorized` throw becomes an assistant error and `unanswered/model_error`, not Harness failure. A subsequent submission succeeds. |
| Tool restart policy | Only stored-safe/current-safe reruns. Safe/unsafe, unsafe/safe, unsafe/unsafe, and safe/missing return an `interrupted` tool error without repeating execution. The submission can still finish after the model sees this result. |
| Trust hook replay gap | First execution calls `beforeTool`. Safe recovery bypasses a newly blocking `beforeTool`; unsafe recovery does not call it either. A synthetic external idempotency ledger prevents duplicate effects when safe execution runs twice. This is not an upstream exactly-once guarantee. |

## Authoritative branch locations

Paths below are read-only installed implementation evidence, relative to `node_modules/@earendil-works/`:

- `pi-durable/dist/harness/scheduler.js`: `open` normalizes `running` to `pending` without dispatch; `resume` enables dispatch; registry notifications kick enabled scheduling. `#fit`, `#resolve`, and `#inspectTask` distinguish missing tasks, older installed code, equal versions, and migrations. Migration errors are cached per definition and reported; successful migrations and hot replacement of running definitions are separate, untested paths.
- `pi-durable/dist/harness/harness.js`: `abortTask` forwards without `resume`; `waitForTask` explicitly resumes.
- `pi-durable/dist/session/session.js`: guarded storage calls fail the Session; failure seals admission and closes resources. A failed commit is not retried or replaced by a reset.
- `pi-durable/dist/storage/jsonl/storage.js`: `readLines` truncates bytes after the last newline before parsing; complete malformed JSON throws. `recover` confirms sidecar references and removes valid unconfirmed tails separately. These tests cover torn lines and malformed complete lines, not every confirmation/reclamation branch.
- `pi-durable/dist/harness/agent.js`: `selectExtensions` skips absent names; `filterTools` skips absent selected tools. This is not a compatibility gate.
- `pi-durable/dist/harness/generation.js`: `prepare` and `request` check model availability; stream classification distinguishes successful output, overflow, retries, and terminal model errors. Tests disable compaction and retries.
- `pi-ai/dist/models.js` and `pi-ai/dist/auth/resolve.js`: missing auth and resolver failures become stream errors before provider dispatch. OAuth refresh and real credential stores are not exercised.
- `pi-durable/dist/harness/tool.js`: `call` validates and invokes `beforeTool`, then commits `execute` intent. Recovery enters `execute` directly and reruns only when both stored and current policy are safe. The default policy is unsafe. Other combinations, including missing implementation, settle as interrupted.

## Host requirement and limits

Before enabling scheduling, the host must check session/branch ownership, project trust, selected capabilities, provider availability, and compatible runtime code. It must block visibly on a mismatch. Do not use tool hooks as the sole recovery trust check: they do not guard the replay branch. This test adds no host policy or ownership lock.

The memory wrapper only delays backend close between Harness instances and injects a failure **before** commit. Final cleanup closes the underlying storage. JSONL cases close and reopen separate backends serially; no two writers share a directory. Controlled tool/provider checkpoints use cancellation-aware waits; cleanup closes every Harness before removing storage. No fixed sleeps or timeout overrides are used.

This file does not prove process-crash recovery, power-loss safety, commit-success/response-loss ambiguity, cross-process locking, real authentication, host reload/session replacement, report delivery, main-session receipts, prefix compatibility across ordinary turns, or complete agent lifecycle semantics. Unsafe tools may already have external effects: an interrupted result cannot undo them. A separate host design and the remaining plan tests are required before integration.

## Verification

- `npm exec -- vitest run packages/pi-subagents/test/durable-upstream.test.ts`: **26 passed**, within the configured 5,000 ms per-test limit.
- `npm exec -- tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node packages/pi-subagents/test/durable-upstream.test.ts`: passed.
- Focused Biome check: passed after formatting the owned test file.
- Semantic review: public import boundary, cancellation, repeated close, persistence preservation, replay policy, and trust/capability gaps reviewed against the applicable guides.
- Root build/check, full tests, package pack, and Pi loading smokes: not run, as requested. No production loading or publishing path changed.
