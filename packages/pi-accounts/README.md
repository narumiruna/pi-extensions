# 🔐 pi-accounts — Switch Between Subscription OAuth Accounts

[![npm](https://img.shields.io/npm/v/@narumitw/pi-accounts)](https://www.npmjs.com/package/@narumitw/pi-accounts) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Save and switch named OpenAI Codex, Anthropic, and GitHub Copilot subscription accounts without replacing Pi's built-in provider integrations.

Each selection overrides only the chosen provider, and selecting `default` restores Pi's normal authentication without deleting saved accounts.

## ✨ Features

- Manages named OpenAI Codex, Anthropic Claude Pro/Max, and GitHub Copilot OAuth accounts through `/accounts`.
- Keeps an independent selected account—or Pi's default login—for each provider.
- Applies provider-specific credentials, endpoints, headers, and model availability through Pi's built-in providers.
- Refreshes rotating credentials safely and verifies effective runtime authentication before reporting success.
- Makes only the verified active OAuth credential available process-locally to compatible current-account consumers.
- Stores credentials atomically in a private local file and fails closed for the affected provider on activation errors.
- Migrates legacy `pi-codex-accounts.json` data while preserving its rollback source.

## 🔌 Supported providers

| Provider | Provider ID | Account-specific behavior |
| --- | --- | --- |
| OpenAI Codex | `openai-codex` | ChatGPT Plus/Pro OAuth, OAuth-only native-provider bridge, and Codex WebSocket invalidation |
| Anthropic | `anthropic` | Claude Pro/Max OAuth without interfering with Anthropic API-key auth after returning to `default` |
| GitHub Copilot | `github-copilot` | Individual or Enterprise login, credential-derived API endpoint, and account-specific available models |

> [!WARNING]
> Anthropic currently treats Claude Pro/Max use through third-party harnesses as **extra usage billed per token**, rather than consumption of the normal plan allowance.
> Review your Anthropic billing and extra-usage settings before using a named Anthropic account.

## 📦 Install

`pi-codex-accounts` is deprecated and its source is archived under `deprecated/`.
Do not load both packages together; they can manage and refresh the same rotating Codex credential independently.
To migrate one Pi installation:

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
npm --workspace @narumitw/pi-accounts run build
pi -e ./packages/pi-accounts
```

The package declares `dist/index.ts`, so an unbuilt local checkout must be built before Pi loads the package directory.

## 🚀 Quick start

Run `/accounts` in TUI or RPC mode, then choose a provider action from the account manager.
Use the manager to log in, switch accounts, restore Pi's default login, or remove a saved account.

## 💬 Commands

Open the interactive account manager:

```text
/accounts
```

The standard manager runs in TUI or RPC mode; Back returns through provider/account screens and Escape closes the root.
Print and JSON modes reject it observably.
Any extra text after `/accounts` is ignored so the entry point stays singular.
Provider-owned OAuth challenges, account-name text input, and exact replacement/removal confirmations remain specialized dialogs because they carry credential and destructive-action policy rather than ordinary navigation.

When no accounts are saved yet, the menu starts with login:

```text
Accounts

No saved accounts yet.

What do you want to do?
› Login new account
```

After accounts exist, `/accounts` shows the current model and every supported provider's active account before offering actions:

```text
Accounts

Current model:
  Anthropic / claude-sonnet-4

Active accounts:
  Anthropic: work
  GitHub Copilot: enterprise
  OpenAI Codex: default

What do you want to do?
› Switch Anthropic account
  Login new account
  Remove account
  Switch another provider’s account
```

Login reuses Pi's native `/login` dialog in TUI mode: choose a provider, enter a named account, then complete the provider's OAuth flow in the same bordered screen with native links, device codes, progress, prompts, and Escape cancellation.
Provider-owned choices temporarily use Pi's native selector before returning to the login dialog.
RPC mode uses Pi's standard extension UI requests for the same OAuth contract.
`default` is reserved for Pi's built-in login.
Reusing an existing provider/account name asks before replacing the stored credential.

Switching the current model provider is the primary flow.
Switching a different provider is explicit: choose **Switch another provider’s account**, choose the provider, then choose the account.
Choosing `default` restores Pi's built-in login for that provider.
`/accounts` manages account identity only; it does not switch models except when login succeeds while the current model is still `unknown`, where it selects that provider's default model as onboarding help.

Removing an account lists named accounts as `Provider · account`, asks for confirmation, then removes the credential.
Removing an active account automatically restores that provider to Pi's built-in login.

## 🔒 Security and privacy

Each selected account is refreshed through the provider's own OAuth `refresh()` implementation and converted through `toAuth()`.
The extension then applies the returned API key, headers, and endpoint, verifies the effective runtime state, and reports success.

If refresh, conversion, provider overlay, or verification fails, the extension installs a non-secret failing runtime credential and aborts turns for that provider.
It does not silently fall back to Pi's built-in login, an environment API key, or another named account.
Other providers remain independent and usable.

Selecting `default` removes the package-owned runtime override and restores the exact provider registration that existed before activation.
Pi's built-in credentials are never deleted.

The extension implements the versioned `oauth:credential-source:v1` protocol for compatible current-account consumers such as usage reporters.
It offers a fresh in-memory clone only after the named OAuth credential has produced and verified the active runtime authentication for the exact Pi session.
Pending, default, stale, failed, replaced, reloaded, and shut-down states offer nothing.
The offer contains no account name or extension identity and is never persisted or logged by the protocol.
A consumer must still match the offered access token and provider-specific metadata against freshly resolved runtime auth before using it.
Installing `pi-accounts` without a compatible consumer does not change account activation behavior.
An older or absent consumer simply does not request the credential.

Pi extensions run with the user's process privileges, and the shared event bus is not a security boundary between installed extensions.
Install only trusted extensions because any installed extension may already read user files and process memory.
The protocol reduces accidental credential coupling; it does not sandbox malicious code.

GitHub Copilot's `availableModelIds` are projected into the active provider model list.
Switching Copilot accounts rebuilds the projection from the complete pre-overlay model catalog.
A currently selected model that is unavailable to the named account is rejected before the turn starts.

## 🗄️ Storage and migration

The canonical file is:

```text
~/.pi/agent/pi-accounts.json
```

When `PI_CODING_AGENT_DIR` is set, the file is stored at `$PI_CODING_AGENT_DIR/pi-accounts.json` instead.
Its versioned structure keeps account maps and active names under separate provider IDs.
Credential values are private and must not be committed.
When neither canonical nor legacy storage exists, reads use an empty in-memory store without creating an agent directory or file; the first account mutation creates the private canonical file.

On first load, if `pi-accounts.json` does not exist and released `pi-codex-accounts.json` does, the extension:

1. Locks and validates the legacy file.
2. Repairs its permission to `0600`.
3. Copies all Codex credentials and the active name into the `openai-codex` provider section.
4. Atomically installs private `pi-accounts.json`.
5. Retains the private legacy file for rollback.

If both files exist, `pi-accounts.json` is canonical and the legacy file is not imported again.
The retained legacy refresh token may become stale after `pi-accounts` rotates it, so rollback can require a new Codex login.

### Rollback

1. Switch managed providers to `default` and stop Pi sessions using `pi-accounts`.
2. Remove `pi-accounts` from the Pi package configuration.
3. Reinstall the deprecated `@narumitw/pi-codex-accounts` package only if necessary.
4. Reauthenticate Codex if the retained legacy refresh token was rotated.

The repository preserves the predecessor implementation under `deprecated/pi-codex-accounts` for reference.
It is excluded from active workspace checks, version bumps, and publishing.

## 🚧 Limitations

- This package manages only subscription OAuth accounts.
  It does not store or switch API-key profiles.
- Continue using Pi's `auth.json`, environment variables, or `!command` secret-manager resolution for API keys.
- It does not rotate accounts automatically, evade quotas, or report usage.
- It does not support arbitrary custom providers in the first release.
- Live OAuth login and model requests depend on provider service availability and account entitlement.

## 🗂️ Package layout

```text
packages/pi-accounts/
├── src/
│   ├── index.ts
│   ├── account-store.ts
│   ├── accounts.ts
│   ├── oauth.ts
│   ├── oauth-credential-source.ts
│   ├── runtime-auth.ts
│   └── storage.ts
├── dist/               # Generated source-mapped Jiti runtime
├── scripts/
│   └── build-runtime.mjs
├── test/
│   ├── accounts-storage.test.ts
│   ├── accounts.test.ts
│   └── build-runtime.test.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, OAuth accounts, OpenAI Codex, ChatGPT Plus, ChatGPT Pro, Anthropic, Claude Pro, Claude Max, GitHub Copilot, GitHub Enterprise, subscription account switching.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
