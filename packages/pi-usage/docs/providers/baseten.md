# Baseten Model APIs spend

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `baseten`
- Semantics: organization-wide Model APIs spend, not per-key quota or account balance
- Source: `GET https://api.baseten.co/v1/billing/usage_summary` using Pi's resolved Baseten API key
- Displayed data: trailing 30-day gross usage, credits used, and net subtotal in USD
- Statusline example: `baseten USD 166.15 net`

The extension intentionally ignores Dedicated deployment and Training categories because they do not represent Pi's Model APIs provider usage.
The query window is a precise trailing 30 days and stays below the endpoint's 31-day maximum.
The fixed Management API endpoint is queried only for an official `https://inference.baseten.co` model and an official resolved-auth origin.
Custom and proxy origins fail before network access, redirects are rejected, and only the resolved Bearer credential is forwarded.
An empty `model_apis_usage` result is reported as no Model APIs usage rather than zero account-wide spend.

The contract was verified on 2026-08-30 against Baseten's [Billing and usage](https://docs.baseten.co/organization/billing#view-usage), [Model APIs usage](https://docs.baseten.co/inference/model-apis/pricing-and-limits#usage), first-party [`baseten-go` Management OpenAPI](https://github.com/basetenlabs/baseten-go/blob/f028e27beb4bde106d984833313c055ddd6fefa4/internal/tools/apigen/specs/management.json), and [`baseten-cli` billing behavior](https://github.com/basetenlabs/baseten-cli/blob/e3d002b465f49a7295ea44b5988dbfeb8197896d/internal/cmd/command.org.go).
