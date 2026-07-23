## Goal

Consolidate `@narumitw/pi-subagents` into a fixed, cache-stable five-tool surface that preserves both blocking batch delegation and detached stateful execution:

- `subagent`
- `subagent_spawn`
- `subagent_send`
- `subagent_manage`
- `subagent_mailbox`

## Context

The extension currently exposes one blocking batch tool plus seven stateful lifecycle tools. The lifecycle API is precise, but `subagent_send` versus `subagent_message` is easy to confuse, polling-oriented tools remain visible despite non-polling guidance, and eight model-facing names add selection surface. Dynamically activating lifecycle tools would reduce visibility but can invalidate provider KV caches when tool schemas are added or removed.

The target keeps all five tools registered for the session. `subagent` remains blocking; `subagent_spawn` and `subagent_send` remain detached; management and mailbox operations remain immediate control-plane actions rather than waits for delegated output.

## Architecture

- Keep `subagent`, `subagent_spawn`, and `subagent_send` behavior and result contracts unchanged.
- Replace `subagent_list`, `subagent_interrupt`, and `subagent_close` with `subagent_manage` using `action: "list" | "interrupt" | "close"`.
  - `list` accepts only `includeClosed`.
  - `interrupt` and `close` require `agentId` and optionally accept `subtree`.
- Replace `subagent_message` and `subagent_messages` with `subagent_mailbox` using `action: "send" | "read"`.
  - `send` requires `agentId` and `message`, and optionally accepts `senderId` and `deduplicationKey`.
  - `read` requires `agentId`, and optionally accepts `acknowledge` and `limit`.
- Use provider-compatible flat TypeBox objects with `StringEnum` action fields and explicit action-specific runtime validation; do not use `Type.Union`/`Type.Literal` discriminators that are incompatible with Google tool schemas.
- Preserve current operation-specific `content` and `details` shapes so callers still receive `agent`, `agents`, `message`, or `messages` as applicable.
- Keep completion delivery, registry, persistence, hierarchy, transport, worktree cleanup, settings, and `/subagents:agents` behavior unchanged.
- Never change active tool membership in response to spawn, completion, interrupt, close, or mailbox state; explicit settings changes may still refresh prompt metadata as they do today.

## Non-Goals

- Do not add `subagent_wait` or change automatic completion delivery.
- Do not merge blocking `subagent` with detached `subagent_spawn`.
- Do not change subprocess/in-process transport behavior, persisted record format, concurrency policy, context selection, or workspace isolation.
- Do not add legacy model-facing aliases, because retaining them would violate the fixed five-tool goal.
- Do not publish, bump versions, or modify release automation as part of this plan.

## Assumptions

- The five-tool surface is an intentional public API break for the five replaced lifecycle names; migration documentation and rollback instructions are required before release.
- Existing persisted agents remain compatible because only model-facing tool registration changes; stored registry and mailbox schemas do not change.
- Action-based schemas are acceptable only if prompt-contract tests and a bounded model-facing smoke distinguish follow-up, queue-only message, mailbox read, list, interrupt, and close reliably.

## Risks

- Consolidated schemas can trade fewer tool names for weaker action selection or invalid cross-action argument combinations.
- Removing public tool names can break external prompts and resumed workflows that explicitly call the old names.
- `stateful.ts` is already about 905 lines; implementation must remain below 1,000 lines or extract cohesive tool contracts/dispatch helpers instead of adding an oversized action switch.
- Documentation or prompt guidance may retain old names and teach unavailable calls.
- A lifecycle-driven `setActiveTools()` optimization would undermine the cache-stability goal even if the final visible count is five.

## Rollback / Recovery

- Before publication, rollback is a source revert because persistence and settings formats remain unchanged.
- After publication, users can pin the previous `@narumitw/pi-subagents` version; its separate state directory remains readable because this change does not migrate stored records.
- If model-selection smoke shows unreliable action routing, stop the five-tool rollout and prepare a separate fixed six-tool design rather than introducing dynamic tool visibility or silently restoring aliases.

## Plan

- [x] Add red-first registration and schema contract tests in `extensions/pi-subagents/test/orchestration.test.ts` for exactly `subagent_spawn`, `subagent_send`, `subagent_manage`, and `subagent_mailbox` when stateful execution is enabled, no replaced lifecycle names, unchanged disabled behavior, exact action enums, and no lifecycle-driven active-tool mutation. Evidence: the first `npm test` run failed only because the implementation still registered the seven old lifecycle names (1053/1054 passed); the focused green run passed and preserved the mock active-tool set.
- [x] Add red-first action-dispatch tests covering every valid `subagent_manage` and `subagent_mailbox` operation plus missing, irrelevant, wrong-type, bounded-message, limit, subtree, unknown-agent, cleanup-failure, and repeated-close cases. Evidence: orchestration tests cover schema/runtime rejection paths; in-process tests cover all actions, deduplication/read acknowledgement, subtree close, cleanup failure recovery, and repeated close while asserting `agent`, `agents`, `message`, and `messages` details.
- [x] Refactor `extensions/pi-subagents/src/stateful.ts` to register the two consolidated tools and dispatch through small action-specific handlers while retaining existing registry, confirmation, interruption, subtree, persistence, truncation, deduplication, and worktree-cleanup behavior. Evidence: provider-compatible schemas/validators live in `src/stateful-tool-params.ts`; `stateful.ts` is 968 lines after rebasing onto the command-manager changes; package typecheck and the 95-test extension suite pass.
- [x] Update detached prompt metadata and tool descriptions so `subagent_send` means follow-up work, `subagent_mailbox(action="send")` means queue-only messaging, and anti-polling guidance names `subagent_manage(action="list")` and `subagent_mailbox(action="read")`. Evidence: prompt-contract tests assert the distinction and reject replaced names; scoped source search finds no legacy tool registration or guidance.
- [x] Update in-process and orchestration integration tests to exercise spawn, list, interrupt/reuse, follow-up, mailbox send/read/ack, subtree close, repeated close, completion delivery, and shutdown through the five-tool API. Evidence: all 95 `pi-subagents` tests and all 1072 repository tests pass; a live default-subprocess spawn/close smoke and the in-process integration both passed.
- [x] Run a bounded local Pi model-selection smoke covering list, interrupt, close, queue-only message, mailbox read, and follow-up prompts. Evidence: six isolated `pi --mode json --print` routes selected exactly `subagent_manage(list|interrupt|close)`, `subagent_mailbox(send|read)`, and `subagent_send`, each once with the requested arguments and `ROUTE_OK`; no fallback criterion was triggered.
- [x] Update `extensions/pi-subagents/README.md`, `docs/implementation-notes/pi-subagents-stateful-runtime.md`, `docs/implementation-notes/pi-subagents-native-runtime-alignment.md`, and `docs/implementation-notes/pi-subagents-capability-matrix.md` with the fixed five-tool table, blocking/detached semantics, old-to-new migration mapping, absence of `subagent_wait`, cache-stability rationale, and previous-version pin rollback. Evidence: scoped stale-name search finds replaced names only in migration text and negative contract tests.
- [x] Run Biome on intended files, package typecheck, `npm test`, the full `npm run check`, `just pack-subagents`, a non-interactive `pi -e ./extensions/pi-subagents` load smoke, `git diff --check`, and a final scoped stale-name/static-surface audit. Evidence: Biome and package typecheck passed; `npm run check` passed 1072/1072 tests; the dry-run tarball contains `src/stateful-tool-params.ts` and 23 expected files; package-directory load returned `LOAD_OK`; no publication or version change was made.

## Completion Checklist

- [x] Stateful-enabled sessions expose exactly four lifecycle tools, and the extension exposes exactly five subagent tools including blocking `subagent`; registration contract tests assert the exact ordered names.
- [x] Blocking batch, detached spawn/follow-up, management, and mailbox semantics pass action-level and integration coverage on both transports; deterministic in-process tests and a live default-subprocess spawn/close smoke passed.
- [x] Tool membership remains static across lifecycle transitions, preserving a stable provider tool-schema prefix during normal operation; source has no lifecycle `setActiveTools()` call and the registration test proves lifecycle calls leave the active set unchanged.
- [x] Model-facing smoke evidence distinguishes all consolidated actions and `subagent_send` versus queue-only mailbox delivery without repeated mis-selection; all six requested routes passed once.
- [x] Current user and implementation documentation match the five-tool API and clearly document the intentional migration and rollback path; stale names are confined to migration/history or negative tests.
- [x] Repository checks, package dry run, runtime load smoke, whitespace audit, and final diff review pass with no known required work remaining; version remains the rebased base version `0.26.0` and nothing was published.
