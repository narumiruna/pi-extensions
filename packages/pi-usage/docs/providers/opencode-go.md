# OpenCode Go (Zen)

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `opencode-go`
- Semantics: OpenCode Zen plan usage windows—rolling, weekly, and monthly
- Source: `GET https://opencode.ai/zen/go/v1/usage` using Pi's resolved inference API key
- Displayed data: used percentage and reset time for each window
- Status handling: `rate-limited` windows remain visible, while unknown statuses become unavailable notes
- Statusline examples: `zen 0% ↻ 2h30m · 4% ↻ 6d · m:2%` or static fallback `zen r:0% · w:4% · m:2%`

The fixed endpoint is queried only when the OpenCode Go model uses the official `https://opencode.ai` origin.
When resolved provider auth includes a base URL, that URL must use the same origin.
Other origins fail before the credential is sent.
