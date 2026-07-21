# 📊 pi-usage — Provider Usage for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-usage)](https://www.npmjs.com/package/@narumitw/pi-usage) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-usage` is a native [Pi coding agent](https://pi.dev) extension that adds one interactive `/usage` command for reading usage from the account Pi is actually using. It supports OpenAI Codex ChatGPT subscription windows and OpenRouter API-key spend limits without pretending those limits have the same semantics.

## ✨ Features

- Opens one interactive `/usage` menu with current state and next actions.
- Automatically queries the selected model provider and active runtime account.
- Supports OpenAI Codex subscription windows, resets, credits, and model-specific buckets.
- Supports OpenRouter per-key credit limits plus daily, weekly, monthly, and all-time spend.
- Provides explicit refresh, another-provider, and all-configured-provider actions.
- Runs manually requested all-provider queries with concurrency limited to two and preserves partial results.
- Labels only the selected model provider as `Current`; other results are `Configured`.
- Keeps the compact statusline scoped to the current provider and runtime account.
- Isolates its five-minute in-memory cache by provider and a process-salted credential fingerprint.
- Resolves credentials through Pi and never reads Pi, account-extension, Codex CLI, or provider auth files.
- Retains `/codex-status` as a temporary argument-free compatibility alias.

## 📦 Install

Requires Pi 0.81.0 or newer so the extension can validate the effective base URL attached to resolved provider auth before sending credentials to an official usage endpoint.

```bash
pi install npm:@narumitw/pi-usage
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-usage
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-usage
```

## 🚀 Usage

Run:

```text
/usage
```

The menu first queries the current model provider and presents its state with these actions:

```text
Refresh current usage
View another configured provider…
View all configured providers…
Close
```

There are intentionally no `/usage --refresh`, `/usage <provider>`, or `/usage --all` argument paths. Cross-provider traffic requires an explicit interactive choice.

`/codex-status` opens the same menu during the migration period. Its former flags are not supported by `pi-usage`.

## 📋 Provider semantics

### OpenAI Codex

- Provider ID: `openai-codex`
- Semantics: ChatGPT consumer subscription limits
- Source: the Codex usage endpoint using Pi's resolved runtime authorization
- Displayed data: returned duration-based windows, resets, credits, earned usage-limit resets, and additional model buckets
- Statusline examples: `codex 59% 5h 61% wk` or `codex spark 100% 5h`

The statusline selects a returned bucket that matches the current Codex model when one is available. Unlike `pi-codex-usage`, this successor intentionally has no Codex CLI fallback because the CLI may be logged into a different account than Pi's active runtime account.

### OpenRouter

- Provider ID: `openrouter`
- Semantics: API-key spend and per-key credit limits—not consumer subscription quota
- Source: OpenRouter's documented [`GET /api/v1/key`](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) endpoint using Pi's resolved inference API key
- Displayed data: key label when safely returned, optional per-key limit and remaining amount, reset period, and daily/weekly/monthly/all-time spend
- Statusline examples: `openrouter $74.50 left` or `openrouter $25.50 used`

The extension does not call OpenRouter's account-level `/credits` endpoint because that operation requires a separate management key. OpenRouter documents the distinction between credit and rate limits in its [API limits guide](https://openrouter.ai/docs/api_reference/limits).

## 🧭 Current and configured accounts

`Current` means the provider and credential used by Pi's selected model. `Configured` means Pi reports runtime auth for another supported provider; it does not mean that provider is active.

The extension does not enumerate multiple accounts inside one provider and does not switch accounts. Account selection remains owned by Pi or an account-management extension. After the active runtime credential changes, the next command, turn, or scheduled refresh resolves auth again and cannot reuse another account's cached report.

## 📊 Statusline behavior

The `usage` status item is active only for the selected model provider. It refreshes every five minutes while the session remains on a supported provider and is cleared when the model changes to an unsupported provider.

Manual another-provider and all-provider queries never publish to the statusline. `@narumitw/pi-statusline` supplies the default `📊` icon; `pi-usage` publishes text-only values.

## 🔄 Migrating from pi-codex-usage

`pi-codex-usage` remains available while this successor soaks. To migrate one installation:

```bash
pi remove npm:@narumitw/pi-codex-usage
pi install npm:@narumitw/pi-usage
```

Do not load both packages together: both register `/codex-status`, so Pi must suffix duplicate commands and the two packages can publish overlapping usage status.

Behavior changes:

- Use `/usage` as the primary entry point.
- `/codex-status` is an argument-free compatibility alias.
- Refresh and cross-provider operations are menu actions rather than flags.
- Codex CLI fallback is removed to preserve active-runtime-account correctness.
- The status key changes from `codex-usage` to `usage`.

## 🚧 Limitations

- Only providers with a stable, meaningful usage source and Pi-resolvable runtime auth are supported.
- Credentials resolved for custom provider base URLs are never forwarded to the providers' official usage endpoints; effective auth origin validation requires Pi 0.81.0 or newer.
- Provider reports are snapshots and may themselves be delayed by the provider.
- OpenRouter successful inference responses do not expose proactive request-rate counters; `/usage` reports the documented per-key credit/spend fields instead.
- A provider may not return a safe human-readable account identity. In that case the provider and runtime credential state remain visible without exposing secrets.
- Immediate account-change events are not available from Pi; auth is re-resolved before commands, turns, and scheduled refreshes.

## 🗂️ Package layout

```txt
extensions/pi-usage/
├── src/
│   ├── usage.ts       # Pi entrypoint, menu, cache, and lifecycle orchestration
│   ├── query.ts       # Runtime auth resolution and provider queries
│   ├── format.ts      # Provider-aware notifications and statusline text
│   ├── core.ts        # Cache, concurrency, fingerprint, and redaction helpers
│   ├── providers/     # Codex and OpenRouter normalization adapters
│   └── types.ts       # Common presentation and adapter contracts
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `usage.ts` is a Pi entrypoint; other source modules are internal.

## 🔎 Keywords

Pi extension, Pi coding agent, usage, quota, OpenAI Codex usage, ChatGPT subscription limits, OpenRouter credits, API-key spend limits, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
