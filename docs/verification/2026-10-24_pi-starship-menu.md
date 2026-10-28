# pi-starship menu verification

## Outcome

The main menu now has six actions, led by Configure with agent. Configuration has four operations with an inline source, path, health, and warning summary. The separate editor, explanation, module-browser, overview, normalized-TOML, and loaded-document menu entries are removed.

The settings side thread can read four immutable opening snapshots: exact loaded text when available, normalized active public TOML, configuration metadata and diagnostics, and existing runtime module inspection. These virtual documents are held in memory, not written beside user settings. The disk baseline and private draft remain distinct from loaded settings. Missing loaded text or runtime inspection is explicit.

The compatibility `/starship settings|status|help` routes remain unchanged. Preset customization, profile editing, preview, confirmation, reload, Gist review, History, and atomic commit/rollback behavior remain available without broader agent permissions.

## Guides and semantic audit

Reviewed the complete change against `AGENTS.md`, `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`. Applied the skill-authoring guidance to the bundled reference update and the general prompt guidance to the provider-neutral child prompt. Consulted Pi's extension/TUI guidance and the installed SelectList, key matcher, core read tool, and Kit rendering/interaction implementations.

| Area | Audit and evidence |
| --- | --- |
| Compatibility and scope | Removed only menu presentations and their unused formatter. Kept command parsing/completions and mode behavior; retained shared serializer, inspection, editor, preview, persistence, and recovery code. Updated navigation tests rather than removing retained-operation coverage. |
| Configuration rendering | All diagnostics are available through the summary viewport. Native SelectList and Kit framing preserve action focus, width/height limits, callback theme roles, and pointer routing after clipping. Tests cover zero/narrow widths, constrained heights, resize, terminal controls, and long warnings. |
| Keyboard behavior | Cancellation precedes selection; hard Ctrl+C closes independently of remapped cancellation. Home/End remain supported. Configured page actions scroll the summary rather than select operations; this deviation is documented. Tests cover aliases, modifier order, invalid keys, first usable configured alternatives, legacy collisions, terminal-mode differences, and non-default bindings. |
| Privacy and authorization | The child still has only read/write/edit, no shell, active-file writes, or profile publication tool. Snapshot writes/edits are rejected. Snapshot reads do not start collectors, commands, or network requests. README discloses runtime snapshot data sent to the selected provider. Gist descriptions retain unlisted-not-private and gh requirements, including a complete selected description at narrow widths. |
| Lifecycle | The new summary owns no asynchronous background work; Kit owns cancellation and disposal. Every changed awaited menu continuation rechecks ownership. Session replacement/shutdown and preview cleanup regressions pass. Snapshot reads reject stale or disposed draft owners. |
| Settings integrity | No storage policy or settings path migration. Missing-file reads create no user directory. Tests retain invalid-file protection, unknown-field/comment preservation, serialized mutation, concurrent-change rejection, atomic writes, History, and rollback coverage. |
| Model-visible prefix | The new opening side-thread prompt and read-tool description intentionally describe snapshot access. They are fixed for that chat; snapshots enter requests only through ordinary read results at the tail. Serialized message-prefix and ordered tool-definition tests pass across ordinary turns. The parent prompt, tools, and transcript are unchanged. |
| Generated runtime | The new summary and snapshot modules remain outside the eager graph. Builder tests validate exact emitted relative imports and deterministic publication. The Jiti-loader test opens Configuration, Profiles, and the child chat, and reads a generated active-state snapshot through the child tool. |

The Configuration screen uses a small extension-owned summary viewport because Kit action headers do not scroll. It uses native SelectList, Kit bounded framing, and Kit interaction cleanup; no shared Kit change, dependency upgrade, or new configuration option is required. At extremely short terminal heights, the selected operation takes priority; enlarge the terminal to read the summary.

## Verification evidence

- `npm run check`: passed builds, Biome, package boundaries, and every workspace typecheck.
- `npm test`: passed 14,561 tests in 769 files. Two existing conditional cases were skipped: macOS installation on Linux and the native case-insensitive filesystem case in pi-sync. No changed test was skipped.
- Focused menu and generated-loader suites passed 32 tests. Snapshot, child-prefix, draft-permission, and chat-command tests also passed in the root gate. Existing module-inspection and normalized-configuration data coverage remains active; obsolete page/search tests were replaced with menu and snapshot coverage.
- Fenced-code-aware required-heading audit: passed all 37 publishable package READMEs. Reviewed changed access instructions, links, privacy warnings, recovery guidance, and section scope against implementation.
- `npm --workspace @narumitw/pi-starship run build --if-present`: passed.
- `uv run python packages/pi-starship/test/settings-chat-smoke.py`: passed six local-package scenarios: regular/fullscreen parent mode with discard, profile-only save, and save-and-apply. Each scenario checks the simplified main menu, inline Configuration summary, Back navigation, skill-backed tool execution, message queues, unchanged parent transcript, active-file/History outcomes, draft cleanup, and clean process exit. The provider is a deterministic local fixture; no live-provider quota is used.
- `npm run package:pack -- starship`: passed. Created and inspected an actual tarball with `npm pack --workspace @narumitw/pi-starship --pack-destination <temporary-directory> --json`: 157 files, including the new source modules, generated Configuration chunk, entrypoint, skill, and references; tests and the deleted formatter are absent. SHA-1: `287a8ef9b0bfcb250e0dc5373fd159eef17f01e9`.
- Installed that tarball with production dependencies in a separate temporary npm root and repeated all six CLI scenarios successfully. Total: twelve real-CLI scenarios across local and independently installed package paths.
- `npm run changeset:status`: exited successfully and selected only pi-starship for a minor release, including the new Changeset and the existing side-thread Changeset. Existing unrelated Kit-floor notices remain; no manifests or lockfile changed.
- `git diff --check`: passed.

An initial PTY assertion expected a Ctrl+C hint on the standard main menu, which Kit does not display. The smoke now waits for the actual Escape hint. The corrected harness passes without changing production key behavior. Early focused failures from removed menu indices, native read continuation-notice overhead, and a mistaken assumption about Kitty's raw Ctrl+I alias were corrected against installed implementations; no acceptance gate was waived.

## Existing dependency advisories

`npm install` and a read-only `npm audit --json` report four existing advisories: three moderate entries through Pi, just-bash, and guarded-fetch, and one high entry for undici. The repository manifests and lockfile are unchanged. Dependency remediation is outside this menu change; no forced audit fix was run. This change does not establish a vulnerability-free dependency tree.

## External handoff and release limits

Live-provider behavior remains unverified. An authorized provider account owner can perform a short configuration conversation after preparing Pi authentication and approving quota use, then check that active-state explanations use the read-only snapshots. Deterministic tests establish tool routing and prefix stability, not real-provider answer quality. Do not claim live-provider validation without that check.

The CLI smoke covers Linux PTYs. Platform maintainers need the relevant operating system and terminal to check physical terminal/IME behavior and subjective usability. Those results are not implied by the automated rendering tests or Linux smoke; the coding plan does not require subjective acceptance.

Snapshots describe chat-opening state, not ongoing runtime monitoring, and the ordinary main-session skill does not gain runtime access. No package publication, visibility change, version tag, or release workflow dispatch was performed or authorized by this implementation.
