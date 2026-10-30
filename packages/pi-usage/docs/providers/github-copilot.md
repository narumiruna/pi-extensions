# GitHub Copilot

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `github-copilot`
- Semantics: the allowance reported for the active Copilot plan
- Allowance labels: AI credits for usage-based billing, premium requests for legacy annual billing, or chat requests for Copilot Free
- Source: GitHub's undocumented `GET /copilot_internal/user` endpoint
- Displayed data: entitlement, remaining allowance, percentage, reset time, plan, and any additional usage beyond the included allowance
- Statusline examples: `copilot credits 1200/1500 80% ↻ 6d`, `copilot 245/300 82% ↻ 6d`, or static fallback `copilot chat 40/50 80%`

This undocumented quota endpoint may change without notice.
GitHub's quota endpoint requires the original GitHub OAuth token rather than the short-lived Copilot inference token exposed by runtime auth.
`pi-usage` supports Copilot accounts created through Pi's `/login` flow and named accounts offered by a compatible `oauth:credential-source:v1` owner.
It uses a candidate only when its short-lived access token exactly matches the freshly resolved active runtime credential.
Duplicate equivalent candidates are harmless, while conflicting matches fail closed without choosing by extension load order.
API-key credentials, account mismatches, GitHub Enterprise accounts, and proxy/custom provider origins fail closed.
The detailed report follows the endpoint's `token_based_billing` marker so AI credits are not mislabeled as legacy premium requests.
It reports overage without treating a negative included balance as malformed.

## Statusline countdowns

Finite quotas show a countdown automatically when the displayed quota has a valid future reset. Missing, invalid, or expired resets keep the static output; unlimited allowances have no countdown.
The status retains counts, percentages, and any overage. Codex-only display preferences do not apply.
