## Goal

Restore `pi-codex-accounts` on Pi 0.80.8 without dropping Pi 0.80.3 compatibility, and add Pi 0.80.3 to the GitHub Actions compatibility matrix.

## Context

Pi 0.80.8 stopped exporting `FileAuthStorageBackend`, made the legacy OAuth entry point type-only, and moved runtime API-key overrides behind its model runtime. The extension currently imports removed runtime values and accesses the older `modelRegistry.authStorage` shape.

## Plan

- [x] Replace the removed Pi auth-storage dependency with package-owned locked file and in-memory backends; `npm test` passes all 524 tests, including private writes and migrations.
- [x] Adapt OAuth and runtime API-key application to Pi 0.80.3 and 0.80.8; the extension uses provider-owned OAuth, regression tests pass, Pi 0.80.8 typechecking passes, and an isolated active-account print-mode smoke completes session start and reset.
- [x] Add Pi 0.80.3 to `.github/workflows/ci.yml`; matrix inspection passes and `npm run check` passes against the local Pi 0.80.3 dependency floor.
- [x] Update package metadata/docs and inspect the publish payload; `just pack-codex-accounts` includes both source modules, metadata, README, and license.

## Risks

- The Pi 0.80.8 extension-facing registry does not publicly expose runtime override mutation, so compatibility requires a guarded adapter over the old and new runtime shapes.
- Cross-process credential refresh must retain locking and `0600` writes after removing Pi's storage backend.

## Completion Checklist

- [x] Pi 0.80.8 loads and runs `extensions/pi-codex-accounts` without extension errors, verified with an isolated active-account `/codex-account default` print-mode smoke.
- [x] Pi 0.80.3 compatibility is covered by the explicit GitHub Actions matrix entry and a passing local `npm run check` on Pi 0.80.3 dependencies.
- [x] Credential storage, refresh serialization, and runtime override tests pass with `npm run check` (524 tests).
- [x] The npm dry-run contains `src/codex-accounts.ts` and `src/storage.ts` plus package metadata, README, and license.
