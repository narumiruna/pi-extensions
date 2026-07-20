# 🔐 pi-accounts — Subscription OAuth Account Switcher for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-accounts)](https://www.npmjs.com/package/@narumitw/pi-accounts) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-accounts` is a native [Pi coding agent](https://pi.dev) extension for keeping and switching named subscription OAuth accounts independently across supported providers.

It uses Pi's built-in providers and provider-owned OAuth implementations. A named account temporarily overrides only that provider's runtime auth; selecting `default` restores Pi's normal `/login`, `auth.json`, or environment-based resolution without deleting the named account.

## ✨ Features

- Manages OpenAI Codex, Anthropic Claude Pro/Max, and GitHub Copilot OAuth accounts through one `/account` command.
- Keeps an independent active named account—or Pi's built-in login—for every provider.
- Stores complete provider-owned OAuth credentials, including GitHub Enterprise and available-model metadata.
- Refreshes rotating OAuth credentials under a cross-process file lock.
- Writes `~/.pi/agent/pi-accounts.json` atomically with private directory and `0600` file permissions.
- Applies provider-specific runtime API keys, headers, endpoints, and Copilot model availability.
- Verifies effective runtime auth before reporting activation success.
- Fails closed and aborts only the affected provider's turn after refresh or activation failure.
- Restores the exact provider registration that existed before the account overlay.
- Invalidates cached Codex WebSockets only when the applied Codex identity changes.
- Migrates released `pi-codex-accounts.json` state without deleting the rollback source.
- Retains `/codex-login`, `/codex-account`, and `/codex-logout` as temporary compatibility aliases.

## 🔌 Supported providers

| Provider | Provider ID | Account-specific behavior |
| --- | --- | --- |
| OpenAI Codex | `openai-codex` | ChatGPT Plus/Pro OAuth, OAuth-only native-provider bridge, and Codex WebSocket invalidation |
| Anthropic | `anthropic` | Claude Pro/Max OAuth without interfering with Anthropic API-key auth after returning to `default` |
| GitHub Copilot | `github-copilot` | Individual or Enterprise login, credential-derived API endpoint, and account-specific available models |

> [!WARNING]
> Anthropic currently treats Claude Pro/Max use through third-party harnesses as **extra usage billed per token**, rather than consumption of the normal plan allowance. Review your Anthropic billing and extra-usage settings before using a named Anthropic account.

## 📦 Install

Do not load `pi-accounts` and the deprecated `pi-codex-accounts` package together; both register the Codex compatibility commands and can refresh the same rotating credential independently.

```bash
pi uninstall npm:@narumitw/pi-codex-accounts
pi install npm:@narumitw/pi-accounts
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-accounts
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-accounts
```

## 🚀 Usage

List every provider or one provider:

```text
/account list
/account list anthropic
```

Login and store a named subscription account (`default` is reserved):

```text
/account login openai-codex work
/account login anthropic personal
/account login github-copilot enterprise
```

Switch one provider without changing another provider's active account:

```text
/account switch openai-codex work
/account switch anthropic personal
/account switch github-copilot enterprise
```

Omit the account name in interactive mode to open a selector:

```text
/account switch anthropic
```

Return only one provider to Pi's built-in login:

```text
/account switch anthropic default
```

Remove a named account:

```text
/account remove github-copilot enterprise
```

Provider and stored-account arguments offer completion. Mutating commands always require an explicit provider ID.

### Temporary Codex aliases

These commands use exactly the same `openai-codex` state and runtime path as `/account`:

```text
/codex-login work
/codex-account work
/codex-account default
/codex-logout work
```

## 🔐 Auth and fail-closed behavior

Each selected account is refreshed through the provider's own OAuth `refresh()` implementation and converted through `toAuth()`. The extension then applies the returned API key, headers, and endpoint, verifies the effective runtime state, and reports success.

If refresh, conversion, provider overlay, or verification fails, the extension installs a non-secret failing runtime credential and aborts turns for that provider. It does not silently fall back to Pi's built-in login, an environment API key, or another named account. Other providers remain independent and usable.

Selecting `default` removes the package-owned runtime override and restores the exact provider registration that existed before activation. Pi's built-in credentials are never deleted.

GitHub Copilot's `availableModelIds` are projected into the active provider model list. Switching Copilot accounts rebuilds the projection from the complete pre-overlay model catalog. A currently selected model that is unavailable to the named account is rejected before the turn starts.

## 🗄️ Storage and migration

The canonical file is:

```text
~/.pi/agent/pi-accounts.json
```

When `PI_CODING_AGENT_DIR` is set, the file is stored at
`$PI_CODING_AGENT_DIR/pi-accounts.json` instead. Its versioned structure keeps account maps and
active names under separate provider IDs. Credential values are private and must not be committed.

On first load, if `pi-accounts.json` does not exist and released `pi-codex-accounts.json` does, the extension:

1. Locks and validates the legacy file.
2. Repairs its permission to `0600`.
3. Copies all Codex credentials and the active name into the `openai-codex` provider section.
4. Atomically installs private `pi-accounts.json`.
5. Retains the private legacy file for rollback.

If both files exist, `pi-accounts.json` is canonical and the legacy file is not imported again. The retained legacy refresh token may become stale after `pi-accounts` rotates it, so rollback can require a new Codex login.

### Rollback

1. Switch managed providers to `default` and stop Pi sessions using `pi-accounts`.
2. Remove `pi-accounts` from the Pi package configuration.
3. Reinstall the released `@narumitw/pi-codex-accounts` package if needed.
4. Reauthenticate Codex if the retained legacy refresh token was rotated.

The repository keeps the predecessor implementation at `deprecated/pi-codex-accounts`; moving it there does not run `npm deprecate` or change npm registry visibility.

## 🚧 Limitations and non-goals

- This package manages only subscription OAuth accounts. It does not store or switch API-key profiles.
- Continue using Pi's `auth.json`, environment variables, or `!command` secret-manager resolution for API keys.
- It does not rotate accounts automatically, evade quotas, or report usage.
- It does not support arbitrary custom providers in the first release.
- Live OAuth login and model requests depend on provider service availability and account entitlement.

## 🗂️ Package layout

```text
extensions/pi-accounts/
├── src/
│   ├── account-store.ts
│   ├── accounts.ts
│   ├── oauth.ts
│   ├── runtime-auth.ts
│   └── storage.ts
├── test/
│   ├── accounts-storage.test.ts
│   └── accounts.test.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/accounts.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, OAuth accounts, OpenAI Codex, ChatGPT Plus, ChatGPT Pro, Anthropic, Claude Pro, Claude Max, GitHub Copilot, GitHub Enterprise, subscription account switching.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
