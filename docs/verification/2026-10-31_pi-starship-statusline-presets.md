# pi-starship statusline preset verification

## Outcome

The Presets catalog contains twenty entries. Seven additions are Lualine Bubbles, Lualine Eviline, Lualine Slanted Gaps, Catppuccin Tmux, Dracula Tmux, Powerlevel10k Lean, and Oh My Posh Atomic. Pastel Powerline, Gruvbox Rainbow, and Tokyo Night use refreshed documents under their existing IDs. Jetpack omits its progress separator when no progress values exist. All existing IDs remain unchanged.

The display labels Session Indicators and Pure retain the `no-runtime-versions` and `pure-preset` IDs and their exact TOML documents. Bubbles now describes its violet Pi badge, gray workspace, and separate session pills.

Catppuccin Tmux uses one logical primary row: workspace details stay on the left and session details stay on the right of one fill. Its Mocha palette, module colors, rounded caps, fields, and ID remain unchanged. This removes the deliberate stacking of the Pi and model pills; narrow terminals still wrap, and public extension statuses keep their conditional line.

The implementation is package-owned TOML stored in TypeScript string constants. No runtime reads from `tmp/starship/`, font/image assets, new dependencies, public command routes, or new UI mechanisms are required. The existing lazy command graph owns preset loading. A minor Changeset records the release intent; no publication, version update, tag, or installation was performed.

Active settings and profiles remain independent copies. Nothing in this change rewrites them automatically. An older copy of a refreshed preset remains usable and can appear as Custom configuration because recognition compares exact bytes. Explicit application keeps the existing review, confirmation, atomic replacement, and History behavior.

## Guides and semantic audits

The touched-area review used `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, the bundled `configure-pi-starship` references, and Pi's extension, package, TUI, SDK, CLI, and RPC documentation.

- Settings: every catalog document has zero native configuration diagnostics. Reachability is limited to local Pi and Git modules. No GitHub PR query, optional workspace version command, cloud/system reader, identity probe, or extra persistence source is enabled.
- Rendering: tests cover width zero and one, narrow and normal widths, Unicode, combining characters, oversized Indic graphemes, hostile terminal controls, missing model/Git/context values, clean and dirty Git, context availability and boundaries, and neutral third-party statuses. Shared transitions remain attached to the Git branch/status, context/clock, and Tokyo Night model/thinking groups when one member is hidden or unavailable. Branch-suppression cases cover disabled, ignored, detached, bare, and missing display labels from the authoritative module code. Rendering does not mutate inputs, and color capability does not change layout. Eviline owns an explicit background on its text, edges, thinking overrides, and context thresholds; Dracula and Slanted Gaps retain explicit backgrounds.
- Compatibility: all existing IDs remain. The three refreshed documents intentionally shorten model labels and change layout; the documentation explains exact-byte recognition and the absence of automatic migration.
- UI and lifecycle: the existing picker and command ownership are unchanged. Tests cover the larger catalog, paging, configured navigation keys, preview restoration, cancellation/disposal, and a Bubbles application with an exact original-document History backup. Existing lifecycle tests cover replacement and shutdown. No new asynchronous owner or key handler was added.
- Runtime loading: the builder policy and its contract keep all ten promoted documents outside the eager graph. Generated imports resolve to exact emitted paths, and the Jiti test opens the generated Presets menu and previews all twenty entries without publishing settings.
- Documentation and notices: package README sections and warnings remain. Public configuration references describe font requirements, layouts, and compatibility limits. Required Starship, Lualine, Catppuccin Tmux, Dracula Tmux, Powerlevel10k, and Oh My Posh notices are included in the packed package.
- Scope: model-visible prompts, tool definitions, collector and lifecycle behavior, settings storage, package manifests, dependency floors, and the lockfile are unchanged. Activity display now sanitizes tool names, and the shared footer wrapper bounds residual overwide rows.

The source adaptations intentionally differ from their upstream runtimes. Eviline uses thinking-level colors rather than Vim modes; Dracula uses rectangular segments; Lean wraps rather than hiding overlapping right content; Atomic uses actual Pi activity rather than command duration and keeps a fixed Git background. Slanted Gaps uses a light surface. The ten promoted documents show context from 0% when available and at most two extension statuses on a conditional new line. Only Eviline changes context warning colors at 60% and 80%; the other nine use fixed palette colors.

## Review resolution

All six reviewed findings are resolved:

1. Eviline no longer relies on whole-style inheritance to paint its dark background. Native chunks and ANSI runs retain it with and without fill, at every thinking level and context threshold; the extension-status row remains neutral.
2. Active and completed tool names use single-line sanitization for both `$tool` and `$text`. LF, CR, Unicode line separators, terminal sequences, control characters, and direction controls cannot add footer rows. Raw map keys, counts, and completed identities remain unchanged.
3. The footer keeps Pi's ordinary ANSI-aware wrapping byte-for-byte. Only a residual overwide row uses Pi's `truncateToWidth()` with `…`; a single grapheme wider than the viewport cannot trigger a regular-mode width violation. Tests include one-cell widths and one 249-byte Indic path component measured as one 42-cell grapheme at width 40.
4. Tokyo Night owns its model/thinking transition in a shared conditional group. Native chunk and ANSI tests cover present, missing, and disabled combinations with and without Git; an empty thinking level does not keep an empty block.
5. Jetpack's progress pair is conditional. All seven operation labels remain intact without progress, including the meaningful slash in `AM/REBASE`; valid `3/7` progress remains visible. Pure verifies the equivalent existing behavior.
6. The configuration reference identifies the named upstream design instead of describing all sources as Starship presets.

The safety regressions produced 45 expected failures before the activity/wrapper fixes. All 91 tests in the two new safety files pass afterward. A separate read-only semantic review found no actionable defects in sanitization, wrapping, labels, compatibility, or documentation. Its independent probe preserved 614 fitting native rows byte-for-byte and bounded 27 residual rows at widths 0, 1, 2, and 40. No external runtime or shared-library implementation was changed.

## Single-row shape correction

The user's terminal screenshot showed the first-row Pi capsule touching the second-row model label. The correction only removes Catppuccin Tmux's forced main-row newline and second fill, then places model, thinking, activity, context, and time in the right-hand group. No glyph, palette, module style, renderer, or row-padding change is needed.

The new native regression failed with two primary rows before the change. It passes with one full-width primary row at widths 160 and 240 in both color modes, preserves workspace/session order and clock alignment, and retains the optional status line. The existing matrix still checks narrow-width wrapping and missing/hostile values. Physical-terminal acceptance of the revised layout remains external.

## Checks

| Verification | Result |
| --- | --- |
| Native configuration validation | Twenty unique IDs and documents; zero diagnostics |
| Focused config, module, picker, builder, rendering, safety, lifecycle, and preview tests | 630 passed in nine files; builder policy and contract agree |
| Preset rendering tests | 376 passed, including 5,400 preset/fixture/width/color cases with repeat-render and input-purity assertions, plus single-row layout, native background, and shared-segment regressions |
| Matrix dimensions | Twenty presets × fifteen fixtures × nine widths (`0`, `1`, `2`, `8`, `20`, `40`, `80`, `120`, `160`) × two color modes |
| Activity and footer-wrapping safety tests | 91 passed; raw identities and intentional format newlines remain unchanged |
| Non-default picker keys | Passed; configured navigation reaches Catppuccin Tmux and cancellation restores the preview |
| New preset application | Passed; Bubbles is saved exactly and the original document is retained in History |
| `npm run check` | Passed: builds, Biome, package boundaries, workspace typechecks |
| `npm test` | 17,124 passed; 15 skipped; no failures or unhandled errors |
| `npm run changeset:status` | Minor bump for pi-starship only; reports unchanged Kit dependency-range warnings for other workspaces |
| Fenced-code-aware README heading audit | All 37 packages have required sections; pi-starship's title, badges, and safety warnings are preserved |
| Package build and generated Jiti loader | Passed; all twenty preset selections are traversed in the native mock TUI |
| `npm run package:pack -- starship` | Passed; canonical pack dry run |
| Actual `npm --workspace @narumitw/pi-starship pack` and tarball inspection | Passed; 168 files, twenty exact source preset documents, notices, bundled references, and valid generated imports |
| Package-directory CLI RPC smoke | Passed; declared generated entrypoint, lazy help/status commands, clean diagnostics, no provider run, no Starship settings write, orderly shutdown |

The tarball contains no temporary studies, tests, fonts, or images. Its preset documents match the source catalog byte-for-byte and validate after extraction. Its SHA-256 is `e196e9e11766b1d5dfdd28c033abeeb4e88c7601de77ae84c468cd055e7c4ae9` for this verification build; a later manifest/version change produces a different artifact.

## CLI smoke

The subprocess used a fresh temporary agent directory, the local package, offline mode, and no discovered extensions, skills, templates, themes, MCP servers, context files, or trusted-project resources:

```bash
pi --mode rpc --no-session --no-extensions --no-skills \
  --no-prompt-templates --no-themes --no-context-files --no-mcp \
  --offline --no-approve -e ./packages/pi-starship
```

The client waited for a successful `get_state` readiness response before starting its operation deadline. It checked `get_commands`, sent `/starship help` and `/starship status`, checked unchanged message state, then closed stdin and joined shutdown. Both extension commands were handled without an agent run. RPC does not render a footer or custom preset menu; the separate generated Jiti/native-TUI harness verifies that lazy menu boundary.

## External handoff and limits

The maintainer or user must load the local build in a physical terminal and open `/starship` → **Presets** to review glyph joins, font metrics, readability, and light/dark background contrast. Designs marked Nerd Font require an appropriate terminal font. Resize the terminal and compare the single-row and two-row layouts; applying a choice remains an explicit confirmation.

The temporary `tmp/starship/` research files were removed at the user's request and are excluded from version control. The maintained presets and required notices remain under `packages/pi-starship/`. No new physical-terminal or browser visual acceptance was performed during this promotion. Native mock-TUI tests and the RPC smoke do not establish physical-terminal behavior or subjective acceptance. No live-provider smoke was needed because this change introduces no provider behavior. Changesets reports unchanged Kit dependency-range warnings in other workspaces; their manifests and dependency floors were not changed here. The maintainer must review those separately before a shared release. Do not claim physical visual acceptance or a published release from these results.
