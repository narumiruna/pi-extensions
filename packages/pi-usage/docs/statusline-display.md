# Quota statusline display templates

[Back to Settings](../README.md#-settings)

Set `statuslineDisplay` in Pi's user `pi-usage.json`, normally `~/.pi/agent/pi-usage.json`, then run `/reload`.
The extension loads settings at each session start. It does not read project overrides or create a file merely to load defaults.
The existing Settings screen edits Codex preferences only; templates require manual JSON editing.

## Defaults and syntax

All fields are optional strings. Omitted fields use these defaults:

```json
{
  "statuslineDisplay": {
    "template": "{provider} {windows}",
    "window": "{window}:{value}",
    "countdown": "{value} ↻ {reset}",
    "separator": " · "
  }
}
```

| Field | Accepted placeholders | Purpose |
| --- | --- | --- |
| `template` | `{provider}`, `{windows}` | Format the complete quota status text. |
| `window` | `{window}`, `{value}` | Format a static quota segment. |
| `countdown` | `{window}`, `{value}`, `{reset}` | Format a segment when its existing countdown policy permits a reset. |
| `separator` | None; all text is literal | Join available window segments. |

`{provider}` includes the existing provider prefix and any Fast, model, or region qualifier, such as `codex fast`, `codex (Fast unknown)`, or `minimax cn`.
`{windows}` contains the formatted segments in their existing order.
`{window}` is the existing compact label, such as `5h`, `wk`, `mo`, `r`, or `w`.
`{value}` is the existing formatted value, including `%` when applicable, or `unlimited`.
`{reset}` is the existing reset countdown, such as `2h30m`.

Templates accept literal text and the listed placeholders only. There are no expressions, scripts, conditionals, ANSI styles, or brace escapes.
Unknown placeholders, placeholders in the wrong field, and unmatched or nested braces are invalid.
Braces in `separator` are literal text. Replacement values are not parsed as templates.
Literal spacing is preserved. Empty strings are valid explicit values, not requests for defaults.

## Examples

Use a custom separator and static ordering:

```json
{
  "statuslineDisplay": {
    "window": "{window} {value}",
    "separator": " / "
  }
}
```

A mixed result is `codex 89% ↻ 2h30m / wk 97%`.
With the Codex countdown disabled, it is `codex 5h 89% / wk 97%`.

Retain labels alongside countdowns and move the provider prefix:

```json
{
  "statuslineDisplay": {
    "template": "[{windows}] {provider}",
    "countdown": "{window}:{value} ↻ {reset}"
  }
}
```

Example: `[5h:89% ↻ 2h30m · wk:97%] codex fast`.

## Compatibility and validation

Templates apply only to quota windows for Codex, Command Code, Kimi, MiniMax Token Plan Global/China, Z.AI Global/China, and OpenCode Go.
They do not change percentages, window selection or ordering, model groups, or reset calculations.
One available segment has no separator; unavailable quotas do not create empty segments.
Unlimited windows use `window`, not `countdown`.

The existing `codexStatusResetCountdown` setting still controls only Codex.
Other scoped providers still show countdowns automatically for valid future resets and use static labels for missing, invalid, or expired resets.
Codex retains its existing expired-reset `0m` countdown.
Detailed reports, ChatGPT companion, GitHub Copilot, credits-only fallback text, and balance/spend statuslines remain unchanged.

Every configured display field must be a string, and `statuslineDisplay` must be an object.
Terminal controls, including tabs, line breaks, escape sequences, and C1 controls, are rejected; Unicode line separators are also rejected.
Invalid settings produce a field-specific warning in TUI and RPC without displaying the rejected value.
Print and JSON modes have no UI warning channel. Settings loading retains the validation error as data and uses the existing default-settings fallback.
An invalid file remains unchanged and blocks subsequent saves until repaired and reloaded.

Unknown JSON fields are ignored at runtime and preserved during ordinary settings saves, including unknown fields inside `statuslineDisplay`.
Reads remain side-effect free. Existing ordered, private temporary-file-plus-rename save behavior remains unchanged; separate Pi processes are not mutually locked.

## Verification scope

Verification covers deterministic formatting, settings validation, and offline Pi loading. Live-provider output and interactive visual behavior remain unverified. A maintainer with an already configured provider can apply the examples above, run `/reload`, and confirm unchanged quota values and the intended spacing in the target terminal.
