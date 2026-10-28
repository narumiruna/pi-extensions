# @narumitw/pi-accounts

## 0.54.0

### Minor Changes

- 5442c02: Notify current-session usage consumers when an account selection is committed so status lines can refresh without waiting for the next turn. Wait for each provider's pending account activation before resolving usage authentication, including OpenRouter, Kimi, and legacy Codex.

## 0.53.3

### Patch Changes

- 14c86c5: Hide providers without saved accounts from the default account menu.

## 0.53.2

### Patch Changes

- f8b1ca9: Retry provider OAuth lookups after a failed load instead of caching the rejection until restart. Keep current-call failures, concurrent lookup sharing, and successful lookup caching unchanged.

## 0.53.1

### Patch Changes

- 2a339f6: Fix OpenAI account login failing with "Sign in with ChatGPT requires a device ID (UUID) for this installation". Pass Pi's stable installation device ID to provider login flows, as Pi's `/login` does, in TUI and RPC modes.

## 0.53.0

### Minor Changes

- 1a81acc: Support OpenAI and Meta OAuth accounts alongside all existing built-in login providers. Add named API key profiles for supported providers with native API key authentication, preserving session-local selection, private credential storage, and fail-closed activation. API key entry uses visible native TUI/RPC input. Verify effective model authentication and fail closed when configured headers would select a different account, without rewriting user configuration.
- 629be1d: Add versioned `pi.events` protocols for read-only named-account topology discovery and explicit session-scoped OAuth or API-key account activation. Return credential-free typed outcomes, preserve session isolation and stale-activation safety, and support restoring Pi's built-in authentication without introducing automatic rotation or routing policy.
- 40bf607: Allow `PI_ACCOUNT=<name>` to select the named account for every supported provider in the current Pi process without changing saved defaults or session selections. Missing or invalid names fail closed instead of falling back to another account.

### Patch Changes

- 2537959: Wait for queued credential writes before replying to account topology and activation requests, preserve activation results across routine same-account syncs while honoring consumer cancellation, verify effective authentication for every available model, and classify credential read and resolved auth conflicts with specific error codes.

## 0.52.2

### Patch Changes

- 751a296: Start Pi sessions without waiting for account-file locks or provider activation, while preserving fail-closed authentication by gating each provider's first use, allowing compatible usage queries to await pending activation, and cancelling stale startup work.
- Updated dependencies [e6db042]
  - @narumitw/pi-tui-kit@0.65.1

## 0.52.1

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.52.0

### Minor Changes

- da8b65e: Add a Set default account picker to `/accounts` for each provider. New sessions use the saved default, while current, resumed, and reloaded sessions retain their own account selections. Preserve unknown settings fields during saves and order asynchronous reads after queued writes.

## 0.51.0

### Minor Changes

- f6b3000: Keep OAuth account selections local to each Pi session and restore them after resume or reload.

## 0.50.0

### Minor Changes

- ae12c77: Add named OAuth account management for xAI, Kimi For Coding, OpenRouter, and Radius.

## 0.49.11

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.49.10

### Patch Changes

- 42e8940: Allow current-account consumers to verify named OAuth credentials through a process-local protocol, including GitHub Copilot usage and OpenAI Codex reset flows.

## 0.49.9

### Patch Changes

- 71125e0: Pass a lifecycle-cancellable signal to provider-owned OAuth refresh so expiring account credentials refresh correctly with Pi 0.84.x.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 0.49.8

### Patch Changes

- dc4f90e: Load each extension from a generated source-mapped Jiti runtime while preserving first-use feature boundaries.

## 0.49.7

### Patch Changes

- 25aa27e: Use Pi's native login dialog and selector for provider OAuth steps in TUI mode while preserving standard extension UI requests in RPC mode.

## 0.49.6

### Patch Changes

- d3242d6: Pass the account menu's abort signal to provider-owned OAuth login so interactive GitHub Copilot and other provider logins do not fail while Pi is idle and stop safely when their session closes.
