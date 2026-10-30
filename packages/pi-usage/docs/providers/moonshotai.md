# Moonshot AI API balance

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider IDs: `moonshotai` and `moonshotai-cn`
- Semantics: current API account balance, not Kimi For Coding subscription usage
- Global source: `GET https://api.moonshot.ai/v1/users/me/balance`
- China source: `GET https://api.moonshot.cn/v1/users/me/balance`
- Displayed data: available, voucher, and cash balance in USD for Global or CNY for China
- Statusline examples: `moonshot USD 49.58894` or `moonshot CNY 49.58894`

Each endpoint uses Pi's resolved inference Bearer key for the matching region.
Pi maps both built-in providers to `MOONSHOT_API_KEY`, so that shared environment credential is eligible only for the currently selected region.
Querying the sibling region requires a provider-specific stored, runtime, or `models.json` credential.
The extension rejects custom, proxy, and cross-region origins before network access and refuses redirects.
Available and voucher balances must be nonnegative, while cash balance may be negative when the account owes money.
The endpoint does not provide historical spend, token totals, quota windows, or reset times.
These API-platform balances are independent from the `kimi-coding` subscription and booster wallet.

The contracts were verified on 2026-08-30 against the official [Global balance reference](https://platform.kimi.ai/docs/api/balance), [China balance reference](https://platform.moonshot.cn/docs/api/balance), and first-party [`MoonshotAI-Cookbook` balance client and DTO](https://github.com/MoonshotAI/MoonshotAI-Cookbook/tree/25a9e46d2391dd4817d28ab980dac69eb59b582c/examples/golang_demo).
