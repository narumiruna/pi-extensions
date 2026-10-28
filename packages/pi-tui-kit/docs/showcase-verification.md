# Showcase, search, and copy verification

[Back to README](../README.md)

The repository showcase uses the local built Kit, not a separately installed demo package. All commands below run from the repository checkout root. Showcase scripts and fixtures are repository-only; they are not published with Kit.

## Implemented boundaries

The main menu uses Kit's existing searchable choice screen to filter demo names and descriptions. Every demo route remains available; search uses native Input editing and paste behavior.

Runtime information resolves the actual ESM export, checks function and API identity, and displays a sanitized real module origin plus its manifest version. The launcher builds before starting Pi; the extension loads Kit only when `/tui-kit-showcase` runs.

Secret input uses synthetic values and discards submitted payload references. Model and thinking selectors change only in-memory demo state, including save-default intent. Theme samples use callback roles, `theme.style()`, concrete colors, and appearance without changing host settings. Tasks have separate success, failure, and cancellation cases, with bounded timers and abort cleanup.

The copy gallery uses only an in-memory sink. Its first attempt fails deliberately; a repeated attempt succeeds. A bounded owned widget shows an ASCII JSON representation that retains source code units, including whitespace and hidden controls. Narrow displays explicitly mark clipping. Copy stays in the review or detail view and never approves its confirmation. No system clipboard is used.

Native pointer examples use Pi's normalized events and exact owned overlay handles. They do not replace the layout root, stop the parent terminal, or create another renderer. Regular mode leaves mouse handling to the terminal. These custom demos require reachable Ctrl+C cancellation: if Pi's fullscreen host owns that key, the affected demo warns and returns before mounting. Native overlay search-toggle ownership and replacement-view viewport ownership are tested separately; native bindings are not overridden.

## Verification record

Implementation verification on 2026-10-20 used the Pi peers declared in the repository manifests. The tests separate simulated render/input evidence from physical terminal acceptance.

| Boundary | Deterministic evidence |
| --- | --- |
| Local launch and Jiti | Launcher ordering, lazy loading, real resolved `dist/index.js` identity/API, masked input, return to menu, and mode rejection. |
| Inputs and selectors | Native editing/paste, current/default/selection markers, memory-only save intent, theme/resize retention, cancellation, replacement, and disposal. |
| Tasks and overlays | Controlled task clocks, timer release, retries, regular/fullscreen routing, handled/unhandled wheel, drag capture, exact completion, nested hard cancel, host-conflict admission, and unrelated-overlay preservation. |
| Copy | Full raw source and IDs, all three entry routes, independent confirmation, single flight, safe failure/retry, mutable document/action snapshots, preserved method receivers, abort/drain, and stale-feedback suppression. |
| Protocol | A real offline Pi RPC subprocess loads the fixture through Jiti, pages all three document routes, never exposes or invokes Copy, and does not start an agent/provider run. |
| Release boundary | Root/focused declaration consumers and actual published search artifacts; no independently installable consumer uses the new copy API. |

Root `npm run format`, `npm run check`, and the separate `npm test` gate passed. The full run passed 697 files and 12,050 tests with zero unhandled errors; one file and two tests remain skipped by existing gates. Fresh test emission and workspace typechecks passed. The fenced-code-aware heading audit passed all 35 package READMEs, and changed local documentation links resolve.

`npm run package:pack -- <name>` passed for `tui-kit`, `starship`, `recall`, and `tool`. Actual local tarballs were also created and inspected: their required licenses, entries, declarations, and docs are present, and repository scripts/tests are absent. Exact generated relative-import checks passed for all four tarballs. The extracted Kit's public review/testing exports completed an exact-source fake copy.

Real offline Pi CLI RPC processes loaded the three extracted extension package directories and the local showcase. Registration, representative lazy commands, Tool detail dialogs, cancellation, and shutdown passed without provider runs. The extracted consumers resolved the verified published search minimum rather than the workspace Kit. The dedicated copy protocol test separately paged standard review, standalone review, and browse detail with zero callback invocations or clipboard escapes.

Review followed the root and Kit instructions plus `extension-conventions.md`, `extension-settings.md`, and `readme-conventions.md`. The semantic audit covered correctness, raw/display security, source-bearing errors, mutable snapshots, owner/session revalidation after awaits, cancellation/disposal/draining, native key/overlay priority, API compatibility, modes, package boundaries, regressions, and scope. Settings reads/writes, destructive Recall routes, and model-visible prompt/tool prefixes are unchanged. Independent review identified the native hard-cancel conflict; admission guards and native tests now prevent mounting those custom demos with an unreachable Ctrl+C. No required agent check remains failing or waived.

### Published search artifacts

The search consumers resolve the published Kit minimum recorded in their manifests and lockfile. Workspace hoisting is not the proof. Actual npm artifacts `0.60.0` and `0.65.6` each passed 16 compatibility cases through native regular/fullscreen input, text/code/browse search, two-match next/previous navigation, editing/paste, wrapped literal matches, query/selection restoration, raw identity/content, RPC pagination, and print/JSON rejection. Artifact `0.59.0` failed search activation as an intentional negative control.

The packed `0.60.0` SHA-512 matched npm metadata:

```text
sha512-2QGXp9Od4HzkytCh74K+N9C5BNIhRDifx3gEGQldDjjgRrR4W7SWU3H6e6gxAc5JOUtF2uv1pePRL5buJGrydA==
```

To reproduce, pack and extract the selected published version into a temporary directory, then run:

```bash
node packages/pi-tui-kit/scripts/published-search-smoke.mjs /tmp/kit-search-proof/package
```

Prepare dependencies in the temporary parent, not in the artifact or installed `node_modules`; the implementation check used a parent dependency link and read-only extracted files. Verify tarball integrity against npm metadata first. The script rejects the workspace path and imports only public artifact exports. Published artifacts do not contain later workspace host-hint filtering; the compatibility evidence does not claim that separate enhancement.

### Native input-pipeline frame captures

These are component-frame captures after input passed through Pi's real in-memory renderers. ANSI styling is removed; trailing spaces are not visible here. They are not terminal screenshots, protocol-negotiation evidence, or clipboard acceptance. Tests compare callback payloads directly rather than reconstructing them from these frames.

A 52-column, 20-row review produced the same frame in regular and fullscreen modes after the fake copy callback completed:

```text
────────────────────────────────────────────────────
Full source — fake copy

demo = "synthetic"
    keep = true
last row

↑/↓ navigate • esc back • ctrl+c close · space
search · Copied · ctrl+x Capture raw source
────────────────────────────────────────────────────
```

A fullscreen native overlay in a 60-column, 24-row host recorded this normalized click; its 90% overlay width intentionally clips secondary text:

```text
──────────────────────────────────────────────────────
Native pointer / wheel / overlay routing
Fullscreen: normalized pointer events. Regular: termin
Press/click here; drag beyond the overlay to inspect n
click root
local=2,3 screen=5,7
button=left shift=false alt=false ctrl=false
handled=true capture=false focus=false

> Wheel handling: handled (blocks fallback)
  Open nested native overlay
  Close native demo
Configured select up/down: choose; confirm: activate;
Ctrl+C: close all demo overlays, including under neste
──────────────────────────────────────────────────────
```

## Physical terminal handoff

**Responsible role:** maintainer or tester with the target terminal/client. **Prerequisite:** a local build and passing deterministic checks; use synthetic data only. **Action:** perform the steps below. **Expected result:** correct focus, native input ownership, bounded layout, and complete source capture. **Unverified behavior:** hardware cursor, IME placement, terminal negotiation, subjective colors, OS clipboard access, and remote OSC 52 acceptance. **Restriction:** simulated output does not establish physical acceptance; automated checks must not overwrite a real clipboard.

1. Run `npm run showcase:tui-kit`, then `/tui-kit-showcase` without arguments. Type `built module origin` to find Runtime information by its description; open it and confirm the origin belongs to this checkout's built Kit. Return to the menu, test a query with no matches, then clear the query and verify that the entries return.
2. Exercise secret masking, editable prefill, selector search/current/default markers, save-default intent, task success/failure/cancellation, and menu return; verify that no real model or settings changed.
3. Inspect theme samples; close the view before manually changing Pi's Theme or Show hardware cursor setting. Reopen input examples with hardware cursor off and on, test IME composition and narrow resize, then restore the host settings.
4. In fullscreen mode, test pointer press/click/drag, handled and unhandled wheel, nested overlay completion, Ctrl+C, and an unrelated overlay. To compare regular mode after building, run `pi --no-extensions --no-skills --no-session --tui-mode regular -e ./packages/pi-tui-kit/scripts/showcase/extension.ts`.
5. Inspect all three in-memory copy routes. Confirm first failure, retry, repeated capture, exact ASCII JSON including CRLF/tabs/trailing spaces/controls, unchanged confirmation, and widget removal after exit or replacement. No OS clipboard result is implied.

Native clipboard acceptance requires a separately and explicitly invoked temporary consumer adapter using Pi's public `copyToClipboard()` helper. Test synthetic content locally and remotely where supported; verify unavailable-backend feedback. Native writes can complete after cancellation and cannot be undone by Kit. Do not request credentials, claim secure erasure, or promise restoration of previous clipboard contents.

## Publication and consumer-copy handoff

**Responsible role:** repository maintainer. **Prerequisite:** passing gates, Changesets, explicit publication approval, and registry visibility. **Action:** use the established release workflow, then authorize a separate Starship/Tool copy adoption and any later Recall adoption. **Expected result:** independently installed consumers resolve the published API and provide precise source labels, sensitivity policy, and transport. **Unverified behavior:** future registry installation and real consumer clipboard integration. **Restriction:** this implementation does not authorize package publication, tags, visibility changes, or release dispatch; do not require the unpublished copy API in consumer manifests or imports.

The admitted consumer contracts are Starship raw/effective TOML and Tool exact schemas. Their published packages remain on the already-published search contract here. Kit owns interaction and draining only; clipboard transport, domain confirmation, persistence, validation, and session ownership remain consumer responsibilities.

Before publication, a failed slice can be reverted with only its intended lockfile changes. After publication, retain exported signatures and correct regressions through a forward release. No settings or credential migration is required, and a completed external clipboard write cannot be rolled back by Kit.
