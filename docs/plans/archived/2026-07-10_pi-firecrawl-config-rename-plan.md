## Goal

Rename the persisted Firecrawl extension settings file from `pi-firecrawl-settings.json` to `pi-firecrawl.json` without breaking existing users.

Success means phase 1 automatically migrates existing Firecrawl tool-selection settings, warns clearly, saves only to the new filename, and preserves the current active-tool policy when settings are missing or invalid. Phase 2 removal is intentionally not performed in this code change because the deprecation window has not elapsed.

## Context

`extensions/pi-firecrawl/src/firecrawl.ts` previously stored selected `firecrawl_*` tools at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json`. `/firecrawl status` and `extensions/pi-firecrawl/README.md` exposed that path. The settings file stores only tool names and `updatedAt`; it must not store `FIRECRAWL_API_KEY`, request headers, or other secrets.

## Plan

### Phase 1 — compatibility migration release

- [x] Add settings path constants for `NEW_SETTINGS_FILE = pi-firecrawl.json` and `LEGACY_SETTINGS_FILE = pi-firecrawl-settings.json` in `extensions/pi-firecrawl/src/firecrawl.ts`; verified with `rg -n "pi-firecrawl-settings|pi-firecrawl\.json" extensions/pi-firecrawl/src/firecrawl.ts` showing both constants.
- [x] Add tests with an isolated temporary `PI_CODING_AGENT_DIR` for: new file only loads and applies saved tools, legacy file only migrates atomically to the new filename and warns, exclusive installation never overwrites an existing new file or leaves temporary files, migration failure uses the valid legacy file for the session, both files use the new file and warn that legacy is ignored, a new file created while legacy settings are loading still takes precedence, invalid legacy file warns without creating the new file, missing settings preserve active tools, invalid new settings do not fall back to legacy settings, and `/firecrawl disable` saves only the new filename; verified by red test runs before the implementations and final green test runs.
- [x] Implement settings loading so the new file is preferred, legacy-only settings are migrated without overwriting an existing new file, migration failure falls back to reading the legacy file with a warning, and missing/invalid settings still preserve Pi's current active-tool policy; verified with `npm test -- --workspace @narumitw/pi-firecrawl` passing.
- [x] Update save behavior so all future writes go to `pi-firecrawl.json` only and never recreate `pi-firecrawl-settings.json`; verified by the `firecrawl saves tool selection only to the new settings file` test.
- [x] Update `/firecrawl status` to show `pi-firecrawl.json` as the settings path and include a clear compatibility note when a legacy file was migrated or ignored during the session; verified by status-message assertions in `extensions/pi-firecrawl/test/firecrawl.test.ts`.
- [x] Update `extensions/pi-firecrawl/README.md` to document `pi-firecrawl.json`, automatic phase-1 migration from `pi-firecrawl-settings.json`, the planned removal window, and that no API keys or secrets are stored; verified with `rg -n "pi-firecrawl-settings|pi-firecrawl\.json|FIRECRAWL_API_KEY" extensions/pi-firecrawl/README.md`.
- [x] Run phase-1 verification: `npm test -- --workspace @narumitw/pi-firecrawl`, `npm --workspace @narumitw/pi-firecrawl run typecheck`, `npm --workspace @narumitw/pi-firecrawl run check`, `npm run check`, and `just pack-firecrawl`; all passed, and the dry-run tarball contained `LICENSE`, `README.md`, `package.json`, and `src/firecrawl.ts`.
- [x] Not applicable: release phase 1 as a patch or minor version with release notes. Publishing is outside this coding task; the README now contains the release-note content needed for publish notes, and `just pack-firecrawl` verified the package contents.

### Deprecation interval

- [x] Not applicable now: keep phase 1 and phase 2 separated by at least one normal minor release cycle and preferably 4–8 weeks. This interval cannot elapse during this code change; the README documents the intended 4–8 week or next-major-release window.
- [x] Not applicable now: before phase 2, confirm the phase-1 version has been published long enough for users to receive automatic migration. No phase-2 removal was performed.

### Phase 2 — legacy removal release

- [x] Not applicable now: remove legacy migration and all active code references to `pi-firecrawl-settings.json` from `extensions/pi-firecrawl/src/firecrawl.ts`. The compatibility migration intentionally keeps legacy references during phase 1.
- [x] Not applicable now: update tests so only `pi-firecrawl.json` is expected. Current tests intentionally cover phase-1 legacy compatibility.
- [x] Not applicable now: update `extensions/pi-firecrawl/README.md` so normal docs no longer mention `pi-firecrawl-settings.json`. Current docs intentionally mention the legacy filename only in the phase-1 compatibility note.
- [x] Not applicable now: release phase 2 as a major version if strict semver is desired. No phase-2 removal or publish was performed.

## Risks

- [x] Import-time settings path constants can make tests accidentally use the real user directory. Mitigated by runtime `settingsFilePath()`/`legacySettingsFilePath()` helpers and tests with isolated temporary `PI_CODING_AGENT_DIR` values.
- [x] Overwriting `pi-firecrawl.json` when both files exist would lose the user's newer preference. Mitigated by rechecking the new path after asynchronous legacy reads and failed migration attempts, always preferring any concurrently created new file, and atomically hard-linking a fully written same-directory temporary file only when the new path is absent.
- [x] An interrupted or disk-full migration could publish partial JSON at the new path and hide valid legacy settings. Mitigated by fully writing a temporary file before atomically installing it, cleaning the temporary file on success or failure, and retaining the legacy fallback until installation succeeds.
- [x] Users who skip phase 1 may lose persisted tool selection in phase 2. Mitigated for this change by not performing phase 2 and documenting the deprecation window.
- [x] Firecrawl settings must remain non-secret. Mitigated by preserving the existing `{ tools, updatedAt }` schema, source review, and README text that the settings file stores only tool names and a timestamp, never `FIRECRAWL_API_KEY`, request headers, or other secrets.

## Rollback / Recovery

- If phase 1 causes migration issues, revert the migration code and document that users can manually rename `pi-firecrawl.json` back to `pi-firecrawl-settings.json`; the JSON schema is unchanged.
- If phase 2 causes skipped-version breakage in the future, reintroduce a small legacy-read shim in a patch release and document manual rename recovery.

## Completion Checklist

- [x] Phase 1 loads and saves `pi-firecrawl.json`, migrates legacy-only settings safely, and warns users, verified by pi-firecrawl tests and source review.
- [x] Phase 1 preserves missing/invalid-settings behavior, verified by tests showing Pi's current active-tool policy is not changed when settings are absent or invalid.
- [x] Phase 1 keeps Firecrawl settings non-secret, verified by schema/source review and README text that only tool names and `updatedAt` are stored.
- [x] Phase 1 README documents the new filename, automatic migration, deprecation interval, and no-secret-storage guarantee; no standalone release-notes file exists in this repo, so publish notes remain a release-time handoff.
- [x] Not applicable now: at least one minor release cycle or 4–8 weeks passes between phase 1 and phase 2. The window is documented, and phase 2 was not performed.
- [x] Not applicable now: phase 2 removes active code and docs references to `pi-firecrawl-settings.json`. Legacy references intentionally remain for phase-1 compatibility.
- [x] Final verification passes for the touched package and repository, verified by `npm test -- --workspace @narumitw/pi-firecrawl`, `npm --workspace @narumitw/pi-firecrawl run typecheck`, `npm --workspace @narumitw/pi-firecrawl run check`, `npm run check`, and `just pack-firecrawl`.
