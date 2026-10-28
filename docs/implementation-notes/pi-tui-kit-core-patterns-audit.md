# Pi TUI Kit core-pattern audit

Historical audit: 2026-10-14. The decisions, benchmark samples, and verification results below describe that change, not a new test run or current performance guarantee. Later host-key and shared-helper work is recorded in the [package-owned alignment audits](../../packages/pi-tui-kit/docs/core-alignment-audit.md).

Retain the TaskLoader theme and width fixes and correct the SettingsList capability comment. Defer Markdown instance retention, Input composition changes, and macOS hint conversion. Public exports, dependencies, input presentation, settings behavior, and lifecycle ownership remain unchanged.

## Baseline and applicable rules

The branch starts at `45779b3c` on `origin/main`. Root `npm install` resolves Pi TUI and Coding Agent to `1.1.0`, deduplicated across workspaces; manifests and the lockfile do not change. Global Pi `1.2.0` observations in the original plan are discovery evidence only. No minimum-support claim is added for the wildcard peers.

Guides applied: `docs/extension-conventions.md` and `packages/pi-tui-kit/AGENTS.md`. Loader changes MUST rebuild themed content, bound every line, use callback theme/keybindings, preserve hard cancel, and release owned tasks. Verification is `task.test.ts`, `renderer-interaction.test.ts`, and render/disposal review. Candidate cache changes MUST preserve theme output, lazy imports, search coordinates, and interaction-scoped retention; verification is the serial benchmark, output hashes, existing document/search/review/browse tests, and cache review. Input and hint candidates MUST preserve focus, paste/editing, reachable shortcuts, and Back/Close outcomes; verification is the installed-runtime probe, selector/input/hint/renderer tests, and matcher/listener review. Compatibility MUST retain type-only Coding Agent imports, mode boundaries, and release intent; verification is import/export review, a patch Changeset, `npm run check`, and `npm test`.

No settings ownership, persistence, settings UI behavior, or README changes occur. The settings and README guides are therefore not applicable. The SettingsList change is a comment only, not a settings migration.

## Version-specific capability inventory

Authoritative installed implementations are under `node_modules/@earendil-works/pi-tui/dist/` and Coding Agent's `dist/modes/interactive/components/themed-text.js`. Production code uses only public Pi TUI exports.

| Primitive | Installed-runtime evidence and decision |
| --- | --- |
| Input | Constructor accepts prompt, placeholder, and placeholderStyle. Render subtracts prompt display width and supplies the focused IME marker; mouse input subtracts a fixed two columns. Paste, editing, horizontal scrolling, and grapheme movement remain core-owned. Custom prompts are not pointer-compatible; defer migration. |
| SettingsList | `selectItem(id)` initializes selection against all items or filtered items, and is a no-op for unknown IDs. Activation mutates currentValue and calls onChange synchronously; there is no awaited-save/rollback, disabled-row policy, or public search-focus interface. Correct the cursor claim and retain the adapter. |
| Markdown | Render caches one width and styled lines. Parsed tokens are held by WeakRef, keyed by normalized source, and survive invalidate/setText. A separately cached defaultStylePrefix survives invalidate too. Retention must not assume that public invalidation refreshes all styles. |
| Text | Invalidate clears wrapped-line caches, not its already-styled source. setText clears those caches and replaces source. Use package-local callback text over this public primitive. |
| Loader and Container | Loader starts its interval in construction, recomputes styled spinner/message during invalidation, and stops idempotently. Container invalidates children. The hint needs its own source rebuilding; final output also needs clipping for oversized graphemes at narrow widths. |
| Coding Agent ThemedText | Rebuilds styled source after invalidation, but importing its runtime is outside Kit's public Pi-only boundary. Retain the same local composition principle without a Coding Agent runtime import. |

## Five candidate decisions

### TaskLoader: implement

The actual component regression failed before the fix: borders and message became green, while the hint retained red ANSI colors. A second regression failed because an oversized grapheme exceeded a narrow supplied width. The local CallbackText rebuilds its source through the callback-owned theme. TaskLoader floors finite widths, returns no rows below one cell, and clips every child line by display cells.

The hint text, configured cancellation keys, hard Ctrl+C, non-cancellable behavior, and normal-width presentation are unchanged. Tests dispose the harness in finally blocks; fake-timer tests prove exactly one stop after repeated disposal and no subsequent timer redraws. No asynchronous production code or task ownership changes are introduced.

### SettingsList comment: implement

The installed `selectItem()` API disproves the old cursor-initialization claim. The comment now retains the disabled-row, search-focus, async-save, and rollback reasons. No adapter implementation changes.

### Markdown retention: defer after measurement

The bounded fixture is `packages/pi-tui-kit/scripts/benchmark-document-rendering.mjs`, run from the root after a Kit build:

```sh
node packages/pi-tui-kit/scripts/benchmark-document-rendering.mjs
```

It measures complete presentations with search metadata for fixed prose and table/code documents, eight operations per sample, seven samples after one warm-up, serially. All timing comparisons used the same Node `26.5.0` process environment and installed Pi `1.1.0`; final repository gates use the required Node `26.11.1` and bundled npm `11.20.0`. It covers repeated search preparation, alternating 60/80-cell widths, and alternating callback theme output with invalidation. Two complete baseline runs preceded two prototype runs; a final run followed prototype removal. The cold-import/first-frame benchmark is not used as a substitute.

The discarded prototype retained exactly one public Markdown component per interaction cache, shared across display/reference/boundary widths, replaced it for renderLatex changes, and called public invalidate on theme invalidation. It added no imports, public API, width-keyed map, or global retention. Source/options and transformed Mermaid text were revalidated on each presentation. It was removed in full because theme output was not equivalent and table improvements were not repeatable.

Each cell below is median milliseconds ± median absolute deviation, for eight operations:

| Document/workload | Baseline 1 | Prototype 1 | Baseline 2 | Prototype 2 | Output equivalence |
| --- | --- | --- | --- | --- | --- |
| Prose/search preparation | 34.91 ± 1.28 | 24.71 ± 0.82 | 36.07 ± 1.90 | 24.47 ± 0.93 | Yes |
| Prose/alternating width | 27.36 ± 0.19 | 19.73 ± 0.35 | 36.17 ± 0.15 | 20.05 ± 0.62 | Yes |
| Prose/theme invalidation | 32.45 ± 0.29 | 23.08 ± 0.49 | 35.76 ± 1.30 | 22.91 ± 0.14 | No |
| Tables/search preparation | 120.70 ± 8.73 | 137.40 ± 19.37 | 110.31 ± 1.26 | 140.49 ± 5.75 | Yes |
| Tables/alternating width | 102.29 ± 1.42 | 97.59 ± 0.46 | 103.75 ± 0.34 | 109.13 ± 9.22 | Yes |
| Tables/theme invalidation | 110.22 ± 0.88 | 106.72 ± 0.71 | 109.53 ± 0.72 | 109.68 ± 3.15 | No |

SHA-256 covers complete styled output, search lines, wrap metadata, and table reading-order sources. Theme hashes differed because Markdown's defaultStylePrefix retains the old color around inline-style transitions even after public invalidate. Resetting that private field is not acceptable. Recreating the component on invalidation would remove the measured invalidation benefit and needs separate evidence; it is not retained as a speculative workaround. All six final hashes match the original baseline. Raw samples, dispersion, hashes, and Input probe output are in [pi-tui-kit-core-patterns-evidence.json](./pi-tui-kit-core-patterns-evidence.json) beside this note.

No cache code is retained. Existing exact text/code/diff, search coordinates, table reading order, Mermaid widths, RPC pagination, and lazy-loading behavior stay on their existing implementation and regression gates. Optimization timing is host-dependent and is not a deterministic acceptance threshold.

### Input composition: defer

`node packages/pi-tui-kit/scripts/probe-core-input.mjs` exercises the installed public API, not global Pi. The default prompt works for plain, scrolled, and wide-grapheme text. Clicking the first text cell of `Search: abc` yields `abcX`, not `Xabc`; `Search: > abc` fails too. The scrolled custom prompt yields `abcdefghijX`, not `abcdeXfghij`; wide content yields `你🙂abXc`, not `X你🙂abc`. A wide prompt also fails.

The probe checks display-cell bounds at normal, narrow, and zero widths and focused versus unfocused IME markers. Prompt-only narrow rows have no editable cell, and core still accepts a synthetic pointer beyond that row; wrappers must retain their hit bounds. Existing wrappers retain visible Search/Find prefixes and `>`, placeholder placement, coordinate translation, focus forwarding, paste, editing, and injected-key dispatch. No installed code, prompt workaround, or dependency upgrade is retained.

### macOS hint presentation: defer

The audit includes formatInteractionHints normalization, exclusions and deduplication; selector canonical modifier ordering and reachability plans; live-choice matching; menu compact-frame key classification; browse search hints; and review's separate binding formatter. TaskLoader and questionnaire already have local macOS display conversion, and those policies are unchanged.

Normalization/exclusion/deduplication currently uses canonical `alt` strings. CompactMenuHint parses displayed segments into key sets and intersects them with generated groups. Consumers can supply raw custom hint text: converting only generated groups to `option` would stop raw `alt+...` segments matching their cancellation/confirmation priority group. Review's separate formatter also retains canonical strings, while browse uses formatInteractionHints. DocumentSearchController does not parse modifier hints itself, but rendered search hints and tests must remain aligned with these producers.

A global display-only replacement is therefore not proven classification-neutral. Retain canonical formatting rather than add a parser migration or platform option for an optional presentation change. Existing hint/selector/renderer tests cover aliases, modifier order, invalid strings, legacy collisions, terminal protocols, earlier listeners, and usable fallback keys. No new platform support claim is made.

## Verification and final semantic audit

Completed evidence:

- Root `npm install` succeeds without manifest or lockfile changes. It reports five existing dependency-audit findings (three high, two critical); no audit-fix command was run.
- `node scripts/check-install-policy.mjs` passes with the repository-required Node `26.11.1` and bundled npm `11.20.0`, selected with `fnm exec --using 26.11.1` without changing the default toolchain.
- `npm run format`, `git diff --check`, and `npm run check` pass. The check includes builds, Biome, package boundaries, and all workspace typechecks. Initial changed-file Biome import-order and control-character-regex diagnostics were corrected before the final passing gate.
- Focused Kit suite passes 46 files and 834 tests, including exact documents, search, Markdown, Mermaid, RPC, input/paste, hints, lazy loading, lifecycle, and package exports.
- `npm test` passes 598 files: 8,567 tests pass and eight suite-defined skips remain. The gate runs separately from checks, builds Kit before consumer tests, and changes no timeout or skip policy. The first full invocation was interrupted by the command tool's 300-second limit; the final invocation ran to completion with an explicitly captured zero exit status.
- The initial default-toolchain run exposed an npm optional-dependency policy failure; it passes with the required bundled npm. A baseline-identical progress-menu assertion also rejected correctly wrapped settings-path rows. Its test-only correction accepts row wrapping while still requiring the settings label and filename. Both affected files then pass all 39 focused tests; no progress runtime or settings behavior changes.
- Two serial baseline/prototype benchmark runs and final restored output hashes support the Markdown deferral. The Input probe covers custom prompt width, horizontal scrolling, wide graphemes, narrow/zero widths, and focused IME-marker placement.
- `npm run changeset:status` identifies only the intended Kit patch. No public export, dependency, consumer floor, manifest, or runtime-loading graph changes.

The loader renderer regressions run through real regular/fullscreen Pi renderers and their Terminal.start input pipeline. They cover dark-to-light callback theme invalidation, cell-bounded resize, remapped cancellation with hard Ctrl+C, task abort/draining, focus restoration, and preserved main-editor drafts followed by normal editing. Existing renderer tests retain earlier-listener, terminal-protocol, search, pointer, and review behavior. The existing `renderer-loader-smoke.test.ts` also passes: DefaultResourceLoader/Jiti loads the actual extension fixture and triggers its lazy selector command in both renderers, observing notifications and draft/focus restoration.

Pack and package-directory loading are inapplicable: no metadata, generated import targets, or runtime-loading boundaries change. Existing package-export and lazy-import tests remain passing. No interactive Pi command was opened. Physical terminal emulators, real palette discovery, platform clipboard services, and live providers are not tested; no new support claims depend on those paths. The renderer custom-dialog adapter remains a documented simulation of the reviewed host contract.

The final diff audit covers correctness, security, lifecycle safety, compatibility, regressions, and scope. All changed production code is synchronous: there are no changed awaits or session continuations. CallbackText owns no timer or task; Loader still owns the same interval, and TaskLoader disposal still stops it once. Existing runTask ownership checks, owner replacement/shutdown signals, external disposal, user cancellation, late result/error draining, and non-TUI direct execution remain unchanged and pass their regressions. Display clipping does not mutate raw task labels or keybindings; existing display sanitization stays in the owning runner. No secrets, settings writes, file mutation, provider calls, model-visible context, or terminal handoff policy is introduced.

The only verification-scope addition is the progress-menu test's wrapped-path assertion, needed to run the complete gate on long temporary paths; it adds no published behavior or Changeset. All other retained files belong to the specified five-candidate evaluation, loader correction, release scope, or evidence. The cache prototype is absent from the final diff. Input and key-hint behavior stay unchanged, and the three deferrals are the evidence-gated outcomes authorized by the plan.

All plan tasks and completion criteria have evidence above. The completed plan was removed after the handoff audit. No publication, visibility change, version tag, or release workflow was performed.
