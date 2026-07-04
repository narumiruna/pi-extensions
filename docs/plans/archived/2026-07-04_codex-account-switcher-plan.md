## Goal

Build a Pi extension package that lets the user manage and switch multiple ChatGPT Plus/Pro Codex subscription accounts without changing Pi's built-in `/login` or `/logout` provider lists. Success means `/codex-login`, `/codex-account`, and `/codex-logout` manage self-stored Codex OAuth credentials, set the runtime `openai-codex` bearer token when active, and fall back to Pi's normal Codex auth only when no self-managed account is active.

## Context

Agreed behavior:

- Support only ChatGPT Plus/Pro Codex, not Claude subscription switching.
- Do not register provider aliases and do not register custom OAuth providers.
- Keep using Pi's native `openai-codex` provider and the user's selected `/model`.
- Match built-in `/login` model behavior: login/account switching should not change the current model, except selecting `openai-codex/gpt-5.5` is allowed only when Pi currently has `unknown/unknown`.
- Store managed accounts outside Pi's `auth.json`, in a private file under the Pi agent directory.
- Show `codex:<account>` status only while the selected model provider is `openai-codex`.

Relevant repository evidence:

- The monorepo uses workspace packages under `extensions/*`.
- `@narumitw/pi-codex-usage` already demonstrates Codex provider detection, model-change status clearing, stale-context handling, and tests.
- The current dependencies expose `@earendil-works/pi-ai/oauth` and Pi `AuthStorage` runtime API key APIs.

## Architecture

Created `extensions/pi-codex-accounts` instead of expanding `pi-codex-usage`; account switching is auth state management, while `pi-codex-usage` is display/status only.

Data flow:

1. `/codex-login <name>` runs OpenAI Codex OAuth through Pi AI's existing Codex OAuth provider, stores credentials for `<name>`, sets global active account to `<name>`, and applies that account's `access` token as the runtime API key for provider `openai-codex`.
2. `/codex-account [name]` changes only the active self-managed account. With no argument, it opens a selector that includes stored accounts plus `(default pi login)`, which clears active account and removes the runtime override.
3. `/codex-logout <name>` removes one stored account. If it was active, clear active account and remove the runtime override so Pi returns to built-in auth behavior.
4. `session_start`, `model_select`, and `before_agent_start` keep the runtime `openai-codex` key in sync with the active account and refresh near-expired tokens.
5. If an active account exists but refresh fails, set a non-empty invalid runtime key so provider auth fails closed instead of falling through to Pi's `auth.json` credential.

Storage shape:

```json
{
  "active": "work",
  "accounts": {
    "work": { "access": "...", "refresh": "...", "expires": 1234567890, "accountId": "..." }
  }
}
```

The implementation uses Pi's exported `FileAuthStorageBackend` for locking and private `0600` writes.

## Non-Goals

- Do not modify or intercept built-in `/login` or `/logout`.
- Do not add `openai-codex-main` or similar provider aliases.
- Do not automatically rotate accounts to bypass limits.
- Do not switch Claude, Anthropic, or browser-cookie sessions.
- Do not merge Codex usage reporting into this package.

## Plan

- [x] Confirmed the target package API surface for OAuth login and runtime API key injection by checking `@earendil-works/pi-ai/oauth` and Pi coding-agent typings; implementation uses `openaiCodexOAuthProvider`, `FileAuthStorageBackend`, and runtime `setRuntimeApiKey`/`removeRuntimeApiKey`.
- [x] Created `extensions/pi-codex-accounts` with `package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `src/codex-accounts.ts`, and `test/codex-accounts.test.ts`.
- [x] Added account storage helpers around `~/.pi/agent/codex-accounts.json` using `FileAuthStorageBackend`, validating schema, preserving private writes, and never logging token values in parse errors.
- [x] Implemented `/codex-login <name>` with dynamic safe account names, existing Codex OAuth login, account persistence, active-account selection, runtime token injection, and model preservation.
- [x] Implemented `/codex-account [name]` with stored-account completions, no-arg selector, and `(default pi login)` fallback that clears the runtime override.
- [x] Implemented `/codex-logout <name>` with stored-account completions, active/non-active account deletion, and fallback cleanup when the active account is removed.
- [x] Implemented lifecycle sync on `session_start`, `model_select`, `before_agent_start`, and `session_shutdown`, including refresh-before-use and fail-closed runtime auth on active refresh failure.
- [x] Implemented Codex-only statusline output: `codex:<name>` is set only when the current model provider is `openai-codex`, and cleared for other providers.
- [x] Wired the workspace: root scripts, `just` recipes, lockfile workspace/link entries, and root README package listing.
- [x] Added package tests covering storage parse/write/redaction, account login/switch/logout, default fallback, refresh success/failure, status visibility, argument completions, and no model change when the current model is not `unknown/unknown`.
- [x] Verified package contents with `just pack codex-accounts`.
- [x] Smoke-tested extension loading with `pi -e ./extensions/pi-codex-accounts --list-models`; real OAuth smoke was not run because it requires interactive user credentials, but command behavior is covered by mocked OAuth tests.

## Tests

- [x] Unit tests for account file parsing, invalid JSON/schema behavior, private file writes, and token redaction.
- [x] Unit tests for `/codex-login` storing and activating an account without changing a non-unknown selected model.
- [x] Unit tests for `/codex-account` switching accounts and clearing to default Pi auth.
- [x] Unit tests for `/codex-logout` removing active and non-active accounts.
- [x] Unit tests for refresh success, refresh persistence, and fail-closed refresh failure.
- [x] Unit tests for statusline visibility only on `openai-codex`.
- [x] Repository checks: `npm run check`.
- [x] Package dry run: `just pack codex-accounts`.
- [x] Runtime load smoke: `pi -e ./extensions/pi-codex-accounts --list-models`.

## Completion Checklist

- [x] Extension package is independently installable and listed in `package.json` `pi.extensions`.
- [x] Built-in `/login` and `/logout` behavior is unchanged: code does not call `registerProvider`, does not add provider aliases, and `pi -e ./extensions/pi-codex-accounts --list-models` showed no account-specific provider aliases.
- [x] `/codex-login`, `/codex-account`, and `/codex-logout` are implemented with completions where useful.
- [x] Account switching uses `openai-codex` runtime API key override only.
- [x] Account switching does not change `/model` except the allowed `unknown/unknown` path.
- [x] Active account refresh failure fails closed and does not fallback.
- [x] No active account falls back to Pi's normal Codex auth.
- [x] Tests and package dry run pass.
