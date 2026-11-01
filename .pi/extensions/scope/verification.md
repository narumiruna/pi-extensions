# Scope verification and terminal handoff

Deterministic tests exercise the real Pi loader, runner, agent loop, and stock tool pipeline without a live provider. They do not prove physical key delivery, IME placement, or terminal usability.

## Applicable guides and audit

The implementation follows root `AGENTS.md`, `docs/extension-conventions.md`, and `docs/extension-settings.md`. `docs/readme-conventions.md` applies to active package READMEs; this extension stays inside the project-resource boundary and has no package metadata or publication step.

| Touched area | Required behavior and verification |
| --- | --- |
| Boundary and loading | Default factory, trusted discovery, no other extension's private imports; native Jiti and CLI smokes. |
| Commands | Only `/scope` and `/scope off`, exact completion, observable non-TUI rejection, idle checks; lifecycle tests and real RPC/print/JSON commands. |
| Tool safety | Stock source checks, unchanged built-in definitions, exact pre-mutation validation, bounded errors; policy, conformance, and native side-effect tests. |
| Lifecycle | Active-branch reconstruction, no captured context after replacement, session-manager ownership, cancellation and task drainage; lifecycle and native reload/resume/fork/tree tests. |
| Context | Stable serialized prefix and declarations, one fixed recovery boundary, no native system-message folding; contract tests, real runner tests, and offline agent request capture. |
| UI | Public Kit screens, callback theme and keys, bounded frame, native Input editing, paste isolation, focus, pointer identity, disposal; input, picker, menu, widget, and fullscreen host tests. |
| Settings | No writes on read, boolean validation, latest-document merge, ordered reads/saves/flush, atomic rename, invalid-file protection and rollback; fault-injection and ordering tests. |

The final semantic audit covers user cancellation, disposal, session replacement, shutdown, and every await that can outlive its owner. Final apply receives the task's operation signal, rechecks idle state, scope revision, ownership, canonical targets, and usable loadout before committing. Shutdown aborts and drains tracked tool checks, UI work, and preference writes.

## Runtime boundary

The conformance matrix uses the installed native `write` and `edit` implementations, not only a copied path helper. It covers relative and absolute paths, dot segments, leading `@`, `~`, file URLs and URI errors, Unicode and literal whitespace, POSIX literal backslashes, macOS read-only fallback separation, symbolic links, missing ancestors, hard links, nonregular files, metadata failures, and cancellation.

Native SDK tests execute the exported tool pipeline with real session hooks. They verify selected writes/edits and deferred creation, unselected read/ls, and no target side effects from unselected write/edit, shell, codemode, or opaque tools. A trusted host-only fixture invokes a delegation wrapper to prove its `ctx.executeTool()` children retain real nested events and guards. The same wrapper is blocked when model-issued; production contains no test allowlist.

Codemode is blocked because not all of its branches are nested tool calls. Active router-only loadouts fail clearly instead of changing core tools or settings. SDK replacement tools are not accepted by name. Arbitrary SDK `baseToolsOverride` and custom `prepareLoadout` behavior cannot be attested through public metadata and remain unsupported.

## Prefix epochs

Scope adds no tool definitions and does not change active tool names, snippets, guidelines, or the leading system prompt. An explicit activation, changed reservation, or exit appends a new notice and starts the next Scope contract epoch. Reapplying the identical reservation is a no-op.

Missing or compacted-away notices create one deterministic tail recovery and a non-model persisted prefix anchor. Ordinary requests reuse its original boundary. Deferred original publication is placed at that first-seen boundary, not after newer output. Retained historical contracts remain in order after replacement and exit.

Restoration uses `context_with_system`, not legacy `context`. Native legacy context restoration folds prompt/tool deltas into the leading system message when the conversation changes. The full-system hook preserves existing system messages, including the leading message at index zero. Regression tests use the real runner with additive native deltas, also after Scope exit; an empty-prefix saved anchor cannot precede the leading system message.

A separate native agent-loop test replaces only the stream function with a local completed stream. It compares effective prompt, ordered provider-visible tool definitions, active names, and the serialized earlier message prefix across ordinary requests. It excludes timestamps, usage, and other non-model accounting. It makes no transport request and claims no provider-reported cache hit.

## Compatibility decisions

The manager, settings, review, and task screens use public Kit APIs. The selector and path field use small extension-owned adapters over public Pi `SelectList` and `Input`. Kit was not changed.

The standalone Kit selector does not expose the required in-place validation, live count, exact path preview, and paste-safe completion behavior. The local adapter retains the checked draft and query after validation failure. It treats literal Space as text, uses configured selection confirmation, preserves a pressed raw file ID when scrolling recenters the viewport, and discards pasted controls during pending validation.

Custom selector/input screens intentionally show no key hints or additive shortcuts. Pi's configured matchers remain authoritative; host listeners can consume keys before component dispatch. Table-driven tests cover aliases, modifier order, legacy collisions, Kitty/legacy differences, invalid strings, and remapped confirmation/submission. No fallback shortcut is selected or advertised. Ctrl+C remains a hard-cancel path outside paste.

All new-file targets receive one exact review; ordinary in-cwd file selection has no second routine confirmation. A changed or removed alias can be repaired by explicitly selecting its real path, even if both reservations have the same canonical target.

Preference ordering uses a stable absolute lexical path across loads, first creation, and atomic replacement. It is not a file-identity or cross-process lock. Different parent-directory aliases are not coordinated. Native target mutations retain Pi's own queue.

## Recorded checks

Run from the repository root, sequentially. Root checks clear and rebuild Kit output; do not run consumer tests during that build.

| Check | Status |
| --- | --- |
| Local TypeScript: `npm exec -- tsc -p .pi/extensions/scope/tsconfig.json` | Passed. |
| Local tests: `npm exec -- vitest run --config .pi/extensions/scope/vitest.config.ts` | Passed: 301 tests in 11 files; 1 Windows-only test skipped on this host. |
| CLI smoke: `node .pi/extensions/scope/test/runtime-smoke.mjs` | Passed: all 5 CLI paths after the final context change. |
| Local Biome: `npm exec -- biome check .pi/extensions/scope --error-on-warnings` | Passed: 29 files. |
| `npm run check` | Passed: builds, Biome, boundaries, and all workspace typechecks. |
| `npm test` | Passed: 17,517 tests; 15 platform/conditional skips; no unhandled errors. |

Independent final source review found no remaining concrete defect after the pointer-identity, lexical-reservation repair, and full-system context corrections. Existing root informational diagnostics about the Biome schema and `pi-sync` remain unchanged; neither failed a gate. No package metadata, root test wiring, dependencies, Changeset, or publishing operation changed.

CLI smoke coverage includes explicit `--no-extensions -e` loading, trusted-project discovery, trust denial, print mode, and JSON mode. Each command rejection is observed without a model run or protocol corruption. Subprocess deadlines start only after readiness, and all child exits are awaited.

The native SDK also opens the lazy manager and selector through Jiti with a TUI harness, then cancels them without releasing the scope. A separate native TUI-command test applies a selection and explicitly exits, proves real write side effects and blocking, retains both notices, and preserves the loadout. Trusted-project SDK reload reconstructs the runner, preserves registration and enforcement, and exercises the command afterward. RPC cannot invoke built-in `/reload` safely; it would become model input, so that route is reserved for the terminal handoff.

## Physical-terminal handoff

Maintainer: after the repository build, run these checks in a real terminal with the usual Pi configuration. Do not claim verified native UX or release readiness from headless evidence alone. No publication is part of this change.

From the repository root, prepare a disposable workspace:

```sh
repo="$PWD"
fixture="$(mktemp -d)"
printf 'first\n' > "$fixture/a.txt"
printf 'second\n' > "$fixture/b.txt"
cd "$fixture"
pi --no-extensions -e "$repo/.pi/extensions/scope/index.ts"
```

1. Open `/scope`; confirm that the first action is selected and cwd and inactive state are clear.
2. Select `a.txt`, filter and toggle it, then finish with **Start restriction**. Confirm return to the prompt and the active widget.
3. Reopen the selector, change its draft, then cancel. Confirm the live set is still only `a.txt`.
4. Try **Use only a new file…** with `a.txt`; confirm the draft survives rejection. Correct it to a new nested path, review it, then cancel. Confirm that no file or parent directory was created.
5. Repeat new-file reservation and complete it. Confirm that the set has one deferred target, not the earlier file plus the new path.
6. Exercise literal and bracketed-pasted spaces, long and Unicode text, Backspace, cursor movement, resize, pointer selection, and IME. Repeat with non-default submit, confirm, and cancel bindings; use Ctrl+C as the hard-cancel path.
7. Change the hidden-file preference. Confirm immediate persistence and that Back does not undo the save. Restore the preference if required.
8. Run interactive `/reload` while restricted. Confirm the widget, complete Status list, command, and restriction survive.
9. Check a new session, resume, and tree navigation before and after activation. Expect the state of each active branch, not the last state from another branch.
10. End through **End restriction** and then `/scope off`. Confirm return to the prompt, cleared owned widget, and an inactive no-op on the second exit.

Physical terminal keys, IME positioning, subjective interaction quality, and the interactive `/reload` route remain unverified until this handoff is run. Live-provider behavior and untested operating systems are not claimed. These external UX checks do not replace the deterministic coding gates.
