# Z.AI (GLM Coding Plan)

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `zai` and `zai-coding-cn`
- Semantics: GLM Coding Plan quota windows—the rolling 5-hour and weekly plan-usage windows plus the monthly MCP allowance
- Source: the undocumented `GET {origin}/api/monitor/usage/quota/limit` endpoint also used by Z.AI's official coding plugin, plus the undocumented `GET {origin}/api/biz/subscription/list` plan endpoint
- Allowed origins: the model base URL must resolve to `https://api.z.ai` or `https://open.bigmodel.cn`
- Displayed data: explicit used and remaining values, reset times, provider-reported per-tool MCP details, and the plan name with its renewal date
- Percentage-only windows remain percent-based
- Statusline: publishes remaining plan percentages such as `zai 87% ↻ 2h30m · 76% ↻ 6d`, with static fallback `zai 5h:87% · wk:76%`; monthly MCP details remain available through `/usage`

The monitor endpoint is not a published API contract and may return legacy `TOKENS_LIMIT` or newer `CREDIT_LIMIT` window names.
The extension classifies both forms by the provider's window unit and does not label provider-reported counts as tokens or calls.
The quota monitor expects a raw API key without a `Bearer` prefix.
The extension removes that prefix from resolved authorization before sending it to the monitor endpoint.
Fingerprinting and redaction keep using the original resolved credential.
Quota errors use fixed English hints for the [documented Z.AI business error codes](https://docs.z.ai/api-reference/api-code), accepting nested `error.code` and the monitor endpoint's top-level `code` as strings or numbers.
An explicit nested code takes precedence; when it is absent, the top-level code is used.
For example, `1113` reports insufficient balance or no resource package, and `1309` reports an expired GLM Coding Plan.
When a failed HTTP response has no business error code, the hint uses its HTTP status; unknown business codes use a generic API failure message.
The monitor's top-level `code: 500` is not a documented business code and is not treated as HTTP 500 or proof that the credential has no Coding Plan.
Error classification never matches or echoes provider `msg` or `error.message` text, which may contain credentials.
Quota errors and missing or malformed quota data remain query failures with a statusline error hint, a 30-second request backoff, and scheduled retries; they no longer clear the statusline as unsupported.
An accepted Z.AI query failure discards the matching cached report, so the next turn after backoff expires retries instead of restoring stale usage.
The plan endpoint only contributes the plan name and renewal date; when it is unavailable or fails, the quota windows remain reported and the plan note falls back to the quota response's plan level.
Only the official `api.z.ai` and `open.bigmodel.cn` origins are queried; other origins fail before sending the credential.

Statusline usage refreshes every five minutes while the selected model remains on Z.AI. Monthly MCP details remain in `/usage` rather than the compact status.
