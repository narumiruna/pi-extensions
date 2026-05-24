## Goal

Add a `/firecrawl` slash-command menu that teaches Firecrawl extension usage, shows configuration quick-start help, and can enable, disable, toggle, or report the active state of the `pi-firecrawl` tools without affecting unrelated Pi tools. Success means `/firecrawl` opens an instructional menu, users can still run direct subcommands, the five `firecrawl_*` tools can be turned on or off at runtime, the command itself remains available while tools are disabled, the selected tool state is saved to JSON and restored on the next Pi startup or `/reload`, and the behavior is documented and typechecked.

## Context

`extensions/pi-firecrawl/src/firecrawl.ts` currently registers five tools and a `/firecrawl` command. The command only reports whether `FIRECRAWL_API_KEY` is present and which API URL will be used. The extension already keeps API-key values out of user-facing output, which must remain true.

Research and precedent from `docs/plans/2026-05-24_chrome-devtools-toggle-tools-plan.md` apply here too: Pi extension commands can use `ctx.ui.select()` for menus, and `pi.getActiveTools()` / `pi.setActiveTools(names)` can enable or disable registered tools at runtime. Pi's normal extension-tool default is enabled, so Firecrawl tools should be enabled when no valid Firecrawl settings JSON exists.

Firecrawl tools to manage as one group:

- `firecrawl_scrape`
- `firecrawl_crawl`
- `firecrawl_crawl_status`
- `firecrawl_map`
- `firecrawl_search`

## Architecture

- Keep all Firecrawl tools registered at extension load time; use active-tool selection to hide/show them from the LLM.
- Extend the existing `/firecrawl` command instead of adding another command; change no-argument behavior to open an instructional menu.
- Preserve the old configuration-status behavior as a menu option and direct subcommand such as `/firecrawl config` or `/firecrawl quickstart`.
- Use `ctx.ui.select()` for a simple `/firecrawl` menu with choices for configuration quick start, command guide, tool status, enable all, disable all, and toggle all; keep per-tool checkboxes out of scope unless the user later wants individual Firecrawl tools toggled separately.
- When `ctx.hasUI` is false, make no-argument `/firecrawl` fall back to command-guide/status notification instead of trying to open an interactive selector.
- Compute updates from the current active tool set at command time so unrelated tool choices from users or other extensions are preserved.
- Persist only the Firecrawl group state (`"enabled"` or `"disabled"`) to a user-level JSON file at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json`; do not persist the full active-tool list or any API key material.
- Load the JSON setting during `session_start` and apply it with the same add/remove helpers used by the command, including on `/reload`; if no valid saved setting exists, rely on Pi's normal extension-tool default, which is all Firecrawl tools enabled.
- Define toggle semantics explicitly: if all Firecrawl tools are currently active, toggle disables and persists `"disabled"`; if any Firecrawl tool is inactive, toggle enables all and persists `"enabled"`.
- Do not use a broad previous-tool restore snapshot for enable/disable, because that can overwrite tool changes made by other extensions.

## Non-Goals

- Do not add Firecrawl API-key storage, login, or secret management.
- Do not change Firecrawl API request behavior, parameters, result shapes, or output rendering.
- Do not introduce a generic all-tools UI; Pi already has a reference `/tools` extension for that pattern.
- Do not persist per-tool Firecrawl selections in the first version; persistence is for the whole Firecrawl tool group only.

## Plan

- [ ] Define a single `FIRECRAWL_TOOL_NAMES` list in `extensions/pi-firecrawl/src/firecrawl.ts` covering `firecrawl_scrape`, `firecrawl_crawl`, `firecrawl_crawl_status`, `firecrawl_map`, and `firecrawl_search`; verify by code review that every registered Firecrawl tool name appears exactly once.
- [ ] Extend the `/firecrawl` command parser to accept `status`, `enable`/`on`, `disable`/`off`, `toggle`, `help`, `config`, and `quickstart`; verify by reading the command handler and checking README usage examples.
- [ ] Implement no-argument `/firecrawl` as an interactive `ctx.ui.select()` menu with choices for configuration quick start, command guide, tool status, enable all Firecrawl tools, disable all Firecrawl tools, and toggle all Firecrawl tools, with a non-interactive `ctx.hasUI === false` fallback that shows the command guide and status; verify manually that each menu action triggers the same helper as the matching direct subcommand.
- [ ] Implement additive/removal helpers that call `pi.getActiveTools()` and `pi.setActiveTools()` to add or remove only `FIRECRAWL_TOOL_NAMES`; verify with `npm --workspace @narumitw/pi-firecrawl run typecheck`.
- [ ] Add JSON settings helpers in `extensions/pi-firecrawl/src/firecrawl.ts` that read and atomically write `{ "tools": "enabled" | "disabled", "updatedAt": number }` at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json`, create the parent directory when saving, ignore missing files, and warn without crashing on invalid JSON; verify with focused code review and typecheck.
- [ ] Save the JSON setting after `/firecrawl enable`, `/firecrawl disable`, and `/firecrawl toggle` menu/direct actions, with toggle persisting the resulting group state (`"disabled"` when all tools were active before toggling, otherwise `"enabled"`); verify by running the commands locally and inspecting the settings file.
- [ ] Apply the saved JSON setting on `session_start` so startup and `/reload` restore the last explicit Firecrawl group state, and default to all Firecrawl tools enabled when no valid settings file exists; verify by deleting/renaming the settings file, starting Pi, and checking `/firecrawl status`.
- [ ] Report configuration quick-start content through `ctx.ui.notify()` without displaying the API key value, including API-key presence, API URL, `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL`, and `FIRECRAWL_BASE_URL`; verify manually with and without `FIRECRAWL_API_KEY` set.
- [ ] Report command-guide content through `ctx.ui.notify()` using concise multiline text that documents `/firecrawl`, `/firecrawl help`, `/firecrawl config`, `/firecrawl quickstart`, `/firecrawl status`, `/firecrawl enable`, `/firecrawl disable`, and `/firecrawl toggle`; verify by manual run with `just try-firecrawl` and selecting the menu help options.
- [ ] Report tool state through `ctx.ui.notify()` with active/disabled/partial runtime status, persisted setting (`enabled`, `disabled`, or default), settings JSON path, API-key presence, API URL, and the preserved non-Firecrawl tool count; verify by manual run with `just try-firecrawl` and `/firecrawl`, `/firecrawl status`, `/firecrawl toggle`, `/firecrawl disable`, `/firecrawl enable`.
- [ ] Add command argument completions for the new subcommands if the current Pi type version accepts `getArgumentCompletions`; verify with typecheck, or mark this task not applicable if the package version lacks the type.
- [ ] Update `extensions/pi-firecrawl/README.md` to document the `/firecrawl` menu plus `/firecrawl help|config|quickstart|status|enable|disable|toggle`, clarify that disabling tools affects LLM tool availability but not the slash command itself, state that the enable/disable choice is persisted in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json` and restored on Pi startup or `/reload`, and repeat that API keys are never logged or stored by this feature; verify by README review.
- [ ] Run repository verification with `npm run check`; verify the command exits successfully.
- [ ] Preview publish contents with `just pack-firecrawl`; verify the tarball includes `src/firecrawl.ts`, `README.md`, and `LICENSE`.

## Risks

- `setActiveTools()` is global for the current Pi session; another extension can later change the active tool list, so the command should always patch the current list instead of restoring stale snapshots.
- Disabling tools after a provider request has already been sent cannot remove tool schemas from that in-flight request; the new active-tool set applies reliably to subsequent turns.
- Persisting disabled state across reloads can surprise users if they forget the last menu action, so status/help output should mention the settings file and the current persisted state.
- Other tool-management extensions can also call `setActiveTools()` on `session_start`; if they run after `pi-firecrawl`, their setting may override the saved Firecrawl state. Document this as load-order-dependent behavior rather than trying to own the global active-tool list.
- The settings JSON must not contain `FIRECRAWL_API_KEY` or request headers; only the tool-group state and timestamp should be persisted.

## Completion Checklist

- [ ] `/firecrawl disable` removes all five `firecrawl_*` names from `pi.getActiveTools()` while preserving non-Firecrawl tools; verified by manual runtime evidence or an equivalent extension-level inspection.
- [ ] `/firecrawl enable` adds the five `firecrawl_*` names back without duplicating names or dropping unrelated tools; verified by manual runtime evidence or an equivalent extension-level inspection.
- [ ] `/firecrawl toggle` disables all Firecrawl tools when all five are active, enables all five when any are inactive, and persists the resulting JSON setting; verified by runtime evidence and settings-file inspection.
- [ ] `/firecrawl` with no args opens an instructional menu whose choices show configuration quick start, show command usage, report status, enable all tools, disable all tools, and toggle all tools, and falls back to non-interactive help/status when no UI is available; verified by manual runtime evidence or code review for the fallback.
- [ ] `/firecrawl config` or `/firecrawl quickstart` still shows API-key presence and API URL without exposing the API key value; verified by manual runtime evidence or code review.
- [ ] Disabling Firecrawl tools writes `"tools": "disabled"` to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json` and the disabled state is restored after Pi restart or `/reload`; verified by settings-file inspection plus `/firecrawl status`.
- [ ] With no valid settings file, all Firecrawl tools are enabled by default; verified by deleting/renaming `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json`, restarting Pi, and checking `/firecrawl status`.
- [ ] Enabling Firecrawl tools writes `"tools": "enabled"` to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl-settings.json` and the enabled state is restored after Pi restart or `/reload`; verified by settings-file inspection plus `/firecrawl status`.
- [ ] README documents the menu, direct command modes, settings JSON path, restart/reload persistence behavior, and no-secret-storage constraint; verified in `extensions/pi-firecrawl/README.md`.
- [ ] TypeScript and repo checks pass; verified by `npm --workspace @narumitw/pi-firecrawl run typecheck` and `npm run check`.
- [ ] Package dry-run passes and expected files are included; verified by `just pack-firecrawl` output.
