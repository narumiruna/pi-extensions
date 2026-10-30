# DeepSeek API balance

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `deepseek`
- Semantics: current API account balance, not historical usage or quota
- Source: documented `GET https://api.deepseek.com/user/balance` using Pi's freshly resolved runtime API key
- Displayed data: whether API calls are available plus separate total, granted, and topped-up balances for each returned CNY or USD currency
- Statusline examples: `deepseek CNY 110.00` or `deepseek CNY 110.00 · USD 20.00`

The extension queries the fixed balance endpoint only when the selected model origin is `https://api.deepseek.com` and any resolved-auth origin override, when present, has the same official origin.
Pi's built-in DeepSeek API-key resolver does not attach a redundant auth origin, so the validated model origin remains authoritative when no override exists.
Custom and proxy origins fail before network access, redirects are rejected, and only the resolved Bearer credential is forwarded from Pi's runtime auth.
Monetary decimal strings remain exact from the response through display.
CNY and USD stay separate and are never converted or added together.
The statusline reports when the API is unavailable.
The balance endpoint does not provide historical spend, request windows, reset times, or aggregate token usage, so `pi-usage` does not claim those DeepSeek capabilities.

The contract was verified on 2026-08-28 against [DeepSeek's Get User Balance documentation](https://api-docs.deepseek.com/api/get-user-balance) and Pi's [`deepseek.ts`](https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/providers/deepseek.ts) at `c49906ec77788625aacbdc53ebca6fbe65bd20f5`.
DeepSeek Harness `cd5ef8148158c3a752a658978873241fdf8e2bbc` reports only per-request model token usage and does not provide account balance data.
