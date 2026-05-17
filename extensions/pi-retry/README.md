# 🔁 pi-retry — Retry Hints for Pi Provider Errors

[![npm](https://img.shields.io/npm/v/@narumitw/pi-retry)](https://www.npmjs.com/package/@narumitw/pi-retry) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-retry` is a native [Pi coding agent](https://pi.dev) extension that treats provider responses containing `Unknown error (no error details in response)` as retryable.

Use it to make Pi sessions more resilient when an upstream AI provider returns a transient unknown error without useful details.

## ✨ Features

- Detects assistant messages that end with `stopReason: "error"`.
- Matches the known provider error text `Unknown error (no error details in response)`.
- Appends Pi's retryable-provider-error hint.
- Lets Pi's built-in retry path continue the turn.
- Shows a short-lived statusline item only when a matching error triggers retry.
- Requires no commands or configuration.
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

The extension does not keep a permanent statusline entry. It briefly shows `🔁 retrying` only when it has matched the error and asked Pi to retry.

## 🧠 Use cases

- Reduce manual restarts after transient provider failures.
- Improve reliability during long Pi coding agent sessions.
- Keep tool-heavy implementation tasks moving when a provider returns an unknown error.
- Pair with `@narumitw/pi-goal` for more robust autonomous task loops.

## 🗂️ Package layout

```txt
extensions/pi-retry/
├── src/
│   └── unknown-error-retry.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/unknown-error-retry.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, retry, provider error, unknown error, AI provider reliability, agent resilience, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
