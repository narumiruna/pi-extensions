# 📊 pi-usage — Check Provider Usage, API Balance, and Codex Fast Mode

[![npm](https://img.shields.io/npm/v/@narumitw/pi-usage)](https://www.npmjs.com/package/@narumitw/pi-usage) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Inspect usage and DeepSeek API balance for Pi's active provider account, query other configured providers, and toggle Fast mode for supported OpenAI Codex models.
The extension keeps each provider's native quota, allowance, and spending semantics instead of treating unlike values as equivalent.
xAI OAuth subscription reporting follows the reviewed Grok Build contract and runs only after an explicit `/usage` action.

## ✨ Features

- Shows active-account usage and next actions through `/usage`.
- Reports subscription allowances, API balances, and spending for the supported providers listed below without mixing their billing semantics.
- Toggles persistent Codex Fast routing through `/fast` or the usage menu.
- Redeems eligible Codex resets only after fresh account matching and explicit confirmation.
- Refreshes one or all configured providers with bounded concurrency while preserving partial results.
- Scopes statusline and cache data to the active provider and runtime account.
- Resolves credentials through Pi or the process-local OAuth credential-source protocol and validates the effective provider endpoint before sending them.

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

Choose **Settings** in `/usage` to edit Codex Fast mode and the Codex reset countdown through Pi's settings-list interaction in TUI mode.
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

### Codex Fast mode

Run `/fast` without arguments to toggle Fast for the active supported Codex model, or use **Turn Fast mode on/off** in `/usage`.
Fast is about 1.5× faster and uses more of your plan allowance.
The `codexFastMode` preference defaults to Off.

Fast currently applies only to official `openai-codex-responses` requests for `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` at `https://chatgpt.com`.
It sends `service_tier: "priority"` while enabled and explicit `service_tier: "default"` otherwise.
The statusline adds `fast` only while the preference is effective, for example `codex fast 59% ↻ 2h30m` with the default reset countdown.
Unsupported models and custom or proxy origins are left unchanged.

A toggle affects provider requests whose payload hook starts after the save; a request already sent is unchanged.
Repair or remove an invalid file, then run `/reload` before trying the toggle again.

### Codex statusline reset countdown

The `codexStatusResetCountdown` preference defaults to `true`. It replaces the window labels with the time remaining until each returned limit resets.
Turn **Codex reset countdown** Off in the TUI Settings screen, or set it to `false` in `pi-usage.json` and run `/reload`, to restore the legacy `5h` and `wk` labels:

```json
{
  "codexStatusResetCountdown": false
}
```

## 📋 Provider semantics

Usage is provider-specific: a subscription allowance, current balance, and rated spend are not interchangeable.
Currencies and billing targets remain separate.

| Provider | Reported data |
| --- | --- |
| OpenAI Codex | Subscription windows, credits, resets, and model buckets |
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
| xAI | OAuth subscription allowance and credits; explicit menu queries only |
| Z.AI | Coding Plan quota windows, MCP allowance, plan name, and renewal date |

Read the [provider reference](./docs/providers.md) for provider IDs, exact endpoints, authentication requirements, normalization rules, statusline examples, limitations, and pinned contract evidence.
Codex reset redemption requires a freshly matched current OAuth account and explicit confirmation; custom or proxy origins fail before mutation.

## 🧭 Current and configured accounts

`Current` identifies the provider and credential used by Pi's selected model.
`Configured` identifies runtime auth for another supported provider, not an active provider.

The extension selects one provider target for one query and never flattens targets into provider rows or aggregates every visible target.
Provider adapters own target discovery and validation; core owns one-target selection, persistence, cache identity, cancellation, and UI.
A compatible credential owner may offer the verified active named account through the versioned process-local protocol without exposing its account label or storage.
Without such an owner, `pi-usage` retains its standalone Pi `auth.json` behavior.
An older or incompatible owner degrades to the existing authentication-unavailable result when the stored login does not match runtime auth.
After the active runtime credential changes, the next command, turn, or scheduled refresh resolves auth again and cannot reuse another account's cached report.

## 📊 Statusline behavior

The `usage` status item is active only for selected providers that publish statusline usage.
It refreshes every five minutes while the session remains on such a provider and is cleared when the model changes to an unsupported or menu-only provider.
DeepSeek publishes each returned currency as a separate exact balance segment and reports when the API is unavailable.
Fireworks publishes exact per-currency rated spend totals and reports when no rated usage exists.
Moonshot AI publishes the available balance with its region-native currency.
Vercel AI Gateway publishes the exact current USD credit balance.
MiniMax publishes Token Plan window percentages or the regional pay-as-you-go available balance.
Baseten publishes the exact trailing 30-day Model APIs net subtotal after credits.
xAI is always menu-only and never starts a scheduled status refresh.
Z.AI statusline usage refreshes every five minutes while the selected model remains on Z.AI.

Queries for another provider or all providers never publish their results to the statusline.
`@narumitw/pi-statusline` supplies the default `📊` icon; `pi-usage` publishes text-only values.

## 🔄 Migrating from pi-codex-usage

`pi-codex-usage` is deprecated and its source is archived under `deprecated/`.
To migrate one installation:

```bash
pi remove npm:@narumitw/pi-codex-usage
pi install npm:@narumitw/pi-usage
```

Remove the deprecated package rather than loading both usage extensions together.

Behavior changes:

- Use `/usage` for usage management; `/codex-status` is no longer registered.
- Refresh and cross-provider operations are menu actions rather than flags.
- Codex CLI fallback is removed to preserve active-runtime-account correctness.
- The status key changes from `codex-usage` to `usage`.

## 🔒 Security and privacy

Credential candidates are collected synchronously in memory and are not cached, persisted, logged, formatted, or appended to the Pi session.
The protocol carries no account name or extension identity.
Only the selected provider's exact runtime match is used, and secrets are sent only to its validated official origin.
DeepSeek balance requests require Bearer authentication, send only that resolved credential from Pi's runtime auth to `https://api.deepseek.com/user/balance`, and refuse redirects.
Fireworks spend requests send only that resolved credential to the official `https://api.fireworks.ai` account-listing and billing-summary endpoints and refuse redirects.
Moonshot balance requests send only the resolved Bearer credential to the matching official Global or China balance origin and refuse redirects.
Vercel AI Gateway credit requests send only the resolved Bearer credential to `https://ai-gateway.vercel.sh/v1/credits` and refuse redirects.
MiniMax usage requests send only the resolved API key to one deterministic endpoint on the matching official Global or China API root and refuse redirects.
Baseten billing requests send only the resolved Bearer credential to `https://api.baseten.co/v1/billing/usage_summary` for an official Baseten model and refuse redirects.
Pi extensions run with the user's process privileges, so the shared event bus is not a security boundary between installed extensions.
Install only trusted extensions because they can read user files and process memory.
Protocol v1 interoperability is characterized for the repository's supported Pi runtime.
An absent or incompatible peer preserves standalone fallback and fail-closed mismatch behavior.

## 🚧 Limitations

- Only providers with a meaningful usage source and verifiable Pi runtime auth are supported.
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

Pi extension, Pi coding agent, usage, quota, DeepSeek API balance, DeepSeek balance, Fireworks API spend, Fireworks rated spend, Vercel AI Gateway credits, Vercel AI Gateway usage, Baseten Model APIs spend, Baseten usage, OpenAI Codex usage, ChatGPT subscription limits, Kimi For Coding, Kimi Coding Plan usage, Moonshot AI balance, Moonshot API balance, MiniMax Token Plan, MiniMax API balance, GitHub Copilot AI credits, GitHub Copilot premium requests, OpenRouter credits, xAI OAuth usage, Grok subscription allowance, API-key spend limits, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
