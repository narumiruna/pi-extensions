# 🔐 pi-accounts — Switch Between OAuth Accounts

[![npm](https://img.shields.io/npm/v/@narumitw/pi-accounts)](https://www.npmjs.com/package/@narumitw/pi-accounts) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Save and switch named OAuth accounts for Pi's built-in providers.
Each Pi session keeps its own selection for every provider, and choosing `default` restores Pi's normal authentication only for that session without deleting saved accounts.

> [!WARNING]
> Anthropic currently treats Claude Pro/Max use through third-party harnesses as **extra usage billed per token**, rather than consumption of the normal plan allowance.
> Review your Anthropic billing and extra-usage settings before using a named Anthropic account.

## ✨ Features

- Manages named OpenAI Codex, Anthropic Claude Pro/Max, GitHub Copilot, Kimi For Coding, OpenRouter, Radius, and xAI OAuth accounts through `/accounts`.
- Selects an account—or Pi's default login—independently for each provider and Pi session.
- Restores session selections after resume or reload while allowing concurrent sessions to use different accounts.
- Applies provider-specific credentials, endpoints, headers, and model availability through Pi's built-in providers.
- Refreshes rotating credentials and verifies the effective authentication before reporting success.
- Offers only the verified active OAuth credential to compatible in-process consumers.
- Writes credentials atomically to a private local file and fails closed for only the affected provider when activation fails.
- Imports legacy `pi-codex-accounts.json` data while retaining the source file for rollback.

## 📦 Install

Install persistently:

```bash
pi install npm:@narumitw/pi-accounts
```

`pi-codex-accounts` is deprecated and archived under `deprecated/`.
Do not load both packages because each can refresh the same rotating Codex credential.
Migrate an existing installation with:

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

Run `/accounts` in TUI or RPC mode.
Use the manager to log in, switch accounts, restore a provider's default Pi login, or remove an account.

## 🔌 Supported providers

| Provider | Provider ID | Account-specific behavior |
| --- | --- | --- |
| OpenAI Codex | `openai-codex` | ChatGPT Plus/Pro OAuth, OAuth-only native-provider bridge, and Codex WebSocket invalidation |
| Anthropic | `anthropic` | Claude Pro/Max OAuth without interfering with Anthropic API-key auth after returning to `default` |
| GitHub Copilot | `github-copilot` | Individual or Enterprise login, credential-derived API endpoint, and account-specific available models |
| Kimi For Coding | `kimi-coding` | Kimi Code subscription OAuth with provider-owned Bearer-header authentication |
| OpenRouter | `openrouter` | OpenRouter OAuth that mints a persistent account API key without managing manually entered API-key profiles |
| Radius | `radius` | Gateway-bound OAuth with credential-specific dynamic model-catalog refresh and selected-model rebinding |
| xAI | `xai` | SuperGrok or X Premium OAuth with the native xAI provider and model catalog |

## 💬 Commands

Open the interactive account manager:

```text
/accounts
```

The manager supports TUI and RPC mode.
Back returns through provider and account screens, and Escape closes the root.
Print and JSON modes do not provide account-manager output.
Extra text after `/accounts` is ignored.
OAuth challenges, account names, and replacement or removal confirmations use dedicated dialogs.

When no accounts are saved yet, the menu starts with login:

```text
Accounts

No saved accounts yet.

What do you want to do?
› Login new account
```

After accounts exist, `/accounts` shows the current model and the current Pi session's selected account for every supported provider before offering actions:

```text
Accounts

Current model:
  Anthropic / claude-sonnet-4

Active accounts:
  Anthropic: work
  GitHub Copilot: enterprise
  Kimi For Coding: fast
  OpenAI Codex: default
  OpenRouter: credits
  Radius: work
  xAI: personal

What do you want to do?
› Switch Anthropic account
  Login new account
  Remove account
  Switch another provider’s account
```

### Login

In TUI mode, login uses Pi's native `/login` dialog with links, device codes, progress, prompts, and Escape cancellation.
Provider-owned choices temporarily open Pi's native selector, then return to the login dialog.
RPC mode uses Pi's standard extension UI requests for the same OAuth flow.
`default` is reserved for Pi's built-in login.
Reusing a provider and account name requires confirmation before replacement.

### Switch or remove an account

The primary switch action targets the current model's provider.
To switch another provider, choose **Switch another provider’s account**, then choose the provider and account.
Choosing `default` restores Pi's built-in login for that provider in the current Pi session only.
Switching or logging in does not change selections owned by other running or resumable sessions.
`/accounts` changes account identity, not the model.

Removal lists accounts as `Provider · account` and requires confirmation.
Removing the current session's selected account records `default` for that provider.
Because named credentials are shared, another session that selected the removed name fails closed on its next turn until the user chooses another account or `default`.

## 🔒 Security and privacy

The extension refreshes each selected account through the provider's OAuth `refresh()` implementation and converts it through `toAuth()`.
It applies the returned API key, headers, and endpoint, then verifies the effective runtime state before reporting success.

If refresh, conversion, provider overlay, or verification fails, the extension installs a non-secret failing runtime credential and aborts turns for that provider.
It does not silently fall back to Pi's built-in login, an environment API key, or another named account.
Other providers remain independent and usable.
Selecting `default` removes the package-owned runtime override and restores the exact provider registration that existed before activation.
Pi's built-in credentials are never deleted.

Session selections are stored as versioned, non-model custom entries in Pi's session JSONL.
The entries contain only provider IDs and account names, not OAuth credentials.
The owning Pi session ID prevents a fork or clone from treating copied parent entries as its own selection.
Resume and reload restore entries owned by the same session, while `/tree` navigation keeps one session-wide selection instead of changing authentication by branch.
A malformed matching selection entry fails managed providers closed until `/accounts` writes a valid snapshot; recovery defaults any other managed provider whose selection could not be trusted.

The extension implements the versioned `oauth:credential-source:v1` protocol for compatible current-account consumers such as usage reporters.
It offers a fresh in-memory clone only after the named OAuth credential has produced and verified active runtime authentication for the exact Pi session.
Pending, default, stale, failed, replaced, reloaded, and shut-down states offer nothing.
The protocol does not persist or log the offer, which contains neither the account name nor extension identity.
Consumers must match its access token and provider metadata against freshly resolved runtime authentication.
Without a compatible consumer, account activation works unchanged and no credential is requested.

Pi extensions run with the user's process privileges, and the shared event bus does not isolate installed extensions.
Install only trusted extensions because any extension can read user files and process memory.
The protocol reduces accidental credential coupling; it is not a sandbox.

GitHub Copilot's `availableModelIds` are projected into the active provider model list.
Switching Copilot accounts rebuilds the projection from the complete pre-overlay model catalog.
A currently selected model that is unavailable to the named account is rejected before the turn starts.

Kimi's provider-owned OAuth returns an `Authorization: Bearer` header instead of an API key.
The extension applies that header and installs a non-secret runtime selector to displace Pi's default Kimi credential.
Activation verifies the effective Bearer header and fails closed before a turn if Pi does not retain it.

OpenRouter's provider-owned OAuth returns a persistent API key represented as an OAuth credential with an empty refresh token.
The extension preserves that exact provider credential and does not treat it as a manually managed API-key profile.

Radius OAuth is bound to the active `radius` provider's configured gateway.
The extension refreshes Radius's dynamic model catalog when the session or effective named credential changes, rebinds a retained selected model to its refreshed endpoint, and fails closed if the selected model disappears or catalog publication fails.
Selecting `default` refreshes the Radius catalog against Pi's restored credential after a named account was active.
Shutdown removes named Radius authentication and makes a bounded attempt to restore the default catalog; Pi's next catalog refresh remains the recovery path if the gateway is unavailable during shutdown.
Custom gateways configured for the `radius` provider ID are supported, while arbitrary Radius provider aliases are not.

## 🗄️ Storage and migration

The canonical file is:

```text
~/.pi/agent/pi-accounts.json
```

When `PI_CODING_AGENT_DIR` is set, the file is stored at `$PI_CODING_AGENT_DIR/pi-accounts.json` instead.
Its versioned structure keeps shared credential maps and a compatibility default under separate provider IDs.
The legacy provider-level `active` value seeds a session that has no owned selection entry, but login, switch, and `default` actions no longer change it.
A resumed session created before session-local selection support snapshots the current compatibility default once because its historical account choice cannot be inferred.
Every new session snapshots that compatibility default; forked and cloned sessions do not inherit copied parent selections because their new IDs do not own those entries.
Removing the credential named by the compatibility default clears that default so new sessions are not seeded with a missing account.
Credential values are private and must not be committed.
When neither canonical nor legacy storage exists, reads return an empty store without creating a directory or file.
The first account change creates the private canonical file.

On first load, if `pi-accounts.json` does not exist and released `pi-codex-accounts.json` does, the extension:

1. Locks and validates the legacy file.
2. Repairs its permission to `0600`.
3. Copies all Codex credentials and the active name into the `openai-codex` provider section.
4. Atomically installs private `pi-accounts.json`.
5. Retains the private legacy file for rollback.

If both files exist, `pi-accounts.json` takes precedence and the legacy file is not imported again.
The retained legacy refresh token may become stale after `pi-accounts` rotates it, so rollback can require a new Codex login.
Older releases reject files that contain provider sections added later.
Before downgrading, stop Pi, back up the file, and remove the `kimi-coding`, `openrouter`, `radius`, and `xai` sections.

### Rollback

1. Switch managed providers to `default` and stop Pi sessions using `pi-accounts`.
2. Remove `pi-accounts` from the Pi package configuration.
3. Reinstall the deprecated `@narumitw/pi-codex-accounts` package only if necessary.
4. Reauthenticate Codex if the retained legacy refresh token was rotated.

Older `pi-accounts` releases ignore session selection entries and return to the retained provider-level compatibility default.
Select the desired account again after rollback because switches made by this version did not update that global default.

The repository preserves the predecessor implementation under `deprecated/pi-codex-accounts` for reference.
It is excluded from active workspace checks, version bumps, and publishing.

## 🚧 Limitations

- This package manages only provider-owned OAuth accounts.
  It does not store or switch manually entered API-key profiles.
- Continue using Pi's `auth.json`, environment variables, or `!command` secret-manager resolution for API keys.
- It does not rotate accounts automatically, evade quotas, or report usage.
- It does not support arbitrary custom providers.
- Live OAuth login and model requests depend on provider service availability and account entitlement.
- Sessions created before this behavior cannot recover a historical per-session choice and therefore use the shared compatibility default for their first snapshot.

## 🗂️ Package layout

```text
packages/pi-accounts/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── accounts.ts                    # Account activation and session lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, OAuth accounts, OpenAI Codex, ChatGPT Plus, ChatGPT Pro, Anthropic, Claude Pro, Claude Max, GitHub Copilot, GitHub Enterprise, Kimi For Coding, Kimi Code, OpenRouter, Radius, xAI, Grok, SuperGrok, X Premium, account switching.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
