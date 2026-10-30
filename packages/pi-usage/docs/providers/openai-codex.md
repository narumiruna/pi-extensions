# OpenAI Codex

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `openai-codex` (legacy; not an alias for native `openai`)
- Semantics: ChatGPT consumer subscription limits
- Source: the Codex usage and earned-reset endpoints using Pi's resolved runtime authorization
- Displayed data: returned duration-based windows, resets, credits, earned usage-limit resets, and additional model buckets
- Reset mutation: `POST /wham/rate-limit-reset-credits/consume` with a unique redemption request ID and, when available, the selected opaque credit ID
- Statusline examples: `codex 59% ↻ 2h30m · 61% ↻ 2d15m`, `codex fast 59% ↻ 2h30m`, or `codex spark 100% ↻ 2h30m`

The statusline selects a returned bucket that matches the current Codex model when one is available.
`pi-usage` has no Codex CLI fallback because the CLI may be logged into a different account than Pi's active runtime account.
The provider-owned reset endpoints may change without notice.

## Statusline settings

Choose **Settings** in `/usage` to edit these user-scoped preferences in TUI mode.
For manual JSON edits, use the [shared settings file](../../README.md#-settings) and run `/reload`.
These settings change only Codex statusline formatting, not provider data or the detailed `/usage` report, and do not control other providers' countdowns.
For shared window formatting, see [display templates](../statusline-display.md).

### Percentage

The `codexStatusPercentage` preference accepts `"remaining"` or `"used"` and defaults to `"remaining"`.
Choose **Codex percentage** in the TUI Settings screen, or set:

```json
{
  "codexStatusPercentage": "used"
}
```

With `"used"`, a limit with 70% remaining appears as `30%`; its reset countdown or window label stays unchanged.

### Reset countdown

The `codexStatusResetCountdown` preference accepts a boolean and defaults to `true`.
It replaces window labels with the time remaining until each returned limit resets; expired returned resets show `↻ 0m`.
Turn **Codex reset countdown** Off in the TUI Settings screen, or set:

```json
{
  "codexStatusResetCountdown": false
}
```

The static result is, for example, `codex 5h:59% · wk:61%`.

## Codex Fast mode

Run `/fast` without arguments to toggle Fast for the active supported Codex model, or use **Turn Fast mode on/off** in `/usage`.
The boolean `codexFastMode` preference defaults to Off. Fast requests priority routing and uses more plan allowance.
The `fast` label indicates requested routing, not a measured speedup; actual availability and speed depend on the service.

Fast applies to official `openai-codex-responses` requests at `https://chatgpt.com` when the current account's Codex model directory advertises a `priority` service tier or the legacy `fast` speed tier.
Discovery validates the active OAuth account and caches its model capabilities for five minutes, with background refresh on session and model changes.
`/fast` and `/usage` can refresh capability information before enabling Fast or displaying its controls, while provider request hooks use the account-validated cache and leave directory refresh in the background.

Fast sends `service_tier: "priority"` while enabled and supported, and explicit `service_tier: "default"` otherwise.
The statusline adds `fast` only while the preference is effective, for example `codex fast 59% ↻ 2h30m` with the default reset countdown.
A missing model, incomplete capability information, or first directory failure displays **Unknown** and uses standard routing, with `codex (Fast unknown)` shown when the preference remains enabled.
Temporary network failures reuse successful discovery for the same account, while authentication rejection or malformed directory data invalidates that account's capability information.
The preference can still be turned off while capability information is unknown.
Other providers, APIs, and custom or proxy origins retain their own request payloads.
Model support is intentionally conservative and may require an extension update when Codex adds or removes service tiers.

A toggle affects provider requests whose payload hook starts after the save; a request already sent is unchanged.
Repair or remove an invalid settings file, then run `/reload` before trying the toggle again.
A later-loaded extension can replace the final provider payload; arbitrary third-party payload-rewrite conflicts cannot be prevented.

## Reset authentication

Reset redemption is available only when Codex is the current provider.
Pi's freshly resolved access token must exactly match an OAuth credential from Pi's stored login or a compatible credential source.
`pi-usage` forwards only the bearer authorization and matching `chatgpt-account-id` to the official ChatGPT origin.
API-key credentials, configured-but-not-current Codex accounts, account changes during the flow, and custom/proxy origins fail before mutation.
Backend-provided titles and descriptions are sanitized for terminal display.
Opaque credit and account IDs are never shown or persisted by the extension.

## Redeem a Codex usage reset

For the current OpenAI Codex OAuth account, **Redeem usage limit reset…** checks fresh earned-reset details, lets you choose a reset, and previews its exact effect before confirmation.
**No, go back** is the safe default, and cancellation before confirmation sends no mutation.

**After confirmation, the reset cannot be cancelled from its progress view**; session replacement or shutdown still aborts owned work.
A transport failure offers **Try again** with the same redemption request ID so the backend can handle an uncertain retry idempotently.
Successful, already-completed, not-needed, and no-credit outcomes are reported separately, then usage and the statusline refresh for the still-current account.
