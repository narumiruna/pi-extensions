# Editor widget consolidation

Ticker, Chat, and File Context now use the existing `EditorStatusWidget` for passive editor widgets. Kit owns the muted top rule and terminal-width guard. No Kit API, dependency range, settings schema, command, or shared lifecycle controller was added.

## Ownership and compatibility

| Consumer | Shared presentation | Retained extension behavior |
| --- | --- | --- |
| Ticker | The widget factory returns `EditorStatusWidget` directly. | Quote packing and wrapping, snapshot publication, refresh timers, cancellation, exact-key cleanup, and plain RPC rows. |
| Chat | A frame inside the existing lazy widget module renders live data. | One mounted component, render requests, disposal, privacy modes, dock preview thresholds, input-target hints, TUI-only publication, and session ownership. Off or disconnected widgets render neither a rule nor a body. |
| File Context | The TUI publisher creates a frame with callback-themed, wrapped snapshot rows. | Pending quote state, escaped control-character labels, token estimates, exact raw prompt payloads, quote consumption, cleanup, and plain RPC rows without a separator. |

Chat and File Context gain the standard top rule. File Context's TUI summary uses the full body width instead of Pi's string-array `Text` margins. Ticker removes its equivalent local rule. These are passive components; no editor or input-routing contract changes.

All new Kit imports use focused exports. Chat's widget module remains lazy. File Context's builder permits only the exact `editor-status-widget` and `terminal-text` specifiers; the Kit root, unrelated subpaths, and descendants of either exception remain forbidden. Ticker retains its existing focused-subpath policy. No installed dependency or generated output was edited directly.

## Semantic audit

Applied guides: root and File Context `AGENTS.md`, `docs/extension-conventions.md`, `docs/extension-settings.md` for the no-change settings boundary, Pi's extension/TUI/RPC contracts, and Kit's widget ownership contract. No README changes were needed.

The final review covers width normalization, terminal-cell clipping, Unicode, callback themes, invalidation, snapshot ownership, mode boundaries, generated imports, and scope. Cancellation, disposal, replacement, shutdown, and stale asynchronous continuations retain extension ownership. No production `await`, settings writer, authentication flow, or model-visible context transformation changed.

A read-only review found a pre-existing display-direction-control gap in File Context's path escaping. The touched widget now applies the existing `sanitizeTerminalText()` after its visible C0/C1 escaping and before styling or wrapping. Tests cover every supported bidirectional control and Unicode line separators in TUI and RPC. The whole widget diff was audited for this class: Chat retains its local sanitizer, Ticker sanitizes symbols and currencies, and File Context sanitizes displayed paths. Raw identities and quote payloads are unchanged. Other File Context screens and notifications were not migrated or audited as part of this widget-only work.

## Verification

The following commands passed from the repository root:

- `npm install`, `npm ls @narumitw/pi-tui-kit`, and the Kit build; manifests and the lockfile are unchanged, and installation reported zero vulnerabilities.
- `npm run format` and `npm run check`; builds, Biome, package boundaries, and all workspace typechecks pass. Biome reports one unchanged informational diagnostic in Sync's `merge-apply.ts`.
- Test compilation and the focused Ticker, Chat, and File Context suites: **36 files, 314 tests passed**.
- The separate `npm test` gate: **783 files passed, one existing file skipped; 15,061 tests passed, two existing tests skipped**. No timeout or skip policy changed.
- Builder tests validate generated relative imports, external package boundaries, exact File Context exceptions, and preserved first-use boundaries. All three generated entries load through Pi's Jiti resource loader and exercise a representative lazy menu. Mounted-widget tests use controlled transports and lifecycle events without live services.
- `npm run changeset:status` reports only the three intended consumer patch releases. It also reports existing independent Kit-floor warnings; no consumer floor was synchronized or raised.
- `git diff --check` and final scope review pass.

Each package directory also passed an isolated CLI smoke with this command shape:

```sh
pi --offline --mode rpc --no-session --no-extensions --no-mcp \
  --no-skills --no-prompt-templates --no-themes --no-context-files \
  -e /absolute/path/to/packages/pi-<consumer>
```

The runner used a temporary workspace and agent directory, waited for a successful `get_commands` readiness handshake, verified the expected extension command and idle `get_state`, then closed stdin. Ticker, Chat, and File Context each shut down with exit code zero. No prompts, provider requests, live quotes, or public chat joins were sent. The operation deadline started after readiness.

Package manifests and published file inventories did not change, so a metadata pack audit was not required. Generated runtime builds and import checks passed through the root gates and focused builder tests.

## External handoff and release restrictions

A tester with a physical terminal can verify regular/fullscreen placement, palette changes, narrow resizing, and Chat dock height after building the packages. Expected result: the standard separator and bounded content remain visible without changing editor input. Physical-device and subjective visual acceptance are unverified; offline RPC smokes and deterministic component tests do not establish them.

The generated Chat Jiti test exercises its lazy menu, not first-use mounting of the changed widget chunk through a real chat connection. Builder import validation and injected-transport mounted-widget tests cover that boundary separately; do not claim a live packaged-chat or cross-terminal smoke.

No publication, visibility change, version tag, or release dispatch was performed. Release operations still require explicit approval. The agent implementation plan is complete; this record does not establish physical-terminal acceptance or release readiness.
