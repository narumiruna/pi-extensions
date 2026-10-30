# MiniMax Token Plan and API balance

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider IDs: `minimax` and `minimax-cn`
- Token Plan source: `GET {region-api-root}/v1/token_plan/remains`
- Pay-as-you-go source: `GET {region-api-root}/account/query_balance`
- Region API roots: `https://api.minimax.io` and `https://api.minimaxi.com`
- Statusline examples: `minimax 15% ↻ 2h30m · 80% ↻ 6d`, static fallback `minimax 5h:15% · wk:80%`, unlimited `minimax cn 5h:unlimited · wk:unlimited`, or pay-as-you-go `minimax USD 98.00001`

Pi's resolved MiniMax API key selects exactly one endpoint before network access.
Keys with the first-party `sk-api-` prefix query pay-as-you-go balance; other MiniMax API keys query Token Plan quota.
The extension never probes both endpoints with one credential.
Token Plan reports preserve provider rows, rolling and weekly windows, counts, reset times, unlimited status, and first-party handling for legacy versus current `*_usage_count` semantics.
Pay-as-you-go reports keep available, cash, voucher, credit, and owed amounts separate in USD for Global or CNY for China.
Custom, proxy, and cross-region origins fail before network access, and redirects are rejected.

The contract was verified on 2026-08-30 against MiniMax's [Token Plan FAQ](https://platform.minimax.io/docs/token-plan/faq#how-to-check-token-plan-usage) and the first-party [`MiniMax-AI/cli`](https://github.com/MiniMax-AI/cli/tree/b78eccea80a0f9692e186d98906cff26931464f3), including endpoint selection, response types, quota normalization, and SDK tests.

## Validation limits

Token Plan field semantics have changed over time. Contradictory counts and percentages are reported as unavailable rather than guessed.
