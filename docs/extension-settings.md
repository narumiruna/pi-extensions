# Extension settings conventions

Use these conventions when an extension owns user-facing configuration. Keep packages independently
installable: each package owns its loader, validator, persistence, UI, tests, and migration code.

## File names and locations

Name the active user JSON file after the unscoped package name and use the same basename for project
overrides:

```text
<getAgentDir()>/<unscoped-package-name>.json
<workspace>/<CONFIG_DIR_NAME>/<unscoped-package-name>.json
```

For example:

```text
~/.pi/agent/pi-lsp.json
<workspace>/.pi/pi-lsp.json
```

- Use `getAgentDir()` instead of reconstructing `~/.pi/agent` or reading
  `PI_CODING_AGENT_DIR` directly.
- Use `CONFIG_DIR_NAME` instead of hard-coding `.pi`.
- Check `ctx.isProjectTrusted()` before honoring project settings.
- Do not place mutable settings under an `extensions/` source directory.
- Do not add `-config` or `-settings` to a new active filename.
- Use variants such as `.local` or state filenames only when they describe a concrete storage
  semantic. Credential sensitivity changes permissions and migration handling, not the basename.

## Terminology and commands

Call user-editable preferences **settings** in new code and UI. Use names such as `Settings`,
`loadSettings()`, `saveSettings()`, and `normalizeSettings()`. Existing `config` names may remain when
renaming would break compatibility or when configuration describes a distinct connection or setup
workflow.

An extension with user-facing settings should expose Settings, Status, and Help as actions in its
primary command's no-argument menu. Add documented direct subcommands only for a concrete payload,
supported non-TUI workflow, compatibility requirement, or frequent unambiguous primary action, as
defined in [`docs/extension-conventions.md`](extension-conventions.md).

`config` may remain as a documented compatibility alias. Do not register a generic `/settings`
command that competes with Pi's built-in command.

## Interactive settings UI

Extensions with multiple directly editable settings should provide a screen matching Pi's built-in
`/settings` interaction pattern. In TUI mode:

- Open the Settings menu action with `ctx.ui.custom()`.
- Use `SettingsList` from `@earendil-works/pi-tui` with `getSettingsListTheme()` from
  `@earendil-works/pi-coding-agent`; do not rebuild an equivalent selector or reopen
  `ctx.ui.select()` after every toggle, because doing so resets the cursor.
- Represent booleans, enums, and small bounded choices directly as rows.
- Give each row a clear label, current effective value, and concise description.
- Enable search when the list can become difficult to scan.
- Follow the built-in keyboard behavior: arrows navigate, Enter or Space changes a value, typing
  searches when enabled, and Escape closes the screen.
- Apply and persist a change immediately unless the setting belongs to an explicitly transactional
  workflow. Do not label Escape as rollback when earlier changes are already saved.
- Serialize saves in user action order and keep the queue usable after each failure. If persistence
  or runtime application fails, restore the previous displayed and effective value and notify the
  user.
- Use a `submenu`, `ctx.ui.input()`, or `ctx.ui.editor()` for free-form or complex values instead of
  forcing them into a value cycle.
- Use the callback-provided theme and keybindings, and request a render after state changes.

A primary extension command invoked without arguments should open a small main menu containing
Settings, Status, and Help. If the extension has a justified direct settings route, it should open the
same settings screen rather than a second implementation.

Minimal structure:

```ts
import {
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

async function showSettings(ctx: ExtensionCommandContext) {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${settingsFilePath()}`, "info");
    return;
  }

  const items: SettingItem[] = [
    {
      id: "enabled",
      label: "Enabled",
      description: "Enable this extension for new sessions",
      currentValue: settings.enabled ? "true" : "false",
      values: ["true", "false"],
    },
  ];

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Extension Settings")), 1, 1));

    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => void queueSettingsChange(id, value),
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
```

The sample omits extension-specific validation, serialized persistence, rollback, and runtime
application; production implementations must provide them.

## Scope and precedence

When both scopes are supported, resolve effective settings in this order:

```text
defaults -> user settings -> trusted project overrides -> explicit runtime override
```

- Merge objects by recognized field; project arrays replace user arrays unless the setting documents
  another behavior.
- Write only explicit project overrides, not a copy of inherited user settings.
- Make the edited scope and inherited values clear before saving project overrides.
- Prefer the canonical user JSON file for user-facing settings and extension-managed credentials.

## Environment variables

- Do not introduce extension-specific environment variables unless the user or maintainer explicitly
  requires them.
- Do not speculatively mirror JSON fields into environment variables.
- Existing environment variables may remain for backward compatibility; do not treat them as a
  template for new extensions.
- Pi infrastructure variables such as `PI_CODING_AGENT_DIR` are not extension-specific settings.
  Consume their effects through Pi APIs such as `getAgentDir()` rather than reading them directly.
- When an explicitly required environment variable overrides a file value, document its precedence,
  show the effective source without exposing the value, and test both sources.

## Loading, validation, and persistence

- Treat a missing file as defaults, not an error.
- Require a JSON object at the top level and validate values at runtime.
- Warn when invalid settings are ignored; do not silently overwrite an invalid file.
- Preserve unknown fields during UI saves and migrations so older versions do not erase
  forward-compatible data.
- Write atomically through a temporary file in the destination directory followed by rename.
- Keep the previous file and effective runtime settings when a write fails.
- Reload settings on `session_start`, including starts caused by `/reload` and session replacement.
- Document defaults, precedence, paths, reload behavior, and accepted values in the package README.

For a filename migration, prefer the canonical file when both names exist. Validate legacy content,
copy its original JSON bytes to the canonical path, install it without overwriting a concurrently
created canonical file, and remove the legacy file only after confirming it did not change.

## Secrets and status output

- Store extension-managed credentials in the canonical user JSON settings file by default; do not
  create a differently named credential file solely because its contents are sensitive.
- Use Pi/provider authentication instead only when the product intentionally delegates credential
  management to Pi or the provider. Follow the environment-variable policy above for environment
  credentials.
- Never place secrets in project settings intended for source control.
- Create, migrate, and replace user settings containing credentials with private file permissions
  (`0600` on POSIX). Preserve those permissions across atomic writes.
- Never display credential values in settings rows, status output, notifications, logs, or errors.
- Show credential presence and source instead, for example `Pi auth`, `environment`, `settings file`,
  or `missing`.

## Non-TUI behavior

`ctx.ui.custom()` is TUI-only. In print, JSON, and RPC modes, the Settings action and any justified
direct settings route must not attempt to open the interactive screen. RPC mode may use
`ctx.ui.notify()` to provide the active settings path. Do not write ad hoc output that would corrupt
JSON protocol output. Keep settings paths and manual instructions available through the package
README and any supported Status or Help route.

## Verification

Tests for a configurable extension should cover the behavior it implements, including:

- missing, valid, malformed, and invalid settings;
- defaults and user/project precedence;
- project trust gating;
- unknown-field preservation and atomic-write failure;
- secret redaction and private permissions when applicable;
- UI save serialization, rollback after failure, and immediate runtime application;
- legacy migration and canonical-file precedence when applicable.
