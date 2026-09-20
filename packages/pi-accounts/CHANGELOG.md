# @narumitw/pi-accounts

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
