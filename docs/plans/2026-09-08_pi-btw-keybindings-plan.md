# Pi BTW configurable keybindings

## Goal

Make `exit`, `cycleThinkingLevel`, and `bringToMain` configurable through `/btw` → Settings without changing Pi's global keybindings or existing defaults. Implementation was explicitly authorized in the follow-up execution request.

| Setting | Default | Behavior |
| --- | --- | --- |
| `exit` | `Ctrl+C` | Exit BTW with the existing cancellation semantics: cancel the response, discard drafts and queued questions, and retain completed exchanges for resumption. |
| `cycleThinkingLevel` | Inherit Pi's `app.thinking.cycle` | Cycle through the current model's supported thinking levels. |
| `bringToMain` | `Ctrl+R` | Open the existing bring-to-main flow when available. |

`Ctrl+C` remains an unconditional hard-cancel path. A configured exit key adds an exit path rather than removing this safeguard.

## Context

`packages/pi-btw/src/settings.ts` already owns validation, ordered mutations, unknown-field preservation, and temporary-file-plus-rename publication in `<getAgentDir()>/pi-btw.json`. `src/menu.ts` provides the existing Settings screen through Pi TUI Kit. `src/fullscreen-ui.ts` handles terminal ownership and hard cancellation, while `src/transcript-pager.ts` handles conversation shortcuts and hints.

Apply `docs/extension-conventions.md` and `docs/extension-settings.md` to the touched areas. Read the installed Pi documentation, relevant examples, and linked API references before implementation; inspect the installed implementation before defining matching or conflict rules.

## Non-Goals

- Do not add a literal `/btw settings` route; preserve `/btw <question>` and use `/btw` → Settings.
- Do not configure scrolling, submission, newline, or editor navigation.
- Do not add multiple bindings per action, key-recording UI, dependencies, or project-scoped settings.
- Do not modify Pi's global keybinding file or unrelated extensions.

## Architecture

Store optional overrides in a `keybindings` object in the existing user settings file. Each action accepts one key-combination string; omission restores its default. Keep binding resolution, validation, and hint generation within pi-btw, with one authoritative policy shared by its UI components.

Add three rows to the existing Settings screen. Show the effective key or inheritance from Pi, use existing UI components for string entry, and provide a reset-to-default action. Save changes immediately; cancellation of an unfinished edit leaves its previous value unchanged. Successful saves apply when BTW is next opened or resumed, without requiring `/reload`.

Reject invalid or conflicting edits with an actionable explanation. Preserve standard editor actions and the reserved hard-cancel path. Determine runtime handling for overrides that become conflicting after Pi keybindings change during the initial discovery task; never display an unusable binding as active.

## Plan

- [x] Inspect installed Pi key matching, Editor input handling, terminal modes, listener ordering, and BTW's existing shortcut filters; document the complete relevant equivalence classes, reserved keys, precedence, and runtime conflict fallback, backed by a table of expected matching outcomes. Evidence: installed `keys.js`, `components/editor.js`, `keybindings.js`, and `tui-alt-screen.js`; see discovery below.
- [x] Extend `packages/pi-btw/src/settings.ts` with optional overrides and field-level reset semantics; verify defaults, accepted and invalid values, side-effect-free reads, nested unknown-field preservation, ordered saves, stale-read prevention, and atomic-write failure recovery through settings tests.
- [x] Add a focused package-owned keybinding policy module that resolves defaults, validates overrides, and derives effective hints; verify aliases, modifier order, legacy collisions, terminal-mode differences, invalid strings, inherited Pi bindings, and the first usable fallback with table-driven tests.
- [x] Extend `packages/pi-btw/src/menu.ts` with three editable shortcut rows and reset actions using existing UI components; verify effective-value display, invalid/conflicting edit rejection, save ordering, failed-save rollback, cancellation, and non-TUI guards through menu tests.
- [x] Integrate the resolved bindings into `packages/pi-btw/src/fullscreen-ui.ts` and `packages/pi-btw/src/transcript-pager.ts`, auditing related bring-to-main screens; verify idle and streaming shortcuts, existing availability conditions, dynamic hints, editor focus, paste behavior, and non-default Pi keybindings through component tests.
- [x] Audit asynchronous flows for user cancellation, disposal, session replacement, shutdown, and post-await validity; verify task release, repeated cleanup, root and nested-overlay hard cancellation, input-drain ordering, unrelated overlay preservation, and the first input after terminal restoration through lifecycle and handoff tests.
- [x] Update `packages/pi-btw/README.md` with settings access, defaults, accepted syntax, persistence and activation timing, conflicts, resets, and permanent `Ctrl+C` behavior; add a feature Changeset and review documentation against `docs/readme-conventions.md`.
- [ ] Run `npm run check` and `npm test` sequentially, ensuring Kit is built before consumer tests; perform the smallest practical terminal smoke and record any manual verification that cannot be performed without launching an interactive process.
- [ ] Review the final diff against both extension guides' touched-area and verification checklists; record checks, smokes, deviations, and unverified paths, and delete this plan only after all completion criteria pass or remaining limitations are explicitly accepted.

## Discovery and execution evidence

Work started on `narumi/feat/btw-keybindings` from `origin/main`; the only pre-existing worktree change was this untracked plan. `npm install` restored installed Pi packages to the versions already required by manifests and lockfile; no dependency files changed. An initial typecheck exposed the stale installation rather than a need to change compatibility floors.

The policy reserves Pi TUI editor, input, selection, and fullscreen actions, fixed Editor newline/deletion/space fallbacks, BTW paging, and manual selection copying when enabled. It validates candidate input with Pi's public matcher rather than reproducing its parser. Inherited thinking bindings retain explicitly configured printable Pi shortcuts for compatibility; new BTW overrides cannot claim ordinary text. Custom conflicts fall back to usable defaults, then no shortcut with a warning if none remains. An explicitly unbound inherited thinking action stays unbound without a warning.

| Input class | Expected matching / conflict behavior |
| --- | --- |
| `esc` / `escape`, `return` / `enter`, case and modifier order | Canonicalize aliases and order; reject unknown or repeated modifiers in new settings. |
| Raw Ctrl bytes | Detect Ctrl+I/Tab, Ctrl+M/Enter, Ctrl+J/newline, Ctrl+[/Escape, Ctrl+-/Ctrl+_, and Ctrl+H/Backspace collisions through Pi. |
| ESC-prefixed raw input | Detect Alt+B/F/P/N versus Alt+arrows and Ctrl+Alt+H/M versus Alt+Backspace/Enter where Pi matches them; Ctrl+Alt+I does not match Alt+Tab. |
| Kitty versus legacy mode | Use live matcher branches for Alt raw input, Ctrl+Space, Enter and Shift+Enter; do not mutate global terminal mode. |
| Windows Terminal and SSH | Let Pi choose whether raw BS means Backspace or Ctrl+Backspace. |
| CSI-u, modifyOtherKeys, keypad, shifted letters, lock bits and base-layout fallback | Use the matcher-normalized key/modifier identity; test representative encodings and releases. |
| Function keys, Clear, modified Escape and unsupported syntax | Only expose candidates that match a representative input; reject modified function keys and unsupported Clear/Escape modifiers. |
| Bracketed paste, including split payloads | Bypass all new screen shortcuts until paste ends; preserve Editor payload handling. |
| Earlier listeners and nested overlays | Preserve standard bindings and unconditional Ctrl+C; route a configured exit through the same synchronous root cancellation and deferred terminal handoff. |

The Settings rows reuse Kit's existing settings, actions, and input screens. A field opens Edit / Restore default, avoiding a new custom input component. Shortcut resolution is associated with the owning TUI through a WeakMap, avoiding configuration plumbing through domain-level thinking and request controls.

Initial focused verification found partial keybinding mocks and absent notification methods in existing UI harnesses; fixtures and policy API use were corrected. The first affected-test invocation selected no files because its base selector considers committed differences; it is not passing test evidence. Use direct focused Vitest runs during implementation and root `npm test` for the required full gate.

Focused verification now passes: `npm exec -- vitest run packages/pi-btw/test` reports 13 files and 297 tests; `npx tsc -p tsconfig.test.json --noEmit` and the package build pass. New settings, policy, menu, component, command-propagation, and native terminal-pipeline tests cover the planned behaviors. Native `TuiMainScreen` / `TuiAltScreen` smokes use a controllable Terminal instead of opening an interactive process: they exercise custom exit and permanent Ctrl+C under root/nested focus, thinking cycling, bring-to-main with a large expanded paste, streaming abort, drain ordering, and restored parent input. Physical terminal/emulator keyboard reporting and live-provider behavior are not claimed; no interactive process is launched under the execution constraints.

Hardening found two additional in-scope failure paths: queued shortcut edits now revalidate against the latest settings document inside the mutation queue, and both transcript renderers clamp output at narrow widths (including zero-width rendering). Runtime key resolution also refreshes after asynchronous Kitty negotiation. Existing `btw.ts` is just over 1,000 lines; an adjacent comment documents retaining its injectable command-coordination seams while policy, settings, terminal ownership, and rendering remain separate.

Touched-area MUST audit evidence: settings protection/order/atomicity/rollback (settings and menu tests); TUI bounds, focus, paste and effective hints (component tests); cancellation/disposal/root-and-nested handoff/input restoration (fullscreen tests); safe non-TUI entry guards and retained command surface (existing menu/command tests); independent package and generated-runtime boundaries (passing root Validator and generated Jiti loader tests); published behavior versioning (minor Changeset). No model-visible context, provider payload, tool definitions, commands, dependencies, or global Pi settings changed.

## Final verification and remaining blocker

Final `npm run check` passes (build, Biome, boundaries, all workspace typechecks). Final focused Vitest run passes all 297 tests in 13 files; test TypeScript compilation passes. `npm run package:pack -- btw` passes; a separate actual `npm pack --workspace @narumitw/pi-btw` tarball inspection confirms all 17 expected manifest, license, documentation, source, and generated runtime files. Generated Jiti loader tests pass. `git diff --check` passes.

The complete root `npm test` exits 1: 20 failed files, 361 passed; 55 failed tests, 4,191 passed, one skipped. No BTW tests fail. Failures are outside this package, predominantly five-second timeouts, plus the github-pr periodic-refresh assertion. A focused reproduction on unchanged `origin/main` (`09d0f4d4`) reproduces the github-pr assertion and sync timeouts; this does not prove every root failure is baseline. No timeout was raised and no unrelated package was changed. Logs: `/tmp/pi-btw-root-tests-complete.log` and `/tmp/pi-btw-baseline-tests.log` (local, not published artifacts).

Final semantic Review against `docs/extension-conventions.md` and `docs/extension-settings.md` covers compatibility, settings read/write protection, unknown fields, atomicity, async cancellation and stale state, terminal ownership, paste, effective hints, and unchanged model-visible context. README review follows `docs/readme-conventions.md`. Test, Review, Validator, and deterministic native-terminal Smoke evidence is recorded above. Physical emulator and live-provider smokes remain unverified under the non-interactive execution constraint; no acceptance of that limitation is inferred.

The full-test acceptance gate remains blocked. Retain this plan and submit the focused changes as a draft pull request, rather than deleting it or claiming end-to-end completion. The final review itself is complete; its combined review/delete task remains unchecked because deletion depends on the blocked criteria.

## Risks

The main complexity is actual input reachability, not JSON storage. Different key strings can match the same terminal input, and an earlier listener or Editor action can consume a key before BTW sees it. Validation must follow installed runtime behavior rather than compare raw strings alone.

Custom exit handling touches shared-terminal ownership. Preserve synchronous logical cancellation and deferred physical terminal transfer; do not replay bytes coalesced behind the exit key.

## Completion Checklist

- [x] All three bindings can be edited, persisted, reset, and used after opening or resuming BTW; old settings retain existing behavior.
- [x] Settings tests prove invalid-file protection, unknown-field preservation, ordered reads and writes, and failure rollback.
- [x] Keybinding tests cover non-default Pi bindings, aliases, modifier order, legacy collisions, terminal modes, invalid strings, and usable fallbacks.
- [x] Component tests prove effective hints, preserved editor and paste behavior, and existing thinking-level and bring-to-main semantics.
- [x] Lifecycle tests prove cancellation and disposal release owned tasks and safely restore terminal input under root and nested-overlay focus.
- [x] Non-TUI behavior remains safe and observable where claimed, without entering custom TUI work.
- [ ] `npm run check` and `npm test` pass; any applicable runtime-loading build/load checks are completed or explicitly documented as not applicable.
- [ ] A terminal smoke confirms custom exit, permanent `Ctrl+C`, thinking cycling, and bring-to-main, or the user explicitly accepts the recorded unverified paths.
- [x] README and Changeset are complete, and the semantic audit names applicable MUST rules and their Test, Review, Validator, or Smoke evidence.
- [ ] Implementation is explicitly authorized, all plan tasks and completion checks are satisfied, and this saved plan is deleted in the final handoff.
