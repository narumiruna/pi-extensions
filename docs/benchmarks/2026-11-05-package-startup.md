# Package startup loading

This batch reduces unused UI loading in pi-btw, pi-codex-imagegen, and pi-edit-scope. Commands, tools, renderers, lifecycle hooks, editing restrictions, and settings behavior stay unchanged.

## Scope

The baseline is `82c8d30a`, after the pi-sync startup optimization merged. A read-only audit and a separate-process screen covered all 36 other active extensions. This batch selects unused UI code, not every high-cost module:

- pi-btw loads menus, the main-context picker, fullscreen/split UI, transcript views, and bring/import actions only when used. Session lifetimes and main-thread update listeners remain eager.
- pi-codex-imagegen loads only its default command menu on first use. Tool schemas, renderers, exposure rules, request code, and injected-menu behavior remain eager or unchanged.
- pi-edit-scope imports the terminal-text library entry for pure display functions and keeps frame rendering in its menu-only UI module. Enforcement and model-context publication remain eager.

No dependency, manifest, setting, command syntax, provider behavior, or model-prefix change is required. pi-edit-scope remains private; its Changeset is separate from the publishable packages. No publication or visibility change was performed.

## Repeatable measurements

Each selected case uses five separate offline Pi RPC processes after one warm-up, with empty isolated agent directories. Warm mode uses Jiti's filesystem cache; cold mode disables it. No model request is made. The measurements cover unconfigured startup, not first UI use or live-provider work. Do not add standalone package times: shared imports and process state make them non-additive.

Environment: linux x64, 6.18.33.2-microsoft-standard-WSL2, Node.js v26.11.1.

Values are milliseconds. Arrows show before → after medians. The first RPC response includes Pi core and session initialization, not only extension cost. The corresponding no-extension first-response medians ranged from 172.23 to 193.58 ms. These host-specific values are not test thresholds.

| Package | Entry | Jiti cache | Module import | First RPC response |
| --- | --- | --- | --- | --- |
| pi-btw | source | warm | 109 → 47 | 327.17 → 225.28 |
| pi-btw | source | cold | 631 → 300 | 846.12 → 479.51 |
| pi-btw | package | warm | 15 → 13 | 211.91 → 188.44 |
| pi-btw | package | cold | 382 → 224 | 567.36 → 410.88 |
| pi-codex-imagegen | source | warm | 75 → 23 | 266.14 → 202.81 |
| pi-codex-imagegen | source | cold | 317 → 226 | 498.42 → 403.77 |
| pi-codex-imagegen | package | warm | 72 → 24 | 254.19 → 202.97 |
| pi-codex-imagegen | package | cold | 327 → 226 | 510.23 → 412.26 |
| pi-edit-scope | source | warm | 70 → 52 | 256.81 → 232.29 |
| pi-edit-scope | source | cold | 276 → 244 | 456.3 → 425.53 |
| pi-edit-scope | package | warm | 72 → 52 | 262.44 → 230.12 |
| pi-edit-scope | package | cold | 272 → 248 | 450.29 → 427.05 |

First use still pays the deferred import cost. Dynamic module imports cannot be aborted; owned command cleanup drains them, and post-import ownership checks prevent stale UI.

Run from the repository root for each selected package, entry, and cache mode:

```sh
npm run build
npm run benchmark:extension-startup -- --entry ./packages/pi-btw --runs 5 --cache-mode cold --baseline
npm run benchmark:extension-startup -- --entry ./packages/pi-btw/src/index.ts --runs 5 --cache-mode warm --baseline
```

Raw module-import samples:

| Package | Entry | Jiti cache | Before | After |
| --- | --- | --- | --- | --- |
| pi-btw | source | warm | 124, 124, 103, 104, 109 | 48, 46, 46, 47, 47 |
| pi-btw | source | cold | 723, 631, 635, 624, 574 | 304, 296, 300, 299, 301 |
| pi-btw | package | warm | 13, 14, 17, 15, 15 | 14, 13, 13, 13, 13 |
| pi-btw | package | cold | 381, 389, 386, 381, 382 | 232, 219, 219, 229, 224 |
| pi-codex-imagegen | source | warm | 75, 74, 85, 71, 77 | 23, 23, 24, 23, 23 |
| pi-codex-imagegen | source | cold | 314, 314, 317, 321, 321 | 240, 232, 226, 218, 221 |
| pi-codex-imagegen | package | warm | 72, 72, 72, 71, 75 | 24, 24, 24, 24, 24 |
| pi-codex-imagegen | package | cold | 343, 312, 327, 353, 322 | 223, 230, 226, 235, 223 |
| pi-edit-scope | source | warm | 70, 71, 67, 67, 71 | 52, 52, 55, 52, 53 |
| pi-edit-scope | source | cold | 276, 274, 265, 287, 303 | 245, 242, 249, 244, 243 |
| pi-edit-scope | package | warm | 66, 81, 72, 72, 67 | 52, 63, 51, 54, 52 |
| pi-edit-scope | package | cold | 264, 272, 266, 274, 278 | 249, 248, 245, 243, 248 |

## Screening inventory

This inventory uses one measured cold-Jiti sample after one warm-up per isolated entry. It selects inspection candidates; it is not a stable ranking or an after-change benchmark. Values are module-import milliseconds.

| Package | Source entry | Package entry |
| --- | --- | --- |
| pi-accounts | 383 | 263 |
| pi-agentfs | 285 | 261 |
| pi-analytics | 293 | 231 |
| pi-btw | 554 | 381 |
| pi-cache-hit-monitor | 179 | 172 |
| pi-caffeinate | 216 | 171 |
| pi-chat | 326 | 239 |
| pi-codex-compact | 427 | 257 |
| pi-codex-imagegen | 325 | 336 |
| pi-context-management | 339 | 253 |
| pi-dotenv | 114 | 120 |
| pi-edit-scope | 263 | 264 |
| pi-file-context | 425 | 316 |
| pi-fleet | 436 | 317 |
| pi-github-pr | 152 | 136 |
| pi-goal | 488 | 312 |
| pi-herdr | 281 | 212 |
| pi-inspect | 397 | 233 |
| pi-langfuse | 303 | 229 |
| pi-lsp | 281 | 213 |
| pi-notes | 203 | 220 |
| pi-notify | 375 | 212 |
| pi-plan-mode | 504 | 347 |
| pi-progress | 291 | 234 |
| pi-recall | 177 | 141 |
| pi-stamp | 289 | 239 |
| pi-starship | 803 | 449 |
| pi-statusline | 365 | 212 |
| pi-subagents | 505 | 354 |
| pi-ticker | 197 | 155 |
| pi-tool | 177 | 151 |
| pi-typesafe | 191 | 196 |
| pi-typesafe-compact | 221 | 236 |
| pi-typesafe-search | 317 | 252 |
| pi-usage | 781 | 475 |
| pi-worktree | 264 | 217 |

Other candidates remain outside this batch. Usage's Settings UI can be deferred, but synchronous public normalizer exports pin other provider code. Starship's inactive collectors need separate parser/equality modules; synchronous configuration validation and rendering must remain intact. Subagents' attachment validation is another first-use candidate, but process entry URLs, tool definitions, and session ownership need their own tests. No optimization is claimed for these unchanged packages.

## Verification

Applicable guides: `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and `docs/runtime-builder.md`.

The semantic audit covers all new import awaits, eager registration and enforcement, shared generated chunks and exact relative import targets, cancellation, session replacement, shutdown draining, command overlap, loader failures, settings ordering, private-package release boundaries, and unchanged model-visible prefixes. No guide deviations were introduced. The supported terminal-text library entry is below Edit Scope's existing dependency floor; no dependency upgrade was required.

- `npm run check`: passed builds, Biome, package boundaries, and all workspace typechecks.
- `npm test`: 19,260 passed, 16 skipped; 898 test files passed, one skipped, and no unhandled errors.
- New source/eager graph tests: passed, including transitive shared generated chunks for pi-btw.
- Delayed-import tests: passed cancellation, replacement, shutdown draining, failed-load cleanup, overlap prevention, and first-use behavior.
- Existing UI suites: passed rendering, editor/paste, non-default keybindings, terminal handoff, settings persistence, and enforcement/prefix contracts.
- Jiti tests: passed the generated BTW default menu and the source Codex Imagegen default menu. Existing Edit Scope runtime tests exercise its menu/picker boundary.
- Real standalone Pi RPC smokes: passed each package's registration, startup, observable non-TUI rejection, and shutdown with isolated directories. No settings or workspace files were created, and no provider request was made. Edit Scope's existing TUI-only rejection is an expected `extension_error`, not an initialization failure.
- `npm run package:pack -- <name>` and actual temporary tarballs: inspected 50 BTW entries, 18 Codex Imagegen entries, and 19 Edit Scope entries. Required source modules, generated BTW chunks/maps, READMEs, changelogs, and licenses are present.
- `npm run changeset:status`: passed after separating private Edit Scope from the public-package Changeset. The prior pi-sync Changeset remains unchanged.
- Fenced-code-aware README audit: required headings passed for all 38 packages, and 21 local links passed for the three touched packages. Final whitespace audit passed.

Existing unrelated tooling notices remain: Biome reports its schema-version mismatch, and Changesets reports Edit Scope's Kit dependency floor. Both commands exit successfully.

Physical-terminal interaction, Windows-only paths, live-provider latency, and billed image generation were not exercised. These are not required to establish the measured startup changes; no native rendering, provider protocol, or platform path algorithm changed. No release approval is implied.
