# 🧭 Pi TUI Kit

[![npm](https://img.shields.io/npm/v/@narumitw/pi-tui-kit)](https://www.npmjs.com/package/@narumitw/pi-tui-kit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Reusable navigation helpers and typed, declarative interaction flows for independently installable
[Pi](https://pi.dev) extensions, built on
[`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). The initial
high-level API lets extensions describe menu screens and domain actions while this package owns
standard rendering, navigation, mode adaptation, cancellation, and lifecycle behavior.

## 📦 Install

Add the library as a runtime dependency of the extension package:

```bash
npm install @narumitw/pi-tui-kit
```

The published package contains built ESM and declarations in `dist/`; consumers do not need a
TypeScript loader for dependencies.

## 🚀 Example

```ts
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

type Screen = "main" | "settings";
type Action = "refresh" | "setMode";
interface State {
  mode: "Safe" | "Fast";
}

declare function refreshDomainState(signal: AbortSignal): Promise<void>;
declare function saveMode(mode: State["mode"], signal: AbortSignal): Promise<void>;
declare function loadState(signal: AbortSignal): Promise<State>;
declare function currentGeneration(): number;
declare function formatError(error: unknown): string;

const menu = defineMenu<State, Screen, Action>({
  start: "main",
  screens: {
    main: ({ state }) => ({
      kind: "actions",
      title: "Example extension",
      lines: [`Current mode: ${state.mode}`],
      items: [
        { id: "refresh", label: "Refresh", action: "refresh", busyLabel: "Refreshing" },
        { id: "settings", label: "Settings", to: "settings" },
        { id: "close", label: "Close", close: true },
      ],
      hint: "close",
    }),
    settings: ({ state }) => ({
      kind: "settings",
      title: "Settings",
      items: [
        {
          id: "mode",
          label: "Mode",
          currentValue: state.mode,
          values: ["Safe", "Fast"],
          action: "setMode",
        },
      ],
    }),
  },
  actions: {
    refresh: async ({ signal }) => {
      await refreshDomainState(signal);
      return { kind: "stay" };
    },
    setMode: async ({ value, signal }) => {
      await saveMode(value === "Fast" ? "Fast" : "Safe", signal);
      return { kind: "stay" };
    },
  },
});

export async function showMenu(ctx: ExtensionCommandContext, generation: number) {
  return runMenu(ctx, menu, {
    getState: ({ signal }) => loadState(signal),
    signal: currentSessionSignal(),
    isCurrent: () => generation === currentGeneration(),
    onError: (_ctx, error) => ctx.ui.notify(formatError(error), "error"),
    onUnsupportedMode: (_ctx, mode) => {
      ctx.ui.notify(`The menu is unavailable in ${mode} mode.`, "warning");
    },
  });
}
```

The state loader runs again whenever a screen is entered or refreshed, so screen factories can
remain pure projections of current extension state.

## 🖥️ Standard screens

`defineMenu()` supports four standard screen kinds:

- **`actions`** — navigation targets, domain actions, close rows, and optional cancellable busy
  labels.
- **`detail`** — read-only wrapped text with Back or Close behavior.
- **`settings`** — immediate value changes with serialized saves and rollback when an action rejects.
- **`multiSelect`** — optimistic toggles with stable cursor restoration, serialized saves, rollback,
  and optional bulk action rows.

All standard TUI screens use Pi's injected keybindings, sanitize display text, rebuild themed
content after invalidation, and bound rendered output to the supplied terminal width. Escape follows
the screen's Back/Close hint; `Ctrl+C` closes the menu.

Action handlers return one of these results:

```ts
{ kind: "stay" }
{ kind: "back" }
{ kind: "close" }
{ kind: "to", screen: "another-screen" }
{ kind: "rejected", error?: unknown }
```

A rejected settings or multi-select action restores the last accepted value. Throwing has the same
recovery behavior and is routed through `onError`.

## 🔌 Runtime and mode behavior

`runMenu()` accepts Pi's `ExtensionCommandContext`, a definition, and runtime options:

- `getState({ ctx, signal })` loads extension-owned state.
- `signal` aborts state loads and actions immediately when the owning session is replaced or shut down.
- `isCurrent()` prevents stale continuations after session replacement or shutdown.
- `onError(ctx, error)` customizes observable failure reporting.
- `onUnsupportedMode(ctx, mode)` provides print/JSON fallback behavior.

In TUI mode the runtime uses `ctx.ui.custom()`. In RPC mode it adapts standard screens to
`ctx.ui.select()` dialogs. Print and JSON modes never attempt custom UI and instead call the
unsupported-mode hook. `runMenu()` resolves to `closed`, `unsupported`, `stale`, or `error`.

## 🧩 Ownership boundary

The library owns:

- width-safe standard rendering and injected keybindings;
- screen-stack navigation, Back/Close semantics, and per-screen cursor memory;
- serial settings and multi-select updates, optimistic rollback, and pending-update draining;
- menu, screen, and busy-action cancellation;
- stale-continuation checks around asynchronous work;
- TUI/RPC adaptation and unsupported-mode routing.

The consuming extension still owns:

- domain state, tool activation, commands, and settings schemas;
- transactional persistence and preservation of unknown settings fields;
- confirmations and product-specific copy;
- session generation and shutdown policy supplied through `isCurrent()`;
- specialized editors, previews, forms, or other custom TUI.

Keep specialized UI local rather than adding package hooks that expose Pi TUI internals.

## 📚 Public API

- `defineMenu()` — validates and returns a typed menu definition.
- `runMenu()` — runs the definition in the current Pi mode.
- `resolveMenuScreen()` — resolves and validates a dynamic screen for tests or adapters.
- `createMenuNavigator()` — lower-level stack and selection state helper.
- exported screen, action, transition, runtime option, and result types.
- `PI_EXTENSION_MENU_API_VERSION` — current declarative API version (`1`).

## 🗂️ Package layout

- `src/` — authored TypeScript
- `dist/` — generated ESM and declarations included in the npm package
- `test/` — contract, renderer, navigation, and lifecycle coverage

## 📄 License

MIT © narumiruna
