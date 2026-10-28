# Agent and Continuous Sync Recovery Boundaries

Pi Sync distinguishes a rejected pre-publication observation from an uncertain publication. Only proven freshness failures retry automatically. Unknown errors do not become retryable because their text looks temporary.

## Failure classification audit

The authoritative paths are `src/sync/merged-sync.ts`, `agent-plan.ts`, and `continuous-errors.ts`. The error classifier follows at most eight unique causes and uses typed categories, backend conflict types, HTTP status, and known operating-system error codes. It does not infer policy from provider or Git error text.

| Decision branch | Classification and next action |
| --- | --- |
| Local bytes, baseline fingerprint, or remote revision changes before no-transfer baseline acceptance | `stale`; reject acceptance and inspect fresh evidence after bounded backoff. |
| Local bytes, baseline fingerprint, or remote revision changes before the publication journal | `stale`; no transfer of the rejected candidate. |
| Local bytes or baseline changes after journal creation, before any backend publication call | Clear the safely uncommitted journal first, then report `stale`; a cleanup failure retains its original classification. |
| Backend proves a conflict happened before commit and the candidate cannot have been active | Retire the uncommitted journal and use the existing bounded merge attempts; exhausted attempts retain the typed conflict cause and classify as `stale`. |
| Upload possible-secret scan; remaining unsupported or refused Agent groups | `unsafe`; retain evidence, suppress unchanged resolution, and inspect changed evidence again. |
| Bounded/unsafe Agent disclosure, unsupported conflict, missing verified ancestor, or invalid candidate application | `unsafe`; no inferred ancestor or bypass of partial-sync policy. |
| Missing model or unusable/refused resolver output | `model`; unchanged evidence does not repeatedly dispatch. A valid cached refusal stays cached during ordinary Sync now. |
| Changed local, baseline, or remote evidence during resolver validation | `stale`; discard authorization for that observation. |
| Known HTTP/network/lock errors | Preserve the existing typed/status/code policy and bounded retry delay. |
| Settings fingerprint, selected model, physical session root, or idle/automatic authorization changes | Stop the old authorization; do not convert a generic authorization error to `stale`. Continuous cycle guards can cancel and load fresh authorization. |
| Weak automatic-publication capability, local-field/policy migration, unresolved partial state while partial sync is off, missing baseline/selection, path collisions, bounds, protected paths, or an unverified plan | Retain existing review/error paths; no new automatic permission. |
| Delegated preflight, filesystem, settings/content merge, or review errors | Preserve their structured category/code when present; otherwise remain conservative. |
| Journal identity/local-field/session-root mismatch; publication bytes or selection cannot be proved; interrupted baseline changes; unsafe apply-only remote advance; missing remote selection metadata; lost automatic apply idle; remote changes during local apply | Preserve the journal and existing conservative recovery. No new automatic republishing or rollback is authorized. |
| Other publication exceptions or opaque provider/Git errors | Retain the cause and recovery evidence; `unknown` when no authoritative category is available. |

Existing safe journal retirement is unchanged. An inactive candidate with unchanged local/baseline preimages can be retired without publication. An apply-only journal with an advanced head can be retired only when its original preimages are unchanged. A journal whose committed baseline is already accepted needs cleanup, not another transfer.

## Resolver cancellation

The resolver combines caller cancellation with its own deadline and passes that signal to pre-dispatch validation, reservation, post-reservation validation, and post-response validation. Snapshot reads and backend head requests receive that signal. Ownership, settings, model, baseline, local bytes, and remote revision are checked again before acceptance.

SDK runtime/session construction and atomic private-file writes have no interruptible publication boundary. Pi Sync awaits those operations, checks cancellation around them, and drains the actual prompt and callbacks before releasing its claim and disposing the SDK session. It does not abandon them with `Promise.race()`. Installed Pi `AgentSession.abort()` waits for idle; `dispose()` is not a substitute for awaiting abort.

A request reservation published before cancellation remains spent. An atomic candidate replacement or remote commit remains committed. Provider content and charges cannot be recalled. The resolver deadline and outer startup/Continuous deadlines are separate; cleanup can take additional time.

## Confirmed refusal retry

Ordinary Sync now retains its existing cached-result policy. The manager-only **Retry refused model result…** action uses the same `sync` operation with an internal control value, not a new public command, flag, or setting.

The action requires Agent mode, foreground TUI/RPC, an accepted baseline, matching current evidence, a valid cached refusal, and no pending merge journal. A pending journal must be reconciled through ordinary Sync now or reviewed recovery first. A missing, accepted, corrupt, stale, or unverified cached result is not retry authorization. Opening the manager may show the action before eligibility is known; activation checks it without dispatching when those conditions are absent.

The flow holds the existing resolver claim while the operation lock is released for review and inference. The safe-default review names the setup, connection, exact configured storage path and bucket/branch where applicable, selected provider/model, conflict paths, disclosure, cost, and possible writes. Confirmation binds the same candidate key and cache bytes. Changed settings, model, session, evidence, or cache invalidates it. A competing participant cannot obtain another live resolver claim.

One fresh request is permitted for the reviewed candidate. A second refusal, malformed response, cancellation before acceptance, or changed evidence does not replace the active refusal. A complete result passes the normal parser, assembled-file bounds, merged-target preflight, upload secret policy, and fresh local/baseline/remote checks before its cache publication callback can run. Under the claim and operation lock, Pi Sync checks the original cache again and writes a private content-keyed refusal archive before atomic active-candidate replacement. Failed replacement retains the old result; a failure after replacement publication still retains the archive. The existing candidate format is unchanged, and older readers ignore the archive names.

Retry does not reset Continuous request counts, remove candidates, or add background confirmation dialogs. A reviewed retry is a separate manual authorization and can incur another charge even when the automatic window is full. It does not authorize retries for another candidate if evidence changes later.

## Read-only diagnostics

Status normalizes only a detached record read. It reports the rolling-window allowance, next window eligibility, exhausted candidate counts, serialized accounting capacity, actual stored bytes, verified advisory owner, and category-specific recovery actions. Window allowance is not dispatch authority. Candidate, capacity, ownership, and safety checks still apply.

The owner's model is unavailable unless authoritative owner data supplies it; the current observing session is not evidence of another owner's model. Invalid records are retained and do not represent unused allowance. Status creates no directories, leases, reservations or files and does not clear accounting. Full accounting requires reviewed repair, not count pruning or deletion. Candidate and refusal archives remain retained without automatic pruning.

## Verification

The audit follows root and package `AGENTS.md`, `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`. It checks touched-area requirements, asynchronous cancellation/disposal/replacement/shutdown, prefix stability, atomic private publication, unchanged settings/accounting formats, TUI/RPC behavior, and package boundaries.

Focused tests cover recovery races and content repair, disclosure preflight, deadline propagation and draining, refusal review/replacement, structural merge fixtures, and read-only diagnostics. The [quality corpus](agent-quality-verification.md) defines structural expectations; mocked replies do not measure model accuracy.

Verification uses the Node version pinned by `.node-version` and its bundled npm. A full serial run used Vitest's public `VITEST_MAX_WORKERS=1` override on a busy host. The final full gate also passes with the standard worker configuration; the 5,000 ms test limit is unchanged.

| Check | Evidence |
| --- | --- |
| `npm run check` | Builds, Biome, package boundaries, and workspace typechecks pass. Existing informational lint notices remain. |
| Full `npm test` with pinned Node | 744 files pass; 13,103 tests pass and 19 existing tests are skipped; zero unhandled errors. The earlier full serial run also passed before two final owner-expiry cases were added. |
| Original-source regressions | Two recovery cases fail with `blocked/unknown`, the disclosure preflight fails with one request instead of zero, and all nine resolver deadline regressions fail before the fix. The fixed focused recovery/preflight/deadline/Jiti run passes 35 tests. |
| Generated Jiti runtime | Command, startup, Continuous, and confirmed-refusal retry resolve synthetic conflicts against conditional loopback WebDAV. The retry loads its lazy review chunk and retains a refusal archive. |
| Package-directory RPC, default Off | Command discovery and manager/Settings navigation pass; settings bytes remain unchanged and no agent run or scheduler/resolver resource starts. |
| Package-directory RPC, Continuous On | A synthetic local edit publishes automatically to loopback storage; durable provider count is zero and the scheduler lease is absent after orderly exit. |
| Package build and archives | Package build, `npm run package:pack -- sync`, and a real temporary archive pass. All 306 files match the runtime/docs boundary; no tests, private state, credentials, or `node_modules` are included, and Pi peers stay external. |
| README and semantic review | Required headings/order pass for all 36 package READMEs; changed local links resolve. Independent source review and the final diff audit cover correctness, trust boundaries, lifecycle, persistence, compatibility, regressions, and scope. |

Earlier verification exposed test typing/lint issues, fixture assumptions, and an asynchronous menu-factory adapter regression; these were corrected and the affected suites rerun. The final manager checks cover 35 refusal UI cases, including owner expiry before a recovery warning. Source review also corrected no-consent partial progress, premature refusal replacement, and silently dropped recovery decisions. A full run with the shell's older Node passed all 13,099 executed tests but failed the repository's pinned-Node setup assertion; it is not a passing gate. Earlier parallel attempts also hit host-load timeouts. No timeout was increased or failing suite skipped to obtain a result.

No live provider, production Git/S3/WebDAV, Windows, or Android verification is claimed. The corpus does not measure production semantic model accuracy. No package publication, tag, visibility change, release workflow, or live model request is part of this change.

## Downgrade and recovery

Stop Continuous sync and drain all participating owners before downgrade. Disable Agent mode too if autonomous startup work must stop. Reconcile pending journals with the current runtime. Preserve backups, snapshots, accepted and refused candidates, unresolved groups, and request accounting. This change adds no settings, accounting, or candidate schema migration. Do not delete private state to regain allowance or blindly republish an uncertain transfer.
