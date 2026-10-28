# Pi TUI Kit API reference

[Back to README](../README.md)

- [Horizontal rules](#-horizontal-rules)
- [Editor status widgets](#-editor-status-widgets)
- [Bounded frames](#bounded-frames)
- [Configured keys](#configured-keys)
- [Complete menu example](#-complete-menu-example)
- [Standalone interactions](#standalone-tasks)
- [Full-source document copy](#full-source-document-copy)
- [Searchable default-aware selectors](#searchable-default-aware-selectors)
- [Mermaid Markdown transformers](#mermaid-markdown-transformers)
- [Standard screens](#-standard-screens)
- [Runtime and mode behavior](#-runtime-and-mode-behavior)
- [Fullscreen terminal handoff](#fullscreen-terminal-handoff)
- [Ownership boundary](#-ownership-boundary)
- [Testing entrypoint](#-supported-testing-entrypoint)
- [Public API and compatibility history](#-public-api)

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

## 📊 Editor status widgets

Use `EditorStatusWidget` as a width-safe presentation frame for passive status or progress rows near Pi's editor.
The component renders the standard `borderMuted` top rule and truncates every extension-owned body row to the available terminal width.
The consumer continues owning widget keys, placement, snapshots, body formatting, terminal-text sanitization, RPC publication, refresh scheduling, and session lifecycle.
The body renderer receives a normalized non-negative integer width and runs on every render, so it can wrap or style content before the final width guard.

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";

export function publishProgress(ctx: ExtensionContext, lines: readonly string[]) {
  const snapshot = [...lines];
  ctx.ui.setWidget(
    "example:progress",
    (_tui, theme) =>
      new EditorStatusWidget({
        theme,
        renderBody: (width) => snapshot.map((line) => theme.fg("muted", line)),
      }),
    { placement: "aboveEditor" },
  );
}
```

`EditorStatusWidget` treats body rows as terminal-formatted display text and does not sanitize or wrap them.
Sanitize untrusted values before styling or width-sensitive formatting, and perform product-specific wrapping in `renderBody()`.
Publish plain string arrays separately when an extension supports Pi RPC widgets because RPC ignores component factories.

Optional focused helpers provide stable publication (`createEditorStatusPublisher`), session-local view transitions (`createEditorStatusView`), and bounded whole-snapshot items (`createEditorStatusCollection`).
Their subpaths are `editor-status-publisher`, `editor-status-view`, and `editor-status-collection`; the same functions and types are available from the root export.
The publisher retains visible TUI components and adapts RPC snapshots, while owners keep data, settings, timing, events, and priority policy.
See [editor status presentation](./editor-status-presentation.md) for ownership, exact event semantics, capacity failures, two-consumer admission, recovery, and terminal/release limits.
No `upsert`, `push`, `append`, shared registry, or sidebar API is provided.

Optional [editor status presentation helpers](./editor-status-presentation.md) provide stable snapshot publication, explicit session-local view transitions, and bounded whole-snapshot item collections. Use the focused `editor-status-publisher`, `editor-status-view`, and `editor-status-collection` subpaths, or their root exports. The frame remains unchanged; owners retain data, policy, events, timers, row reservations, and cleanup. No helper coordinates extensions or adds a right sidebar.

## Bounded frames

Use `renderBoundedFrame()` to share the standard menu's height-bounded presentation without adopting its input or save lifecycle. It accepts already sanitized, styled, wrapped single-line rows and a rendered horizontal rule. The caller owns terminal row reservations, themes, input, persistence, and which content must survive clipping. This is a stateless layout primitive, not another screen or lifecycle API.

```ts
import { HorizontalRule, renderBoundedFrame } from "@narumitw/pi-tui-kit";

const width = 40;
const rows = renderBoundedFrame({
  width,
  maxRows: 8,
  rule: new HorizontalRule().render(width)[0] ?? "",
  title: ["Settings"],
  content: ["First setting", "Selected setting", "Saving…"],
  hints: ["enter change • esc cancel"], // Supply effective, reachable bindings in real UI.
  compactHint: "esc cancel",
  priorityRows: [1, 2],
  focusedRow: 1,
});
```

A full frame contains the rule, title, context, a blank separator before nonempty content, hints, and the closing rule. On overflow, blank content rows are removed. `priorityRows` refers to indexes in the original content array, in retention order; invalid, duplicate, and blank-row indexes are ignored. `focusedRow` determines proximity when filling remaining space, not selection styling. Explicitly include the focused row in `priorityRows` when it must survive. The function never infers selection from cursor glyphs.

Compact layout reserves a hint row when `compactHint` is nonempty and at least two body rows remain, then retains priority content, one title row, full hints when they fit, neighboring content, and context. `compactHints` can replace full hints during compact rendering, for example to include an overflow count. Rules remain when at least five total rows are available. Static frames prioritize context at one row. Output retains original row order.

Width and row budgets are floored and clamped to zero; non-finite values normalize to zero. A zero row budget returns no rows. Every line is truncated by terminal cells, without an ellipsis. The helper preserves ANSI styling, does not sanitize or wrap rows, and holds no cached theme or dimension state. Sanitize raw values before wrapping or styling, and rebuild rows after resize or theme changes.

### Frame row mapping

Use `renderBoundedFrameLayout()` when a custom wrapper needs to route normalized mouse coordinates after height clipping. It uses the same layout as `renderBoundedFrame()` and returns `BoundedFrameLayout`: `lines` plus `contentRows`, an array of `BoundedFrameContentRow` mappings.

```ts
import { renderBoundedFrameLayout } from "@narumitw/pi-tui-kit";

const frame = renderBoundedFrameLayout({
  width: 40, maxRows: 5, rule: "─".repeat(40), title: ["Settings"],
  content: ["First setting", "Focused setting", "Description"],
  priorityRows: [1], focusedRow: 1,
});
const nativeRows = new Map(frame.contentRows.map(({ frameIndex, contentIndex }) => [frameIndex, contentIndex]));
// In handleMouse(event), nativeRows.get(event.y) identifies the retained content row.
```

Both indexes are zero-based. `contentIndex` always refers to the original `content` array, not a setting or selection item. `frameIndex` refers to the returned `lines`. Titles, rules, context, hints, and inserted separator rows have no mapping. Blank content rows are mapped in full layouts but omitted when compacting; duplicate text never merges row identities. A zero-width layout can retain row mappings while its lines are empty. A zero-height layout has neither lines nor mappings.

Rebuild the map after each render or resize and clear stale geometry on invalidation or input changes. The caller still validates bounds, translates coordinates, preserves native press/click/drag semantics, and owns focus and terminal reservations. This API does not sanitize content or create a mouse router.

## Configured keys

Use `canonicalizeConfiguredKey(value)` to validate a configured key identifier and obtain a canonical `KeyId`, or `undefined` for an invalid value. It normalizes case to native `KeyId` spelling (including `pageUp` and `pageDown`), normalizes `esc`/`return` aliases, and orders modifiers while retaining literal `+` keys such as `ctrl++`. It rejects invalid or repeated modifiers and unsupported base/modifier combinations; it does not trim or repair input.

```ts
import { canonicalizeConfiguredKey } from "@narumitw/pi-tui-kit";

const key = canonicalizeConfiguredKey("ALT+CTRL++"); // "ctrl+alt++"
const invalid = canonicalizeConfiguredKey("ctrl+ctrl+x"); // undefined
```

This is configured-key syntax, not raw terminal-event decoding. Use Pi's `matchesKey()` or the injected keybinding manager for dispatch. Canonical equality does not establish input equivalence, conflict freedom, availability, or reachability. Native legacy aliases, logical/physical shifted symbols, keyboard layouts, terminal modes, and earlier listeners can give different names the same input.

Protocol-overlap and global availability helpers remain deferred: arbitrary byte strings accepted by the native matcher are not the same contract as keys a terminal can produce. Each caller retains its blockers, action priority, fallback selection, paste exclusions, and host integration policy. Kit's internal hint filtering is not a public dispatch contract.

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
declare function currentSessionSignal(): AbortSignal;
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
An ordinary terminal result is `{ kind: "closed", reason: "back" | "close" }`.
Root Back reports `back`.
Ctrl+C, a Close hint, a close row, or an accepted Close action reports `close`.
Nested Back remains inside the menu.
RPC preserves each adapter's existing transition: a generic cancelled selector applies Back, while input and review cancellation follow their declared hint.
Owner replacement remains `stale` and takes precedence over any racing Close event.

### Standalone tasks

For abort-aware work outside a menu, use `runTask()`.
TUI mode shows the Kit's Pi-styled cancellable bordered loader; RPC, print, and JSON execute the same task directly.
The effective cancellation bindings are shown in the loader, and Ctrl+C remains a hard-cancel input when those bindings are remapped.
The loader rebuilds hint colors after theme invalidation and bounds each line after resize; widths below one cell or non-finite widths produce no rows.
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

### Confirmations

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

TUI confirmation uses the standard bounded actions presentation.
Selecting the cancel row or pressing Escape returns `{ kind: "closed", reason: "back" }`.
Ctrl+C returns the same result with reason `"close"`.
RPC uses one signal-aware `select()` request with explicit confirm and cancel rows.
Explicit cancel and protocol cancellation deterministically map to Back because Pi RPC does not expose a separate Ctrl+C dialog outcome.
Print and JSON return `unsupported`.
Owner abort, session replacement, external TUI disposal, and failures remain distinct `stale` or `error` results.
The Kit owns only this interaction lifecycle—the caller performs every confirmed side effect and must abort its owner signal on replacement or shutdown.

### Document reviews

Use `runDocumentReview()` for one standalone read-only document with optional confirmation:

```ts
import { runDocumentReview } from "@narumitw/pi-tui-kit/document-review";

const result = await runDocumentReview(ctx, {
  title: "Review generated configuration",
  content: generatedDocument,
  format: { kind: "diff", filePath: "settings.json" },
  viewportSize: "adaptive",
  enableSearch: true,
  confirmation: { label: "Apply" },
  signal: currentSessionSignal(),
  isCurrent: () => generation === currentGeneration(),
});

if (result.kind === "confirmed") await persistGeneratedConfiguration();
```

The API uses the same text, code, diff, and Markdown formatter as declarative `review` screens, including exact cell-width wrapping, terminal sanitization, syntax highlighting, LaTeX, Mermaid fallback, custom keybindings, search, scrolling, and mouse wheel behavior.
Before opening a TUI Markdown review with an enabled top-level Mermaid fence, it awaits Kit's lazy renderer preparation and revalidates the owner signal and generation.
Mermaid preparation remains internal; callers receive no renderer or component factory.

TUI Escape and Ctrl+C return typed `cancelled` results with Back and Close reasons.
When `confirmation` is omitted, no action can confirm the document; optional Copy stays in the same view.
RPC uses the authoritative sanitized document pages, optional confirmation, and signal-aware `select()` dialogs; TUI-only search is ignored.
Print and JSON return `unsupported`.
Owner abort, stale ownership, external disposal, invalid options, and failures remain distinct `stale` or `error` results.
The caller owns every confirmed side effect and must revalidate domain state before applying it.

### Full-source document copy

Set optional `copy: { label, onCopy }` on a `ReviewScreen`, exact `BrowseDetailDocument`, or `RunDocumentReviewOptions`. The same TUI implementation runs the action in place; Copy does not confirm, navigate, or add a completion result. Omit it to retain existing behavior. Legacy browse `details` arrays have no exact-source copy contract.

```ts
import type { DocumentCopyAction } from "@narumitw/pi-tui-kit/document-review";
import { runDocumentReview } from "@narumitw/pi-tui-kit/document-review";

// The owner decides what is safe to expose and supplies its clipboard transport.
declare function copyApprovedSource(content: string, signal: AbortSignal): Promise<void>;
const copy: DocumentCopyAction = {
  label: "Copy raw TOML",
  onCopy: ({ content, signal }) => copyApprovedSource(content, signal),
};

await runDocumentReview(ctx, {
  title: "Raw settings",
  content: rawToml,
  format: { kind: "code", language: "toml" },
  enableSearch: true,
  copy,
  signal: currentSessionSignal(),
  isCurrent: () => generation === currentGeneration(),
});
```

`DocumentCopyContext` supplies the original `content`, an optional raw browse `itemId`, and an `AbortSignal`. Kit snapshots source, identity, label, and callback before awaiting the action, and preserves the original action as a method callback's receiver. It sends the complete source, including offscreen text, CRLF, tabs, trailing spaces, final newlines, and source controls. It never copies sanitized rows, wrapped text, search highlights, or rendered Markdown. **Raw source can contain sensitive text or controls that the preview does not display.** The owner must opt in, choose a precise label, and apply its sensitivity policy before providing the action.

Kit uses the injected `app.message.copy` binding, normally Ctrl+X. It filters hints against native host keys, standard navigation, Home/End, confirmation, cancellation, and Space search activation. Active search owns input; paste and key-release events never invoke Copy. No usable binding means no Copy hint. These filters are local to Kit, not a public global-reachability API.

Only one copy callback can run per interaction. Repeated input while pending is ignored, not queued. Generic busy, completion, and retryable failure feedback stays in the document frame. Kit does not expose callback errors through notifications, owner error reporters, or result payloads because they can contain source text. Callback completion means only that the owner callback returned successfully, not that an OS or remote clipboard accepted the source.

Back, Close, confirmation, disposal, and owner cancellation abort supported callback work and drain accepted work before the interaction returns. Changing the active document or copy action clears stale feedback. Owners must honor the signal or otherwise bound their work, supply current session ownership, and revalidate domain state around their own awaits. Native clipboard writes may not be cancellable; Kit cannot undo a completed write or restore the previous clipboard.

Copy is TUI-only. RPC omits Copy controls and never invokes its callback; document pagination and confirmation are unchanged. Print and JSON retain their existing unsupported results. Kit contains no clipboard backend and never emits OSC 52. A consumer can explicitly use Pi's public `copyToClipboard()` helper inside its TUI callback; that transport and its local/remote limitations remain consumer-owned.

### Multi-selects

Use `runMultiSelect()` to collect a set of stable IDs without moving domain state or persistence into Kit:

```ts
import { runMultiSelect } from "@narumitw/pi-tui-kit/multi-select";

const result = await runMultiSelect(ctx, {
  title: "Enabled tools",
  items: tools.map((tool) => ({
    id: tool.id,
    label: tool.label,
    selected: tool.enabled,
    disabled: tool.required,
    disabledReason: tool.required ? "Required by policy" : undefined,
    searchText: tool.aliases.join(" "),
  })),
  enableSearch: true,
  completionLabel: "Apply",
  signal: currentSessionSignal(),
  isCurrent: () => generation === currentGeneration(),
});

if (result.kind === "completed") await saveEnabledToolIds(result.selectedItemIds);
```

TUI reuses the standard multi-select screen's optimistic toggles, disabled explanations, fuzzy search, callback-provided keybindings, IME focus, paste behavior, width bounds, and mouse routing.
The explicit completion row waits for pending toggles before returning selected IDs in input order.
Escape and Ctrl+C cancel without returning a completed set.
RPC presents a deterministic unfiltered list, loops after each enabled toggle, keeps disabled rows inert, and completes only through the explicit completion row; protocol cancellation returns `cancelled`.
Print and JSON return `unsupported`.
Owner abort, stale ownership, external disposal, invalid options, and failures remain typed.
The interaction mutates only its private selected-ID set; the caller decides whether and how to validate, persist, or apply a completed result.

### Live choices

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
Set `confirmationDisabled` when only the primary action must be inert while shortcuts remain available.
For example, an active preset can still allow Customize even when it cannot be applied again.
Use `confirmationDisabledReason` to explain the blocked primary action.
If both states are present, full `disabled` behavior and its reason take precedence.
Shortcut keys use Pi `KeyId` values; keys that conflict with current standard choice controls are omitted from shortcut hints and dispatch.
Synchronous previews run immediately.
While an asynchronous preview is pending, newer cursor changes coalesce to the latest row.
Completion, Back, Close, owner cancellation, external disposal, and errors abort the callback signal and drain owned preview work before returning.
The callback must honor that signal.
The caller still owns its preview snapshot, rollback, persistence, confirmation, and final apply policy.

Set `enableSearch: true` to reuse the standard choice screen's TUI-only fuzzy filtering.
Each item can provide non-rendered `searchText`; TUI searches sanitized labels, descriptions, and that explicit metadata while preserving raw IDs, current markers, initial selection, disabled rows, and empty results.
Search owns printable input and paste, so additive custom shortcuts are omitted while it is enabled; configured navigation, confirmation, cancellation, Home, End, and Ctrl+C retain priority.
Filtering participates in the same coalesced preview queue, and disposal or owner cancellation still aborts and drains preview work.

RPC deliberately degrades to a signal-aware ordinary selector.
It ignores `enableSearch` and `searchText`, keeps the deterministic unfiltered list, and never runs live previews or custom shortcuts.
Disabled and confirmation-disabled rows remain explanatory and inert, and cancellation follows the requested Back or Close hint.
Print and JSON return `unsupported`.
Results distinguish `selected`, `shortcut`, `closed`, `stale`, `unsupported`, and `error`.

### Masked secret input

Use `runSecretInput()` only for one secret whose domain validation and persistence remain consumer-owned:

```ts
import { runSecretInput } from "@narumitw/pi-tui-kit";

const result = await runSecretInput(ctx, {
  title: "WebDAV password",
  required: true,
  signal: currentSessionSignal(),
  isCurrent: () => generation === currentGeneration(),
});

if (result.kind === "submitted") await saveCredential(result.value);
```

TUI renders one masked, horizontally scrolling draft and supports callback-provided submit, cancel, cursor, deletion, kill/yank, undo, and line-editing bindings, bracketed paste, Kitty printable input, IME focus, and mouse cursor placement.
`required` defaults to `true`; required-empty and pasted-control validation retries in the same component without exposing the value.
Back and Ctrl+C return distinct `closed` reasons, while owner abort, stale ownership, external disposal, unsupported modes, and failures retain typed results.
Completion and every exit clear the component's internal references, but the API does not promise secure erasure from the JavaScript runtime.
It never writes history, status, error details, settings, or credential storage.

Pi RPC has no masked-input field.
`runSecretInput()` therefore returns `unsupported` in RPC, print, and JSON modes and never falls back to plaintext `ctx.ui.input()`.
A consumer that already offers plaintext RPC entry must keep that behavior outside this API until its users explicitly accept a documented migration or provide a safe manual configuration path.

### Questionnaires

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
A single question renders its header as plain muted text and omits Review and question-navigation controls.
Its answer confirmation is labeled as submission, and the interaction returns as soon as that answer is confirmed.
Add an optional note before confirming a single preset answer because that confirmation submits the interaction.
Free-form answers are enabled by default, notes require `allowNotes`, and `maxTextLength` applies to free-form answers and notes.
TUI answers and notes use a separate instance of the custom editor registered through Pi's `ctx.ui.setEditorComponent()`, when available through `ctx.ui.getEditorComponent()`.
The custom editor owns editing and submission keys, including Escape; Ctrl+C remains a hard cancellation path.
Its `onSubmit` value is authoritative, including intentional whitespace normalization; raw marker decoding still preserves unsafe characters without restoring the pre-submit draft.
Editing hints defer to the custom editor's keybindings instead of advertising selector cancellation or standard submission keys it may consume.
The questionnaire does not replace the main editor, alter its draft, or copy its application action handlers.
Without a custom factory, the existing Editor and cancellation behavior remain unchanged; selector and Review cancellation also remain unchanged.
Questionnaire-owned editor instances receive focus and optional mouse/key-release input.
Each later answer or note edit gets a fresh custom editor instance so earlier asynchronous submissions cannot affect it.
Retired instances receive any pending owned key releases before their optional `dispose()` method runs; interaction cleanup disposes every remaining instance.
For release-aware editors, key cycles stay with the editor that received the press across answer/note submission; selector-owned opening releases and repeats are not forwarded.
RPC preserves the existing sequential `select()` and `editor()` fallback for choices and free-form answers, but does not collect TUI-only notes or show the final review.
RPC preserves the editor response verbatim, including an empty string, for compatibility with existing Pi dialogs.
Pi's RPC editor API has no abort signal, so owner cancellation during an open editor is classified as stale after that editor closes.
Print and JSON return `unsupported`.
Owner abort, stale state, external disposal, invalid options, and UI failures remain distinct typed results.
The caller owns question-count and option-count policy, domain validation, side effects, result persistence, and mapping answer IDs back to domain objects.

### Searchable default-aware selectors

Use `runModelSelector()` and `runThinkingSelector()` for searchable selection flows that distinguish the active value from the saved default. The selectors use the callback-provided theme and effective keybindings, and return `saveDefault` when the user presses the configured save shortcut (`Ctrl+S` by default).

```ts
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  runModelSelector,
  runThinkingSelector,
} from "@narumitw/pi-tui-kit";

declare function saveDefaultModel(provider: string, modelId: string): Promise<void>;
declare function saveDefaultThinking(level: string): Promise<void>;

export async function chooseModel(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const models = ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }) => model)
    : ctx.modelRegistry.getAvailable();
  const result = await runModelSelector(ctx, {
    models,
    currentModel: ctx.model,
    // Load this through the consumer's Pi settings owner when it wants a default marker.
    defaultModel: undefined,
  });
  if (result.kind === "selected") await pi.setModel(result.model);
  if (result.kind === "saveDefault") {
    if (await pi.setModel(result.model)) {
      await saveDefaultModel(result.model.provider, result.model.id);
    }
  }
}

export async function chooseThinking(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const result = await runThinkingSelector(ctx, {
    availableLevels: ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"],
    currentLevel: pi.getThinkingLevel(),
  });
  if (result.kind === "selected") pi.setThinkingLevel(result.level);
  if (result.kind === "saveDefault") {
    pi.setThinkingLevel(result.level);
    await saveDefaultThinking(result.level);
  }
}
```

The selectors deliberately return intent instead of writing Pi's `settings.json`. The consumer owns default persistence, ordered writes, failure reporting, and any rollback because it owns the relevant settings manager. A `saveDefault` result should normally apply the highlighted value to the current session as well as save it, matching Pi's built-in behavior.

Both selectors are TUI-only and return `unsupported` in RPC, print, and JSON modes. The model selector renders the supplied snapshot and does not refresh provider catalogs or choose between all and scoped models; pass `ctx.scopedModels` when session scope applies, as shown above. Escape returns Back, while Ctrl+C remains a hard Close path.

### Custom interactions and display helpers

`formatInteractionHints()` is available for other specialized components.
Pass the callback-injected keybindings with binding-backed or literal-key hint groups.
The formatter normalizes arrows and Enter or Escape names, sanitizes controls, applies exclusions, de-duplicates keys, and supports a custom separator.

```ts
import { formatInteractionHints } from "@narumitw/pi-tui-kit/interaction-hints";

const hint = formatInteractionHints(keybindings, [
  { bindings: ["tui.select.up", "tui.select.down"], label: "preview" },
  { bindings: ["tui.select.confirm"], label: "apply" },
  { keys: ["e"], label: "customize" },
]);
```

For a specialized custom component that does not belong in the declarative screen union, use `runCustomInteraction()`.
It supplies an interaction-owned signal and classifies owner replacement or external component disposal as stale.
It retains asynchronous creation even when Pi closes the dialog before the factory returns, disposes the returned component exactly once, and drains optional `waitForPending()` work before returning.
Accepted completion aborts the interaction signal immediately, including when `complete()` is called inside the factory.
A rejection during creation, disposal, or pending-work draining matching that signal's reason, directly or through an `AbortError` cause, preserves the accepted result after draining; unrelated initialization and cleanup errors remain reportable.
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

Use `sanitizeTerminalDocument()` for untrusted multiline display text that must retain line feeds and tabs.
It normalizes CRLF and CR to LF, removes terminal and bidirectional controls, and replaces other C0 and C1 controls with spaces.
Use `hardWrapTerminalDocument()` to apply that sanitizer, expand tabs at four-column stops, preserve printable whitespace, and hard-wrap graphemes by terminal cells.
A non-positive or non-finite width produces one empty display line.
Both helpers are available from the package root and the focused `/terminal-document` subpath.

```ts
import {
  hardWrapTerminalDocument,
  sanitizeTerminalDocument,
} from "@narumitw/pi-tui-kit/terminal-document";

const lines = hardWrapTerminalDocument(sanitizeTerminalDocument(rawDocument), width);
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

### Mermaid Markdown transformers

Use the focused `/markdown` subpath when a specialized transcript constructs Pi `UserMessageComponent` or `AssistantMessageComponent` instances outside the normal interactive transcript.
Call `prepareMermaidMarkdownRenderer()` with the display Markdown before creating message components.
It returns a shared promise only when the sanitized document contains a top-level Mermaid fence and the renderer still needs loading; ordinary Markdown, nested literal fences, an already loaded renderer, an earlier load failure, or a host without Pi's rich-Markdown APIs returns `undefined`.
An `undefined` result therefore means no wait is required, not necessarily that rendering is unavailable.

After any returned promise settles, revalidate the owning session, generation, signal, and mutable content before creating UI.
Then call `createMermaidMarkdownTransformer()` with the callback-provided theme.
It returns `undefined` when preparation did not make a renderer available; omit it from the component transformer array in that case.
The returned transformer is synchronous, renders user and finalized assistant messages, and leaves streaming assistant content and assistant thinking unchanged.

```ts
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  createMermaidMarkdownTransformer,
  prepareMermaidMarkdownRenderer,
} from "@narumitw/pi-tui-kit/markdown";

const preparation = prepareMermaidMarkdownRenderer(answerMarkdown);
if (preparation) {
  await preparation;
  if (signal.aborted || generation !== currentGeneration()) return;
}

const transformer = createMermaidMarkdownTransformer(theme);
const component = new AssistantMessageComponent(
  response,
  true,
  getMarkdownTheme(),
  "",
  1,
  transformer ? [transformer] : [],
);
```

The transformer sanitizes finalized Markdown at the display boundary, uses Pi's exact available content width, and can switch between Unicode art and fenced source when the terminal resizes.
Warning-free supported diagrams render as themed Unicode; malformed, unsupported, oversized, unavailable, or throwing renders retain readable fenced source, with a sanitized warning when parsing is partial.
Preparation is process-local, de-duplicated, and not cancellable because JavaScript module loading is not cancellable; consumers must ignore stale completion after every await.
The renderer uses no browser, image, SVG, or network, and this API is independent of Pi's normal-transcript Mermaid setting.

## 🖥️ Standard screens

`defineMenu()` supports eight standard screen kinds:

- **`actions`** — navigation targets, domain actions, close rows, optional cancellable busy labels, adaptive long-label columns, and disabled explanations.
- **`detail`** — read-only wrapped text with Back or Close behavior.
- **`browse`** — a searchable read-only catalog with textual status, adaptive list/detail views, restored selection, prose or exact details, and RPC pagination.
- **`choice`** — one confirmed static value with separate current and initial items, details, disabled explanations, optional TUI search, and a bounded viewport.
- **`settings`** — Pi-style searchable, aligned settings rows with immediate value changes, serialized saves, and rollback when an action rejects.
- **`input`** — single-line text entry inside the menu stack with IME focus, serialized submission, rejected-draft retention, and TUI/RPC adaptation.
- **`review`** — fixed or terminal-adaptive scrollable exact text, code, or diff content with optional confirmation, opt-in full-source Copy, and paginated RPC fallback.
- **`multiSelect`** — optimistic toggles with restored cursor, serialized saves, rollback, row descriptions, optional fuzzy search and bulk actions, and a bounded viewport.

All standard TUI screens use Pi's injected keybindings, sanitize display text, rebuild themed content after invalidation, and bound rendered output to the supplied terminal width.
Interactive rows use the latest rendered geometry: hover is passive, left press moves selection, a matching click activates, and wheel events navigate or scroll the targeted list or document.
Disabled rows and passive details never activate, embedded Input and Editor rows receive translated mouse coordinates, and disposal clears stale pressed targets.
The testing harness covers normalized component events only; a human-operated terminal smoke must verify Pi's fullscreen mouse listener and terminal protocol.
At normal terminal heights, every screen renders a themed full-width horizontal rule above and below its content.
Height-adaptive browse and review screens omit the rules only when preserving them would remove critical content at constrained heights.
Escape follows the screen's Back/Close hint; `Ctrl+C` closes the menu.

Disabled action rows stay visible and focusable for context but never navigate, close, or invoke a domain action.
Set `disabledReason` to explain why.
TUI prefixes the semantic label with `[-]` and keeps an unavailable reason visible below the selected row at every width.
The primary column adapts to available width, and unavoidable action-label truncation uses an ellipsis.
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
Action and choice screens mark clipped names with an ellipsis and wrap the complete selected label below the list when it does not fit inline.
Choices use adaptive primary columns and preserve the textual current marker when enough cells remain for both it and a label fragment.
The selected description also wraps below the list when it does not fit inline.
At constrained heights, the selected row takes priority; a filtered empty state keeps its recovery guidance ahead of the search field.
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
TUI fuzzy-searches sanitized labels, descriptions, and explicit search text.
It preserves raw stable IDs, query and selection after a rejected action, disabled explanations, and IME focus.
A muted count below the query shows the catalog total or filtered results, separately from cursor position.
Details and raw IDs are not searched implicitly.
RPC deliberately keeps one deterministic unfiltered selector and ignores interactive search metadata.

Keep preview snapshots, rollback, persistence, and confirmation policy in the consuming extension.
Use standalone `runLiveChoice()` when its list-and-shortcut contract fits; keep a fully specialized UI local only when cursor behavior needs more than that contract.

Browse rows only reveal information and never invoke domain actions. An exact detail document can opt into the separate [full-source copy callback](#full-source-document-copy).
TUI fuzzy-searches each sanitized label, textual `statusText`, description, and optional non-rendered `searchText`.
Enter opens an adaptive scrolling detail view; Escape returns to the list without losing the query or selected raw id, then returns to the parent, while Ctrl+C closes the menu.
List rows reserve name cells before bounding status text, and mark clipped names or status with an ellipsis.
Query editing remains available when a constrained height hides the search field, but the hidden field has no cursor or focus.
Omitted or `"adaptive"` viewport size uses the live terminal row budget; a positive number caps item rows without disabling terminal bounds.
RPC intentionally keeps one deterministic unfiltered list, then presents bounded detail pages; `searchText` is never rendered.
Set `enableDetailSearch: true` to add literal, case-insensitive search over the displayed legacy or exact detail text in TUI mode.
The detail search uses standalone Space for component-local activation.
Configured standard actions retain priority; when one claims Space, the search activation hint is omitted.
Next, previous, and search-close use Pi's effective bindings, list filtering stays independent, and search clears when it closes or the detail view exits.
Activation intentionally avoids Pi's globally reserved alternate-screen search key because fullscreen Pi consumes that key before custom components receive input.
Document search caps each query at 4,096 code units and highlights only the current result above 1,000 matches while preserving exact count and navigation.
`Ctrl+C` always closes the whole menu, while the configured search-close binding closes only search first.
RPC ignores `enableDetailSearch` and retains its existing pages.

Use `details` for legacy prose lines.
The Kit normalizes their whitespace and prepends available status and description text.
Use `detailDocument` for a complete body such as JSON, source code, a diff, or Markdown.
Text, code, and diff formats preserve indentation, expand tabs to four-column stops, hard-wrap by terminal cells, and strip terminal plus bidirectional display controls.
Diff formatting adds inverse word-level emphasis only when one removed line is followed by exactly one added line; ambiguous multi-line groups, pairs above 4,096 combined code units, and work beyond a 20,000-code-unit document budget retain line-level color without intraline work.
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
  enableDetailSearch: true,
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

TUI settings screens retain the extension title and supporting context above Pi's familiar search field.
They use width-bounded aligned label and value columns, a ten-row viewport, a position indicator, selected-row context, and a keyboard hint.
Values retain space at narrow widths; clipped selected labels or values appear in full below the list when height permits, followed by the description.
Rows below six columns prioritize the cursor and label rather than attempting two columns.
Typing fuzzy-filters labels, arrows navigate, and Enter or Space changes the selected value.
Changes save immediately, so Back or Close never implies rollback.
The embedded search input forwards focus for IME positioning.
The Kit owns this adapter because Pi's public `SettingsList` does not expose restored cursor, disabled rows, asynchronous rollback, and search focus together.

Input screens submit through the existing action `value`.
Validation, normalization, persistence, and product copy remain extension-owned.
Set `initialValue` for editable TUI content with the cursor at its end; `placeholder` remains non-editable guidance shown only for an empty draft.
Rejection keeps the TUI draft and later edits available for correction.
Pi's RPC input protocol has no prefill field, so RPC deliberately ignores `initialValue`, preserves the original placeholder, and reopens a fresh signal-aware input dialog after rejection.
Print and JSON retain `runMenu()`'s existing explicit `unsupported` result.

```ts
const inputScreen = {
  kind: "input" as const,
  title: "Maximum image count",
  lines: ["Current: 20"],
  placeholder: "Enter a positive integer",
  initialValue: "20",
  action: "setMaximum" as const,
};
```

Review screens preserve indentation and hard-wrap by terminal cells rather than prose words.
Their viewport supports Up, Down, Page Up, Page Down, Home, and End.
RPC sends bounded pages instead of one unbounded dialog title.
Treat `content` as untrusted display input; the Kit strips terminal and bidirectional display controls before formatting it.
Set `enableSearch: true` to search displayed TUI text with case-insensitive literal matching across normalized rendered whitespace.
The search bar uses standalone Space for component-local activation.
Configured standard actions retain priority; when one claims Space, the search activation hint is omitted.
Next, previous, and search-close use Pi's effective bindings while preserving document scrolling.
Activation intentionally avoids Pi's globally reserved alternate-screen search key because fullscreen Pi consumes that key before custom components receive input.
Document search caps each query at 4,096 code units and highlights only the current result above 1,000 matches while preserving exact count and navigation.
Closing search clears its query and highlights, a later Back or Close keeps the screen's existing meaning, and `Ctrl+C` always closes the menu.
RPC ignores `enableSearch` and retains deterministic bounded pages.

```ts
const reviewScreen = {
  kind: "review" as const,
  title: "Review configuration changes",
  content: unifiedDiff,
  format: { kind: "diff" as const, filePath: settingsPath },
  viewportSize: "adaptive",
  enableSearch: true,
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
Adaptive review reserves three terminal rows for Pi-owned UI.
It keeps the complete frame within `max(1, floor(terminal rows) - 3)` rows and is not capped at the numeric 50-row maximum.

At constrained heights, adaptive review prioritizes one content row, then a compact title, then a compact confirmation/Back-or-Close/navigation hint.
With four available rows, adaptive review shows position when content scrolls.
Additional space restores the wrapped title, supporting context, full keyboard hint, and separator before enlarging the content viewport.
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
TUI typing fuzzy-filters each sanitized label and optional non-rendered `searchText`.
Use `searchText` for source, policy, aliases, or other useful metadata without parsing display labels or raw IDs.
The query is local to the current screen instance.
Rows in `actions` remain pinned below the matches, including when there are no matching toggle rows, so Save, Discard, and bulk workflows stay reachable.
Clearing the query restores a valid stable-ID selection.
The embedded public Pi `Input` forwards focus for IME positioning and sanitizes pasted terminal controls before filtering.

Search and the viewport affect TUI presentation only.
RPC deliberately keeps one flat, unfiltered list of unique dialog choices.
It preserves raw identity, disabled rows, toggle semantics, and action rows without adding a second query protocol.

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

Disabled multi-select rows stay visible and focusable with a textual `[-]` or `unavailable` marker.
They show `disabledReason` with the selected description and never invoke the toggle handler.
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

The consumer must own and abort the session signal and check its generation or equivalent identity after every await.
It must not retain or use an `ExtensionContext` after session replacement, reload, or shutdown.
The Kit does not create lifecycle ownership for the extension.
`input` uses a signal-aware RPC dialog; a multi-line `editor` screen is intentionally deferred because Pi's current RPC editor contract does not accept an `AbortSignal`.

### Fullscreen input and custom UI limits

Kit screens replace Pi's editor area; they do not own the fullscreen transcript or its layout root.
Pi processes fullscreen transcript actions before replacement-component input, including default PageUp/PageDown, Ctrl+Home/Ctrl+End, and transcript search.
Use arrows for Kit document navigation, or configure non-conflicting host viewport bindings when document paging is required.
Plain Home/End remain available to the focused component, including its search input.
A focused Pi overlay can own viewport input until its owner explicitly transfers focus.
Kit does not override these host decisions or expose overlay options through `runCustomInteraction()`.
Built-in interaction hints omit configured keys intercepted by the native host, including modifier aliases and legacy key collisions; a usable configured fallback remains visible.
Host-owned Space also suppresses the local document-search hint.
Other extensions can install earlier input listeners that Pi does not expose through a public ownership API; Kit cannot predict those listeners.
The [selector and host-input audit](./core-alignment-audit.md) records native dispatch evidence and retained cross-mode contracts.

Custom Kit interactions do not currently receive the blocked program-status reporting provided by Pi's native dialogs.
Kit does not emit terminal program-status codes on Pi's behalf.
Review screens return no rows for non-positive or non-finite widths and rebuild their display caches on theme invalidation; raw document content remains unchanged.

### Fullscreen terminal handoff

The opt-in `createFullscreenHandoff<T extends TUI>(parent, { isCurrent?, canRestoreParent? })` resource shares only physical terminal entry and restoration. Its methods are `enter(syncChildFactory): Promise<T | undefined>`, `restore(): Promise<void>`, and `setOverlayHandle(handle): void`. The [retained contract matrix and handoff record](./fullscreen-handoff.md) defines lifecycle ordering, error propagation, ownership, two-consumer admission, release requirements, verification evidence, and external limits.

This resource is separate from `runCustomInteraction()`: it does not replace that helper's component lifecycle or typed results. Input routing, paste, root cancellation, domain work, layouts, and non-TUI guards remain consumer-owned. Pi advises against a second renderer; this is an intentional opt-in deviation with one active renderer, not an official support guarantee. Starship and BTW prove the same physical contract through native adapter tests; their domain workflows remain separate.

## 🧩 Ownership boundary

Reuse Pi primitives and domain components from their package root whenever their public contract fits.
Use non-exported Pi composites only as interaction references; never deep-import Pi's `dist/*` implementation paths.
The Kit owns a composite only when public controls do not provide the complete cross-mode and lifecycle contract shared by multiple extensions.

The library owns:

- standalone task-mode adaptation, cancellation, stale checks, error routing, and draining;
- interaction lifecycle ownership, disposal, and pending-work draining for live-choice and specialized custom interactions;
- width-safe standard rendering and injected keybindings;
- screen-stack navigation, Back/Close semantics, and per-screen cursor memory;
- serial settings and multi-select updates, optimistic rollback, and pending-update draining;
- menu, screen, and busy-action cancellation;
- stale-continuation checks around asynchronous work;
- input draft/pending behavior and shared exact-document formatting, scrolling, and RPC pagination;
- read-only browse search, legacy or exact detail disclosure, cursor restoration, and RPC pagination;
- generic masked-secret TUI editing, validation, cancellation, disposal, and unsupported-mode routing;
- TUI/RPC adaptation and unsupported-mode routing.

The consuming extension still owns:

- domain state, tool activation, commands, and settings schemas;
- transactional persistence and preservation of unknown settings fields;
- confirmations and product-specific copy;
- session generation and shutdown policy supplied through `isCurrent()`;
- preview snapshots, rollback and persistence, credential validation or storage, authentication/setup policy, multi-line editors, multi-field forms, or other specialized custom TUI.

Keep specialized UI local rather than adding package hooks that expose Pi TUI internals.

## 🧪 Supported testing entrypoint

The same npm package exposes test-only drivers from `@narumitw/pi-tui-kit/testing`; there is no second package to install.
Keep production imports on the main entrypoint and import harnesses only from test code.
The testing entrypoint drives Kit behavior through Pi's public custom-factory and RPC dialog boundaries.
It neither returns a raw component nor creates a general `ExtensionContext` mock.

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

The TUI harness supports semantic Kit bindings, explicit raw input, normalized mouse events, Ctrl+C, Home, End, focus, and invalidation.
It also supports live dimension changes, render-request observations, pending-action draining, sequential screens, result observation, and external disposal.
`done`, disposal, factory failure, and obsolete async openings settle exactly once; input after closure is inert.
Supply optional callback-compatible theme/keybinding overrides only when a test needs them.
These normalized events do not prove Pi's fullscreen listener, terminal mouse protocol, or theme reload behavior.
After building the package, a human can load `test/fixtures/interaction-smoke.ts` with:

```bash
pi --no-extensions --no-skills -e ./packages/pi-tui-kit/test/fixtures/interaction-smoke.ts
```

Run `/kit-capabilities-smoke`, `/kit-selector-smoke`, and `/kit-secret-smoke`, then verify remapped keys, mouse presses and clicks, wheel navigation, narrow resizes, and `/reload` theme behavior in a real terminal.
Do not automate this interactive smoke through a non-interactive subprocess.

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
The current Kit runtime uses only signal-aware `input()` and `select()` in RPC.
The testing entrypoint therefore does not mock confirmations, editors, notifications, sessions, models, settings, filesystems, clocks, or networks.
Consumer fixtures continue to own domain state, persistence, generation checks, and owner signals.

## 📚 Public API

- `defineMenu()` — validates and returns a typed menu definition.
- `runMenu()` — runs the definition in the current Pi mode and preserves root Back versus Close.
- `runTask()` — runs typed abort-aware work with a cancellable TUI loader and direct non-TUI fallback.
- `runConfirmation()` — preserves Confirmed, Back, Close, Stale, Unsupported, and Error for one standalone confirmation without owning the confirmed side effect.
- `runDocumentReview()` — reuses authoritative text, code, diff, and Markdown review behavior with search, optional confirmation, TUI/RPC adaptation, and typed lifecycle outcomes.
- `runLiveChoice()` — adapts live-preview choice to TUI and RPC while preserving typed selection, gating, shortcuts, and lifecycle outcomes.
- `runMultiSelect()` — reuses authoritative multi-select behavior with interaction-local selection, disabled rows, optional TUI search, explicit completion, and TUI/RPC adaptation.
- `prepareMermaidMarkdownRenderer()` and `createMermaidMarkdownTransformer()` — lazily prepare and synchronously transform finalized Pi message Markdown; the root and `@narumitw/pi-tui-kit/markdown` both export them plus `MermaidMarkdownTheme`.
- `runModelSelector()` and `runThinkingSelector()` — provide searchable TUI selectors with current/default markers and typed save-default intent.
- `runQuestionnaire()` — adapts choices, free-form answers, optional TUI notes, direct single-question submission, multi-question review, and sequential RPC.
- `runSecretInput()` — collects one masked TUI secret with typed cancellation and lifecycle outcomes and explicit unsupported results elsewhere.
- `formatInteractionHints()` — formats sanitized, normalized, de-duplicated bindings and literal keys; `@narumitw/pi-tui-kit/interaction-hints` also exports it and its types.
- `sanitizeTerminalDocument()` — normalizes and sanitizes untrusted multiline display text while retaining LF and tabs; `@narumitw/pi-tui-kit/terminal-document` also exports it.
- `hardWrapTerminalDocument()` — sanitizes, expands tabs, and hard-wraps exact multiline display text by terminal cells; `@narumitw/pi-tui-kit/terminal-document` also exports it.
- `sanitizeTerminalText()` — removes terminal and bidirectional controls from untrusted single-line display text without changing raw payloads; `@narumitw/pi-tui-kit/terminal-text` also exports it.
- `EditorStatusWidget` — frames passive editor status rows with a muted top rule and terminal-width guard; `@narumitw/pi-tui-kit/editor-status-widget` exports it and its options.
- `createEditorStatusPublisher` — retains one owner-scoped TUI mount and publishes plain RPC snapshots; its focused subpath is `editor-status-publisher`.
- `createEditorStatusView` — applies session-local manual modes and explicitly armed one-shot compaction; its focused subpath is `editor-status-view`.
- `createEditorStatusCollection` — holds bounded whole-snapshot items with independent presentation controls; its focused subpath is `editor-status-collection`.
- `createEditorStatusPublisher`, `createEditorStatusView`, and `createEditorStatusCollection` — optional [owner-local presentation helpers](./editor-status-presentation.md); each has a dependency-free focused subpath with the corresponding `editor-status-*` name.
- `HorizontalRule` — renders a full-width or inset horizontal divider with an optional sanitized and aligned label plus render-time style callbacks.
- `renderBoundedFrame()` and `BoundedFrameOptions` — frame preformatted rows within explicit width and height budgets, with caller-owned content priorities and no input or lifecycle ownership.
- `renderBoundedFrameLayout()`, `BoundedFrameLayout`, and `BoundedFrameContentRow` — provide the same frame with original content indexes for caller-owned coordinate mapping.
- `canonicalizeConfiguredKey()` — validates and canonicalizes configured key syntax without predicting runtime input ownership.
- `runCustomInteraction()` — owns cancellation, stale checks, exactly-once disposal, optional pending-work draining, and typed results for one custom TUI component.
- `resolveMenuScreen()` — resolves and validates a dynamic screen for tests or adapters.
- `createMenuNavigator()` — lower-level stack and selection state helper.
- exported screen, item, action, transition, runtime option, `BrowseDetailDocument`, `DocumentCopyAction`, `DocumentCopyContext`, `MenuCloseReason`, and result types; the `/document-review` subpath also exports the copy types.
- Focused interaction subpaths — `confirmation`, `custom-interaction`, `document-review`, `live-choice`, `multi-select`, `questionnaire`, `selectors`, and `task` export the matching runtime functions and types without requiring the package root.
- `@narumitw/pi-tui-kit/testing` — test-only subpath for `createTuiHarness()`, `createRpcHarness()`, strict scripts, and their types; the production root does not re-export it.
- `PI_EXTENSION_MENU_API_VERSION` — current API version (`22`).
Version 22 adds opt-in in-place full-source document copy while version-21 definitions and completion results remain valid.
Version 21 adds frame row metadata and configured-key canonicalization while version-20 definitions remain valid.
Version 20 adds focused interaction subpaths plus standalone document-review and multi-select APIs while version-19 definitions remain valid.
Version 19 adds public lazy Mermaid Markdown transformer preparation and the focused `/markdown` subpath while version-18 definitions remain valid.
Version 18 adds standard-screen mouse routing, intraline diff emphasis, searchable live choices, input prefill, and masked secret input while version-17 definitions remain valid.
Version 17 adds searchable default-aware selectors while version-16 menu definitions remain valid.
Version 16 adds the stateless bounded-frame helper while version-15 menu definitions remain valid.
Version 15 adds opt-in review and browse-detail search plus public multiline terminal-document helpers while version-14 menu definitions remain valid.
Version 14 adds the standalone `runQuestionnaire()` interaction while version-13 menu definitions remain valid.
Version 13 adds opt-in Markdown, LaTeX, and Mermaid document formatting while version-12 menu definitions remain valid.
Version 12 added optional searchable `choice` fields.
Version 11 added Live Choice confirmation-only gating.
Version 10 added exact browse detail documents.
Version 9 added `runLiveChoice()` and `formatInteractionHints()`.
Version 8 added disabled action reasons and adaptive action-label columns.
Version 7 added `runConfirmation()`.
Version 6 added the read-only `browse` screen and `runCustomInteraction()`.
