## Goal

Add a `/chrome-devtools` slash-command menu that teaches available Chrome DevTools extension commands, shows endpoint quick-start help, and can enable, disable, toggle, or report the active state of the `pi-chrome-devtools` tools without affecting unrelated Pi tools. Success means `/chrome-devtools` opens an instructional menu, users can still run direct subcommands, the five `chrome_devtools_*` tools can be turned on or off at runtime, the command itself remains available while tools are disabled, the selected tool state is saved to JSON and restored on the next Pi startup or `/reload`, and the behavior is documented and typechecked.

## Context

Research result: this is feasible with Pi's extension API. `pi.registerCommand()` creates slash commands, `ctx.ui.select()` can present a menu from a command handler, and `pi.getActiveTools()` / `pi.setActiveTools(names)` can enable or disable registered tools at runtime. Pi rebuilds the system prompt when active tools change. The current `extensions/pi-chrome-devtools/src/chrome-devtools.ts` already registers `/chrome-devtools`, but it only shows the CDP endpoint and quick-start hint. A small JSON settings file can preserve the user's last Chrome DevTools tool-state choice across Pi restarts. Default behavior remains all Chrome DevTools tools enabled when the settings file is missing or unreadable.

Existing evidence:

- Pi docs: `docs/extensions.md` documents `pi.registerCommand()`, `ctx.ui.select()`, `pi.getActiveTools()`, `pi.getAllTools()`, and `pi.setActiveTools(names)`.
- Pi example: `node_modules/@mariozechner/pi-coding-agent/examples/extensions/tools.ts` implements an interactive `/tools` command with `setActiveTools()`.
- Repo precedent: `extensions/pi-plan-mode/src/plan-mode.ts` already uses `pi.setActiveTools()` to restrict and restore tools.

## Architecture

- Keep all Chrome DevTools tools registered at extension load time; use active-tool selection to hide/show them from the LLM.
- Extend the existing `/chrome-devtools` command instead of adding a second command; change the no-argument behavior to open an instructional menu.
- Preserve endpoint and launch help as a menu option so the old quick-start information remains reachable.
- Use `ctx.ui.select()` for a simple `/chrome-devtools` menu with choices for quick start, command guide, status, enable all, disable all, and toggle all; keep per-tool checkboxes out of scope unless the user later wants individual Chrome DevTools tools toggled separately.
- When `ctx.hasUI` is false, make no-argument `/chrome-devtools` fall back to command-guide/status notification instead of trying to open an interactive selector.
- Compute updates from the current active tool set at command time so unrelated tool choices from users or other extensions are preserved.
- Persist only the Chrome DevTools group state (`"enabled"` or `"disabled"`) to a user-level JSON file at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json`; do not persist the full active-tool list.
- Load the JSON setting during `session_start` and apply it with the same add/remove helpers used by the command, including on `/reload`; if no valid saved setting exists, rely on Pi's normal extension-tool default, which is all Chrome DevTools tools enabled.
- Define toggle semantics explicitly: if all Chrome DevTools tools are currently active, toggle disables and persists `"disabled"`; if any Chrome DevTools tool is inactive, toggle enables all and persists `"enabled"`.
- Do not use a broad previous-tool restore snapshot for enable/disable, because that can overwrite tool changes made by other extensions.

## Non-Goals

- Do not add Chrome process launch/kill management.
- Do not change CDP tool behavior, parameters, or output rendering.
- Do not introduce a generic all-tools UI; Pi already has a reference `/tools` extension for that pattern.
- Do not persist per-tool Chrome DevTools selections in the first version; persistence is for the whole Chrome DevTools tool group only.

## Plan

- [ ] Define a single `CHROME_DEVTOOLS_TOOL_NAMES` list in `extensions/pi-chrome-devtools/src/chrome-devtools.ts` covering `chrome_devtools_list_pages`, `chrome_devtools_select_page`, `chrome_devtools_navigate`, `chrome_devtools_evaluate`, and `chrome_devtools_screenshot`; verify by code review that every registered Chrome DevTools tool name appears exactly once.
- [ ] Extend the `/chrome-devtools` command parser to accept `status`, `enable`/`on`, `disable`/`off`, `toggle`, `help`, and `quickstart`; verify by reading the command handler and checking README usage examples.
- [ ] Implement no-argument `/chrome-devtools` as an interactive `ctx.ui.select()` menu with choices for quick start, command guide, status, enable all Chrome DevTools tools, disable all Chrome DevTools tools, and toggle all Chrome DevTools tools, with a non-interactive `ctx.hasUI === false` fallback that shows the command guide and status; verify manually that each menu action triggers the same helper as the matching direct subcommand.
- [ ] Implement additive/removal helpers that call `pi.getActiveTools()` and `pi.setActiveTools()` to add or remove only `CHROME_DEVTOOLS_TOOL_NAMES`; verify with `npm --workspace @narumitw/pi-chrome-devtools run typecheck`.
- [ ] Add JSON settings helpers in `extensions/pi-chrome-devtools/src/chrome-devtools.ts` that read and atomically write `{ "tools": "enabled" | "disabled", "updatedAt": number }` at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json`, create the parent directory when saving, ignore missing files, and warn without crashing on invalid JSON; verify with focused code review and typecheck.
- [ ] Save the JSON setting after `/chrome-devtools enable`, `/chrome-devtools disable`, and `/chrome-devtools toggle` menu/direct actions, with toggle persisting the resulting group state (`"disabled"` when all tools were active before toggling, otherwise `"enabled"`); verify by running the commands locally and inspecting the settings file.
- [ ] Apply the saved JSON setting on `session_start` so startup and `/reload` restore the last explicit Chrome DevTools group state, and default to all Chrome DevTools tools enabled when no valid settings file exists; verify by deleting/renaming the settings file, starting Pi, and checking `/chrome-devtools status`.
- [ ] Report command-guide and quick-start content through `ctx.ui.notify()` using concise multiline text that documents `/chrome-devtools`, `/chrome-devtools help`, `/chrome-devtools quickstart`, `/chrome-devtools status`, `/chrome-devtools enable`, `/chrome-devtools disable`, and `/chrome-devtools toggle`; verify by manual run with `just try-chrome-devtools` and selecting the menu help options.
- [ ] Report tool state through `ctx.ui.notify()` with active/disabled/partial runtime status, persisted setting (`enabled`, `disabled`, or default), settings JSON path, and the preserved non-Chrome tool count; verify by manual run with `just try-chrome-devtools` and `/chrome-devtools`, `/chrome-devtools status`, `/chrome-devtools toggle`, `/chrome-devtools disable`, `/chrome-devtools enable`.
- [ ] Add command argument completions for the new subcommands if the current Pi type version accepts `getArgumentCompletions`; verify with typecheck, or mark this task not applicable if the package version lacks the type.
- [ ] Update `extensions/pi-chrome-devtools/README.md` to document the `/chrome-devtools` menu plus `/chrome-devtools help|quickstart|status|enable|disable|toggle`, clarify that disabling tools affects LLM tool availability but not the slash command itself, and state that the enable/disable choice is persisted in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json` and restored on Pi startup or `/reload`; verify by README review.
- [ ] Run repository verification with `npm run check`; verify the command exits successfully.
- [ ] Preview publish contents with `just pack-chrome-devtools`; verify the tarball includes `src/chrome-devtools.ts`, `README.md`, and `LICENSE`.

## Risks

- `setActiveTools()` is global for the current Pi session; another extension can later change the active tool list, so the command should always patch the current list instead of restoring stale snapshots.
- Disabling tools after a provider request has already been sent cannot remove tool schemas from that in-flight request; the new active-tool set applies reliably to subsequent turns.
- Persisting disabled state across reloads can surprise users if they forget the last menu action, so status/help output should mention the settings file and the current persisted state.
- Other tool-management extensions can also call `setActiveTools()` on `session_start`; if they run after `pi-chrome-devtools`, their setting may override the saved Chrome DevTools state. Document this as load-order-dependent behavior rather than trying to own the global active-tool list.

## Completion Checklist

- [ ] `/chrome-devtools disable` removes all five `chrome_devtools_*` names from `pi.getActiveTools()` while preserving non-Chrome tools; verified by manual runtime evidence or an equivalent extension-level inspection.
- [ ] `/chrome-devtools enable` adds the five `chrome_devtools_*` names back without duplicating names or dropping unrelated tools; verified by manual runtime evidence or an equivalent extension-level inspection.
- [ ] `/chrome-devtools toggle` disables all Chrome DevTools tools when all five are active, enables all five when any are inactive, and persists the resulting JSON setting; verified by runtime evidence and settings-file inspection.
- [ ] `/chrome-devtools` with no args opens an instructional menu whose choices show quick-start help, show command usage, report status, enable all tools, disable all tools, and toggle all tools, and falls back to non-interactive help/status when no UI is available; verified by manual runtime evidence or code review for the fallback.
- [ ] `/chrome-devtools quickstart` still shows the endpoint and launch hint; verified by manual runtime evidence or code review.
- [ ] Disabling Chrome DevTools tools writes `"tools": "disabled"` to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json` and the disabled state is restored after Pi restart or `/reload`; verified by settings-file inspection plus `/chrome-devtools status`.
- [ ] With no valid settings file, all Chrome DevTools tools are enabled by default; verified by deleting/renaming `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json`, restarting Pi, and checking `/chrome-devtools status`.
- [ ] Enabling Chrome DevTools tools writes `"tools": "enabled"` to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools-settings.json` and the enabled state is restored after Pi restart or `/reload`; verified by settings-file inspection plus `/chrome-devtools status`.
- [ ] README documents the menu, direct command modes, settings JSON path, and restart/reload persistence behavior; verified in `extensions/pi-chrome-devtools/README.md`.
- [ ] TypeScript and repo checks pass; verified by `npm --workspace @narumitw/pi-chrome-devtools run typecheck` and `npm run check`.
- [ ] Package dry-run passes and expected files are included; verified by `just pack-chrome-devtools` output.
