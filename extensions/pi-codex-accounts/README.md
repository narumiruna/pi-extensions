# 🔐 pi-codex-accounts — Codex Account Switcher for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-codex-accounts)](https://www.npmjs.com/package/@narumitw/pi-codex-accounts) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-codex-accounts` is a native [Pi coding agent](https://pi.dev) extension that lets you log in to, switch between, and remove multiple ChatGPT Plus/Pro Codex subscription accounts.

It keeps using Pi's built-in `openai-codex` provider. It does **not** add provider aliases, register OAuth providers, or change Pi's built-in `/login` and `/logout` provider lists.

## ✨ Features

- Adds `/codex-login <name>` for storing a named ChatGPT Codex subscription account.
- Adds `/codex-account [name]` for switching the active self-managed Codex account.
- Adds `/codex-logout <name>` for deleting one self-managed account.
- Adds `(default pi login)` in the selector to clear the active self-managed account and return to Pi's normal `openai-codex` auth.
- Stores credentials in `~/.pi/agent/pi-codex-accounts.json` with private file permissions.
- Sets only the runtime API key for Pi's native `openai-codex` provider.
- Leaves your selected `/model` unchanged, matching Pi's built-in `/login` behavior, except it may select `openai-codex/gpt-5.5` when the current model is `unknown/unknown`.
- Shows `codex:<name>` in the statusline only while the current model provider is `openai-codex`.
- Fails closed if an active self-managed account cannot refresh, so Pi does not silently fall back to a different Codex account.
- Closes the current session's cached Codex WebSocket when auth changes, preventing a reused connection from staying on the previous account.

## 📦 Install

```bash
pi install npm:@narumitw/pi-codex-accounts
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-codex-accounts
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-codex-accounts
```

## 🚀 Usage

Login to named accounts:

```text
/codex-login work
/codex-login personal
```

Switch accounts:

```text
/codex-account
/codex-account work
```

Return to Pi's built-in Codex login without deleting any self-managed account:

```text
/codex-account default
```

Remove one self-managed account:

```text
/codex-logout work
```

## 🔐 Auth behavior

The canonical credential file is `~/.pi/agent/pi-codex-accounts.json`. A legacy-only `codex-accounts.json` is migrated under the existing credential-file lock, copied with `0600` permissions, and removed only after the canonical file is installed. If both files exist, the canonical file takes precedence and the legacy file is retained.

When an active self-managed account is set, the extension applies that account's access token as Pi's runtime key for the native `openai-codex` provider. Login and refresh use Pi's provider-owned Codex OAuth implementation. Runtime key application supports both Pi 0.80.3's auth-storage shape and Pi 0.80.8's model-runtime shape.

When no self-managed account is active, the extension removes its runtime override and Pi uses its normal `openai-codex` auth resolution. That means existing `/login openai-codex`, `auth.json`, or environment behavior still works.

If the active self-managed account refresh fails, the extension keeps a non-empty failing runtime key in place. This prevents accidental fallback to a different Codex account.

Account switches and token refreshes also close any cached Codex WebSocket for the current Pi session. The next request reconnects with the newly selected credentials; repeated pre-turn checks, including turns started after compaction, keep the connection when auth is unchanged.

## 🚧 Limitations

- This extension supports ChatGPT Plus/Pro Codex subscription auth only.
- It does not rotate accounts automatically or try to bypass rate limits.
- It does not switch Claude, Anthropic, or browser-cookie sessions.
- Multiple Pi processes refreshing the same account at the same time are serialized through the extension's credential-file lock, but the newest refreshed token wins.

## 🗂️ Package layout

```txt
extensions/pi-codex-accounts/
├── src/
│   ├── codex-accounts.ts
│   └── storage.ts
├── test/
│   └── codex-accounts.test.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/codex-accounts.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, Codex, ChatGPT Plus, ChatGPT Pro, subscription account switching, OAuth.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
