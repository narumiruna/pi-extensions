# 📈 pi-cache-hit-monitor — Inspect Prompt Cache Reuse in Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-cache-hit-monitor)](https://www.npmjs.com/package/@narumitw/pi-cache-hit-monitor) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Show live prompt-cache reuse, token, and estimated cost diagnostics above Pi's editor without changing model-visible context.
The widget starts hidden in every session.

## ✨ Features

- Previews provider-reported cache usage while an assistant response streams.
- Compares each request with the previous request in the current cache prefix epoch.
- Reports weighted active-branch totals, including compaction and branch-summary usage.
- Restores metrics after session start, compaction, and tree navigation.
- Keeps provider and model labels terminal-safe and every widget line within the available width.
- Adds no tools, messages, system instructions, or provider payload changes.

## 📦 Install

Install the extension permanently:

```bash
pi install npm:@narumitw/pi-cache-hit-monitor
```

Try it without installing permanently:

```bash
pi -e npm:@narumitw/pi-cache-hit-monitor
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-cache-hit-monitor
```

Pi extensions run with the Pi process's user permissions, so install only trusted packages.
This extension reads usage and model metadata already present in the active Pi session and performs no network or file operations of its own.

## 🚀 Quick start

Run `/cache-hit-monitor` in TUI or RPC mode to show the widget.
Run the same command again to hide it.
The widget updates when the provider reports usage and is removed when the session shuts down.

## 💬 Commands

`/cache-hit-monitor` shows or hides live prompt-cache diagnostics.
It accepts no arguments, supports TUI and RPC modes, and rejects print and JSON modes.

## 📊 Displayed metrics

- `hit` is `cacheRead / (input + cacheRead + cacheWrite)` for the latest provider response.
- `Δ` is the signed percentage-point change from the previous comparable request.
- `loss` is only the downward part of that hit-rate change.
- `uncached` is the latest `input` share and token count.
- `eligible` is the smaller prompt-token count between the previous and current request.
- `re-billed` estimates reusable-prefix tokens not covered by the current `cacheRead` count.
- `cache saved` estimates the price difference between uncached input and cache-read pricing.
- `miss premium` estimates the extra price of re-billed tokens compared with cache-read pricing.
- `start gap` is the elapsed time between the previous and current provider request start timestamps.
- `Session` reports weighted active-branch totals and does not average request percentages.
- `Trend` shows the latest eight request hit rates from oldest to newest.

Session totals include provider usage reported by compaction and branch-summary calls.
When summary usage omits cache accounting, the request count, tokens, and prompt cost remain included while hit rate and savings stay unavailable.

## 🔄 Runtime behavior

While visible, the widget updates from `message_update` as soon as the provider reports usage and finalizes on `message_end`.
Cache comparisons reset across compaction and branch-summary boundaries because those events create a new cache prefix epoch, while session totals continue to include usage records visible on the active branch.
The extension rebuilds state after session start, compaction, and tree navigation, clears its widget during session replacement and shutdown, and ignores events from stale sessions.

## 🔒 Security and privacy

The extension does not make network requests, read files, write files, or persist separate state.
It reads assistant usage, provider and model IDs, model pricing, and active-branch summary usage from Pi's in-memory session APIs.
No collected metric is sent to the model by this extension.

## 🚧 Limitations

- Values depend on provider-reported Pi usage fields and can remain unavailable when a provider omits cache accounting.
- The monitor does not interpret normalized all-zero cache fields as a complete miss until that provider reports cache-read or cache-write activity.
- `re-billed` compares token counts and cannot prove which exact serialized prefix bytes the provider cached.
- Cost values use reported usage costs with Pi's effective model tiers and cache-write retention pricing as component fallbacks; subscription billing can differ.
- Cache writes are included in the hit-rate denominator but are not labeled as uncached input.

## 🗂️ Package layout

```text
packages/pi-cache-hit-monitor/
├── src/
│   ├── index.ts                # Thin Pi entrypoint
│   ├── cache-hit-monitor.ts    # Command, lifecycle, and widget rendering
│   └── metrics.ts              # Cache calculations and report formatting
├── test/                       # Metrics, modes, lifecycle, and rendering coverage
├── package.json
├── README.md
└── LICENSE
```

The package publishes its TypeScript source entrypoint for Pi's Jiti runtime and needs no build step.

## 🔎 Keywords

Pi extension, Pi coding agent, prompt cache, cache hit rate, token reuse, cache cost, observability, TypeScript widget.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
