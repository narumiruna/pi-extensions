## Goal

Add convention-compliant global WebUI settings and automatic per-session startup while preserving bare `/webui` behavior.

## Assumptions

- `startOnSessionStart` is the only user-facing setting.
- Settings are global-only at `<getAgentDir()>/pi-webui.json`.
- Automatic startup applies to every `session_start`, displays a link, and never opens a browser.

## Plan

- [x] Add and test settings loading, validation, unknown-field preservation, no-overwrite initialization, and atomic persistence; focused settings tests pass.
- [x] Add and test `/webui settings`, `status`, `help`, and `init`, argument completion, non-TUI behavior, ordered UI saves, and rollback; `npm test` passes all 773 tests.
- [x] Add and test settings-aware session startup without weakening existing lifecycle guards; lifecycle and full repository tests pass.
- [x] Add the Pi TUI peer/development dependency and update the root lockfile; package typecheck passes.
- [x] Document settings, commands, paths, validation, and startup behavior in `extensions/pi-webui/README.md`.
- [x] Run package, repository, and package-content verification; package check, full check, and pack dry run pass.

## Completion Checklist

- [x] New pi-webui tests prove command, persistence, UI rollback, and lifecycle behavior; `npm run check` passes all 774 tests.
- [x] Documentation and package metadata match behavior; `npm --workspace @narumitw/pi-webui run check` passes.
- [x] `npm run check` passes.
- [x] `npm run pack:webui` reports 16 publishable files including `src/settings.ts` and browser assets, with no tests, caches, tarball, or dependency output.
