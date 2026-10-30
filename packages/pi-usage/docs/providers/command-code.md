# Command Code

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `command-code`
- Semantics: plan credits plus rolling 5-hour and weekly spending caps
- Account route: `GET https://api.commandcode.ai/alpha/whoami`
- Credits route: `GET https://api.commandcode.ai/alpha/billing/credits`
- Plan route: `GET https://api.commandcode.ai/alpha/billing/subscriptions`
- Period route: `GET https://api.commandcode.ai/alpha/usage/summary`
- Displayed data: five-hour and weekly spend caps in USD with reset times, the billing-period credit pool and remaining balance, plan name and status, request and token totals, and purchased or free credits when present
- Statusline examples: `cmd 99% ↻ 2h30m · 92% ↻ 6d · 96% ↻ 20d` or static fallback `cmd 5h:99% · wk:92% · mo:96%`

The official `@commandcode/pi-commandcode-provider` extension registers this provider through `pi.registerProvider()`, so `command-code` is not a Pi built-in provider.
Pi still resolves its stored `/login` API key through the normal provider registry, and the extension sends it as Bearer authorization only when the selected model and resolved auth share the official `https://api.commandcode.ai` origin.
`credits.monthlyCredits`, `purchasedCredits`, and `freeCredits` are remaining amounts, so the billing-period pool is their sum plus `usage/summary.totalCost`, and `windowLimits.*.resetAt` is a millisecond epoch.
The account response is required; the credits, plan, and period responses degrade to individual notes when unavailable, and a plan without rolling limits reports that instead of inventing windows.
These are undocumented Command Code endpoints pinned on 2026-09-29 against live responses and the same routes the Command Code CLI `/usage` command reads.
They may change without notice, and this paragraph is the contract evidence for the reviewed behavior.
