## Goal

Let advanced users tune WebUI attachment count, source-byte, batch-byte, and pixel limits within documented hard ceilings while preserving current defaults and Pi's provider-ready dimension/Base64 constraints. Success means omitted settings are fully backward compatible and invalid settings fail safely without exposing an unsafe runtime state.

## Context

WebUI currently exposes only `startOnSessionStart` and hardcodes image limits in `src/images.ts`. Image Drop has proven safe defaults, hard ceilings, cross-field validation, warnings above defaults, and whole-file fallback. WebUI settings intentionally preserve unknown fields for forward compatibility.

## Architecture

Add optional image-limit fields to `pi-webui.json` and normalize them into one immutable runtime limits object loaded at `session_start`. Keep Pi's approximately 2,000-pixel and 4.5 MB inline constraints non-configurable. Apply limits consistently at browser admission, server body reads, resident-memory accounting, processing, send preflight, and reattachment.

## Non-Goals

- Raising provider-specific limits beyond Pi-compatible output constraints.
- Project-scoped WebUI settings or environment-variable configuration.
- Exposing every advanced limit as a prominent settings-screen row.

## Plan

- [x] Define central defaults (8 images, 10 MiB/image, 40 MiB/batch, 50 MP) and hard ceilings (32, 50 MiB, 200 MiB, 100 MP), with `maxImageBytes <= maxBatchBytes`; settings tests cover omission, exact ceilings, non-integers, non-positive/above-ceiling values, cross-field rejection, unknown preservation, invalid files, and elevated warnings.
- [x] Extend `src/settings.ts` with whole-file recognized-field validation and atomic save of normalized fields while preserving unknown JSON; malformed/unsafe files remain untouched and use safe defaults under existing load tests.
- [x] Add immutable `src/image-limits.ts` and thread one effective object through runtime, server state/SSE, raw admission, processing, resident accounting, send preflight, browser admission, and reattachment; focused attachment/image/lifecycle/server/reducer tests verify each layer and keep source-byte limits distinct from fixed provider-ready limits.
- [x] Keep all image limits in Advanced JSON because no user-testing evidence currently justifies another routine row; command tests prove the interactive list stays uncluttered and existing cursor/save rollback behavior still passes.
- [x] Emit one concise warning only when configured image limits exceed safe defaults and report effective limits plus source in `/webui status`; settings and command tests verify both paths without routine startup noise.
- [x] Update README schema, Advanced JSON guidance, defaults, ceilings, cross-field/memory/provider warnings, and fixed constraints; command-help tests pass and package dry-run includes `src/image-limits.ts` plus expected assets.
- [x] Run workspace/root checks (793 passing tests), focused settings/browser/server tests, `git diff --check`, `just pack webui`, and Chrome smoke with effective limits 2/1 MiB/1 MiB/123456 verifying dynamic count, per-file, and batch rejection before staging.

## Risks

- Limits enforced only at send time allow browser/server memory spikes; admission and streamed body reads must enforce them before allocation completes.
- Settings changes during a live session could desynchronize browser and server; retain the existing next-session/reload application model.
- Too many visible settings increase cognitive load; keep infrequent byte/pixel controls in documented JSON unless evidence supports UI exposure.

## Rollback / Recovery

Because fields are optional and defaults remain unchanged, rollback ignores the extra JSON fields while preserving them as unknown settings data.

## Completion Checklist

- [x] Omitted settings reproduce the original limits exactly, verified by settings and image tests.
- [x] Invalid, exact-boundary, cross-field, and hard-ceiling cases are tested with safe whole-file fallback; source files remain untouched and source/provider-ready bytes retain distinct bounds.
- [x] Browser admission, streamed server upload, processing/pixel checks, draft resident accounting, send preflight, and reattach consume the same session-loaded effective limits, verified by integration tests and browser smoke.
- [x] `/webui settings`, status/help, README, and package contents accurately describe public settings; advanced fields remain out of the routine TUI and command/pack tests pass.
- [x] `npm run check` (793 tests) and `git diff --check` pass.
