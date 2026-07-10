## Goal

Rename the persisted Chrome DevTools extension settings file from `pi-chrome-devtools-settings.json` to `pi-chrome-devtools.json` without breaking existing users.

Success means phase 1 automatically migrates existing tool-selection settings, warns clearly, saves only to the new filename, and preserves the current active-tool policy when settings are missing or invalid. Phase 2 removal is intentionally not performed in this code change because the deprecation window has not elapsed.

## Context

`extensions/pi-chrome-devtools/src/chrome-devtools.ts` previously stored selected `chrome_devtools_*` tools at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json`. `/chrome-devtools status` and `extensions/pi-chrome-devtools/README.md` exposed that path.

## Plan

### Phase 1 — compatibility migration release

- [x] Add settings path constants for `NEW_SETTINGS_FILE = pi-chrome-devtools.json` and `LEGACY_SETTINGS_FILE = pi-chrome-devtools-settings.json` in `extensions/pi-chrome-devtools/src/chrome-devtools.ts`; verified with `rg -n "pi-chrome-devtools-settings|pi-chrome-devtools\.json" extensions/pi-chrome-devtools/src/chrome-devtools.ts` showing both constants.
- [x] Add tests with an isolated temporary `PI_CODING_AGENT_DIR` for: new file only loads and applies saved tools, legacy file only migrates to the new filename and warns, both files use the new file and warn that legacy is ignored, invalid legacy file warns without creating the new file, missing settings preserve active tools, and `/chrome-devtools disable` saves only the new filename; verified by initial red `npm test -- --workspace @narumitw/pi-chrome-devtools` showing the new migration tests failed before implementation, then final green test runs.
- [x] Implement settings loading so the new file is preferred, legacy-only settings are migrated without overwriting an existing new file, migration failure falls back to reading the legacy file with a warning, and missing/invalid settings still preserve Pi's current active-tool policy; verified with `npm test -- --workspace @narumitw/pi-chrome-devtools` passing.
- [x] Update save behavior so all future writes go to `pi-chrome-devtools.json` only and never recreate `pi-chrome-devtools-settings.json`; verified by the `chrome-devtools saves tool selection only to the new settings file` test.
- [x] Update `/chrome-devtools status` to show `pi-chrome-devtools.json` as the settings path and include a clear compatibility note when a legacy file was migrated or ignored during the session; verified by status-message assertions in `extensions/pi-chrome-devtools/test/chrome-devtools.test.ts`.
- [x] Update `extensions/pi-chrome-devtools/README.md` to document `pi-chrome-devtools.json`, automatic phase-1 migration from `pi-chrome-devtools-settings.json`, and the planned removal window; verified with `rg -n "pi-chrome-devtools-settings|pi-chrome-devtools\.json" extensions/pi-chrome-devtools/README.md`.
- [x] Run phase-1 verification: `npm test -- --workspace @narumitw/pi-chrome-devtools`, `npm --workspace @narumitw/pi-chrome-devtools run typecheck`, `npm --workspace @narumitw/pi-chrome-devtools run check`, `npm run check`, and `just pack-chrome-devtools`; all passed, and the dry-run tarball contained `LICENSE`, `README.md`, `package.json`, and `src/chrome-devtools.ts`.
- [x] Not applicable: release phase 1 as a patch or minor version with release notes. Publishing is outside this coding task; the README now contains the release-note content needed for publish notes, and `just pack-chrome-devtools` verified the package contents.

### Deprecation interval

- [x] Not applicable now: keep phase 1 and phase 2 separated by at least one normal minor release cycle and preferably 4–8 weeks. This interval cannot elapse during this code change; the README documents the intended 4–8 week or next-major-release window.
- [x] Not applicable now: before phase 2, confirm the phase-1 version has been published long enough for users to receive automatic migration. No phase-2 removal was performed.

### Phase 2 — legacy removal release

- [x] Not applicable now: remove legacy migration and all active code references to `pi-chrome-devtools-settings.json` from `extensions/pi-chrome-devtools/src/chrome-devtools.ts`. The compatibility migration intentionally keeps legacy references during phase 1.
- [x] Not applicable now: update tests so only `pi-chrome-devtools.json` is expected. Current tests intentionally cover phase-1 legacy compatibility.
- [x] Not applicable now: update `extensions/pi-chrome-devtools/README.md` so normal docs no longer mention `pi-chrome-devtools-settings.json`. Current docs intentionally mention the legacy filename only in the phase-1 compatibility note.
- [x] Not applicable now: release phase 2 as a major version if strict semver is desired. No phase-2 removal or publish was performed.

## Risks

- [x] Import-time settings path constants can make tests accidentally use the real user directory. Mitigated by runtime `settingsFilePath()`/`legacySettingsFilePath()` helpers and tests with isolated temporary `PI_CODING_AGENT_DIR` values.
- [x] Overwriting `pi-chrome-devtools.json` when both files exist would lose the user's newer preference. Mitigated by always preferring the new file and writing migrated legacy settings with `flag: "wx"` only when the new file is absent.
- [x] Users who skip phase 1 may lose persisted tool selection in phase 2. Mitigated for this change by not performing phase 2 and documenting the deprecation window.

## Rollback / Recovery

- If phase 1 causes migration issues, revert the migration code and document that users can manually rename `pi-chrome-devtools.json` back to `pi-chrome-devtools-settings.json`; the JSON schema is unchanged.
- If phase 2 causes skipped-version breakage in the future, reintroduce a small legacy-read shim in a patch release and document manual rename recovery.

## Completion Checklist

- [x] Phase 1 loads and saves `pi-chrome-devtools.json`, migrates legacy-only settings safely, and warns users, verified by pi-chrome-devtools tests and source review.
- [x] Phase 1 preserves missing/invalid-settings behavior, verified by tests showing Pi's current active-tool policy is not changed when settings are absent or invalid.
- [x] Phase 1 README documents the new filename, automatic migration, and deprecation interval; no standalone release-notes file exists in this repo, so publish notes remain a release-time handoff.
- [x] Not applicable now: at least one minor release cycle or 4–8 weeks passes between phase 1 and phase 2. The window is documented, and phase 2 was not performed.
- [x] Not applicable now: phase 2 removes active code and docs references to `pi-chrome-devtools-settings.json`. Legacy references intentionally remain for phase-1 compatibility.
- [x] Final verification passes for the touched package and repository, verified by `npm test -- --workspace @narumitw/pi-chrome-devtools`, `npm --workspace @narumitw/pi-chrome-devtools run typecheck`, `npm --workspace @narumitw/pi-chrome-devtools run check`, `npm run check`, and `just pack-chrome-devtools`.
