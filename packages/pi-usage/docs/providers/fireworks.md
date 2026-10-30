# Fireworks API spend

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `fireworks`
- Semantics: rated 30-day account spend, not credit balance or spend-cap quota
- Source: documented `GET https://api.fireworks.ai/v1/accounts` account discovery and `GET https://api.fireworks.ai/v1/accounts/{account_id}/billing/summary` rated costs using Pi's resolved inference API key
- Displayed data: exact rated spend per currency with serverless, dedicated-deployment, and training subtotals for the trailing 30 days
- Statusline example: `fireworks USD 12.345678901`

The extension queries the fixed endpoints only when the selected model origin is `https://api.fireworks.ai` and any resolved-auth origin override, when present, has the same official origin.
The account slug is discovered through the documented account listing.
One visible account is selected automatically; several visible accounts use the remembered selection or ask through `/usage`, and a disappeared selection returns **Selection required** without a billing request.
Monetary `units` and `nanos` values are summed exactly with integer arithmetic and stay exact through display.
Fireworks does not expose credit balance, spend caps, per-window quota, or reset times through its API, so `pi-usage` does not claim those Fireworks capabilities; the web console remains the authoritative balance source.
Rated line items may differ from the final invoice once credits or adjustments are applied.

The contract was verified on 2026-07-31 against Fireworks' [Usage & Cost Breakdown](https://docs.fireworks.ai/accounts/exporting-usage-and-costs), [Get billing summary](https://docs.fireworks.ai/api-reference/get-billing-summary), and [List Accounts](https://docs.fireworks.ai/api-reference/list-accounts) API references.

## Account selection and migration

Manage the account through `/usage`; see [provider target selection](../operations.md#choose-a-provider-target).
Selections are stored as `selectedTargets.fireworks` in the user settings file.
The former `fireworksAccountId` field remains read-compatible: it supplies the selection in memory only when the generic value is absent.
A successful explicit Fireworks account selection writes the generic field and removes the legacy field atomically; ordinary reads do not rewrite the file.

The statusline keeps currencies separate and reports when no rated usage exists.
