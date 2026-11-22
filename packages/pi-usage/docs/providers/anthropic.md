# Anthropic Claude usage

[Provider guides](./README.md) · [Package README](../../README.md)

**Experimental and Off by default:** this feature reads an undocumented Anthropic OAuth usage endpoint. The extra-usage contract is based on one user-reported Enterprise response and the plan-window contract on one Pro response; live Max coverage and provider-disabled response shapes remain unverified.

- Provider ID: `anthropic`
- Semantics: Claude subscription five-hour and weekly plan utilization, plus extra-usage spending and monthly cap; not a prepaid balance
- Source: undocumented `GET https://api.anthropic.com/api/oauth/usage`
- Displayed data: `five_hour` and `seven_day` utilization and reset times; `extra_usage.used_credits`, `monthly_limit`, and derived nonnegative remaining allowance
- Statusline examples: `claude 85% ↻ 2h53m · 98% ↻ 4d4h` with plan windows; `anthropic $20.00 left` with extra usage only

## Setup and settings

Use `/login anthropic` with a Claude subscription, select an official `anthropic` model, then turn **Claude extra usage** On in `/usage` → **Settings**. This one setting enables both plan windows and extra usage.
In RPC mode, set `"anthropicExtraUsage": true` in the user settings file and run `/reload`.
The setting accepts only a boolean and defaults to `false`; TUI changes apply immediately after a successful save.
See [shared settings](../../README.md#-settings) for the file path, scope, validation, and save behavior.

`/usage` shows the five-hour and weekly plan limits as percentages left with reset times when the response contains them, followed by extra-usage spend, the monthly spending limit, and the amount left.
Like Codex, the statusline shows only the plan windows, as remaining percentages with reset countdowns. Without plan windows it falls back to the extra-usage allowance: the reported Enterprise example produces `$80.00` used, a `$100.00` limit, and `anthropic $20.00 left`.
The extra-usage allowance is a spending allowance with no inferred reset date. Disabled or incomplete allowance data has no monetary status.

Off prevents Anthropic usage requests and credential discovery.
Disabling cancels owned requests and clears previous numerical cache, menu, and status data; a request already sent cannot be recalled.
API keys, unmatched OAuth grants, custom/proxy origins, and authentication overrides cannot inherit subscription usage.

## Authentication and transport

The adapter requires Pi's freshly resolved access token to match a complete OAuth credential from Pi's login or the versioned credential-source protocol.
Provider and selected-model authorization must agree with that token and with the installed Anthropic transport's effective Bearer header, with no additional API-key header.
Pi owns token refresh and persistence; usage cancellation stops its own continuation without cancelling a token rotation that Pi must finish.
The inference model, configured provider, and resolved-auth origins must be official `https://api.anthropic.com` origins.
Only the matched access-token Bearer header reaches the fixed usage route; refresh tokens, model headers, and unrelated SDK headers are not forwarded. Redirects are rejected, requests have deadlines, and responses are size-bounded.

The SDK reads `ANTHROPIC_CUSTOM_HEADERS` outside Pi's resolved-auth result. Authentication or Host entries in that variable are deliberately unsupported, even when another header would override them.
Explicit model/provider Authorization replacements or removals, conflicting OAuth grants, expired grants, and ordinary API-key credentials cannot inherit another login's usage.
Auth behavior is characterized with synthetic credentials through Pi's real runtime and Anthropic SDK transport, including case collisions, null/empty headers, runtime keys, ambient tokens, federation, and refresh failures.

## Response interpretation

`is_enabled` must explicitly be true for monetary reporting. False produces a disabled note without monetary fields; missing data produces an unavailable note.
Currency must be an explicit uppercase three-letter label and `decimal_places` an integer from 0 through 6; neither USD nor cents is assumed.
Amounts must be finite, nonnegative numbers no larger than `Number.MAX_SAFE_INTEGER`. Decimal-string normalization retains fractional minor units without binary subtraction errors.
Zero caps remain zero; usage above the cap remains visible, with zero remaining and an over-limit note. Missing counters do not become zero, and present invalid fields fail the query.
Plan windows are read only from `five_hour` and `seven_day`. Each needs a finite numeric `utilization`; remaining percent is clamped to 0 through 100, and an unparseable `resets_at` omits the reset. Malformed or null windows are omitted without failing extra-usage reporting. When a plan window is present, the disabled or unavailable extra-usage note is omitted.
The mirrored `spend` object, `limits` array, model-specific and other weekly windows, extra-usage utilization, and raw disabled reasons are ignored.
The read-only API advertises spend and spending-cap quota, not balance measurements.

## Contract evidence and live verification

The source contract is the redacted Enterprise-seat response in [issue #1757](https://github.com/narumiruna/pi-extensions/issues/1757), not a published Anthropic API specification.
The plan-window contract comes from one live Pro response, where `/usage` matched [Claude usage settings](https://claude.ai/settings/usage). Max behavior and provider-disabled shapes remain unverified. Fixture tests do not establish broader live compatibility.
An eligible account owner can enable the feature with their own Pi login and compare `/usage` and the statusline with [Claude usage settings](https://claude.ai/settings/usage); no credential sharing is needed.
