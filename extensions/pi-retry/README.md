# 🔁 pi-retry — Retry Hints for Pi Provider Errors

[![npm](https://img.shields.io/npm/v/@narumitw/pi-retry)](https://www.npmjs.com/package/@narumitw/pi-retry) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-retry` is a native [Pi coding agent](https://pi.dev) extension that treats provider responses containing `Unknown error (no error details in response)` and stalled provider streams as retryable.

Use it to make Pi sessions more resilient when an upstream AI provider returns a transient unknown error without useful details or stops streaming after Pi has sent a request.

## ✨ Features

- Detects assistant messages that end with `stopReason: "error"`.
- Matches the known provider error text `Unknown error (no error details in response)`.
- Appends Pi's retryable-provider-error hint.
- Lets Pi's built-in retry path continue the turn.
- Watches provider requests and assistant stream events for stalls.
- Aborts and rewrites watchdog-triggered aborts as retryable provider errors.
- Shows `📥 receiving` in the statusline while provider/stream events are arriving.
- Shows `🔁 retrying` when a matching error or stall triggers retry.
- Supports `--retry-stall-timeout-ms <ms>` and `PI_RETRY_STALL_TIMEOUT_MS=<ms>`.
- Works as a small, focused npm Pi extension package.

## 📦 Install

```bash
pi install npm:@narumitw/pi-retry
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-retry
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-retry
```

## 🚀 What it does

When an assistant message ends with `stopReason: "error"` and the error message matches `Unknown error (no error details in response)`, the extension appends Pi's retryable-provider-error hint so Pi's built-in retry path can continue the turn.

After Pi sends a provider request, the extension also starts a stall watchdog. Provider responses and assistant stream events briefly refresh a `📥 receiving` statusline item, so you can tell that data is still arriving while Pi shows its normal working indicator. If no provider response or assistant stream event is observed for 30000ms, it briefly shows `🔁 retrying`, calls `ctx.abort()`, and rewrites the resulting assistant abort/error as a retryable provider error.

Configure the watchdog with:

```bash
pi -e npm:@narumitw/pi-retry --retry-stall-timeout-ms 10000
PI_RETRY_STALL_TIMEOUT_MS=10000 pi -e npm:@narumitw/pi-retry
```

Use `0`, `off`, or `false` to disable the watchdog. Retry attempts and backoff remain controlled by Pi's built-in auto-retry settings.

## 🧠 Use cases

- Reduce manual restarts after transient provider failures.
- Improve reliability during long Pi coding agent sessions.
- Keep tool-heavy implementation tasks moving when a provider returns an unknown error or stream stalls.
- Pair with `@narumitw/pi-goal` for more robust autonomous task loops.

## 🗂️ Package layout

```txt
extensions/pi-retry/
├── src/
│   └── retry.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/retry.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, retry, provider error, unknown error, stream stall, watchdog, AI provider reliability, agent resilience, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
