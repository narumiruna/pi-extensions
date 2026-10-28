# 📊 pi-usage — Check Provider Usage, API Balance, and Codex Fast Mode

[![npm](https://img.shields.io/npm/v/@narumitw/pi-usage)](https://www.npmjs.com/package/@narumitw/pi-usage) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Check provider usage, limits, reset times, and API balances from Pi.
The extension keeps each provider's quota, allowance, balance, and spending semantics separate.

## ✨ Features

- Shows active-account usage and next actions through `/usage`.
- Recognizes native `/login openai` ChatGPT OAuth separately from unsupported OpenAI API-key usage reporting.
- Reports subscription allowances, API balances, and spending for the supported providers listed below without mixing their billing semantics.
- Toggles persistent Codex Fast routing through `/fast` or the usage menu.
- Redeems eligible Codex resets only after fresh account matching and explicit confirmation.
- Refreshes one or all configured providers with bounded concurrency while preserving partial results.
- Scopes statusline and cache data to the active provider and runtime account.
- Resolves credentials through Pi or the process-local OAuth credential-source protocol, waits for compatible pending account activation, and validates the effective provider endpoint before sending them.

## 📦 Install

Requires Pi 0.81.0 or newer to validate the effective base URL for resolved provider auth before sending credentials to an official usage endpoint.
The v1 credential-source path is characterized against Pi 0.84.3; other runtimes keep the standalone fallback without its protocol timing guarantee.

Like every Pi extension, this package runs with Pi's process permissions.
Review [Security and privacy](#-security-and-privacy) before installation.

```bash
pi install npm:@narumitw/pi-usage
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-usage
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-usage run build
pi -e ./packages/pi-usage
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.

## 🚀 Quick start

Run `/usage` in TUI or RPC mode to inspect the active provider, refresh its usage, or choose another configured provider.
When a provider exposes several billing targets, `/usage` asks for one target before querying usage.
Run `/fast` to toggle Fast mode for a supported active Codex model.
For native `/login openai`, select an `openai` model and run `/usage` for authentication status and the ChatGPT usage-settings link. Optional [companion usage](#chatgpt-companion-usage) is Off by default.
Native OpenAI Fast mode and earned reset redemption are not implemented; those actions remain specific to legacy `openai-codex`.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/usage` | Query the active provider's usage, then manage provider queries, preferences, or eligible Codex resets. |
| `/fast` | Toggle Fast mode for the active supported Codex model. |

Both commands support TUI and RPC, accept no arguments, and reject print and JSON modes.
Cross-provider queries require an explicit interactive choice; there are no provider-ID, `--refresh`, or `--all` arguments.
Requests use the matched provider credentials; see [Security and privacy](#-security-and-privacy).
Fast mode uses more plan allowance; see [Codex Fast mode](#codex-fast-mode) for eligibility and when changes apply.

Codex reset redemption requires a freshly matched current OAuth account and explicit confirmation; **after confirmation, its progress view cannot cancel the reset**.
Read the [query and reset guide](./docs/operations.md) for target selection, cancellation, and safe retry behavior.

## ⚙️ Settings

Choose **Settings** in `/usage` to edit Codex Fast mode, percentage display, reset countdown, and optional [OpenAI companion usage](#chatgpt-companion-usage) through Pi's settings-list interaction in TUI mode.
RPC mode reports the active manual settings path instead of opening terminal UI.

These preferences live in `pi-usage.json` under Pi's user agent directory, normally `~/.pi/agent/pi-usage.json`.
The extension reloads this file at every session start and does not create it until the first successful save.
Within one Pi process, changes save immediately in invocation order.
Saves preserve unknown JSON fields and publish through a private temporary file plus rename.
Malformed or invalid files remain untouched.
A failed save restores the prior displayed and effective value, while shutdown waits for queued writes.
Separate Pi processes are not mutually locked.

Target selections are stored only as IDs in the provider-neutral `selectedTargets` object in this file and are managed through `/usage`, not the Settings screen.
The former `fireworksAccountId` field remains read-compatible: it supplies `selectedTargets.fireworks` in memory only when the generic value is absent.
A successful explicit Fireworks account selection writes the generic field and removes the legacy field atomically; ordinary reads do not rewrite the file.

### Quota statusline display

Edit `statuslineDisplay` manually in the user settings file, then run `/reload`.
It applies to Codex, Command Code, Kimi, MiniMax Token Plan Global/China, Z.AI Global/China, and OpenCode Go.
For example, retain window labels alongside countdowns and change the separator:

```json
{
  "statuslineDisplay": {
    "countdown": "{window}:{value} ↻ {reset}",
    "separator": " / "
  }
}
```

This produces output such as `codex 5h:89% ↻ 2h30m / wk:97%`.
Missing fields keep the current defaults. Invalid templates produce a warning in TUI and RPC, use default settings, and block saves until the file is repaired; the file remains untouched.
There is no interactive template editor.
See the [display template reference](./docs/statusline-display.md) for defaults, placeholders, validation, and unchanged provider behavior.

### Codex statusline percentage

The `codexStatusPercentage` preference accepts `"remaining"` or `"used"` and defaults to `"remaining"` to preserve existing output.
Choose **Codex percentage** in the TUI Settings screen, or set the field manually and run `/reload`:

```json
{
  "codexStatusPercentage": "used"
}
```

With `"used"`, a limit with 70% remaining appears as `30%`; its reset countdown or window label stays unchanged.
This preference changes only Codex statusline formatting, not provider data or the detailed `/usage` report.

### Codex statusline reset countdown

The `codexStatusResetCountdown` preference defaults to `true`. It replaces the window labels with the time remaining until each returned limit resets.
Turn **Codex reset countdown** Off in the TUI Settings screen, or set it to `false` in `pi-usage.json` and run `/reload`, to show static labels such as `codex 5h:59% · wk:61%`:

```json
{
  "codexStatusResetCountdown": false
}
```

## ChatGPT companion usage

**Experimental source:** this read-only feature uses undocumented ChatGPT backend endpoints that may change without notice.
A user observed the plan weekly remaining percentage and reset time matching the ChatGPT overview; app percentages and broader account/window agreement remain unverified.

**Off by default:** native `openai` queries do not resolve Codex credentials or make companion requests. They show native authentication status and the ChatGPT usage-settings link.
Keep this setting Off if the two provider logins use different accounts or workspaces. Independent `openai-codex` usage, Fast mode, and reset redemption are unchanged.

To opt in, keep `/login openai` for native inference, run `/login openai-codex` with the **same ChatGPT account and workspace**, then turn **Use Codex login for OpenAI usage** On in `/usage` → **Settings**.
The extension cannot verify that the two logins identify the same account or workspace.
In RPC mode, edit the user settings file manually, set `"openaiUseCodexUsage": true`, and run `/reload`; the field accepts only a boolean and defaults to `false` when absent.
When enabled, native queries and scheduled refreshes use the validated Codex companion login; there is no reverse fallback to native OpenAI credentials.

Settings-screen changes apply without `/reload`. Disabling cancels pending companion requests and clears old native quota reports and status immediately after a successful save; late responses cannot restore them.
A request already sent to ChatGPT cannot be recalled. Manual file edits apply at the next session start or `/reload`.

**Upgrade:** automatic companion queries are now disabled unless the new `openaiUseCodexUsage` preference is explicitly `true`.
Historical `openaiCompanionUsage` values, including `true`, do not enable the feature and remain preserved during other settings saves; reads do not rewrite the file.
Users who want to retain numerical native reporting must opt in again.

The extension sends only the independently validated companion bearer and account ID to ChatGPT, never the native token.
It requires exactly one app registration matching the native grant's client ID, but that match is **not independent proof of shared identity**.

The statusline shows only shared **plan limits**, with percentages and reset times/window labels.
Detailed reports also show **app limits** with reset times/window labels only.
App used/remaining percentages are hidden, but their backend data remains validated.
**App allowance** is a separately labeled cap on shared plan usage, not remaining quota or a reserved pool.
Codex percentage/countdown preferences do not change this native report.
No reset tickets are listed or redeemed, and no allowance is changed.

Missing companion login preserves web-only setup guidance; invalid credentials, missing/duplicate registrations, unsupported pagination, malformed responses, and endpoint failures report unavailable data instead of guessed or stale quota.
Removing the companion login restores web-only reporting without changing native inference.

## Codex Fast mode

Run `/fast` or use **Turn Fast mode on/off** in `/usage` for a supported active Codex model.
The `codexFastMode` preference defaults to Off and uses more plan allowance when enabled.
Fast requests priority routing; actual availability and speed depend on the service and the active account's advertised model capabilities.
A saved toggle applies to requests whose payload hook starts afterward, not requests already sent.
Other providers and custom or proxy origins are unchanged.

See the [Fast mode guide](./docs/operations.md#codex-fast-mode) for capability discovery, status labels, fallback behavior, and invalid-settings recovery.

## 📋 Provider semantics

Usage is provider-specific: a subscription allowance, current balance, and rated spend are not interchangeable.
Currencies and billing targets remain separate.

| Provider | Reported data |
| --- | --- |
| OpenAI (native ChatGPT OAuth) | Authentication status by default; optional companion-sourced plan percentages and plan/app resets |
| OpenAI Codex (legacy) | Subscription windows, credits, resets, and model buckets |
| Kimi For Coding | Plan request windows and a separate booster wallet |
| Moonshot AI Global/China | Current API balance in USD/CNY |
| MiniMax Global/China | Token Plan windows or pay-as-you-go API balance |
| GitHub Copilot | AI credits, premium requests, or Free-plan chat allowance |
| OpenRouter | Per-key credit limits and spending windows |
| DeepSeek | Exact current CNY and USD API balances |
| Fireworks | Rated trailing 30-day spend for one selected account |
| Vercel AI Gateway | Team credit balance and lifetime spend |
| Baseten | Organization-wide trailing 30-day Model APIs spend after credits |
| OpenCode Go | Rolling, weekly, and monthly plan windows |
| Command Code | Billing-period plan credits and rolling 5-hour/weekly spending caps |
| xAI | OAuth subscription allowance and credits; explicit menu queries only |
| Z.AI | Coding Plan quota windows, MCP allowance, plan name, and renewal date |

Read the [provider reference](./docs/providers.md) for provider IDs, exact endpoints, authentication requirements, normalization rules, statusline examples, limitations, and pinned contract evidence.
Codex reset redemption requires a freshly matched current OAuth account and explicit confirmation; custom or proxy origins fail before mutation.

## 🧭 Current and configured accounts

`Current` identifies the provider and credential used by Pi's selected model.
`Configured` identifies runtime auth for another supported provider, not an active provider.

The extension selects one provider target for one query and never flattens targets into provider rows or aggregates every visible target.
A compatible credential owner may offer the verified active named account through the versioned process-local protocol without exposing its account label or storage.
When that owner is still activating the requested provider in the current session, `/usage` waits through the extension-neutral `oauth:credential-readiness:v1` protocol before collecting the synchronous credential offer.
Without such an owner, `pi-usage` retains its standalone Pi `auth.json` behavior.
An older or incompatible owner degrades to the existing authentication-unavailable result when the stored login does not match runtime auth.
After the active runtime credential changes, the next command, turn, or scheduled refresh resolves auth again and cannot reuse another account's cached report.

## 📊 Statusline behavior

The `usage` status item is active only for selected providers that publish statusline usage.
By default, Codex, Command Code, Kimi, MiniMax Token Plan, Z.AI, and OpenCode Go separate quota windows with ` · ` and place static labels before values, for example `cmd 5h:100% · wk:97% · mo:98%`.
Countdown segments retain their spacing without window labels, for example `codex 89% ↻ 2h30m · 97% ↻ 5d17h`; a missing reset time falls back to a static label, such as `codex 89% ↻ 2h30m · wk:97%`.
Single windows have no separator. [Display templates](./docs/statusline-display.md) can change this quota presentation. These presentation changes do not alter the reported values; consumers parsing the old status text must adapt to the new format. ChatGPT companion formatting is unchanged.

Kimi, MiniMax Token Plan Global/China, Z.AI Global/China, Command Code, OpenCode Go, and finite GitHub Copilot quotas show countdowns automatically when a displayed quota has a valid future reset time.
For example, `kimi 77% ↻ 2h52m · mo:87%` mixes a countdown with a static fallback; Copilot preserves its counts, percentage, and any overage, such as `copilot 245/300 82% ↻ 6d`.
These providers fall back to their existing static output when reset times are missing, invalid, or expired; unlimited quotas and balance/spend reports do not show countdowns.
Their countdowns are not controlled by the Codex-only settings. Codex and ChatGPT companion retain their existing reset behavior, including `↻ 0m` for expired returned resets.
Countdowns repaint locally every minute while a displayed eligible reset remains in the future, without additional provider requests; hidden windows and unselected model groups do not activate this repaint for the newly supported providers.

The status item refreshes every five minutes while the session remains on a provider that publishes usage and is cleared when the model changes to an unsupported or menu-only provider.
DeepSeek publishes each returned currency as a separate exact balance segment and reports when the API is unavailable.
Fireworks publishes exact per-currency rated spend totals and reports when no rated usage exists.
Moonshot AI publishes the available balance with its region-native currency.
Vercel AI Gateway publishes the exact current USD credit balance.
MiniMax publishes Token Plan window percentages or the regional pay-as-you-go available balance.
Baseten publishes the exact trailing 30-day Model APIs net subtotal after credits.
xAI is always menu-only and never starts a scheduled status refresh.
Z.AI statusline usage refreshes every five minutes while the selected model remains on Z.AI.
Verified native OpenAI OAuth with companion usage enabled and valid companion auth refreshes both read-only endpoints automatically. The statusline shows only plan limits, for example `chatgpt plan 70% ↻ 2h30m`; app reset details remain available in `/usage`.
With companion usage disabled or its login absent, it publishes `chatgpt usage: web only`; refreshes revalidate native auth without calling a usage endpoint.
OpenAI API-key auth clears this status.

Queries for another provider or all providers never publish their results to the statusline.
`@narumitw/pi-statusline` supplies the default `📊` icon; `pi-usage` publishes text-only values.

## 🔒 Security and privacy

Credential candidates are collected synchronously in memory after any compatible readiness promises settle, and are not cached, persisted, logged, formatted, or appended to the Pi session.
The protocols carry no account name or extension identity.
Only the selected provider's exact runtime match is used, and secrets are sent only to its validated official origin.
Native OpenAI status requires fresh Pi OAuth resolution and a matching complete ChatGPT grant, including the direct-token scope and client ID.
Model-level Authorization overrides cannot inherit subscription status from a stored login.
Native tokens are never forwarded to ChatGPT backend endpoints.
The opt-in companion path sends only its validated Codex bearer and matching account ID to fixed `GET /backend-api/wham/usage/chatpass/apps` and `GET /backend-api/wham/usage` routes on `https://chatgpt.com`, rejects redirects, and bounds response sizes and request time.
Both credential identities and native registration metadata bind cache identity and request-boundary revalidation.
Provider-specific endpoints and credential requirements are documented in the [provider reference](./docs/providers.md).
Pi extensions run with the user's process privileges, so the shared event bus is not a security boundary between installed extensions.
Install only trusted extensions because they can read user files and process memory.
Protocol v1 interoperability is characterized for the repository's supported Pi runtime.
An absent or incompatible peer preserves standalone fallback and fail-closed mismatch behavior.

## 🚧 Limitations

- Numerical usage requires a meaningful provider usage source and verifiable Pi runtime auth.
- Native `openai` has no verified native-token numerical quota API. Experimental companion reports require same-account setup, cannot independently prove shared identity, and reject incomplete/paginated app lists. Only one user-reported plan weekly comparison has been observed; app agreement and broader live behavior remain unverified.
- Native Fast mode and earned reset redemption, and OpenAI API-key usage reporting, remain unsupported.
- GitHub Copilot quota, Kimi managed usage, Z.AI quota, and OpenAI Codex reset redemption rely on provider-owned endpoints that may change without notice.
- Codex reset redemption requires a current ChatGPT OAuth credential from Pi's login or a compatible credential source; Codex API keys cannot redeem earned subscription resets.
- xAI usage supports only a uniquely matched Pi OAuth subscription credential; xAI API keys and Management API credentials are unsupported.
- Credentials resolved for custom provider base URLs are never forwarded to the providers' official usage endpoints; effective auth origin validation requires Pi 0.81.0 or newer.
- Provider reports are snapshots and may themselves be delayed by the provider.
- DeepSeek reports current API balance only; it does not expose historical usage, quota windows, reset times, or account-wide token totals through the balance endpoint.
- Fireworks reports rated 30-day spend only; credit balance and spend caps are visible only in the Fireworks web console, and `/usage` must select one visible account before querying a multi-account key.
- Moonshot AI reports current API balance only; it does not expose historical spend, aggregate token usage, quota windows, or reset times through the balance endpoint.
- Vercel AI Gateway reports current team credits and lifetime spend only; Custom Reporting and request-rate counters are not queried.
- MiniMax Token Plan field semantics have changed over time; contradictory counts and percentages are reported as unavailable rather than guessed.
- Baseten reports organization-wide Model APIs spend, not usage attributable only to Pi's current key; Dedicated and Training spend are excluded.
- OpenRouter successful inference responses do not expose proactive request-rate counters; `/usage` reports the documented per-key credit/spend fields instead.
- A provider may not return a safe human-readable account identity.
  In that case the provider and runtime credential state remain visible without exposing secrets.
- Immediate account-change events are not available from Pi; auth is re-resolved before commands, turns, and scheduled refreshes.
- Fast model support is intentionally conservative and may require an extension update when Codex adds or removes service tiers.
- Another later-loaded extension can replace the final provider payload, so arbitrary third-party payload-rewrite conflicts cannot be prevented.

## Read-only extension API

Other extensions can use the [read-only usage API v1](./docs/api/usage-v1.md) through `pi.events` to query reports and capabilities or receive invalidation notifications, without importing this extension.
Use `refresh: true` to obtain a report: cache-only queries currently return `cache-miss` because Pi cannot prove effective runtime auth identity without potentially doing network work. No client helper is exported.

## 🗂️ Package layout

```text
packages/pi-usage/
├── src/                               # Provider adapters, auth, settings, and presentation
│   ├── index.ts                       # Thin Pi entrypoint
│   └── usage.ts                       # Provider queries, cache, and menu
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
└── test/                              # Behavior and lifecycle coverage
```

`src/index.ts` forwards the default factory from `usage.ts` and retains the package's named helper exports; other source modules are internal.
The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, provider usage, Codex usage, subscription limits, reset times, API balances, spending, Codex Fast mode.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
