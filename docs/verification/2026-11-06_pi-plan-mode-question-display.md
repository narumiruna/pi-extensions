# Plan mode question display verification

Status: complete. The corrected implementation passes local checks, all 546 Plan mode tests, and both required repository gates in a complete Linux CI run. The completed plan at `docs/plans/2026-11-06_pi-plan-mode-question-display-plan.md` is removed; this record retains its acceptance evidence and external handoff.

The question-display implementation was merged in [PR #1815](https://github.com/narumiruna/pi-extensions/pull/1815). The completion correction, `227aedc3`, starts from merged base `f3cd9671` and reduces decorative prefixes before they replace otherwise-fitting graphemes or exceed the renderer width.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| Compact calls and answers without raw JSON | Renderer and native `ToolExecutionComponent` tests cover selected answers, custom answers, notes, and default, remapped, or unbound expansion keys. |
| Complete expanded text when graphemes fit | Tests cover every question, answer, note, cancellation, error, and fallback path; zero- through four-cell graphemes; CJK, emoji, flags, combining marks, Indic clusters, resize, and unavoidable wider-than-viewport fallback. |
| Width safety after prefix composition | Mixed leading-mark regressions verify the composed prefix and body, not only their separate widths. All rendered component rows remain within the supplied width. |
| Display-only sanitization and stable model data | Terminal controls are removed before measurement and wrapping. Raw payload equality and cache-contract tests pass; no tool schema, description, active-tool order, or model result changes. |
| Existing questionnaire and lifecycle behavior | All 546 Plan mode tests pass across 40 files, including cancellation, non-TUI behavior, editors, session lifecycle, generated runtime, and cache contracts. |
| Generated runtime and package contents | Jiti loader tests exercise a representative lazy boundary. Dry-run packing and real tarball inspection pass. The 46-file tarball contains the manifest, generated and source entries, renderer, README, changelog, and license. |
| Package-directory loading | Pi RPC smoke passes `/plan` registration, `get_state`, and clean shutdown from an isolated agent directory. No provider request is made. |
| Repository gates | Local and Linux `npm run check` pass. [Full Linux CI attempt 2](https://github.com/narumiruna/pi-extensions/actions/runs/42076480747/attempts/2) passes 19,323 tests with zero failures and 16 skips across 901 files. |

The added regression tests failed before each correction: 13 retention cases first, then six mixed-mark composition cases. All 57 renderer tests now pass, including 30 new cases.

## Semantic review

The review covered the complete implementation and correction against `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`.

- Correctness: decorative prefixes leave enough cells for fitting graphemes; composed rows are measured again before styling.
- Security: sanitization remains display-only and precedes segmentation, measurement, wrapping, and truncation.
- Lifecycle safety: no asynchronous work, input handlers, owned resources, or session state were added.
- Compatibility: Pi still owns framing and expansion; public Kit subpaths stay external, interactive imports stay lazy, and the dependency floor is unchanged.
- Regressions: tests retain ordinary layout, whitespace, theme invalidation, partial/cancelled/failed/restored results, and configured expansion hints.
- Scope: only the renderer correction, regression tests, patch changeset, and verification records changed; no unrelated package behavior or tests were modified.

Independent read-only reviews found the retention and composition defects. Both have deterministic regression coverage and are corrected. No other actionable findings remain from those reviews. The package README and existing warnings remain unchanged by the correction; the required-section audit covers all active package READMEs.

## Full-suite verification

The existing CI workflow was dispatched for `227aedc3` without an affected-test base. This selects the full root and workspace suite, unlike the earlier PR check, which ran affected tests only. The workflow contains checks and tests, not release operations.

Full Linux [attempt 2](https://github.com/narumiruna/pi-extensions/actions/runs/42076480747/attempts/2) passed both `npm run check` and `npm test`: 19,323 passed, zero failed, and 16 skipped across 901 files. Its log explicitly confirms `Running the full test suite: no affected-test base was provided.` The tested runtime, tests, lockfile, scripts, and workflow are unchanged by the final documentation-only cleanup.

The first full Linux [attempt](https://github.com/narumiruna/pi-extensions/actions/runs/42076480747/attempts/1) reported 19,322 passed, 16 skipped, and one failed across 901 files. The failure was `packages/pi-subagents/test/model-selection-runtime.test.ts`, which expected a provisional parent model but observed the host's unknown model. That test launches only the Subagents package and its synthetic provider fixture, not Plan mode. This failure is retained as verification evidence; no assertion or unrelated implementation is changed. The exact startup case passed three unchanged targeted local runs, and the complete suite then passed on the same commit in attempt 2. No assertion, timeout, test selection, or acceptance criterion was weakened.

The original local macOS full-suite run reported 19,272 passed, 34 skipped, and four failed. The same four failures were reproduced on unchanged `24a07ad5`:

- One Fleet Unix socket path-length failure.
- Two Edit Scope assertions affected by wrapped long temporary paths.
- One Edit Scope Unicode-filename assumption that does not hold on this filesystem.

A targeted rerun with `TMPDIR=/tmp` resolved the three path-length failures; the Unicode-filename failure remained. These local limitations were not concealed, waived, or corrected outside this plan's scope. The complete Linux run supplies the compatible environment needed for the full gate; it does not make the local macOS full suite green.

## External handoff

The user can review appearance after loading the built local package: answer a question, expand its result, and inspect the question, answer, and note in the actual terminal and theme. The expected result is a readable summary and complete expanded text when graphemes fit. Component rendering, package contents, and headless loading are verified; subjective appearance and a live interactive TUI smoke remain unverified because this environment does not permit opening an interactive TUI. This visual review is not an agent-plan completion criterion.

Maintainers can investigate the intermittent Subagents startup-model assertion and macOS test limitations in separate work. The failed attempts remain visible above; this completion does not claim those unrelated tests were corrected.

No package was published or installed into user settings, no version tag was created, and no release workflow was dispatched. Release approval remains separate from plan completion.
