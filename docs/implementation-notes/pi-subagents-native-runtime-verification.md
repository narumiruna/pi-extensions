# pi-subagents in-process runtime verification

Date: 2026-07-11

> Historical verification record. On 2026-07-23, the detached `subagent_wait` tool was removed and completion delivery gained opt-in batched `auto-resume`; the original wait/`triggerTurn: false` assertions below describe the earlier runtime.

## Automated evidence

- `npm run check`: passed with Biome, extension boundaries, every workspace typecheck, and 293 tests.
- `just pack-subagents`: passed; npm dry-run contained 22 files, including unchanged `src/subagents.ts` and new `src/in-process-transport.ts`, with no generated/test/temp files.
- Public import audit: `rg 'pi-coding-agent/(src|dist)/' extensions/pi-subagents/src` returned no private Pi imports.
- A deterministic mock provider drove a real public `createAgentSession()` child through prompt completion and disposal without network access or session files.
- Transport tests cover one-session/two-turn reuse, context/history seeding, model inheritance and explicit `provider/model:thinking` selection, current-turn-only prompts, stale-output rejection, timeout 124, parent abort 130, abort-during-creation, unsettled-child discard, custom-tool rejection, and all-session shutdown after one disposal failure.
- Resource-loader tests verify `noExtensions: true`, selected agent prompt injection, and trusted-project settings propagation.
- Registry tests cover detached spawn returning before settlement, one completion callback per settled turn, queued interruption completion, stale-error clearing on follow-up, ordered persistence snapshots under slow writes, exactly-once explicit close, child-before-parent subtree release, TTL release, inert restoration, persistence migration/redaction, and shutdown.
- Registered-tool integration exercises in-process detached spawn → interrupt → follow-up → wait → interrupt → reuse → close with one injected SDK child, verifies live parent model/thinking snapshots, and asserts four bounded `pi-subagent-completion` messages use `deliverAs: "steer"` with `triggerTurn: false`.
- Completion-format tests cover multiline metadata, private-marker redaction, multibyte task bounds, large errors plus partial output, and the 2 KiB final message cap.
- Existing subprocess, hierarchy, mailbox, context, persistence, write-conflict, and real worktree suites remain green.

## Local Pi runtime evidence

Both smokes used a temporary `PI_CODING_AGENT_DIR`, copied only runtime auth/model/settings files needed by Pi, installed a temporary read-only `scout` override using `github-copilot/gpt-4.1`, set `persistence: false`, and removed the directory through a shell trap.

- Default `stateful.transport: "subprocess"`: background spawn overlapped a main-agent README read, then wait completed and Pi returned `SUBPROCESS_STATEFUL_OK`.
- Opt-in `stateful.transport: "in-process"`: background spawn overlapped a main-agent read, then the same `agentId` completed wait → follow-up → wait → close and Pi returned `IN_PROCESS_STATEFUL_OK`.
- Detached completion smoke: the root called `subagent_spawn` once, performed README inspection plus workspace typecheck, never called wait/list/polling tools, consumed the automatic completion message, and returned `DETACHED_NOTIFICATION_OK`.
- An initial subprocess attempt inherited the environment's exhausted Codex quota and correctly returned the child usage-limit failure; the successful smoke selected the available Copilot provider explicitly rather than hiding the failure through transport fallback.

## Public SDK boundary

`InProcessTransport` uses public package exports only. It owns one in-memory SDK session per logical ID, disables child extensions, validates built-in tools, and disposes on timeout/abort/close/expiry/shutdown. It never silently retries a failed in-process task as a subprocess.

Core-global scheduling, inherited resolved approval/sandbox policy, provider-header extension hooks, arbitrary extension state, and interactive parent/child transcript switching remain unsupported. In-process sessions isolate conversation/tool selection but share the parent process memory and crash domain. `SubprocessTransport` remains the default rollback path.

## Rollback

Set `stateful.transport` to `"subprocess"` and reload Pi. Persisted logical records stay transport-neutral and restored work remains inert until explicit follow-up. Batch `subagent` execution is unchanged and continues to use subprocesses.
