# 🧭 Pi TUI Kit — Build Consistent Pi Extension Interfaces

[![npm](https://img.shields.io/npm/v/@narumitw/pi-tui-kit)](https://www.npmjs.com/package/@narumitw/pi-tui-kit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Build consistent typed menus and interactions for independently installable [Pi](https://pi.dev) extensions without reimplementing navigation, rendering, cancellation, or mode adaptation.

Pi TUI Kit provides declarative screens, standalone task and confirmation flows, live choices, terminal-text helpers, and lifecycle ownership for specialized components.

## ✨ Features

- Defines typed action, detail, settings, choice, review, multi-select, and document screens.
- Adapts shared flows across Pi TUI and RPC modes.
- Owns standard navigation, cancellation, disposal, lifecycle, consistent horizontal framing, and width-safe rendering.
- Provides focused task, confirmation, live-choice, custom-interaction, terminal-text, hint, horizontal-rule, and testing helpers.
- Publishes built ESM and TypeScript declarations for independently installable extensions.

## 📦 Install

Add the library as a runtime dependency of the extension package:

```bash
npm install @narumitw/pi-tui-kit
```

The published package contains built ESM and declarations in `dist/`; consumers do not need a TypeScript loader for dependencies.

The package root remains the supported entrypoint for menus and interaction runners.
Import lightweight display helpers from `@narumitw/pi-tui-kit/terminal-text` or `@narumitw/pi-tui-kit/interaction-hints` when a startup path does not otherwise need the full Kit runtime.

### Compatibility floor

Pi TUI Kit is still a zero-major package, so caret ranges are minor-bounded: for example, `^0.40.0` accepts releases from `0.40.0` up to, but not including, `0.41.0`.
When an extension adopts an API introduced in a later Kit minor, raise that extension's minimum compatible minor rather than using a broad `<1` range.
Otherwise an existing npm lock can retain an older Kit that lacks the screen or contract the extension expects.

Compatibility ranges are consumer-owned.
Review each extension against the APIs it imports and keep its tested minimum; do not automatically synchronize every consumer range with the current Kit version.
Pi TUI Kit and its consumers version independently through Changesets.
Publish a new Kit API before raising a consumer's compatibility floor to use it, and declare the dependency in the consuming package so local hoisting cannot hide an incompatible or missing published dependency.

## ⚡ Runtime performance

The Kit's production JavaScript imports Pi TUI at runtime but keeps Pi Coding Agent imports type-only.
This prevents a source-loaded extension from evaluating a second heavyweight coding-agent runtime when its menu first opens.
Borders and task loaders compose public Pi TUI primitives with the theme and keybindings supplied by the active UI callback.
Review syntax coloring synchronously loads the Kit's complete declared highlighter dependency on first use and applies the same callback theme.
Root imports, ordinary menus, task frames, and Markdown-only reviews do not evaluate that highlighter.
Mermaid rendering lazy-loads its declared renderer only before the first screen containing an enabled Mermaid fence.

The `terminal-text` and `interaction-hints` subpaths expose only their focused ESM and declaration graphs, while the package root keeps every existing export for compatibility.

Repository maintainers can measure cold root and lightweight-subpath imports plus first actions, code-review, Mermaid, and task frames in fresh serial processes:

```bash
npm run build --workspace @narumitw/pi-tui-kit
node scripts/benchmark-tui-kit-runtime.mjs --runs 5
```

The benchmark reports medians, median absolute deviations, resolved package URLs, syntax-color evidence, and graph-presence flags so a fast import cannot hide the same dependency cost in the first interaction.

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

## ➖ Horizontal rules

Use `HorizontalRule` as a width-safe divider in custom components and Kit-adjacent widgets.
Every standard Kit TUI screen uses its full-width themed form above and below the screen content.
It fills the supplied width by default, supports symmetric `paddingX`, and can render a sanitized label aligned left, center, or right.
Pass the active callback theme through render-time style functions instead of pre-baking terminal colors.
Style functions must preserve the displayed text and its terminal-cell width.

```ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HorizontalRule } from "@narumitw/pi-tui-kit";

export function createPreviewDivider(theme: Pick<Theme, "fg">) {
  return new HorizontalRule({
    label: "Preview",
    labelAlignment: "left",
    paddingX: 1,
    ruleStyle: (text) => theme.fg("borderMuted", text),
    labelStyle: (text) => theme.fg("muted", text),
  });
}
```

Long and wide-character labels truncate by terminal cells on narrow renders.
Terminal and bidirectional controls are removed from labels at the display boundary.
When the available width cannot preserve the requested padding, the component reduces the inset to keep one rule cell visible.

## 🧭 Complete menu example

```ts
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, type MenuCloseReason, runMenu } from "@narumitw/pi-tui-kit";

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
  const result = await runMenu(ctx, menu, {
    getState: ({ signal }) => loadState(signal),
    signal: currentSessionSignal(),
    isCurrent: () => generation === currentGeneration(),
    onError: (_ctx, error) => ctx.ui.notify(formatError(error), "error"),
    onUnsupportedMode: (_ctx, mode) => {
      ctx.ui.notify(`The menu is unavailable in ${mode} mode.`, "warning");
    },
  });
  if (result.kind === "closed") {
    const reason: MenuCloseReason = result.reason;
    if (reason === "back") ctx.ui.notify("Returned from the root menu", "info");
  }
  return result;
}
```

The state loader runs again whenever a screen is entered or refreshed, so screen factories can remain pure projections of current extension state.
An ordinary terminal result is `{ kind: "closed", reason: "back" | "close" }`: root Back reports `back`; Ctrl+C, a Close hint, a close row, or an accepted action that returns Close reports `close`.
Nested Back remains inside the menu.
RPC preserves each adapter's existing transition: a generic cancelled selector applies Back, while input and review cancellation follow their declared hint.
Owner replacement remains `stale` and takes precedence over any racing Close event.

For abort-aware work outside a menu, use `runTask()`.
TUI mode shows the Kit's Pi-styled cancellable bordered loader; RPC, print, and JSON execute the same task directly.
The effective cancellation bindings are shown in the loader, and Ctrl+C remains a hard-cancel input when those bindings are remapped.
User cancellation, owner replacement, external component disposal, errors, and successful completion remain distinct typed results.

```ts
import { runTask } from "@narumitw/pi-tui-kit";

const result = await runTask(ctx, {
  label: "Refreshing domain state…",
  signal: currentSessionSignal(),
  isCurrent: () => generation === currentGeneration(),
  task: ({ signal }) => refreshDomainState(signal),
  onError: (_ctx, error) => ctx.ui.notify(formatError(error), "error"),
});

if (result.kind === "completed") ctx.ui.notify("Refreshed", "info");
```

A task must honor its supplied signal.
The runner aborts and drains owned work before returning; it does not hide an uncooperative task behind an arbitrary timeout.

For a confirmation nested inside a larger flow, use `runConfirmation()` when Escape must return to the caller while Ctrl+C closes the whole TUI interaction:

```ts
import { runConfirmation } from "@narumitw/pi-tui-kit";

const confirmation = await runConfirmation(ctx, {
  title: "Delete local data?",
  message: "This cannot be undone.",
  confirmLabel: "Delete",
  cancelLabel: "Keep data",
  signal: currentSessionSignal(),
  isCurrent: () => generation === currentGeneration(),
  onError: (_ctx, error) => ctx.ui.notify(formatError(error), "error"),
});

if (confirmation.kind === "confirmed") await deleteDomainData();
else if (confirmation.kind === "closed" && confirmation.reason === "close") return;
```

TUI confirmation uses the standard bounded actions presentation: selecting the cancel row or pressing Escape returns `{ kind: "closed", reason: "back" }`, while Ctrl+C returns the same result with reason `"close"`.
RPC uses one signal-aware `select()` request with explicit confirm and cancel rows.
Explicit cancel and protocol cancellation deterministically map to Back because Pi RPC does not expose a separate Ctrl+C dialog outcome.
Print and JSON return `unsupported`.
Owner abort, session replacement, external TUI disposal, and failures remain distinct `stale` or `error` results.
The Kit owns only this interaction lifecycle—the caller performs every confirmed side effect and must abort its owner signal on replacement or shutdown.

For a choice whose cursor drives an extension-owned preview, use `runLiveChoice()` instead of making a declarative `choice` screen side-effecting:

```ts
import { runLiveChoice } from "@narumitw/pi-tui-kit";

const previousPreview = capturePreview();
let choice;
try {
  choice = await runLiveChoice(ctx, {
    title: "Preset",
    items: presets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      disabled: !preset.available,
      disabledReason: preset.available ? undefined : "Required font is unavailable",
      confirmationDisabled: preset.id === activePresetId,
      confirmationDisabledReason:
        preset.id === activePresetId ? "Already applied" : undefined,
    })),
    currentItemId: activePresetId,
    initialItemId: activePresetId,
    navigationLabel: "live preview",
    confirmLabel: "apply",
    shortcuts: [{ id: "customize", keys: ["e", "shift+e"], label: "customize" }],
    signal: currentSessionSignal(),
    isCurrent: () => generation === currentGeneration(),
    onSelectionChange: ({ item, signal }) => {
      if (!signal.aborted) previewPreset(item.id);
    },
  });
} finally {
  restorePreview(previousPreview);
}

if (choice?.kind === "selected") await saveAndApplyPreset(choice.itemId);
else if (choice?.kind === "shortcut") await customizePreset(choice.itemId);
```

TUI calls `onSelectionChange` for the initial cursor and later focused rows, including disabled rows.
A fully `disabled` row blocks both primary confirmation and shortcuts.
Set `confirmationDisabled` with an optional `confirmationDisabledReason` when only the primary action must be inert while shortcuts remain available, such as allowing Customize for an already-active preset that cannot be applied again.
If both states are present, full `disabled` behavior and its reason take precedence.
Shortcut keys use Pi `KeyId` values; keys that conflict with current standard choice controls are omitted from shortcut hints and dispatch.
Synchronous previews run immediately.
While an asynchronous preview is pending, newer cursor changes coalesce to the latest row.
Completion, Back, Close, owner cancellation, external disposal, and errors abort the callback signal and drain owned preview work before returning.
The callback must honor that signal.
The caller still owns its preview snapshot, rollback, persistence, confirmation, and final apply policy.

RPC deliberately degrades to a signal-aware ordinary selector: it never runs live previews or custom shortcuts, disabled and confirmation-disabled rows remain explanatory and inert, and cancellation follows the requested Back/Close hint.
Print and JSON return `unsupported`.
Results distinguish `selected`, `shortcut`, `closed`, `stale`, `unsupported`, and `error`.

Use `runQuestionnaire()` for a bounded sequence of required choices with optional free-form answers and notes.
Single-question TUI flows submit immediately after answer confirmation, while multi-question flows end with a read-only review:

```ts
import { runQuestionnaire } from "@narumitw/pi-tui-kit";

const result = await runQuestionnaire(ctx, {
  questions: [
    {
      id: "scope",
      header: "Scope",
      prompt: "How broad should this change be?",
      options: [
        { label: "Focused", description: "Change only the requested behavior." },
        { label: "Broad", description: "Include compatible cleanup." },
      ],
    },
  ],
  allowNotes: true,
  maxTextLength: 4_000,
  signal: currentSessionSignal(),
  isCurrent: () => generation === currentGeneration(),
});

if (result.kind === "submitted") {
  await saveDomainAnswers(result.answers);
}
```

TUI preserves Pi selector framing, effective keybindings, Back versus Ctrl+C Close, exact editor input, optional notes, and a plain non-selectable review for multiple questions.
A single question renders its header as plain muted text, omits Review and question-navigation controls, labels answer confirmation as submission, and returns immediately after a preset or free-form answer is confirmed.
Add an optional note before confirming a single preset answer because that confirmation submits the interaction.
Free-form answers are enabled by default, notes require `allowNotes`, and `maxTextLength` applies to free-form answers and notes.
RPC preserves the existing sequential `select()` and `editor()` fallback for choices and free-form answers, but does not collect TUI-only notes or show the final review.
RPC preserves the editor response verbatim, including an empty string, for compatibility with existing Pi dialogs.
Pi's RPC editor API has no abort signal, so owner cancellation during an open editor is classified as stale after that editor closes.
Print and JSON return `unsupported`.
Owner abort, stale state, external disposal, invalid options, and UI failures remain distinct typed results.
The caller owns question-count and option-count policy, domain validation, side effects, result persistence, and mapping answer IDs back to domain objects.

`formatInteractionHints()` is available for other specialized components.
Pass the callback-injected keybindings plus binding-backed or literal-key hint groups; the formatter normalizes arrows, Enter/Escape names, sanitizes controls, applies exclusions, de-duplicates keys, and supports a custom separator.

```ts
import { formatInteractionHints } from "@narumitw/pi-tui-kit/interaction-hints";

const hint = formatInteractionHints(keybindings, [
  { bindings: ["tui.select.up", "tui.select.down"], label: "preview" },
  { bindings: ["tui.select.confirm"], label: "apply" },
  { keys: ["e"], label: "customize" },
]);
```

For a specialized custom component that does not belong in the declarative screen union, use `runCustomInteraction()`.
It supplies an interaction-owned signal, classifies owner replacement and external component disposal as stale, disposes exactly once, and drains optional `waitForPending()` work before returning.
The consumer still owns the component, its Back/Close value, and every domain side effect.
Async factories and pending work must honor the supplied signal; the helper drains them but does not hide uncooperative work behind a timeout.

Use `sanitizeTerminalText()` when a specialized component must place an untrusted model label, path, or other value on one terminal line.
It removes complete and unterminated terminal control sequences, C0/C1 controls, and bidirectional display controls; line separators become spaces.
The result is for display only.
Keep raw paths, IDs, URLs, settings, and action payloads separate, then use Pi TUI's cell-aware wrapping or truncation for layout.

```ts
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { truncateToWidth } from "@earendil-works/pi-tui";

const label = truncateToWidth(sanitizeTerminalText(rawModelId), width, "");
```

```ts
import { runCustomInteraction } from "@narumitw/pi-tui-kit";

const result = await runCustomInteraction<{ kind: "back" | "close" }>(ctx, {
  signal: currentSessionSignal(),
  isCurrent: () => generation === currentGeneration(),
  create: ({ keybindings, signal, complete }) => ({
    render: () => [signal.aborted ? "Closing…" : "Specialized view"],
    invalidate() {},
    handleInput(data) {
      if (keybindings.matches(data, "tui.select.cancel")) complete({ kind: "back" });
    },
  }),
});
```

## 🖥️ Standard screens

`defineMenu()` supports eight standard screen kinds:

- **`actions`** — navigation targets, domain actions, close rows, optional cancellable busy labels, adaptive long-label columns, and disabled explanations.
- **`detail`** — read-only wrapped text with Back or Close behavior.
- **`browse`** — a read-only searchable catalog with textual status, adaptive list/detail views, stable selection restoration, legacy prose or exact document details, and paginated RPC details.
- **`choice`** — one confirmed value from a static list, with separate current and initial items, selected details, disabled explanations, an optional TUI search field, and a bounded viewport.
- **`settings`** — Pi-style searchable, aligned settings rows with immediate value changes, serialized saves, and rollback when an action rejects.
- **`input`** — single-line text entry inside the menu stack with IME focus, serialized submission, rejected-draft retention, and TUI/RPC adaptation.
- **`review`** — fixed or terminal-adaptive scrollable exact text, code, or diff content with an optional primary confirmation action and paginated RPC fallback.
- **`multiSelect`** — optimistic toggles with stable cursor restoration, serialized saves, rollback, selected-row descriptions, optional fuzzy search and bulk action rows, and a bounded TUI viewport.

All standard TUI screens use Pi's injected keybindings, sanitize display text, rebuild themed content after invalidation, and bound rendered output to the supplied terminal width.
At normal terminal heights, every screen renders a themed full-width horizontal rule above and below its content.
Height-adaptive browse and review screens omit the rules only when preserving them would remove critical content at constrained heights.
Escape follows the screen's Back/Close hint; `Ctrl+C` closes the menu.

Disabled action rows stay visible and focusable for context but never navigate, close, or invoke a domain action.
Set `disabledReason` to explain why.
TUI prefixes the semantic label with `[-]`, keeps a supplied unavailable reason visible below the selected row at every width, and adapts the primary column to available width; unavoidable action-label truncation uses an ellipsis.
When a reason is supplied, RPC adds the unavailable state and reason to its selector label; legacy disabled rows without a reason keep their existing RPC label.
This contract also applies to action rows under `multiSelect.actions`.

```ts
const resetAction = {
  id: "redeem-reset",
  label: "Redeem usage limit reset…",
  description: "Current Codex account",
  disabled: availableResetCount === 0,
  disabledReason: availableResetCount === 0 ? "No resets available" : undefined,
  action: "redeemReset" as const,
};
```

Choice screens are for bounded static alternatives rather than actions that run while the cursor moves.
`currentItemId` adds the textual current marker; `initialItemId` controls the first cursor when there is no remembered selection.
They remain separate so a custom or legacy current value can focus a safe fallback.
A confirmed row invokes the screen action with its raw `itemId`; moving the cursor only changes selected details.
Rejected or thrown actions retain the selection.
Disabled rows stay focusable for their explanation but never invoke the action.
RPC flattens choice rows to unique dialog labels while preserving raw identity.

```ts
const profileScreen = {
  kind: "choice" as const,
  title: "Information profile",
  lines: ["Current profile: custom"],
  items: [
    {
      id: "minimal",
      label: "Minimal",
      description: "Four segments",
      details: ["Segments: model · cwd · branch · context"],
    },
    {
      id: "balanced",
      label: "Balanced",
      description: "Recommended",
      details: ["Segments: model · thinking · cwd · branch · tools · context · time"],
    },
  ],
  action: "setProfile" as const,
  currentItemId: "custom", // May be absent from items; no false current marker is shown.
  initialItemId: "balanced",
  viewportSize: 8,
};
```

Set `enableSearch: true` when a choice list needs local filtering, and provide optional `searchText` for safe aliases or metadata that should not be rendered.
TUI fuzzy-searches sanitized labels, descriptions, and explicit search text while preserving raw stable IDs, query and selection after a rejected action, disabled explanations, and IME focus.
Details and raw IDs are not searched implicitly.
RPC deliberately keeps one deterministic unfiltered selector and ignores interactive search metadata.

Keep preview snapshots, rollback, persistence, and confirmation policy in the consuming extension.
Use standalone `runLiveChoice()` when its list-and-shortcut contract fits; keep a fully specialized UI local only when cursor behavior needs more than that contract.

Browse screens are read-only and invoke no action.
TUI fuzzy-searches each sanitized label, textual `statusText`, description, and optional non-rendered `searchText`.
Enter opens an adaptive scrolling detail view; Escape returns to the list without losing the query or selected raw id, then returns to the parent, while Ctrl+C closes the menu.
Omitted or `"adaptive"` viewport size uses the live terminal row budget; a positive number caps item rows without disabling terminal bounds.
RPC intentionally keeps one deterministic unfiltered list, then presents bounded detail pages; `searchText` is never rendered.

Use `details` for legacy prose lines.
The Kit normalizes their whitespace and prepends available status and description text.
Use `detailDocument` for a complete body such as JSON, source code, a diff, or Markdown.
Text, code, and diff formats preserve indentation, expand tabs to four-column stops, hard-wrap by terminal cells, and strip terminal plus bidirectional display controls.
Markdown format applies the same safety boundary but then renders semantic Markdown rather than preserving exact source whitespace.
When both fields are present, `detailDocument` is the complete body and takes precedence over `details`, status, and description inside the detail body.
The item label still names the detail, while status and description remain available in list presentation.
RPC retains the existing status-bearing selector label as the dialog title for compatibility, but does not prepend a second status line to the body.

Exact document content is never added to fuzzy-search metadata or RPC selector labels.
Copy only safe, intentional aliases or metadata into `searchText`; do not copy a large or sensitive document merely to make it searchable.

```ts
const modulesScreen = {
  kind: "browse" as const,
  title: "Modules",
  items: modules.map((module) => ({
    id: module.name,
    label: module.name,
    statusText: module.state,
    description: module.description,
    searchText: module.variables.join(" "),
    details: [
      `Preview: ${module.preview || "none"}`,
      `Variables: ${module.variables.join(", ") || "none"}`,
    ],
  })),
  viewportSize: "adaptive" as const,
};

const schemasScreen = {
  kind: "browse" as const,
  title: "Schemas",
  items: schemas.map((schema) => ({
    id: schema.name,
    label: schema.name,
    searchText: schema.description,
    detailDocument: {
      content: JSON.stringify(schema.value, null, 2),
      format: { kind: "code" as const, language: "json" },
    },
  })),
};
```

Use `choice` when confirmation invokes a domain action; use `browse` when selection only reveals information.
Domain status meaning, catalog construction, and data freshness remain consumer-owned.

TUI settings screens retain the extension title and supporting context above Pi's familiar search field, aligned label/value columns, ten-row viewport, position indicator, selected-row description, and keyboard hint.
Typing fuzzy-filters labels, arrows navigate, and Enter or Space changes the selected value.
Changes save immediately, so Back or Close never implies rollback.
The embedded search input forwards focus for IME positioning.
The kit owns this adapter because Pi's public `SettingsList` does not currently expose restored-cursor, disabled-row, async rollback, and search focus behavior together.

Input screens submit through the existing action `value`.
Validation, normalization, persistence, and product copy remain extension-owned.
Rejection keeps the TUI draft available for correction.
RPC reopens its signal-aware input dialog.

```ts
const inputScreen = {
  kind: "input" as const,
  title: "Maximum image count",
  lines: ["Current: 20"],
  placeholder: "Enter a positive integer",
  action: "setMaximum" as const,
};
```

Review screens preserve indentation and hard-wrap by terminal cells rather than prose words.
Their viewport supports Up, Down, Page Up, Page Down, Home, and End.
RPC sends bounded pages instead of one unbounded dialog title.
Treat `content` as untrusted display input; the kit strips terminal and bidirectional display controls before formatting it.

```ts
const reviewScreen = {
  kind: "review" as const,
  title: "Review configuration changes",
  content: unifiedDiff,
  format: { kind: "diff" as const, filePath: settingsPath },
  viewportSize: "adaptive",
  confirm: { id: "apply", label: "Apply", action: "apply" as const },
};
```

Review formats are `{ kind: "text" }`, `{ kind: "code", language?, filePath? }`, `{ kind: "diff", filePath? }`, and `{ kind: "markdown", renderLatex?, renderMermaid? }`.
Choosing Markdown is opt-in; both rich renderers default to `true`, and either can be disabled explicitly.
TUI uses Pi's Markdown renderer for headings, emphasis, links, lists, code highlighting, and supported inline or block LaTeX.

Enabled top-level `mermaid` fences render locally as themed Unicode when a warning-free flowchart, state, class, entity-relationship, or sequence diagram fits the current width.
Partial parses retain the fenced source and add a warning.
Unsupported, oversized, unavailable, or disabled rendering retains readable fenced source.
Resizing can switch between source and art.
The Kit options are independent of Pi's transcript-only Mermaid setting and use no browser, image, SVG, or network.

```ts
const markdownReviewScreen = {
  kind: "review" as const,
  title: "Architecture notes",
  content: "# Formula\\n\\n$x^2$\\n\\n```mermaid\\nflowchart LR\\n A --> B\\n```",
  format: { kind: "markdown" as const },
  viewportSize: "adaptive" as const,
};
```

Rich Markdown rendering is TUI-only.
RPC keeps sanitized, bounded source pages, and a host without Pi's public rich-Markdown capability safely displays readable source for unsupported rich elements.
Omitted `viewportSize` keeps the fixed 14-row TUI viewport, and numeric values remain fixed integers from 1 through 50.
Set `viewportSize: "adaptive"` to recompute from the live terminal height on every TUI render.
Adaptive review reserves three terminal rows for Pi-owned UI and keeps the complete frame within `max(1, floor(terminal rows) - 3)` rows; this mode is not capped at the numeric 50-row maximum.

At constrained heights, adaptive review prioritizes one content row, then a compact title, then a compact confirmation/Back-or-Close/navigation hint.
From four available rows it shows position when content scrolls; additional space restores wrapped title and supporting context, the full keyboard hint, and the separator before enlarging the content viewport.
Fixed and omitted review rendering is unchanged.
RPC does not read terminal dimensions: adaptive and omitted reviews use deterministic pages of at most eight rows, while numeric values retain the existing eight-row cap.
A review without `confirm` is read-only.
Escape follows Back/Close and `Ctrl+C` closes the whole menu.

Action handlers return one of these results:

```ts
{ kind: "stay" }
{ kind: "back" }
{ kind: "close" }
{ kind: "to", screen: "another-screen" }
{ kind: "rejected", error?: unknown }
```

A rejected settings or multi-select action restores the last accepted value.
Throwing has the same recovery behavior and is routed through `onError`.

For a large multi-select, set `viewportSize` to the maximum number of toggle and action rows rendered at once.
Up and Down wrap; Page Up and Page Down move by one viewport and clamp at the first or last row.
Descriptions for the selected row appear below the viewport.

Set `enableSearch: true` when toggle rows can become difficult to scan.
TUI typing fuzzy-filters each sanitized label plus optional non-rendered `searchText`; use that field for source, policy, aliases, or other useful metadata without parsing display labels or raw IDs.
The query is local to the current screen instance.
Rows in `actions` remain pinned below the matches, including when there are no matching toggle rows, so Save, Discard, and bulk workflows stay reachable.
Clearing the query restores a valid stable-ID selection.
The embedded public Pi `Input` forwards focus for IME positioning and sanitizes pasted terminal controls before filtering.

Search and the viewport affect TUI presentation only.
RPC deliberately keeps one flat, unfiltered list of unique dialog choices, preserving raw identity, disabled rows, toggle semantics, and action rows without introducing a second query protocol.

```ts
const tools = {
  kind: "multiSelect" as const,
  title: "Tool permissions",
  enableSearch: true,
  viewportSize: 9,
  items: allTools.map((tool) => ({
    id: tool.name, // raw stable identity; never recover it from the display label
    label: tool.name,
    description: tool.description,
    searchText: `${tool.source} ${tool.description}`,
    selected: enabledTools.has(tool.name),
    disabled: blockedTools.has(tool.name),
    disabledReason: blockedTools.has(tool.name) ? "Blocked by the active policy" : undefined,
  })),
  action: "toggleTool" as const,
  actions: [
    // Bulk domain handlers must exclude disabled rows themselves.
    { id: "enable-all", label: "Enable all available", action: "enableAll" as const },
  ],
};
```

Disabled multi-select rows stay visible and focusable, use a textual `[-]`/`unavailable` marker, show `disabledReason` with the selected description, and never invoke the toggle handler.
RPC exposes the same unavailable reason and safely returns to the screen when the row is selected.
Keep policy and bulk-set validation in the consuming extension and revalidate it again before mutation.

## 🔌 Runtime and mode behavior

`runMenu()` accepts Pi's `ExtensionCommandContext` by default, a definition, and runtime options:

- `getState({ ctx, signal })` loads extension-owned state.
- `signal` aborts state loads and actions immediately when the owning session is replaced or shut down.
- `isCurrent()` prevents stale continuations after session replacement or shutdown.
- `onError(ctx, error)` customizes observable failure reporting.
- `onUnsupportedMode(ctx, mode)` provides print/JSON fallback behavior.

In TUI mode the runtime uses `ctx.ui.custom()`.
In RPC mode it adapts standard screens to `ctx.ui.select()` dialogs.
Print and JSON modes never attempt custom UI and instead call the unsupported-mode hook.
`runMenu()` resolves to `closed`, `unsupported`, `stale`, or `error`; only the `closed` result carries the mandatory interaction-level `reason`.

Lifecycle handlers can opt into the shared `ExtensionContext` surface without a cast.
Existing three-generic command menus keep `ExtensionCommandContext`, including command-only methods.

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const settledMenu = defineMenu<State, Screen, Action, ExtensionContext>({
  // screens and actions; action ctx is ExtensionContext here
});

pi.on("agent_settled", async (_event, ctx) => {
  const generation = currentGeneration();
  await runMenu(ctx, settledMenu, {
    getState: ({ signal }) => loadState(signal),
    signal: currentSessionSignal(),
    isCurrent: () => generation === currentGeneration(),
  });
});
```

The consumer must own and abort the session signal, check its generation or equivalent identity after every await, and never retain or use an `ExtensionContext` after session replacement, reload, or shutdown.
The kit does not create lifecycle ownership for the extension.
`input` uses a signal-aware RPC dialog; a multi-line `editor` screen is intentionally deferred because Pi's current RPC editor contract does not accept an `AbortSignal`.

## 🧩 Ownership boundary

Reuse Pi primitives and domain components from their package root whenever their public contract fits.
Use non-exported Pi composites only as interaction references; never deep-import Pi's `dist/*` implementation paths.
The kit owns a composite only when public controls do not provide the complete cross-mode and lifecycle contract shared by multiple extensions.

The library owns:

- standalone task-mode adaptation, cancellation, stale checks, error routing, and draining;
- lifecycle ownership, disposal, and pending-work draining around live-choice and specialized custom interactions;
- width-safe standard rendering and injected keybindings;
- screen-stack navigation, Back/Close semantics, and per-screen cursor memory;
- serial settings and multi-select updates, optimistic rollback, and pending-update draining;
- menu, screen, and busy-action cancellation;
- stale-continuation checks around asynchronous work;
- input draft/pending behavior and shared exact-document formatting, scrolling, and RPC pagination;
- read-only browse search, legacy or exact detail disclosure, cursor restoration, and RPC pagination;
- TUI/RPC adaptation and unsupported-mode routing.

The consuming extension still owns:

- domain state, tool activation, commands, and settings schemas;
- transactional persistence and preservation of unknown settings fields;
- confirmations and product-specific copy;
- session generation and shutdown policy supplied through `isCurrent()`;
- preview snapshots, rollback and persistence, multi-line editors, secret inputs, multi-field forms, or other specialized custom TUI.

Keep specialized UI local rather than adding package hooks that expose Pi TUI internals.

## 🧪 Supported testing entrypoint

The same npm package exposes test-only drivers from `@narumitw/pi-tui-kit/testing`; there is no second package to install.
Keep production imports on the main entrypoint and import harnesses only from test code.
The testing entrypoint drives Kit behavior through Pi's public custom-factory and RPC dialog boundaries without returning a raw component or creating a general `ExtensionContext` mock.

Compose `createTuiHarness()` with the consumer's own context fixture:

```ts
import { runMenu } from "@narumitw/pi-tui-kit";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";

const tui = createTuiHarness({ width: 80, rows: 24 });
const ctx = {
  ...consumerContext,
  mode: "tui" as const,
  hasUI: true,
  ui: { ...consumerContext.ui, custom: tui.custom },
};

const running = runMenu(ctx, menu, options);
await tui.waitForOpen();
tui.setFocused(true);
tui.type("12");
tui.press("tui.input.submit");
await tui.waitForPending();
tui.resize({ width: 60, rows: 12 });
const frame = tui.render();
const result = await running;
```

The TUI harness supports semantic Kit bindings, explicit raw input, Ctrl+C/Home/End, focus, invalidation, live width/row changes, render-request observations, pending-action draining, sequential screens, result observation, and external disposal.
`done`, disposal, factory failure, and obsolete async openings settle exactly once; input after closure is inert.
Supply optional callback-compatible theme/keybinding overrides only when a test needs them.

Use strict scripts for RPC:

```ts
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";

const rpc = createRpcHarness([
  { kind: "input", title: "Value", placeholder: "", response: "not-a-number" },
  { kind: "input", title: "Value", placeholder: "", response: "12" },
  { kind: "select", options: ["Apply", "Back"], response: "Apply" },
]);
const rpcCtx = {
  ...consumerContext,
  mode: "rpc" as const,
  hasUI: true,
  ui: { ...consumerContext.ui, ...rpc.ui },
};

await runMenu(rpcCtx, menu, options);
rpc.assertConsumed();
```

RPC steps match call kind and optional exact title, placeholder, or choices.
Responses are exact raw strings or `undefined` cancellation; the harness never fuzzy-matches labels.
A `waitForAbort: true` step supports owner-abort tests without a timer.
Dialog records are immutable, unexpected or leftover steps fail observably, and any RPC request for custom TUI throws.
The current Kit runtime uses only signal-aware `input()` and `select()` in RPC, so the testing entrypoint deliberately does not mock confirmations, editors, notifications, sessions, models, settings, filesystems, clocks, or networks.
Consumer fixtures continue to own domain state, persistence, generation checks, and owner signals.

## 📚 Public API

- `defineMenu()` — validates and returns a typed menu definition.
- `runMenu()` — runs the definition in the current Pi mode and preserves root Back versus Close.
- `runTask()` — runs typed abort-aware work with a cancellable TUI loader and direct non-TUI fallback.
- `runConfirmation()` — preserves Confirmed, Back, Close, Stale, Unsupported, and Error for one standalone confirmation without owning the confirmed side effect.
- `runLiveChoice()` — adapts a live-preview choice to TUI and ordinary RPC selection while preserving typed selection, confirmation-only gating, shortcuts, Back, Close, Stale, Unsupported, and Error.
- `runQuestionnaire()` — adapts required choices, free-form answers, optional TUI notes, direct single-question submission, multi-question read-only review, and sequential RPC while preserving typed Submitted, Back, Close, Stale, Unsupported, and Error outcomes.
- `formatInteractionHints()` — formats sanitized, normalized, de-duplicated injected bindings and literal shortcut keys for specialized interaction hints; the lightweight `@narumitw/pi-tui-kit/interaction-hints` subpath exports it and its public types.
- `sanitizeTerminalText()` — removes terminal and bidirectional display controls from untrusted single-line presentation text without mutating raw payloads; the lightweight `@narumitw/pi-tui-kit/terminal-text` subpath exports it.
- `HorizontalRule` — renders a full-width or inset horizontal divider with an optional sanitized and aligned label plus render-time style callbacks.
- `runCustomInteraction()` — owns cancellation, stale checks, exactly-once disposal, optional pending work draining, and typed results around one extension-owned custom TUI component.
- `resolveMenuScreen()` — resolves and validates a dynamic screen for tests or adapters.
- `createMenuNavigator()` — lower-level stack and selection state helper.
- exported screen, item, action, transition, runtime option, `BrowseDetailDocument`, `MenuCloseReason`, and result types.
- `@narumitw/pi-tui-kit/testing` — separate subpath for `createTuiHarness()`, `createRpcHarness()`, strict scripts, and their public testing types; it is not re-exported from the production root.
- `PI_EXTENSION_MENU_API_VERSION` — current API version (`14`).
Version 14 adds the standalone `runQuestionnaire()` interaction while version-13 menu definitions remain valid.
Version 13 adds opt-in Markdown, LaTeX, and Mermaid document formatting while version-12 menu definitions remain valid.
Version 12 added optional searchable `choice` fields, version 11 added Live Choice confirmation-only gating, version 10 added exact browse detail documents, version 9 added `runLiveChoice()` and `formatInteractionHints()`, version 8 added disabled action reasons and adaptive action-label columns, version 7 added `runConfirmation()`, and version 6 added the read-only `browse` screen and `runCustomInteraction()`.

## 🗂️ Package layout

- `src/` — authored TypeScript and the public package entrypoint
- `src/components/` — internal TUI input, browse, review, document, Markdown, Mermaid, settings, and rendering adapters
- `src/testing/` — supported TUI/RPC test drivers exported only through the `/testing` subpath
- `src/task.ts` — standalone and menu-shared task lifecycle orchestration
- `src/confirmation.ts` — standalone confirmation mode adaptation and lifecycle results
- `src/live-choice.ts` — standalone live-choice TUI/RPC adaptation and preview-work ownership
- `src/questionnaire.ts` — standalone questionnaire TUI/RPC adaptation and public result contract
- `src/interaction-hints.ts` — injected-key and literal-shortcut hint formatting, published through the lightweight `/interaction-hints` subpath
- `src/terminal-text.ts` — terminal display sanitization published through the lightweight `/terminal-text` subpath
- `src/horizontal-rule.ts` — width-safe full-width, inset, and labeled horizontal dividers
- `src/custom-interaction.ts` — lifecycle ownership for specialized public custom components
- `dist/` — generated ESM and declarations included in the npm package
- `test/` — contract, renderer, navigation, lifecycle, and public testing-entrypoint coverage

## 🔎 Keywords

Pi library, Pi extension development, terminal UI, declarative menus, lifecycle-safe interactions, TypeScript.

## 📄 License

MIT © narumiruna
