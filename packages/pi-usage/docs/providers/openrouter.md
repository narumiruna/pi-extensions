# OpenRouter

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `openrouter`
- Semantics: API-key spend and per-key credit limits—not consumer subscription quota
- Source: OpenRouter's documented [`GET /api/v1/key`](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) endpoint using Pi's resolved inference API key
- Displayed data: key label when safely returned, optional per-key limit and remaining amount, reset period, and daily/weekly/monthly/all-time spend
- Statusline examples: `openrouter $74.50 left` or `openrouter $25.50 used`

The extension does not call OpenRouter's account-level `/credits` endpoint because that operation requires a separate management key.
OpenRouter documents the distinction between credit and rate limits in its [API limits guide](https://openrouter.ai/docs/api_reference/limits).

Successful inference responses do not expose proactive request-rate counters; `/usage` reports the documented per-key credit and spend fields instead.
