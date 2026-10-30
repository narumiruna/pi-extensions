# Vercel AI Gateway credits

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `vercel-ai-gateway`
- Semantics: current team credit balance and lifetime spend, not rate-limit quota
- Source: documented `GET https://ai-gateway.vercel.sh/v1/credits` using Pi's resolved AI Gateway API key
- Displayed data: exact decimal-string credit balance and lifetime spend in USD
- Statusline example: `vercel USD 95.50 left`

The extension queries the fixed endpoint only when the selected model origin and any resolved-auth origin are `https://ai-gateway.vercel.sh`.
Custom and proxy origins fail before network access, redirects are rejected, and only the resolved Bearer credential is forwarded.
The credits endpoint does not provide reset times, request-rate counters, or date-window usage, so `pi-usage` does not claim those capabilities.
Vercel's separate Custom Reporting API is limited to eligible paid plans and is intentionally outside this first integration.

The contract was verified on 2026-08-30 against Vercel's [REST API Reference](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance) and the first-party [`vercel/ai` Gateway implementation](https://github.com/vercel/ai/blob/69428b1f8b037e4d118fb4853428d5c4e620493c/packages/gateway/src/gateway-fetch-metadata.ts).
