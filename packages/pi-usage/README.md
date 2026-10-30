# 📊 pi-usage — Check Provider Usage, API Balance, and Codex Fast Mode

[![npm](https://img.shields.io/npm/v/@narumitw/pi-usage)](https://www.npmjs.com/package/@narumitw/pi-usage) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Check provider usage, limits, reset times, and API balances from Pi.
The extension keeps each provider's quota, allowance, balance, and spending semantics separate.

## ✨ Features

- Shows active-account usage and next actions through `/usage`.
- Reports subscription allowances, API balances, and spending without mixing provider billing semantics.
- Toggles persistent Codex Fast routing and redeems eligible resets after explicit confirmation.
- Refreshes one or all configured providers with bounded concurrency while preserving partial results.
- Scopes statusline and cache data to the active provider and runtime account.
- Matches Pi's resolved credentials and effective provider endpoint before sending usage requests.

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

See the [provider guides](./docs/providers/README.md) for supported providers, login requirements, reported data, and provider-specific setup.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/usage` | Query the active provider's usage, then manage provider queries, preferences, or eligible Codex resets. |
| `/fast` | Toggle Fast mode for the active supported Codex model. |

Both commands support TUI and RPC, accept no arguments, and reject print and JSON modes.
Cross-provider queries require an explicit interactive choice; there are no provider-ID, `--refresh`, or `--all` arguments.
Requests use the matched provider credentials; see [Security and privacy](#-security-and-privacy).

Fast mode uses more plan allowance; see [Codex Fast mode](./docs/providers/openai-codex.md#codex-fast-mode) for eligibility and when changes apply.
Codex reset redemption requires a freshly matched current OAuth account and explicit confirmation; **after confirmation, its progress view cannot cancel the reset**.
Read the [target selection guide](./docs/operations.md#choose-a-provider-target) and [Codex reset guide](./docs/providers/openai-codex.md#redeem-a-codex-usage-reset) for cancellation and safe retry behavior.

## ⚙️ Settings

Choose **Settings** in `/usage` to edit provider preferences through Pi's settings-list interaction in TUI mode.
RPC mode reports the active manual settings path instead of opening terminal UI.

Preferences live in `pi-usage.json` under Pi's user agent directory, normally `~/.pi/agent/pi-usage.json`; there is no project override.
The extension reloads this file at every session start and does not create it until the first successful save.
Settings-screen changes apply immediately after a successful save. For manual file edits, run `/reload`.

Within one Pi process, changes save immediately in invocation order.
Saves preserve unknown JSON fields and publish through a private temporary file plus rename.
Malformed or invalid files remain untouched and block saves until repaired and reloaded.
A failed save restores the prior displayed and effective value, while shutdown waits for queued writes.
Separate Pi processes are not mutually locked.

**Experimental features are Off by default:**

- [Claude extra usage](./docs/providers/anthropic.md#setup-and-settings) uses an undocumented OAuth endpoint based on one user-reported Enterprise response. Live Pro/Max coverage and provider-disabled response shapes remain unverified.
- [OpenAI companion usage](./docs/providers/openai.md#companion-setup-and-settings) uses undocumented ChatGPT endpoints. Enable it only when both logins use the **same account and workspace**; the extension cannot prove this identity match. App numerical agreement and broader live coverage remain unverified.

See [Codex settings](./docs/providers/openai-codex.md#statusline-settings) for percentage and reset-countdown preferences and [Fast mode](./docs/providers/openai-codex.md#codex-fast-mode) for its default-Off routing preference.
Edit `statuslineDisplay` manually to customize quota formatting; see the [display template reference](./docs/statusline-display.md) for defaults, placeholders, and validation. There is no interactive template editor.

Target selections are stored only as IDs in the provider-neutral `selectedTargets` object and are managed through `/usage`, not the Settings screen.
See [target selection](./docs/operations.md#choose-a-provider-target) and [Fireworks migration](./docs/providers/fireworks.md#account-selection-and-migration) for selection and legacy-field behavior.

## 📋 Provider guides

The [provider index](./docs/providers/README.md) lists supported providers and links to their setup, endpoints, authentication requirements, normalization rules, statusline examples, limitations, and contract evidence.

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

The `usage` status item shows only the selected provider when that provider supports statusline usage.
It refreshes every five minutes and clears when the model changes to an unsupported or menu-only provider.
Eligible countdowns repaint locally every minute without additional provider requests.
Queries for another provider or all providers never publish their results to the statusline.

See the [provider guides](./docs/providers/README.md) for each provider's values and availability, and [display templates](./docs/statusline-display.md) for shared quota formatting and countdown rules.
`@narumitw/pi-statusline` supplies the default `📊` icon; `pi-usage` publishes text-only values.

## 🔒 Security and privacy

Credential candidates are collected synchronously in memory after any compatible readiness promises settle, and are not cached, persisted, logged, formatted, or appended to the Pi session.
The protocols carry no account name or extension identity.
Only the selected provider's exact runtime match is used, and secrets are sent only to its validated official origin.
Credentials resolved for custom provider base URLs are never forwarded to the providers' official usage endpoints.

Native OpenAI tokens are never forwarded to ChatGPT backend endpoints; optional companion requests use only the independently validated Codex login.
See the [provider guides](./docs/providers/README.md) for provider-specific credential and destination boundaries.

Pi extensions run with the user's process privileges, so the shared event bus is not a security boundary between installed extensions.
Install only trusted extensions because they can read user files and process memory.
Protocol v1 interoperability is characterized for the repository's supported Pi runtime.
An absent or incompatible peer preserves standalone fallback and fail-closed mismatch behavior.

## 🚧 Limitations

- Numerical usage requires a meaningful provider usage source and verifiable Pi runtime auth.
- Provider reports are snapshots and may themselves be delayed by the provider.
- A provider may not return a safe human-readable account identity. In that case the provider and runtime credential state remain visible without exposing secrets.
- Immediate account-change events are not available from Pi; auth is re-resolved before commands, turns, and scheduled refreshes.
- Another later-loaded extension can replace the final provider payload, so arbitrary third-party payload-rewrite conflicts cannot be prevented.

Provider-specific unsupported behavior and verification limits are documented in the [provider guides](./docs/providers/README.md).

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
├── docs/
│   ├── providers/                     # Published provider guides and index
│   └── api/                           # Published extension API references
└── test/                              # Behavior and lifecycle coverage
```

`src/index.ts` forwards the default factory from `usage.ts` and retains the package's named helper exports; other source modules are internal.
The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, provider usage, Claude extra usage, Anthropic OAuth, Codex usage, subscription limits, reset times, API balances, spending, Codex Fast mode.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
