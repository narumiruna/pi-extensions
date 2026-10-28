# 🧭 Pi TUI Kit — Build Consistent Pi Extension Interfaces

[![npm](https://img.shields.io/npm/v/@narumitw/pi-tui-kit)](https://www.npmjs.com/package/@narumitw/pi-tui-kit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Pi TUI Kit provides typed menus and interactions for independently installable [Pi](https://pi.dev) extensions.
It supplies declarative screens, standalone interactions, terminal-display helpers, and interaction lifecycle ownership.
Consumers reuse its navigation, rendering, cancellation, and mode adaptation instead of rebuilding them.

## ✨ Features

- Defines typed action, detail, browse, choice, settings, input, review, and multi-select screens with keyboard and mouse routing.
- Provides searchable default-aware selectors for model and thinking choices, with configurable save-default actions (Ctrl+S by default).
- Adds opt-in live-choice search, editable input prefill, one-for-one intraline diff emphasis, and masked TUI secret entry.
- Adapts shared menu and interaction flows across Pi TUI and RPC modes without using plaintext fallback for secrets.
- Handles interaction navigation, cancellation, disposal, horizontal framing, and width-safe rendering.
- Provides standalone document review, multi-select, task, confirmation, questionnaire, live-choice, secret-input, and custom-interaction helpers.
- Adds opt-in full-source Copy to review and exact browse-detail views without closing or confirming them.
- Provides focused Mermaid Markdown, terminal-document, terminal-text, interaction-hint, editor-status-widget, horizontal-rule, and testing helpers.
- Exposes bounded-frame row mappings and configured-key canonicalization without taking over native input routing.
- Publishes built ESM and TypeScript declarations for independently installable extensions.

## 📦 Install

Install the library as a runtime dependency of the consuming extension package:

```bash
npm install @narumitw/pi-tui-kit
```

The published package contains built ESM and declarations in `dist/`; consumers do not need a TypeScript loader for dependencies.
The package root remains the supported entrypoint for menus and interaction runners.
When startup does not need the full Kit runtime, import a focused subpath.
The interaction subpaths are `confirmation`, `custom-interaction`, `document-review`, `live-choice`, `multi-select`, `questionnaire`, `selectors`, and `task` under `@narumitw/pi-tui-kit`.
Display and testing subpaths are `editor-status-widget`, `interaction-hints`, `markdown`, `terminal-document`, `terminal-text`, and `testing`.

## 🚀 Quick start

Define a typed screen and let Pi TUI Kit own its navigation and mode adaptation:

```ts
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

const menu = defineMenu<undefined, "main", "unused">({
  start: "main",
  screens: {
    main: () => ({
      kind: "detail",
      title: "Example extension",
      lines: ["Ready"],
      hint: "close",
    }),
  },
  actions: { unused: async () => ({ kind: "stay" }) },
});

export function showMenu(ctx: ExtensionCommandContext) {
  return runMenu(ctx, menu, { getState: () => undefined });
}
```

## 🔗 Compatibility

Pi TUI Kit is a zero-major package, so caret ranges stop at the next minor release.
For example, `^0.40.0` accepts `0.40.0` and later patch releases but not `0.41.0`.
When an extension adopts an API from a later Kit minor, raise that extension's minimum compatible minor instead of using a broad `<1` range.
Otherwise an existing npm lock can retain an older Kit that lacks the required screen or contract.

Each consumer owns its compatibility range.
Review the APIs each extension imports and keep its tested minimum instead of synchronizing every consumer with the current Kit version.
Pi TUI Kit and its consumers version independently through Changesets.
A new Kit API and its consumers can share a Version PR only when Kit publishes first and its exact registry artifact is verified before dependent publication; otherwise release Kit before consumer adoption.
Declare Kit in that consumer so local hoisting cannot hide an incompatible or missing published dependency.

The default-aware selectors use an explicit API-admission exception for two convergent selection flows requested by the maintainer. Consumer migrations remain deferred, and each consumer retains default-setting persistence.

Starship configuration reviews, Recall's non-destructive saved-message preview, and Tool's exact detail documents use the already-published document-search contract. Analytics migration remains separate.

Optional full-source Copy has two convergent consumer contracts: Starship raw/effective TOML and Tool exact schemas. This change prepares the Kit API and repository-only demo without migrating independently installable consumers to the unpublished copy API. Publish Kit before a later consumer-copy adoption.

Masked secret entry uses the same pre-adoption exception for Sync's required credentials and Langfuse's optional blank-to-keep key flow.
The shared API owns only a masked TUI draft and typed lifecycle result; credential validation, storage, and setup policy remain consumer-owned.
RPC has no masked input field, so `runSecretInput()` returns `unsupported` without opening `ctx.ui.input()`.
Sync now adopts the published control while retaining its credential policy and unfinished-paste hard cancellation. Langfuse remains unchanged; its migration must explicitly resolve the existing plaintext RPC setup behavior.

The public Mermaid Markdown transformer uses the same pre-adoption rule for `pi-btw` side-thread transcripts.
This release exposes and verifies the Kit API without changing that extension; `pi-btw` can raise its Kit floor only after this API is published.

Standalone document review and multi-select are maintainer-requested pre-adoption APIs over existing standard-screen behavior.
They add lifecycle and mode adapters without exposing component factories; this release does not migrate consumers or move domain state and persistence into Kit.

Progress and Subagents use published frame row metadata; Notes and Ticker share configured-key syntax without sharing input policy. Usage uses Kit interaction ownership while retaining its native settings and save queue.
The [consumer consolidation audit](./docs/ui-consolidation-audit.md) records compatibility, registry evidence, verification, and the blocked BTW migration. Protocol-overlap, global shortcut availability, and a second paste parser remain deferred.
The [native alignment audit](./docs/core-alignment-audit.md#shared-helper-alignment) records the original API decisions.

Kit screens follow Pi's fullscreen input ownership rather than replacing its transcript controls.
See [Fullscreen input and custom UI limits](./docs/api.md#fullscreen-input-and-custom-ui-limits) for paging, overlay focus, and program-status constraints.
The [selector and host-input audit](./docs/core-alignment-audit.md) records corrections, retained contracts, native-renderer tests, and unverified terminal paths.

## ⚡ Runtime performance

The production JavaScript imports Pi TUI at runtime and keeps Pi Coding Agent imports type-only.
This avoids evaluating a second coding-agent runtime when a source-loaded extension first opens its menu.
Borders and task loaders use public Pi TUI primitives with the theme and keybindings from the active UI callback.
Code review loads the complete declared syntax highlighter synchronously on first use and applies that callback theme.
Root imports, ordinary menus, task frames, and Markdown-only reviews do not load the highlighter.
Mermaid rendering loads its declared renderer only before the first screen or public transformer preparation with an enabled top-level Mermaid fence.
The `/markdown` module itself does not load `grok-mermaid`; consumers await preparation, revalidate ownership, and then create a synchronous transformer.

Every documented interaction, display, and testing subpath exposes a focused ESM and declaration graph.
The package root retains every existing export for compatibility.

Repository maintainers can benchmark cold root and focused-subpath imports plus first action, code-review, Mermaid, and task frames in fresh serial processes:

```bash
npm run build --workspace @narumitw/pi-tui-kit
npm run benchmark:tui-kit-runtime -- --runs 5
```

The benchmark reports medians, median absolute deviations, resolved package URLs, syntax-color evidence, and graph-presence flags.
Each interaction subpath scenario fails if its cold import reaches the package root, menu runtime, or an unrelated heavy component or dependency graph.

## 📚 API guide

The opt-in [`createFullscreenHandoff()` resource](./docs/fullscreen-handoff.md) shares physical terminal lifecycle, not input or domain state. Its contract record includes both consumer proofs, release guards, and physical-terminal limits. Ordinary menus and `runCustomInteraction()` are unchanged.

The [API reference](./docs/api.md) contains the complete examples and contracts:

- [Menus and standalone interactions](./docs/api.md#-complete-menu-example) — typed actions, document reviews, multi-selects, tasks, confirmations, live previews, masked secrets, questionnaires, and custom components.
- [Default-aware selectors](./docs/api.md#searchable-default-aware-selectors) — searchable choices with current/default state and save-default shortcuts.
- [Standard screens](./docs/api.md#-standard-screens) — actions, detail, browse, choice, settings, input, review, and multi-select.
- [Responsive list presentation](./docs/responsive-lists-uiux.md) — UI/UX findings, Codex visual proposal, before/after frames, and verification.
- [Full-source document copy](./docs/api.md#full-source-document-copy) — explicit owner callbacks, raw-source safety, key priority, draining, and TUI-only behavior.
- [Runtime and modes](./docs/api.md#-runtime-and-mode-behavior) — TUI/RPC adaptation, result types, cancellation, and session ownership.
- [Ownership boundary](./docs/api.md#-ownership-boundary) — what Kit owns and what each extension must keep local.
- [Testing](./docs/api.md#-supported-testing-entrypoint) — the public `/testing` subpath and TUI/RPC harnesses.
- [Mermaid Markdown transformers](./docs/api.md#mermaid-markdown-transformers) — lazy preparation, final-message transformation, fallback behavior, and lifecycle ownership.
- [Public exports and compatibility history](./docs/api.md#-public-api) — helpers, types, focused subpaths, and API-version changes.
- [Horizontal rules](./docs/api.md#-horizontal-rules) and [editor status widgets](./docs/api.md#-editor-status-widgets) — passive, width-safe presentation components.
- [Editor status presentation](./docs/editor-status-presentation.md) — optional stable snapshot publication, explicit view controls, and bounded consumer-local items without taking over Pi's layout.
- [Editor status presentation](./docs/editor-status-presentation.md) — stable snapshots, session-local view controls, and bounded item collections with consumer-owned policy.
- [Bounded frames](./docs/api.md#bounded-frames) and [configured keys](./docs/api.md#configured-keys) — row mappings and key syntax helpers with caller-owned input policy.

The consuming extension owns domain state, persistence, confirmations, and session signals.
Abort owned work on replacement or shutdown, honor each supplied signal, and revalidate mutable state after every `await`.
Keep raw action payloads separate from sanitized terminal display text.
Opt-in Copy sends the original full source, which can include sensitive text or controls hidden by the preview; the consumer must supply its sensitivity policy and transport. Kit has no clipboard backend, and non-TUI modes never invoke Copy.
Kit's UI lifecycle handling does not replace those responsibilities.

## 🧪 Local showcase

From the repository root, build Kit and start Pi with the local demo extension:

```bash
npm run showcase:tui-kit
```

You can also run `node packages/pi-tui-kit/scripts/showcase.mjs` directly.
Both commands build Kit before starting Pi with automatic extension and skill loading disabled and session persistence off.
Pi must be available on `PATH`; the launcher loads only the trusted repository demo, which runs with Pi's permissions.

In Pi TUI mode, run `/tui-kit-showcase` without arguments to preview action, detail, browse, choice, settings, input, review, and multi-select screens.
Type in the main menu to filter demo names and descriptions; spaces are part of the query. Use the configured confirm key (Enter by default) to open a matching demo, or clear the search text to show all entries.
The menu also includes masked synthetic input, editable prefill, model/thinking selectors, theme/style samples, bounded task success/failure/cancellation, native pointer/overlay routing, and in-memory copy capture. It reopens after each standalone interaction. Runtime information identifies the local built Kit version, API version, and sanitized resolved module origin.
All demo state stays in memory and resets on each command or session replacement. Save-default selector intent changes only demo state; no Pi settings or real session model changes occur. Enter only synthetic values in secret examples.
The copy demo deliberately fails its first attempt, then captures exact synthetic source in memory; it never writes the system clipboard. Native examples do not replace Pi's renderer or layout. See the [showcase verification and release handoff](./docs/showcase-verification.md) for evidence, physical terminal steps, and unverified paths.
RPC reports that TUI mode is required, while print and JSON modes reject the command without ad hoc output.
The demo loads Kit only when the command runs and is not registered in the repository's default extension set.

The launcher and demo source are repository-only files, not part of the published library.

## 🗂️ Package layout

```text
packages/pi-tui-kit/
├── src/                               # Authored TypeScript and public API
│   ├── index.ts                       # Public library exports
│   ├── components/                    # Internal TUI adapters
│   └── testing/                       # Public test-only drivers
├── dist/                              # Published ESM and TypeScript declarations
├── scripts/                           # Library builder and repository-only showcase
├── docs/                              # Published reference documentation
└── test/                              # Behavior and lifecycle coverage
```

## 🔎 Keywords

Pi library, Pi extension development, terminal UI, declarative menus, lifecycle-safe interactions, TypeScript.

## 📄 License

[MIT](./LICENSE) © narumiruna
