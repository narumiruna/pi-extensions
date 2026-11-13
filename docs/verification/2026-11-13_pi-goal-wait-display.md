# Pi Goal waiting display verification

The waiting footer now contains only `waiting`. The `goal_wait` block uses a short call title, a two-row reason preview, resume guidance, and expandable recorded details. Tool payloads and waiting behavior are unchanged.

## Display evidence

These 80-column captures come from Pi's native `ToolExecutionComponent`, using the same recorded result before and after renderer registration. ANSI styles and outer blank padding are omitted. The executable captures are in `packages/pi-goal/test/wait-renderer.test.ts`.

Before:

```text
goal_wait goal_id="64c2162c-9a8a-4911-bd66-f679aa0cc6e9" reason="The unchanged
mandatory workspace runner i...
Goal waiting: The unchanged mandatory workspace runner is in progress on the
final review-fix code. Monitor job_mwenzczj_3h will wake this session on success
or failure. Commit, publication and thread resolution depend on that result.
```

After, collapsed:

```text
Goal Wait
The unchanged mandatory workspace runner is in progress on the final review-fix
code. Monitor job_mwenzczj_3h will wake this session on success or failure. Com…
Resume: external input or /goal resume
ctrl+o to expand
```

After, expanded:

```text
Goal Wait
The unchanged mandatory workspace runner is in progress on the final review-fix
code. Monitor job_mwenzczj_3h will wake this session on success or failure. Comm
it, publication and thread resolution depend on that result.
Goal: Verify the workspace
Goal ID: 64c2162c-9a8a-4911-bd66-f679aa0cc6e9
Resume: external input or /goal resume
```

The expansion hint uses Pi's configured binding, not a fixed shortcut. Native-row tests also cover a remapped `ctrl+y` binding and an unbound action. A recorded deadline adds a UTC `Safety wake` timestamp; expanded clamped waits show both requested and effective delays.

The footer no longer includes the reason or automatic-work counters. `/goal status` and **View full status** retain the full current wait information. All other footer states retain their existing format.

## Verification

- `npm run check`: passed builds, Biome, boundaries, and workspace typechecks.
- `npm test`: passed 947 files and 21,379 tests; 34 existing conditional skips and no unhandled errors.
- Focused package suite: passed 39 files and 1,005 tests, including render fixtures, waiting-status restoration, provider/recovery waits, cache contracts, and generated Jiti loading.
- `npm --workspace @narumitw/pi-goal run test:runtime`: passed the local faux-provider lifecycle smoke, including quiet waiting, same-ID wake/completion, managed cancellation, retry/compaction, usage recovery, budgets, and ownership.
- `pi --no-extensions -e ./packages/pi-goal --mode rpc`: passed with the installed Pi CLI in an isolated offline environment. `get_commands` confirmed Goal registration, `get_state` confirmed idle state, and EOF produced exit code 0. No model run, extension error, or stderr output occurred. The subprocess startup deadline began only after its bootstrap readiness message.
- `npm run package:pack -- goal`: passed. A separate temporary tarball inspection confirmed 42 entries, including the new source renderer, generated entry/chunks, README, license, and changelog, with no tests or `node_modules`.
- Fenced-code-aware README audit: passed the required sections and badges for all 35 packages. The changed README preserves command routes, installation/build guidance, trust warnings, settings access, and existing reference links.
- `git diff --check`: passed.

The first development checks found test expectation, test typing, import ordering, and test lint errors. These were corrected before the passing gates. Biome still reports the existing schema-version and unrelated `pi-sync` informational notices; neither fails the gate.

## Model and loading compatibility

A temporary baseline package was built from `464b5a42` outside the repository. Fresh-process Jiti loads compared its ordered Goal tool definitions with the changed package. Names, labels, descriptions, schemas, constrained-sampling fields, and prompt metadata were identical in all six loads. Tool order remains `goal_complete`, `goal_blocked`, `goal_wait`.

Three generated-entry load samples per revision, in milliseconds:

| Revision | Samples |
| --- | --- |
| Baseline | 189.0, 12.0, 12.3 |
| Changed | 13.2, 12.9, 12.8 |

Filesystem/Jiti caches and host noise were not controlled; these samples establish no speed claim or performance threshold. The temporary baseline and pack artifacts were removed.

The renderer uses the existing Kit dependency's `terminal-document` leaf for sanitation and exact cell wrapping. The builder allows only that exact eager external specifier; Kit's root, its other leaves, and Goal menu/settings modules remain protected by the existing lazy-boundary tests. No manifest, lockfile, dependency floor, tool schema, or persistent state changed. Repository-locked Pi tests and the installed CLI smoke exercised separate Pi installations.

## Semantic review

Review used `docs/extension-conventions.md`, `docs/readme-conventions.md`, `docs/runtime-builder.md`, package instructions, installed Pi rendering code, and the existing Kit helper contract. An independent read-only review found no actionable implementation issue.

- Correctness and compatibility: accepted, rejected, partial, unknown, and incomplete historical results have distinct tested paths. Invalid deadlines fall back without throwing. Acceptance is not inferred from populated wait details.
- Terminal safety: untrusted reasons, Goal text, IDs, and fallback content are sanitized before wrapping or truncation. Tests cover Chinese, emoji, combining characters, multiline content, long unbroken text, terminal controls, widths 0/1/20/80, resize, and theme invalidation.
- Lifecycle: renderers are synchronous and own no tasks, timers, subscriptions, or mutable session context. Existing cancellation, session replacement, disposal, and shutdown behavior is unchanged.
- Model and state safety: execution code, result content/details, termination, Goal identity, deadlines, counters, active-tool policy, and prompt publication are unchanged. Non-interactive execution tests verify the original payload and no interactive UI entry.
- Scope: no statusline policy, other Goal tool renderer, settings, notification, provider policy, or public event protocol changed. A patch Changeset records the display change.

## External handoff and release restriction

The user or maintainer can review the collapsed/expanded block and footer in their normal terminal, theme, and statusline setup using the captures above as a reference. Expected result: a short footer, readable tool content, and complete details through expansion. The exact native terminal appearance and subjective usability remain unverified; headless native-component captures do not establish visual acceptance. This review is not an agent-plan completion gate.

No package publication, visibility change, version tag, or release workflow was performed. Publication still requires explicit user approval.
