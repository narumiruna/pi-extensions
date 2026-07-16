## Goal

Restore `pi-codex-accounts` on Pi 0.80.8 without dropping Pi 0.80.3 compatibility, and add Pi 0.80.3 to the GitHub Actions compatibility matrix.

## Context

Pi 0.80.8 stopped exporting `FileAuthStorageBackend` and moved runtime API-key overrides behind its model runtime. The extension currently imports the removed constructor and accesses the older `modelRegistry.authStorage` shape.

## Plan

- [x] Replace the removed Pi auth-storage dependency with package-owned locked file and in-memory backends; `npm test` passes all 523 tests, including private writes and migrations.
- [x] Adapt runtime API-key application to both Pi 0.80.3 and 0.80.8 and await async overrides; regression tests pass and isolated `PI_OFFLINE=1 pi --list-models` smoke succeeds on Pi 0.80.8 with an active override.
- [x] Add Pi 0.80.3 to `.github/workflows/ci.yml`; matrix inspection passes and `npm run check` passes against the local Pi 0.80.3 dependency floor.
- [x] Update package metadata/docs and inspect the publish payload; `just pack-codex-accounts` includes both source modules, metadata, README, and license.

## Risks

- The Pi 0.80.8 extension-facing registry does not publicly expose runtime override mutation, so compatibility requires a guarded adapter over the old and new runtime shapes.
- Cross-process credential refresh must retain locking and `0600` writes after removing Pi's storage backend.

## Completion Checklist

- [x] Pi 0.80.8 loads `extensions/pi-codex-accounts` without the removed-constructor error, verified with an isolated non-interactive active-account smoke.
- [x] Pi 0.80.3 compatibility is covered by the explicit GitHub Actions matrix entry and a passing local `npm run check` on Pi 0.80.3 dependencies.
- [x] Credential storage, refresh serialization, and runtime override tests pass with `npm run check` (523 tests).
- [x] The npm dry-run contains `src/codex-accounts.ts` and `src/storage.ts` plus package metadata, README, and license.
