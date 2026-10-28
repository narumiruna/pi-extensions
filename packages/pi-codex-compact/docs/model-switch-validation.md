# Checkpoint replay after a Responses model switch

Validation date: October 18, 2026.

An exact match between the selected model ID and a checkpoint's recorded model ID was unnecessary for the tested model pair on the same Responses-compatible backend. Both models accepted the opaque state. The extension rejected that state locally before it could reach the backend.

This is an observed compatibility result for one backend and model pair, not a guarantee that arbitrary models, accounts, endpoints, or protocols share opaque-state support.

## Environment and original failure

| Component | Tested version or setting |
| --- | --- |
| Pi | `@earendil-works/pi-coding-agent` 1.3.0 |
| Extension before repair | `@narumitw/pi-codex-compact` 0.56.1 |
| Platform | Linux; Node 24.21.0 |
| Live compaction protocol | `remote-v2` |
| Model A / Model B | `gpt-6.1-sol` / `gpt-6-astra` |
| Test tools | TypeScript 7.0.2; Vitest 5.0.3; Biome 2.5.15 |

Model names are normalized contributor labels, not independently verified backend revisions. Deployment information, credentials, raw session files, and private configuration are omitted. Live tests used synthetic conversation content.

The failure sequence was:

1. Compact a conversation on model A and persist a genuine opaque checkpoint.
2. Switch to model B using the same authorized Responses API and compatibility profile.
3. Continue normally or compact again.

Normal continuation omitted the opaque checkpoint. Repeated compaction emitted both warnings and cancelled:

```text
Warning: Responses compaction failed; applying checkpoint recovery (summary or safe cancellation). The active opaque checkpoint belongs to a different Responses model
Warning: Checkpoint recovery could not complete; compaction cancelled and history preserved. The active opaque checkpoint belongs to a different Responses model
```

`isCheckpointCompatible()` required `model.id === details.modelId`, preventing both context projection and provider-payload injection after a switch. Separately, `projectedCurrentMessages()` rejected a different model ID before dispatching compaction. Recovery called the same projection function and failed again. These client-side failures did not establish backend incompatibility.

## Repair and regression coverage

The repair removes both exact-model comparisons within the issuing provider and retains API/profile authorization, summary identity, retained-history fingerprints, marker validation, and branch/session ownership. A model change during an in-flight compaction still cancels that operation. The stored `modelId` remains creator provenance; a subsequent checkpoint records the currently selected model. Backend errors still follow the existing recovery policy.

| File | Change |
| --- | --- |
| `src/codex-compact.ts` | Permit compatible cross-model projection, replay, recompaction, and recovery. |
| `src/checkpoint.ts` | Describe replay in terms of compatible API/profile instead of identical model names. |
| `test/lifecycle.test.ts` | Check cross-model context/payload replay and repeated compaction, including selected request model and new checkpoint provenance. |
| `test/context-management-session.test.ts` | Check persisted checkpoint projection on another model after reload/resume/fork. |
| `test/rejection-recovery.test.ts` | Check cross-model encrypted-state recovery and retain pre-dispatch rejection for an incompatible API. |
| `docs/implementation.md` | Document the compatibility boundary and model provenance. |
| `.changeset/compact-model-switch.md` | Request a patch release for the behavior change. |

Before repair, the real Pi session regression with mocked HTTP returned 14 passes and 2 failures: switched-model compaction cancelled, and ordinary replay had zero opaque items instead of one. The targeted lifecycle unit regression independently returned 26 passes and 1 failure because context projection was missing after the switch.

After repair, the focused package suite passed **24 files / 546 tests**. A separate harness loading the generated entry through actual Pi sessions passed **17 checks**, covering ordinary replay, manual/repeated/automatic compaction, switch-back, resume/reload/fork, API mismatch before dispatch, recovery policy, abort, and cancellation when the model changes during compaction. This harness used mocked HTTP and establishes runtime behavior, not service compatibility.

## Live compatibility evidence

A direct backend probe first bypassed the local model-ID restriction: A created an opaque checkpoint, B recalled the synthetic assistant-only fact `VIOLET-5831`, and B compacted the checkpoint again. All three completed successfully (3.792 s, 1.652 s, and 3.937 s). An earlier attempt encountered a service throughput rejection before cross-model replay; it was not counted as a compatibility result.

The complete live test then used Pi's normal HTTP transport and generated extension entry with `SessionManager`, `setModel()`, `compact()`, `prompt()`, and reload:

| Operation | Observed result | Wall time |
| --- | --- | ---: |
| A compacts | `fromHook=true`; genuine opaque item, 2,956 encrypted-content characters | 6.368 s |
| Switch A → B; ask for the old fact | Recalls `VIOLET-5831` and the new-work marker `CONTINUITY-2048` | 5.792 s |
| Continue on B; compact again | `fromHook=true`; new opaque item, 3,492 encrypted-content characters; checkpoint records B | 9.518 s |
| Reload; switch B → A; ask again | Recalls both values from B's checkpoint | 3.748 s |

There were zero extension errors and no native-summary fallback in this live chain. These timings describe the recorded run, not a performance comparison.

The old fact initially appeared only in an assistant message. After each compaction, assertions verified that its plaintext was absent from `replacementHistory`. New work pushed both the original message and the first recall outside the retained recent window before the next compaction. Follow-up questions did not contain the expected fact. This makes the opaque checkpoint necessary for the observed recall; a visible marker or retained plaintext cannot explain the result.

## Re-running the repository checks

From the repository root, with dependencies installed and a supported Node version:

```bash
npm --workspace @narumitw/pi-tui-kit run build
npm --workspace @narumitw/pi-codex-compact run build
npm --workspace @narumitw/pi-codex-compact run typecheck
npx vitest run packages/pi-codex-compact/test --config vitest.config.ts
npx biome check --vcs-use-ignore-file=false \
  packages/pi-codex-compact/src/codex-compact.ts \
  packages/pi-codex-compact/src/checkpoint.ts \
  packages/pi-codex-compact/test/lifecycle.test.ts \
  packages/pi-codex-compact/test/context-management-session.test.ts \
  packages/pi-codex-compact/test/rejection-recovery.test.ts
npm run check
npm test
```

On the publication branch, package build, package typecheck, focused Biome, and all 546 package tests passed. The generated entry passed the 17-check Pi session harness again. Its three generated runtime TypeScript files matched the live-tested deployment byte-for-byte.

The local verification environment reused focused dependencies, including Pi 1.3.0 and the published TUI Kit, rather than a complete lockfile installation of every workspace. Rebuilding the newer workspace TUI Kit failed with `TS2305` for `highlight.js`'s `HLJSApi` export. Both required root gates were attempted separately and failed during unrelated workspace builds, including missing React/Radix and Langfuse dependencies. **Full-monorepo validation is not claimed.** These environment failures do not replace the need for upstream CI.

To repeat the live scenario, use a backend that supports the selected compaction protocol and both models, put an assistant-only fact before the retained suffix, and run the four operations above. Verify opaque output, selected-model provenance, plaintext absence, and exact recall; successful HTTP status alone is insufficient. Backend-specific configuration and credentials are deliberately not included here.

Provider changes are a separate encryption boundary. See [provider-switch validation](provider-switch-validation.md) for the subsequent failure, issuer-mediated transfer, and current combined test results.
