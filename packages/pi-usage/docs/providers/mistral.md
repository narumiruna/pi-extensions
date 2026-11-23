# Mistral

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `mistral`
- Semantics: monthly Vibe Code and API allowances, plan name, and pay-as-you-go state
- Auth: Pi's resolved Mistral API key (`Authorization: Bearer <key>`); no Enterprise plan required
- Sources: `GET https://api.mistral.ai/v1/billing/subscription` and `GET https://api.mistral.ai/v1/billing/budget`
- Displayed data: used/remaining percentage for each monthly allowance, reset time, plan, and pay-as-you-go
- Currency: EUR (Mistral bills in EUR)

## Setup

1. Obtain an API key from the [Mistral console](https://console.mistral.ai/).
2. Store it in Pi's credential store for the `mistral` provider.
3. Select a Mistral model, then run `/usage`.

The key is only sent to `https://api.mistral.ai`. Pi's model or provider base URL must resolve to that
origin; a proxy or custom base URL fails before any credential is sent.

Mistral is registered for request-boundary revalidation in `usage.ts`, because it issues two
sequential requests that both carry the API key. A provider missing from that list receives no guard,
and any adapter that requires one fails with `requires request-boundary revalidation`.

## Reported data

Both routes are the ones the official Mistral Vibe CLI reads in
`vibe/app_server/_billing.py` (`_SUBSCRIPTION_PATH` / `_BUDGET_PATH`).

`/v1/billing/subscription` contributes the plan and pay-as-you-go state:

| Field | Use |
| --- | --- |
| `plan_name` | `Plan` metric and account label |
| `vibe_payg_enabled` | Pay-as-you-go fallback when the budget omits `payg_enabled` |
| `payg_enabled`, `enterprise` | Normalized; not displayed directly |

`/v1/billing/budget` contributes one percentage bucket per allowance:

| Field | Use |
| --- | --- |
| `vibe_budget` | `Vibe Code monthly allowance` bucket |
| `api_budget` | `API monthly allowance` bucket |
| `usage_percentage` | Bucket `used`; `remaining` is `100 - used`, clamped |
| `initial_budget` | A value `<= 0` means "not configured" and hides the bucket |
| `reset_at` | Bucket reset time |
| `payg_enabled` | Pay-as-you-go state, preferred over the subscription fallback |

Statusline examples: `mistral vibe 97% · api 100%`, or `mistral INDIVIDUAL` when no allowance is
reported.

## Limitations

- The budget route is optional upstream. A member without the `see_org_inference_usage` permission
  gets `403` on `/budget` only, and some self-hosted platforms answer `404`. Either way the report
  degrades to plan details with a note instead of failing.
- A failure on the required `/v1/billing/subscription` route still fails the query; cancellation
  always propagates.
- `/v1/billing/usage` (daily cost rows) and `/v1/admin/*` are **not** used: the former `404`s for
  standard keys and the latter requires an Enterprise Admin API key.
- Only remaining percentages are shown. The `initial_budget` amount is not converted to currency
  spend, because a percentage is what the official CLI surfaces.

## Contract evidence

- `usage_percentage`, `initial_budget`, `currency`, `reset_at`, and `payg_enabled` are read from
  `/v1/billing/budget`; the live INDIVIDUAL-plan response carries `vibe_budget` and `api_budget`
  blocks plus top-level `api_budget` mirrors.
- Status codes verified with a live standard API key: `/billing/subscription` `200`,
  `/billing/budget` `200`, `/billing/usage` `404`, `/v1/admin/usage` `401`.
- Mistral's [Admin API usage metrics](https://docs.mistral.ai/admin/admin-api/usage-metrics) confirms
  the Enterprise-only Admin API is a separate surface and is not required here.
- Plan names are treated as sanitized, length-bounded tokens rather than an enum.
