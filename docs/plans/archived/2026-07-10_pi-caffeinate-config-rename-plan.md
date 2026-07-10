## Goal

Rename the persisted pi-caffeinate settings file from `pi-caffeinate-settings.json` to `pi-caffeinate.json` without surprising existing users.

Success means phase 1 automatically migrates existing user settings, warns clearly, documents the compatibility window, and keeps users working. Phase 2 removal is intentionally not performed in this code change because the deprecation window has not elapsed.

## Context

`extensions/pi-caffeinate/src/caffeinate.ts` previously stored the selected mode at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-caffeinate-settings.json`. `/caffeinate status` and `extensions/pi-caffeinate/README.md` exposed that path.

## Plan

### Phase 1 — compatibility migration release

- [x] Add constants for `NEW_SETTINGS_FILE = pi-caffeinate.json` and `LEGACY_SETTINGS_FILE = pi-caffeinate-settings.json` in `extensions/pi-caffeinate/src/caffeinate.ts`; verified with `rg -n "pi-caffeinate-settings|pi-caffeinate\.json" extensions/pi-caffeinate/src/caffeinate.ts` showing both constants.
- [x] Write tests with isolated temporary `PI_CODING_AGENT_DIR` values for: new file only, legacy-only migration, migration failure fallback, both files with new-file precedence, concurrent creation of the new file while legacy settings load, invalid new and legacy files, and save-only-to-new behavior; verified by the initial red `npm test -- --workspace @narumitw/pi-caffeinate` run showing seven migration tests failed before implementation and final green runs.
- [x] Implement startup migration so `pi-caffeinate.json` is preferred, a valid legacy-only file is atomically hard-linked to the new path and removed without overwriting a concurrently created new file, and migration failures retain and load the legacy file with a warning; verified by pi-caffeinate tests for migration, fallback, and concurrent precedence.
- [x] Update `/caffeinate status` output to show `pi-caffeinate.json` and retain a one-time per-session compatibility note when a legacy file was migrated or ignored; verified by status-message and notification assertions in `extensions/pi-caffeinate/test/caffeinate.test.ts`.
- [x] Update `extensions/pi-caffeinate/README.md` to document `pi-caffeinate.json`, automatic phase-1 migration from `pi-caffeinate-settings.json`, and the planned removal window; verified with `rg -n "pi-caffeinate-settings|pi-caffeinate\.json" extensions/pi-caffeinate/README.md`.
- [x] Run phase-1 verification: `npm test -- --workspace @narumitw/pi-caffeinate`, `npm --workspace @narumitw/pi-caffeinate run typecheck`, `npm --workspace @narumitw/pi-caffeinate run check`, `npm run check`, and `just pack-caffeinate`; all passed, 197 repository tests passed, and the dry-run tarball contained `LICENSE`, `README.md`, `package.json`, and `src/caffeinate.ts`.
- [x] Not applicable: release phase 1 as a patch or minor version with release notes. Publishing is outside this coding task; the README contains the release-note content needed for publish notes, and `just pack-caffeinate` verified the package contents.

### Deprecation interval

- [x] Not applicable now: keep phase 1 and phase 2 separated by at least one normal minor release cycle and preferably 4–8 weeks. This interval cannot elapse during this code change; the README documents the intended 4–8 week or next-major-release window.
- [x] Not applicable now: before phase 2, confirm users had a released version that can migrate their file automatically. No phase-2 removal was performed.

### Phase 2 — legacy removal release

- [x] Not applicable now: remove legacy migration and active code references to `pi-caffeinate-settings.json`. The compatibility migration intentionally keeps legacy references during phase 1.
- [x] Not applicable now: update tests so only `pi-caffeinate.json` behavior is expected. Current tests intentionally cover phase-1 legacy compatibility.
- [x] Not applicable now: remove `pi-caffeinate-settings.json` from normal README documentation. Current docs intentionally mention it only in the phase-1 compatibility note.
- [x] Not applicable now: release phase 2 as a major version if strict semver is desired. No phase-2 removal or publish was performed.

## Risks

- [x] Automatically moving the legacy file can surprise users. Mitigated with a clear warning, status note, and new-file precedence when both paths exist.
- [x] A check-then-rename race could overwrite a concurrently created `pi-caffeinate.json`. Mitigated by atomically hard-linking the existing same-directory legacy file to an absent destination; link failure triggers a new-path recheck and safe fallback.
- [x] Migration failure could lose settings. Mitigated by removing the legacy path only after the new path is installed and falling back to the already validated legacy settings on failure.
- [x] Settings tests could touch a developer's real configuration. Mitigated by fresh dynamic imports and isolated temporary `PI_CODING_AGENT_DIR` values for every settings-loading lifecycle test.
- [x] Users who skip phase 1 may lose persisted mode in phase 2. Mitigated by not performing phase 2 and documenting the deprecation window.

## Rollback / Recovery

- If phase 1 migration causes issues, revert the migration code and document that users can manually rename `pi-caffeinate.json` back to `pi-caffeinate-settings.json`; the JSON schema is unchanged.
- If phase 2 breaks users in the future, reintroduce a small legacy-read compatibility shim in a patch release and document manual rename recovery.

## Completion Checklist

- [x] Phase 1 loads and saves `pi-caffeinate.json`, migrates legacy-only settings safely, and warns users, verified by pi-caffeinate tests and source review.
- [x] Phase 1 preserves default-mode behavior for missing or invalid settings, verified by invalid new/legacy tests showing `display` mode remains active.
- [x] Phase 1 README documents the new filename, automatic migration, and deprecation interval; no standalone release-notes file exists in this repo, so publish notes remain a release-time handoff.
- [x] Not applicable now: at least one minor release cycle or 4–8 weeks passes between phase 1 and phase 2. The window is documented, and phase 2 was not performed.
- [x] Not applicable now: phase 2 removes active code and docs references to `pi-caffeinate-settings.json`. Legacy references intentionally remain for phase-1 compatibility.
- [x] Final verification passes for the touched package and repository, verified by `npm test -- --workspace @narumitw/pi-caffeinate`, `npm --workspace @narumitw/pi-caffeinate run typecheck`, `npm --workspace @narumitw/pi-caffeinate run check`, `npm run check`, and `just pack-caffeinate`.
