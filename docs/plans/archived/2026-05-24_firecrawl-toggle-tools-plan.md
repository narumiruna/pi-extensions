## Goal

Add a `/firecrawl` slash-command menu that teaches Firecrawl extension usage, shows configuration quick-start help, and can report or control the active state of individual `pi-firecrawl` tools without affecting unrelated Pi tools. Success means `/firecrawl` opens an instructional menu, users can still run direct subcommands, the five `firecrawl_*` tools can be selected one by one in a Plan-mode-style selector, the command itself remains available while tools are disabled, the selected tool names are saved to JSON and restored on the next Pi startup or `/reload`, and the behavior is documented and typechecked.

## Context

`extensions/pi-firecrawl/src/firecrawl.ts` previously registered five tools and a `/firecrawl` command that only reported whether `FIRECRAWL_API_KEY` was present and which API URL would be used. The extension already kept API-key values out of user-facing output, which remains true.

Research and precedent from the Chrome DevTools tool-selector implementation apply here too: Pi extension commands can use `ctx.ui.select()` for menus, and `pi.getActiveTools()` / `pi.setActiveTools(names)` can enable or disable registered tools at runtime. Pi's normal extension-tool default is enabled, so Firecrawl tools are enabled when no valid Firecrawl settings JSON exists.

Firecrawl tools managed:

- `firecrawl_scrape`
- `firecrawl_crawl`
- `firecrawl_crawl_status`
- `firecrawl_map`
- `firecrawl_search`

## Architecture

- Keep all Firecrawl tools registered at extension load time; use active-tool selection to hide/show them from the LLM.
- Extend the existing `/firecrawl` command instead of adding another command; change no-argument behavior to open an instructional menu.
- Preserve the old configuration-status behavior as a menu option and direct subcommand such as `/firecrawl config` or `/firecrawl quickstart`.
- Use `ctx.ui.select()` for a simple `/firecrawl` menu with choices for configuration quick start, command guide, tool status, select tools, enable all, and disable all.
- Implement `/firecrawl tools` and `/firecrawl toggle` as aliases for a Plan-mode-style selector titled like `Firecrawl tools (3/5). Non-built-in tools run at user risk.` with `[x]` / `[ ]` entries for individual Firecrawl tools plus `Enable all`, `Disable all`, and `Done` options.
- When `ctx.hasUI` is false, make no-argument `/firecrawl` fall back to command-guide/status notification instead of trying to open an interactive selector; make `/firecrawl tools` report that interactive UI is required plus current status.
- Compute updates from the current active tool set at command time so unrelated tool choices from users or other extensions are preserved.
- Persist only selected Firecrawl tool names to a user-level JSON file at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json`; do not persist the full active-tool list or any API key material.
- Load the JSON setting during `session_start` and apply it with the same selected-tool helper used by the command, including on `/reload`; if no valid saved setting exists, explicitly apply all Firecrawl tools to match Pi's normal extension-tool default.
- Keep direct `/firecrawl enable` and `/firecrawl disable` as convenience actions that persist all Firecrawl tool names or an empty selected-tool list.
- Do not use a broad previous-tool restore snapshot for enable/disable/selection, because that can overwrite tool changes made by other extensions.

## Non-Goals

- Do not add Firecrawl API-key storage, login, or secret management.
- Do not change Firecrawl API request behavior, parameters, result shapes, or output rendering.
- Do not introduce a generic all-tools UI; Pi already has a reference `/tools` extension for that pattern.

## Plan

- [x] Define a single `FIRECRAWL_TOOL_NAMES` list in `extensions/pi-firecrawl/src/firecrawl.ts` covering `firecrawl_scrape`, `firecrawl_crawl`, `firecrawl_crawl_status`, `firecrawl_map`, and `firecrawl_search`; verified by code review that every registered Firecrawl tool name uses `FIRECRAWL_TOOL_NAMES[...]`.
- [x] Extend the `/firecrawl` command parser to accept `status`, `tools`, `select`, `toggle`, `enable`/`on`, `disable`/`off`, `help`, `config`, and `quickstart`; verified by code review of `parseCommand()` and README usage examples.
- [x] Implement no-argument `/firecrawl` as an interactive `ctx.ui.select()` menu with choices for configuration quick start, command guide, tool status, select Firecrawl tools, enable all Firecrawl tools, and disable all Firecrawl tools, with a non-interactive `ctx.hasUI === false` fallback that shows the command guide and status; verified by Node/Jiti harness for non-UI fallback and selector behavior.
- [x] Implement `/firecrawl tools` and `/firecrawl toggle` as a repeated `ctx.ui.select()` selector that shows `Firecrawl tools (<selected>/<total>). Non-built-in tools run at user risk.`, toggles individual `[x]` / `[ ]` Firecrawl tool entries, and includes `Enable all Firecrawl tools`, `Disable all Firecrawl tools`, and `Done`; verified by Node/Jiti harness toggling `firecrawl_search` from `5/5` to `4/5`.
- [x] Implement selected-tool helpers that call `pi.getActiveTools()` and `pi.setActiveTools()` to replace only `FIRECRAWL_TOOL_NAMES` with the selected Firecrawl names while preserving all non-Firecrawl tools; verified with `npm --workspace @narumitw/pi-firecrawl run check`.
- [x] Add JSON settings helpers in `extensions/pi-firecrawl/src/firecrawl.ts` that read and atomically write `{ "tools": string[], "updatedAt": number }` at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json`, create the parent directory when saving, ignore missing files, normalize duplicate tool names into canonical order, reject unknown tool names, and warn without crashing on invalid JSON; verified by Node/Jiti harness for duplicate normalization, selected restore, missing/default enabled, and invalid JSON warning/default enabled behavior.
- [x] Save the JSON setting after `/firecrawl enable`, `/firecrawl disable`, and every `/firecrawl tools` or `/firecrawl toggle` selector change; verified by Node/Jiti harness inspecting the selected tool-name array in the settings file.
- [x] Apply the saved selected-tool JSON setting on `session_start` so startup and `/reload` restore the last explicit Firecrawl tool selection, and default to all Firecrawl tools enabled when no valid settings file exists; verified by Node/Jiti harness for partial restore, missing/default enabled, and invalid JSON warning/default enabled behavior.
- [x] Report configuration quick-start content through `ctx.ui.notify()` without displaying the API key value, including API-key presence, API URL, `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL`, and `FIRECRAWL_BASE_URL`; verified by Node/Jiti harness with `FIRECRAWL_API_KEY=fc-secret-do-not-print` and without `FIRECRAWL_API_KEY` set.
- [x] Report command-guide content through `ctx.ui.notify()` using concise multiline text that documents `/firecrawl`, `/firecrawl help`, `/firecrawl config`, `/firecrawl quickstart`, `/firecrawl status`, `/firecrawl tools`, `/firecrawl toggle`, `/firecrawl enable`, and `/firecrawl disable`; verified by Node/Jiti harness for non-UI menu fallback and README review.
- [x] Report tool state through `ctx.ui.notify()` with active/disabled/partial runtime status, persisted selection (`default all enabled`, `all enabled`, `all disabled`, or `<n>/5 selected`), settings JSON path, API-key presence, API URL, and the preserved non-Firecrawl tool count; verified by Node/Jiti harness for `/firecrawl status`, enable, disable, selector, and config actions.
- [x] Add command argument completions for the new subcommands if the current Pi type version accepts `getArgumentCompletions`; verified by `npm --workspace @narumitw/pi-firecrawl run check`.
- [x] Update `extensions/pi-firecrawl/README.md` to document the `/firecrawl` menu plus `/firecrawl help|config|quickstart|status|tools|toggle|enable|disable`, clarify that disabling or deselecting tools affects LLM tool availability but not the slash command itself, state that the selected tool names are persisted in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json` and restored on Pi startup or `/reload`, and repeat that API keys are never logged or stored by this feature; verified by README review.
- [x] Run repository verification with `npm run check`; verified the command exits successfully.
- [x] Preview publish contents with `just pack-firecrawl`; verified the tarball includes `src/firecrawl.ts`, `README.md`, `LICENSE`, and `package.json`.

## Risks

- `setActiveTools()` is global for the current Pi session; another extension can later change the active tool list, so the command always patches the current list instead of restoring stale snapshots.
- Disabling tools after a provider request has already been sent cannot remove tool schemas from that in-flight request; the new active-tool set applies reliably to subsequent turns.
- Persisting a partial selection across reloads can surprise users if they forget the last selector action, so status/help output mentions the settings file and the current persisted selection.
- Other tool-management extensions can also call `setActiveTools()` on `session_start`; if they run after `pi-firecrawl`, their setting may override the saved Firecrawl state. This is documented as load-order-dependent behavior rather than trying to own the global active-tool list.
- The settings JSON does not contain `FIRECRAWL_API_KEY` or request headers; only selected tool names and timestamp are persisted.

## Completion Checklist

- [x] `/firecrawl disable` removes all five `firecrawl_*` names from `pi.getActiveTools()` while preserving non-Firecrawl tools; verified by Node/Jiti harness showing only `read` and `bash` remain after disable.
- [x] `/firecrawl enable` adds the five `firecrawl_*` names back without duplicating names or dropping unrelated tools; verified by Node/Jiti harness checking all five tool names and unique active-tool names after enable.
- [x] `/firecrawl tools` and `/firecrawl toggle` open a Plan-mode-style selector that can enable or disable individual Firecrawl tools and persist the selected tool-name array; verified by Node/Jiti harness toggling `firecrawl_search` and inspecting settings-file contents.
- [x] `/firecrawl` with no args opens an instructional menu whose choices show configuration quick start, show command usage, report status, open the tool selector, enable all tools, and disable all tools, and falls back to non-interactive help/status when no UI is available; verified by Node/Jiti harness for non-UI fallback and selector behavior.
- [x] `/firecrawl config` or `/firecrawl quickstart` still shows API-key presence and API URL without exposing the API key value; verified by Node/Jiti harness with `FIRECRAWL_API_KEY=fc-secret-do-not-print` and without `FIRECRAWL_API_KEY` set.
- [x] Disabling Firecrawl tools writes an empty `"tools": []` array to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json` and the disabled state is restored after Pi restart or `/reload`; verified by settings-file inspection and disable harness.
- [x] With no valid settings file, all Firecrawl tools are enabled by default; verified by missing-settings restore harness and invalid-settings warning/default-enabled harness.
- [x] Enabling Firecrawl tools writes all five `firecrawl_*` names to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json` and the enabled state is restored after Pi restart or `/reload`; verified by settings-file inspection and enable harness.
- [x] A partial Firecrawl selection writes only the selected `firecrawl_*` names to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json` and the partial state is restored after Pi restart or `/reload`; verified by selector settings-file inspection and partial `session_start` restore harness.
- [x] README documents the menu, direct command modes, settings JSON path, restart/reload persistence behavior, and no-secret-storage constraint; verified in `extensions/pi-firecrawl/README.md`.
- [x] TypeScript and repo checks pass; verified by `npm --workspace @narumitw/pi-firecrawl run check` and `npm run check`.
- [x] Package dry-run passes and expected files are included; verified by `just pack-firecrawl` output.
