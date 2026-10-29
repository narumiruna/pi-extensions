# @narumitw/pi-starship

## 0.64.3

### Patch Changes

- da96231: Keep ambiguous legacy Backspace input with the configuration chat editor instead of treating it as a cancel shortcut. Preserve explicitly encoded cancellation keys, native editing and viewport precedence, and normal response cancellation.

## 0.64.2

### Patch Changes

- Updated dependencies [a21d39b]
- Updated dependencies [f68aa54]
- Updated dependencies [b062d21]
  - @narumitw/pi-tui-kit@0.68.0

## 0.64.1

### Patch Changes

- 57eeae7: Add the opt-in `createFullscreenHandoff()` resource and native test harness. Share terminal entry/exit drain, cancellation-safe restoration, keyboard-protocol recovery, owned overlay handling, and cleanup errors through public Pi TUI APIs. Keep ordinary Kit interactions unchanged.
  
  Use the resource in Starship's configuration chat and BTW's multi-screen workspace. Keep each extension's input policy, layouts, domain state, permissions, and persistence local. BTW now waits for native input drain before entry. Changesets raises both consumer floors to the Kit API release; dependent publication requires its exact registry artifact.
- b46fd49: Put Apply first in profile actions, followed by Review TOML, Edit TOML, Duplicate, Rename, and Delete. Keep the apply confirmation and History action order unchanged.
- Updated dependencies [57eeae7]
  - @narumitw/pi-tui-kit@0.67.0

## 0.64.0

### Minor Changes

- 31774d2: Move configuration chat to a Starship-owned `TuiAltScreen` with native `ScrollView` history and a fixed editor/preview dock. Suspend the parent TUI while the chat owns the shared terminal and restore ownership before review and save screens. Await native input drain before entering the chat and before returning to the parent. Recheck ownership after entry drain, join cancelled entry work, and restore keyboard protocols if entry is cancelled or fails.
  
  History paging now uses `tui.altScreen.pageUp` and `tui.altScreen.pageDown` instead of `tui.editor.pageUp` and `tui.editor.pageDown`; move custom history paging bindings to the viewport actions. Agent behavior, draft permissions, and settings/profile storage are unchanged.
  
  Align tool displays with Pi's built-in message/tool event lifecycle, including streamed arguments, partial results, native edit previews, final diffs, errors, and per-tool clicks. Seed expansion from the parent once and keep subsequent changes local across review. Restrict preview reads to the owned draft and prevent late native preview callbacks from redrawing disposed UI.
  
  Document the intentional deviation from Pi's single-renderer guidance and the required lifecycle and physical-terminal checks. This change does not establish a diagnosis or verified fix for the originally reported wheel/key failure.

## 0.63.0

### Minor Changes

- 7e6690c: Restore Pi's native footer from Restore built-in… instead of saving the Starship example. Keep the previous settings bytes in History before removing the active file. Missing settings now leave the native footer active, and presets can still be applied without reloading. Native-mode previews use cached data and do not start collectors until custom settings are applied.

### Patch Changes

- 9af45da: Align configuration-chat hints with Pi core: use lowercase key names and “to” action descriptions, and replace the ambiguous cancellation label with “esc to interrupt” when Escape is available.
- 584d57b: Keep the configuration chat open on idle Escape instead of opening a review menu. Escape still stops an active response, save shortcuts still open exact-draft review, and Ctrl+C still discards the chat.
- 06c8567: Allow scrolling configuration chat history with the mouse wheel and configured Editor page-up/page-down keys. Keep the history position stable while new output arrives and resume following output at the bottom.
- 71a7a29: Support collapsing and expanding configuration-chat tool output with Pi’s app.tools.expand action (Ctrl+O by default), without changing the main conversation. Preserve the local display state across new tool output and theme invalidation.

## 0.62.0

### Minor Changes

- eb69a7c: Simplify the footer menu around agent-assisted configuration, presets, profiles, and recovery. Show configuration health and warnings inline, and give the configuration chat read-only opening snapshots of loaded settings and module state. Keep the existing settings editor command and all review, confirmation, Gist, and History safeguards.
- 047c6b0: Add a separate fullscreen configuration chat with native Pi message rendering, the bundled skill, and draft-only read, write, and edit tools. Native steering, follow-up, and dequeue actions support messages submitted during a response, with undelivered input restored on cancellation or failure. A direct save shortcut opens reviewed profile creation and shows its active key on the editor border. Hard cancellation restores the active footer without redrawing a replaced session. Short gray editor-border labels show status and controls. Valid edits appear immediately without reload in a bottom-aligned footer preview; the user reviews and saves the draft as a named profile before a separate apply confirmation can change active settings, with History and conflict checks. Declining or failing application retains the saved profile.

### Patch Changes

- 55502a4: Remove the trailing ellipsis from Configure with agent to match other menu-opening labels. Keep the existing conversation, preview, and save behavior unchanged.

## 0.61.0

### Minor Changes

- dee7381: Expand Git, directory, time, language, environment, and Kubernetes settings while preserving existing default footer output. Add bounded version and regex formatting, nested configuration round-tripping, and opt-in Jujutsu, system memory, and Linux battery modules. Keep collectors read-only, cancellable, and separate from rendering.
  
  Custom version formats now use formatter variable boundaries and escapes: use `${raw}_suffix` for appended identifier text and `\$` for a literal dollar sign. The existing `v$raw` default remains unchanged.

## 0.60.1

### Patch Changes

- ee1b9ca: Fix the configuration skill path resolver for managed extension installs with a separate npm or Bun global Pi installation. Resolve the public Pi API beside the first Pi executable on PATH when the host peer is absent from the skill module tree, preserve the original working directory, and stop with actionable guidance instead of guessing a settings path.

## 0.60.0

### Minor Changes

- 8e0942f: Add `pi:<role>` color references for exact public Pi theme roles in styles and palette values. Foreground and background colors follow Pi theme switches and hot reload without reloading TOML, while style modifiers, fixed colors, defaults, and palette-key precedence remain unchanged. Invalid Pi roles report settings diagnostics in either color position.
- e7f5df0: Add named TOML profiles with live selection previews, editing, switching, renaming, duplication, and deletion. Preserve replaced settings in recovery history and expose existing skill backups without changing the active settings path or command routes.

## 0.59.2

### Patch Changes

- 79aca63: Enable existing TUI document search in Starship effective/raw TOML reviews, Recall non-destructive message previews, and Tool exact detail documents.
  
  Use a verified published Kit search release without changing raw content, persistence, confirmation, navigation, or RPC pagination. New Kit copy APIs remain outside these consumer changes.
- Updated dependencies [077137a]
- Updated dependencies [9f80b89]
- Updated dependencies [efc474c]
  - @narumitw/pi-tui-kit@0.66.0

## 0.59.1

### Patch Changes

- 2e333f1: Rename the bundled configuration skill to `configure-pi-starship`.
  Use `/skill:configure-pi-starship` instead of `/skill:configuring-pi-starship`.

## 0.59.0

### Minor Changes

- 6d645f9: Add unlisted GitHub Gist sharing and reviewed settings import to the Configuration menu through GitHub CLI. Import validates and previews TOML before confirmed replacement, with cancellation, bounded requests, and stale-settings protection.

## 0.58.0

### Minor Changes

- ba40826: Allow per-status colors in `extension_status.styles` using exact Pi status keys, explicit namespace wildcards, and an optional fallback style.

## 0.57.0

### Minor Changes

- 229ebe9: Show raw Pi model IDs by default. Add `model.shorten_model = true` to opt in to shortening, without changing `gpt-` to `gpt `.

## 0.56.3

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.56.2

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.56.1

### Patch Changes

- a2803d2: Import the TOML parser instead of resolving it through `createRequire` so settings load under a compiled Pi binary, whose Jiti loader resolves a call-time `require` against the binary's embedded modules rather than the directory the package was installed into. The runtime build now refuses a generated chunk that resolves a package at call time, and the package has the Jiti-loader test its siblings already carry.

## 0.56.0

### Minor Changes

- ff31206: Add ordered exact-match style rules for the provider, model, and thinking modules.

### Patch Changes

- 5e61ff4: Keep timestamped long-term backups when the bundled configuration skill replaces an existing pi-starship document.

## 0.55.2

### Patch Changes

- d365daa: Publish the updated YAML runtime dependency range.
- Updated dependencies [d365daa]
  - @narumitw/pi-tui-kit@0.63.1

## 0.55.1

### Patch Changes

- c5c0151: Avoid periodic TUI redraw requests when cached footer snapshots are unchanged, while preserving clock updates without rescanning session history on idle ticks.

## 0.55.0

### Minor Changes

- f1fffcb: Bundle an authoritative configuration skill with detailed schema, module, runtime, and security references for answering pi-starship setup questions and safely editing or syntax-checking `pi-starship.toml`.

## 0.54.0

### Minor Changes

- b87641b: Show when Pi is waiting for blocking extension UI input and restore the underlying activity after the prompt closes.
  
  Expose `waiting`, `$kind`, and `$title` through pi-starship's activity module.

### Patch Changes

- 36a5ad5: Honor Pi's effective terminal capabilities when rendering pull request hyperlinks and RGB footer colors.

## 0.53.0

### Minor Changes

- ca3491a: Add per-level `thinking` styles that preserve the existing `style` fallback, and add exact terminal-safe `provider_aliases` for provider display names.

## 0.52.3

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.52.2

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.52.1

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.52.0

### Minor Changes

- 7a61fe5: Add nested configuration views for effective public TOML and the exact loaded settings document, plus a validated preview-and-confirm reload workflow for external edits and file removal.

### Patch Changes

- Updated dependencies [f47364f]
  - @narumitw/pi-tui-kit@0.56.1

## 0.51.5

### Patch Changes

- 37bf862: Load the extension from a generated split TypeScript runtime to reduce Jiti package startup work while preserving lazy command and collector boundaries.

## 0.51.4

### Patch Changes

- 5f0ccd3: Load lightweight Pi TUI Kit helpers without evaluating the full menu runtime during extension startup.

## 0.51.3

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.51.2

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.51.1

### Patch Changes

- 11bdf1e: Update runtime dependencies for chat networking, Starship TOML parsing, and TUI syntax highlighting.
- Updated dependencies [11bdf1e]
  - @narumitw/pi-tui-kit@0.54.1

## 0.51.0

### Minor Changes

- ff35763: Render the existing native GitHub PR `$checks`, `$review`, and `$status` variables as compact symbols and counts by default.

  This is a breaking display change for custom formats that expect the previous English values; variable names and the default module format remain unchanged.

## 0.50.3

### Patch Changes

- c3721fd: Reuse Pi TUI Kit's display-only terminal sanitizer for model, symbol, and directory text.

## 0.50.2

### Patch Changes

- d403f3c: Use Pi TUI Kit's published Live Choice interaction for preset browsing while keeping active-preset customization available.

## 0.50.1

### Patch Changes

- 306a4e5: Use Pi TUI Kit's standard adaptive review screen for the read-only footer explanation while keeping inspection snapshots and formatting in Starship.
- Updated dependencies [4a0358b]
- Updated dependencies [93b507b]
  - @narumitw/pi-tui-kit@0.53.0

## 0.50.0

### Minor Changes

- 46f59ba: Add four bundled Pi-native footer presets with menu browsing, live preview, optional TOML customization, confirmed atomic application, and built-in recovery.
