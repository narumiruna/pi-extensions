## Goal

Add a `/caffeinate` slash command to `@narumitw/pi-caffeinate` so users can choose and persist the keep-awake mode:

- `sleep`: prevent system sleep/suspend/hibernate while allowing normal display idle behavior.
- `display`: prevent system sleep and keep the screen/display awake.

Success means every supported OS defaults to `display` mode, `/caffeinate` is the only slash command for this extension, `/caffeinate` provides a menu to choose the mode, the chosen mode is saved in a user-level JSON config, restored on Pi startup/reload, reflected in status/help output, documented in the README, and mapped consistently across Linux/systemd, macOS, Windows, WSL, and Linux `caffeinate` fallback where platform support allows.

## Context

Current `extensions/pi-caffeinate/src/caffeinate.ts` starts an inhibitor on `agent_start` and stops it on `agent_end` or shutdown. The new command surface should be a single `/caffeinate` command with menu choices and direct subcommands. Current platform mappings are:

- macOS: `caffeinate -dimsu` keeps system and display awake.
- Windows/WSL: `SetThreadExecutionState(0x80000003)` keeps system and display awake.
- Linux/systemd: current branch uses `systemd-inhibit --what=sleep`, while PR #88 changes from the older `idle:sleep` behavior to allow screen blanking.
- Linux fallback: `caffeinate -dimsu` keeps system and display awake.

Existing extensions such as `pi-firecrawl` and `pi-chrome-devtools` already use user-level JSON settings under `${PI_CODING_AGENT_DIR:-~/.pi/agent}` and interactive slash-command menus.

## Architecture

- Add a small persisted settings object, for example `{ "mode": "sleep" | "display", "updatedAt": number }`, stored at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-caffeinate-settings.json`.
- Treat missing, invalid, or reset settings as `display` mode on every supported OS: prevent system sleep/suspend/hibernate and keep the display awake.
- Keep environment overrides (`PI_CAFFEINATE_DISABLED`, `PI_CAFFEINATE_COMMAND`, `PI_CAFFEINATE_ICON`) working. `PI_CAFFEINATE_COMMAND` should remain the highest-priority inhibitor command and should be reported as a custom command mode rather than rewritten by the new setting.
- Use the selected mode when building the inhibitor command. If mode changes while an inhibitor is active, restart the inhibitor so the new behavior applies immediately.
- Prefer non-secret, atomic JSON writes using the same `write temp file + rename + cleanup` pattern used by other extensions.

## Assumptions

- Default mode must be `display` on all supported OSes to prioritize uninterrupted long-running Pi work, including Linux desktops that require idle inhibition to prevent automatic suspend. Users can explicitly select `sleep` to allow the screen/display to blank or turn off.
- Backward compatibility for users who relied on display wakefulness is preserved by making `display` the default. Users who prefer screen power saving can choose `/caffeinate sleep`.
- Remove the legacy `/caffeinate-status` and `/caffeinate-stop` commands; `/caffeinate` is the single command surface, with menu choices and direct subcommands for status, mode selection, and stop.
- The Pi command API supports command completions and `ctx.ui.select()` similarly to `pi-firecrawl` and `pi-chrome-devtools`.

## Unknowns

- Resolved: macOS/Linux `caffeinate` `sleep` mode uses `-ims`, omitting display/user-active flags from `-dimsu`; documented in `extensions/pi-caffeinate/README.md`.
- Resolved: Windows `sleep` mode uses `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` (`0x80000001`), while `display` mode keeps the prior `0x80000003`; documented in `extensions/pi-caffeinate/README.md`.

## Plan

- [x] Confirm command API details for `/caffeinate` arguments, completions, and interactive `ctx.ui.select()` by comparing `extensions/pi-firecrawl/src/firecrawl.ts`, `extensions/pi-chrome-devtools/src/chrome-devtools.ts`, and Pi extension docs if needed; verified by copying the existing command handler, completion, non-UI fallback, and selector patterns into `extensions/pi-caffeinate/src/caffeinate.ts`.
- [x] Define `CaffeinateMode = "sleep" | "display"`, a single cross-platform default mode of `display`, command completions, menu labels, and settings path constants in `extensions/pi-caffeinate/src/caffeinate.ts`; verified with `npm --workspace @narumitw/pi-caffeinate run typecheck`.
- [x] Add JSON settings helpers that read, validate, normalize, and atomically write `{ mode, updatedAt }` at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-caffeinate-settings.json`, ignoring missing files and warning without crashing on invalid JSON; verified by code review of `loadSettingsIntoState()`, `normalizeCaffeinateSettings()`, and `saveSettings()` plus `npm --workspace @narumitw/pi-caffeinate run typecheck`.
- [x] Register `/caffeinate` as the only slash command, with a no-arg interactive menu and direct subcommands such as `help`, `status`, `mode`, `sleep`, `display`, and `stop`; verified by code review of `pi.registerCommand("caffeinate")`, `parseCommand()`, `showMenu()`, `showModeSelector()`, and `buildCommandGuide()` plus `npm --workspace @narumitw/pi-caffeinate run check`.
- [x] Remove `/caffeinate-status` and `/caffeinate-stop` command registrations so users access status and stop through `/caffeinate status`, `/caffeinate stop`, or the `/caffeinate` menu; verified with `rg "caffeinate-status|caffeinate-stop" extensions/pi-caffeinate/src extensions/pi-caffeinate/README.md` returning no matches.
- [x] Update inhibitor command construction to accept the selected mode: Linux/systemd uses `--what=sleep` for `sleep` and `--what=idle:sleep` for `display`; Windows/WSL uses `0x80000001` for `sleep` and `0x80000003` for `display`; macOS/Linux `caffeinate` fallback uses display-preventing flags only in `display` mode; verified by code review of `getInhibitorCommand()`, `macCaffeinateArgs()`, and `windowsInhibitorScript()` plus README platform table.
- [x] When `/caffeinate sleep` or `/caffeinate display` changes the mode, save the JSON settings and restart any active inhibitor so the new mode applies immediately; verified by code review of `setMode()` saving settings, stopping the active inhibitor, and calling `startInhibitor()` when the mode changes.
- [x] Update notifications, status text, and `describeState()` to include the selected mode and settings file path where useful; verified by code review of `describeState()`, `statusModeLabel()`, and `setMode()`.
- [x] Update `extensions/pi-caffeinate/README.md` to document `/caffeinate`, its menu, direct subcommands, persisted JSON path, mode semantics, platform mappings, and env var precedence, without documenting removed legacy commands; verified by README review and `rg "caffeinate-status|caffeinate-stop" extensions/pi-caffeinate/src extensions/pi-caffeinate/README.md` returning no matches.
- [x] Run repository verification with `npm run check`; verified passing.
- [x] Preview package contents with `just pack-caffeinate`; verified dry-run tarball contains `LICENSE`, `README.md`, `package.json`, and `src/caffeinate.ts`.

## Risks

- Platform flag semantics are not perfectly symmetric: macOS/Linux `caffeinate` and Windows expose different primitives, so `sleep` mode may not mean exactly the same thing on every OS.
- Keeping the default as display-awake uses more power and may surprise users who expect background tasks to allow screen blanking.
- Restarting an active inhibitor on mode change must avoid leaving orphaned `sleep infinity`, `caffeinate`, or PowerShell child processes.

## Rollback / Recovery

- Users can recover old display-awake behavior by running `/caffeinate display`, or by setting `PI_CAFFEINATE_COMMAND` to a custom inhibitor command.
- If the settings file is invalid or unwanted, deleting `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-caffeinate-settings.json` should restore the default `display` mode on next startup/reload.
- If implementation causes runtime problems, revert `extensions/pi-caffeinate/src/caffeinate.ts` and `extensions/pi-caffeinate/README.md`; no data migration is required because the settings file is optional and non-secret.

## Completion Checklist

- [x] `/caffeinate` is the only slash command and provides a no-arg menu plus direct subcommands, verified by code review of `extensions/pi-caffeinate/src/caffeinate.ts`, `rg "caffeinate-status|caffeinate-stop" extensions/pi-caffeinate/src extensions/pi-caffeinate/README.md` returning no matches, and `npm run check` passing.
- [x] Mode selection persists to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-caffeinate-settings.json` and restores on startup/reload, verified by `loadSettingsIntoState()`, `setMode()`, `saveSettings()`, and `npm run check` passing.
- [x] Missing/reset settings default to `display` mode on Linux/systemd, Windows/WSL, macOS, and Linux fallback, and both `sleep` and `display` modes map to documented inhibitor commands, verified by `DEFAULT_MODE = "display"`, `getInhibitorCommand()`, `macCaffeinateArgs()`, `windowsInhibitorScript()`, and the README platform table.
- [x] README documents the single `/caffeinate` command, menu, modes, config file, environment precedence, and recovery path, verified in `extensions/pi-caffeinate/README.md`.
- [x] `npm run check` passes from the repository root.
- [x] `just pack-caffeinate` dry run shows the expected package contents: `LICENSE`, `README.md`, `package.json`, and `src/caffeinate.ts`.
