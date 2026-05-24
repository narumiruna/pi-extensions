## Goal

Add a `/chrome-devtools` slash-command menu that teaches available Chrome DevTools extension commands, shows endpoint quick-start help, and can report or control the active state of individual `pi-chrome-devtools` tools without affecting unrelated Pi tools. Success means `/chrome-devtools` opens an instructional menu, users can still run direct subcommands, the five `chrome_devtools_*` tools can be selected one by one in a Plan-mode-style selector, the command itself remains available while tools are disabled, the selected tool names are saved to JSON and restored on the next Pi startup or `/reload`, and the behavior is documented and typechecked.

## Context

Research result: this is feasible with Pi's extension API. `pi.registerCommand()` creates slash commands, `ctx.ui.select()` can present a menu from a command handler, and `pi.getActiveTools()` / `pi.setActiveTools(names)` can enable or disable registered tools at runtime. Pi rebuilds the system prompt when active tools change. The current `extensions/pi-chrome-devtools/src/chrome-devtools.ts` already registers `/chrome-devtools`, but it only showed the CDP endpoint and quick-start hint before this implementation. A small JSON settings file now preserves the user's last Chrome DevTools tool selection across Pi restarts. Default behavior remains all Chrome DevTools tools enabled when the settings file is missing or unreadable.

Existing evidence:

- Pi docs: `docs/extensions.md` documents `pi.registerCommand()`, `ctx.ui.select()`, `pi.getActiveTools()`, `pi.getAllTools()`, and `pi.setActiveTools(names)`.
- Pi example: `node_modules/@mariozechner/pi-coding-agent/examples/extensions/tools.ts` implements an interactive `/tools` command with `setActiveTools()`.
- Repo precedent: `extensions/pi-plan-mode/src/plan-mode.ts` already uses `pi.setActiveTools()` to restrict and restore tools.

## Architecture

- Keep all Chrome DevTools tools registered at extension load time; use active-tool selection to hide/show them from the LLM.
- Extend the existing `/chrome-devtools` command instead of adding a second command; change the no-argument behavior to open an instructional menu.
- Preserve endpoint and launch help as a menu option so the old quick-start information remains reachable.
- Use `ctx.ui.select()` for a simple `/chrome-devtools` menu with choices for quick start, command guide, status, select tools, enable all, and disable all.
- Implement `/chrome-devtools tools` and `/chrome-devtools toggle` as aliases for a Plan-mode-style selector titled like `Chrome DevTools tools (4/5). Non-built-in tools run at user risk.` with `[x]` / `[ ]` entries for individual Chrome DevTools tools plus `Enable all`, `Disable all`, and `Done` options.
- When `ctx.hasUI` is false, make no-argument `/chrome-devtools` fall back to command-guide/status notification instead of trying to open an interactive selector; make `/chrome-devtools tools` report that interactive UI is required plus current status.
- Compute updates from the current active tool set at command time so unrelated tool choices from users or other extensions are preserved.
- Persist only selected Chrome DevTools tool names to a user-level JSON file at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json`; do not persist the full active-tool list.
- Load the JSON setting during `session_start` and apply it with the same selected-tool helper used by the command, including on `/reload`; if no valid saved setting exists, rely on Pi's normal extension-tool default, which is all Chrome DevTools tools enabled.
- Keep direct `/chrome-devtools enable` and `/chrome-devtools disable` as convenience actions that persist all Chrome DevTools tool names or an empty selected-tool list.
- Do not use a broad previous-tool restore snapshot for enable/disable/selection, because that can overwrite tool changes made by other extensions.

## Non-Goals

- Do not add Chrome process launch/kill management.
- Do not change CDP tool behavior, parameters, or output rendering.
- Do not introduce a generic all-tools UI; Pi already has a reference `/tools` extension for that pattern.

## Plan

- [x] Define a single `CHROME_DEVTOOLS_TOOL_NAMES` list in `extensions/pi-chrome-devtools/src/chrome-devtools.ts` covering `chrome_devtools_list_pages`, `chrome_devtools_select_page`, `chrome_devtools_navigate`, `chrome_devtools_evaluate`, and `chrome_devtools_screenshot`; verified by code review of `CHROME_DEVTOOLS_TOOL_NAMES` and `defineTool({ name: CHROME_DEVTOOLS_TOOL_NAMES[...] })` registrations.
- [x] Extend the `/chrome-devtools` command parser to accept `status`, `tools`, `select`, `toggle`, `enable`/`on`, `disable`/`off`, `help`, and `quickstart`; verified by code review of `parseCommand()` and README usage examples.
- [x] Implement no-argument `/chrome-devtools` as an interactive `ctx.ui.select()` menu with choices for quick start, command guide, status, select Chrome DevTools tools, enable all Chrome DevTools tools, and disable all Chrome DevTools tools, with a non-interactive `ctx.hasUI === false` fallback that shows the command guide and status; verified by Node/Jiti harness for selector action and non-UI fallback.
- [x] Implement `/chrome-devtools tools` and `/chrome-devtools toggle` as a repeated `ctx.ui.select()` selector that shows `Chrome DevTools tools (<selected>/<total>). Non-built-in tools run at user risk.`, toggles individual `[x]` / `[ ]` Chrome DevTools tool entries, and includes `Enable all Chrome DevTools tools`, `Disable all Chrome DevTools tools`, and `Done`; verified by Node/Jiti harness toggling `chrome_devtools_screenshot` from `5/5` to `4/5`.
- [x] Implement selected-tool helpers that call `pi.getActiveTools()` and `pi.setActiveTools()` to replace only `CHROME_DEVTOOLS_TOOL_NAMES` with the selected Chrome DevTools names while preserving all non-Chrome tools; verified with `npm --workspace @narumitw/pi-chrome-devtools run check`.
- [x] Add JSON settings helpers in `extensions/pi-chrome-devtools/src/chrome-devtools.ts` that read and atomically write `{ "tools": string[], "updatedAt": number }` at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json`, create the parent directory when saving, ignore missing files, normalize duplicate tool names into canonical order, accept legacy `"enabled"`/`"disabled"` values, reject unknown tool names, and warn without crashing on invalid JSON; verified by Node/Jiti harness for missing, selected, and invalid settings plus `npm --workspace @narumitw/pi-chrome-devtools run check`.
- [x] Save the JSON setting after `/chrome-devtools enable`, `/chrome-devtools disable`, and every `/chrome-devtools tools` or `/chrome-devtools toggle` selector change; verified by Node/Jiti harness inspecting the selected tool-name array in `pi-chrome-devtools-settings.json` after direct and selector actions.
- [x] Apply the saved selected-tool JSON setting on `session_start` so startup and `/reload` restore the last explicit Chrome DevTools tool selection, and default to all Chrome DevTools tools enabled when no valid settings file exists; verified by Node/Jiti harness for single-tool restore, missing/default enabled status, and invalid JSON warning/default enabled behavior.
- [x] Report command-guide and quick-start content through `ctx.ui.notify()` using concise multiline text that documents `/chrome-devtools`, `/chrome-devtools help`, `/chrome-devtools quickstart`, `/chrome-devtools status`, `/chrome-devtools tools`, `/chrome-devtools toggle`, `/chrome-devtools enable`, and `/chrome-devtools disable`; verified by Node/Jiti harness for non-UI guide fallback and `/chrome-devtools quickstart` endpoint/launch hint.
- [x] Report tool state through `ctx.ui.notify()` with active/disabled/partial runtime status, persisted selection (`default all enabled`, `all enabled`, `all disabled`, or `<n>/5 selected`), settings JSON path, and the preserved non-Chrome tool count; verified by Node/Jiti harness for `/chrome-devtools status`, disable, enable, and selector actions.
- [x] Add command argument completions for the new subcommands if the current Pi type version accepts `getArgumentCompletions`; verified by `npm --workspace @narumitw/pi-chrome-devtools run check`.
- [x] Update `extensions/pi-chrome-devtools/README.md` to document the `/chrome-devtools` menu plus `/chrome-devtools help|quickstart|status|tools|toggle|enable|disable`, clarify that disabling or deselecting tools affects LLM tool availability but not the slash command itself, and state that selected tool names are persisted in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json` and restored on Pi startup or `/reload`; verified by README review.
- [x] Run repository verification with `npm run check`; verified the command exits successfully.
- [x] Preview publish contents with `just pack-chrome-devtools`; verified the tarball includes `src/chrome-devtools.ts`, `README.md`, `LICENSE`, and `package.json`.

## Risks

- `setActiveTools()` is global for the current Pi session; another extension can later change the active tool list, so the command always patches the current list instead of restoring stale snapshots.
- Disabling tools after a provider request has already been sent cannot remove tool schemas from that in-flight request; the new active-tool set applies reliably to subsequent turns.
- Persisting a partial selection across reloads can surprise users if they forget the last selector action, so status/help output mentions the settings file and the current persisted selection.
- Other tool-management extensions can also call `setActiveTools()` on `session_start`; if they run after `pi-chrome-devtools`, their setting may override the saved Chrome DevTools state. This is documented as load-order-dependent behavior rather than trying to own the global active-tool list.

## Completion Checklist

- [x] `/chrome-devtools disable` removes all five `chrome_devtools_*` names from `pi.getActiveTools()` while preserving non-Chrome tools; verified by Node/Jiti harness showing only `read` and `bash` remain after disable.
- [x] `/chrome-devtools enable` adds the five `chrome_devtools_*` names back without duplicating names or dropping unrelated tools; verified by Node/Jiti harness checking all five tool names and unique active-tool names after enable.
- [x] `/chrome-devtools tools` and `/chrome-devtools toggle` open a Plan-mode-style selector that can enable or disable individual Chrome DevTools tools and persist the selected tool-name array; verified by Node/Jiti harness toggling `chrome_devtools_screenshot` and inspecting settings-file contents.
- [x] `/chrome-devtools` with no args opens an instructional menu whose choices show quick-start help, show command usage, report status, open the tool selector, enable all tools, and disable all tools, and falls back to non-interactive help/status when no UI is available; verified by Node/Jiti harness for interactive selector choice and non-UI fallback.
- [x] `/chrome-devtools quickstart` still shows the endpoint and launch hint; verified by Node/Jiti harness output containing `Chrome DevTools endpoint: http://127.0.0.1:9222` and `Start Chrome with remote debugging enabled:`.
- [x] Disabling Chrome DevTools tools writes an empty `"tools": []` array to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json` and the disabled state is restored after Pi restart or `/reload`; verified by settings-file inspection and `session_start` harness restore.
- [x] With no valid settings file, all Chrome DevTools tools are enabled by default; verified by missing-settings status harness and invalid-settings warning/default-enabled harness.
- [x] Enabling Chrome DevTools tools writes all five `chrome_devtools_*` names to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json` and the enabled state is restored after Pi restart or `/reload`; verified by settings-file inspection and enable harness.
- [x] A partial Chrome DevTools selection writes only selected `chrome_devtools_*` names to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json` and the partial state is restored after Pi restart or `/reload`; verified by settings-file inspection and single-tool `session_start` harness restore.
- [x] README documents the menu, direct command modes, settings JSON path, and restart/reload persistence behavior; verified in `extensions/pi-chrome-devtools/README.md`.
- [x] TypeScript and repo checks pass; verified by `npm --workspace @narumitw/pi-chrome-devtools run check` and `npm run check`.
- [x] Package dry-run passes and expected files are included; verified by `just pack-chrome-devtools` output.
