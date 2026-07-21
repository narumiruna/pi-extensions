# 📊 pi-codex-usage — Codex Usage Status for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-codex-usage)](https://www.npmjs.com/package/@narumitw/pi-codex-usage) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> `@narumitw/pi-codex-usage` is deprecated and will be replaced by [`@narumitw/pi-usage`](../pi-usage).
> Do not load both extensions at the same time. To migrate one Pi installation, run:
>
> ```bash
> pi uninstall npm:@narumitw/pi-codex-usage
> pi install npm:@narumitw/pi-usage
> ```
>
> See the [`pi-usage` migration guide](../pi-usage#-migrating-from-pi-codex-usage) for behavior changes.

`@narumitw/pi-codex-usage` is a native [Pi coding agent](https://pi.dev) extension that adds `/codex-status`, a command for showing ChatGPT Codex subscription usage from inside Pi.

Use it when you want a quick Codex-style usage summary without leaving Pi or requiring Codex CLI to be installed.

## ✨ Features

- Adds a `/codex-status` command to Pi.
- Shows Codex usage windows, reset times, credits, and earned usage-limit resets.
- Labels each window from its reported duration (for example, 5-hour or weekly).
- Displays additional usage buckets when the Codex backend returns them.
- Reads the authoritative available reset count from the current Codex usage contract.
- Automatically shows a compact statusline item while the current Pi model uses `openai-codex`.
- Uses Pi's own OpenAI Codex subscription auth first.
- Falls back to `codex app-server --listen stdio://` only when Pi auth is unavailable.
- Caches results briefly to avoid repeatedly calling the backend.
- Supports `--refresh` to bypass the in-memory cache.
- Works as an independently installable npm Pi extension package.

## 📦 Install

```bash
pi install npm:@narumitw/pi-codex-usage
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-codex-usage
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-codex-usage
```

## 🚀 Usage

```text
/codex-status
/codex-status --refresh
/codex-status --no-statusline
/codex-status --clear-statusline
/codex-status --timeout 30
```

Example output:

```text
  >_ OpenAI Codex Usage

Visit https://chatgpt.com/codex/settings/usage for up-to-date
information on rate limits and credits

  5h limit:                    [█████████████░░░░░░░] 64% left (resets 13:57)
  Weekly limit:                [████████████░░░░░░░░] 62% left (resets 14:37)
  GPT-5.3-Codex-Spark limit:
  5h limit:                    [████████████████████] 100% left (resets 19:16)
  Weekly limit:                [████████████████████] 100% left (resets 00:10 on 21 May)

  Usage limit resets:          2 available
```

## 📊 Statusline behavior

When the selected Pi model provider is `openai-codex`, `pi-codex-usage` refreshes a compact statusline item automatically:

```text
codex 59% 5h 61% wk
codex spark 100% 5h 100% wk
```

`@narumitw/pi-statusline` adds the default `📊` icon unless configured otherwise. The statusline value uses the cached usage snapshot and refreshes every five minutes while the current model remains `openai-codex`. Window labels come from the duration reported by Codex, with 5-hour/weekly fallbacks for older responses that omit it.
When the selected model has its own returned usage bucket, such as `gpt-5.3-codex-spark`, the statusline switches to that bucket instead of the default `codex` bucket.
Switching away from an OpenAI Codex model clears the item.

Use `/codex-status --no-statusline` for a one-off notification without updating the statusline, or `/codex-status --clear-statusline` to clear the item manually.

## 🔐 Auth behavior

`pi-codex-usage` tries usage sources in this order:

1. Pi's `openai-codex` provider auth through the Pi extension API.
2. Codex CLI app-server fallback when Pi auth cannot provide usable subscription auth.

This means Codex CLI is optional. Users who already use a Pi OpenAI Codex model or have logged in to Pi with ChatGPT Plus/Pro subscription auth can use the direct Pi-auth path.

The direct `/wham/usage` response can include the snake_case `rate_limit_reset_credits` summary. Current Codex app-server responses expose the same authoritative count as camelCase `rateLimitResetCredits` and may also include capped detail rows. The extension accepts both forms and keeps the compact statusline focused on rate-limit windows.

The extension does not read Pi or Codex auth files directly, and it does not expose bearer tokens in error messages.

## 🚧 Limitations

- OpenAI API keys are not ChatGPT Codex subscription auth and do not expose this quota.
- Usage data is a snapshot. Statusline and command results are cached for five minutes unless `--refresh` is used.
- The fallback path requires Codex CLI to be installed and logged in.
- `/codex-status` reports earned usage-limit resets but does not redeem them.

## 🗂️ Package layout

```txt
extensions/pi-codex-usage/
├── src/
│   ├── codex-usage.ts  # Pi entrypoint and cache/lifecycle orchestration
│   └── *.ts            # Package-local query, RPC, normalization, and format modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `codex-usage.ts` is a Pi entrypoint; the other source modules are internal. The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/codex-usage.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, Codex usage, Codex status, ChatGPT subscription usage, rate limits, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
