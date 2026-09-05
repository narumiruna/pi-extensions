# 🧭 Pi TUI Kit — Build Consistent Pi Extension Interfaces

[![npm](https://img.shields.io/npm/v/@narumitw/pi-tui-kit)](https://www.npmjs.com/package/@narumitw/pi-tui-kit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Pi TUI Kit provides typed menus and interactions for independently installable [Pi](https://pi.dev) extensions.
It supplies declarative screens, standalone interactions, terminal-display helpers, and interaction lifecycle ownership.
Consumers reuse its navigation, rendering, cancellation, and mode adaptation instead of rebuilding them.

## ✨ Features

- Defines typed action, detail, browse, choice, settings, input, review, and multi-select screens.
- Adapts shared menu and interaction flows across Pi TUI and RPC modes.
- Handles interaction navigation, cancellation, disposal, horizontal framing, and width-safe rendering.
- Provides task, confirmation, questionnaire, live-choice, custom-interaction, terminal-document, terminal-text, interaction-hint, editor-status-widget, horizontal-rule, and testing helpers.
- Publishes built ESM and TypeScript declarations for independently installable extensions.

## 📦 Install

Install the library as a runtime dependency of the consuming extension package:

```bash
npm install @narumitw/pi-tui-kit
```

The published package contains built ESM and declarations in `dist/`; consumers do not need a TypeScript loader for dependencies.
The package root remains the supported entrypoint for menus and interaction runners.
When startup does not need the full Kit runtime, import a lightweight display-helper subpath.
The available subpaths are `editor-status-widget`, `terminal-document`, `terminal-text`, and `interaction-hints` under `@narumitw/pi-tui-kit`.

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
Publish a new Kit API before raising a consumer's compatibility floor.
Declare Kit in that consumer so local hoisting cannot hide an incompatible or missing published dependency.

Searchable review and browse-detail screens use an explicit pre-adoption API-admission exception.
Review behavior converges in `pi-starship` configuration documents and `pi-recall` saved-message previews, while browse-detail behavior converges in `pi-tool` exact tool documents and `pi-analytics` detail catalogs.
Those consumers cannot adopt the fields until this Kit minor is published, so this release keeps their compatibility floors unchanged and defers consumer migration.

## ⚡ Runtime performance

The production JavaScript imports Pi TUI at runtime and keeps Pi Coding Agent imports type-only.
This avoids evaluating a second coding-agent runtime when a source-loaded extension first opens its menu.
Borders and task loaders use public Pi TUI primitives with the theme and keybindings from the active UI callback.
Code review loads the complete declared syntax highlighter synchronously on first use and applies that callback theme.
Root imports, ordinary menus, task frames, and Markdown-only reviews do not load the highlighter.
Mermaid rendering loads its declared renderer only before the first screen with an enabled Mermaid fence.

The `editor-status-widget`, `terminal-document`, `terminal-text`, and `interaction-hints` subpaths expose focused ESM and declaration graphs.
The package root retains every existing export for compatibility.

Repository maintainers can benchmark cold root and lightweight-subpath imports plus first action, code-review, Mermaid, and task frames in fresh serial processes:

```bash
npm run build --workspace @narumitw/pi-tui-kit
node scripts/benchmark-tui-kit-runtime.mjs --runs 5
```

The benchmark reports medians, median absolute deviations, resolved package URLs, syntax-color evidence, and graph-presence flags.
These fields reveal dependencies deferred from import time to the first interaction.

## 📚 API guide

The [API reference](./docs/api.md) contains the complete examples and contracts:

- [Menus and standalone interactions](./docs/api.md#-complete-menu-example) — typed actions, tasks, confirmations, live previews, questionnaires, and custom components.
- [Standard screens](./docs/api.md#-standard-screens) — actions, detail, browse, choice, settings, input, review, and multi-select.
- [Runtime and modes](./docs/api.md#-runtime-and-mode-behavior) — TUI/RPC adaptation, result types, cancellation, and session ownership.
- [Ownership boundary](./docs/api.md#-ownership-boundary) — what Kit owns and what each extension must keep local.
- [Testing](./docs/api.md#-supported-testing-entrypoint) — the public `/testing` subpath and TUI/RPC harnesses.
- [Public exports and compatibility history](./docs/api.md#-public-api) — helpers, types, lightweight subpaths, and API-version changes.
- [Horizontal rules](./docs/api.md#-horizontal-rules) and [editor status widgets](./docs/api.md#-editor-status-widgets) — passive, width-safe presentation components.

The consuming extension owns domain state, persistence, confirmations, and session signals.
Abort owned work on replacement or shutdown, honor each supplied signal, and revalidate mutable state after every `await`.
Keep raw action payloads separate from sanitized terminal display text.
Kit's UI lifecycle handling does not replace those responsibilities.

## 🗂️ Package layout

```text
packages/pi-tui-kit/
├── src/                               # Authored TypeScript and public API
│   ├── index.ts                       # Public library exports
│   ├── components/                    # Internal TUI adapters
│   └── testing/                       # Public test-only drivers
├── dist/                              # Published ESM and TypeScript declarations
├── scripts/build.mjs                  # Library builder
├── docs/                              # Published reference documentation
└── test/                              # Behavior and lifecycle coverage
```

## 🔎 Keywords

Pi library, Pi extension development, terminal UI, declarative menus, lifecycle-safe interactions, TypeScript.

## 📄 License

[MIT](./LICENSE) © narumiruna
