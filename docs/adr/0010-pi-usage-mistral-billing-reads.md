# ADR: Keep Mistral allowance reads optional in Pi Usage

## Status

Accepted and implemented in [PR #2040](https://github.com/narumiruna/pi-extensions/pull/2040). This record moves the rationale out of source comments without changing behavior.

## Context

The [Mistral Vibe billing client](https://github.com/mistralai/mistral-vibe/blob/e76235b203b8965af584e88e69284bc704c31a1f/vibe/app_server/_billing.py) reads separate subscription and budget routes. The standard-key evidence in the [Mistral provider guide](../../packages/pi-usage/docs/providers/mistral.md#contract-evidence) distinguishes those routes from daily billing usage and the Enterprise Admin API. A member may be able to read the subscription but lack permission to see the budget; a platform may not serve budget data at all.

## Decision

- Fetch the subscription first and require it to succeed. Fetch the monthly budget only if the request has more than one second left; reserve that second for the final request-boundary check. A budget permission failure, missing route, or timeout must not discard valid subscription data. Cancellation and stale-context errors still propagate. Unlike the Vibe client, Pi Usage does not treat a subscription failure as a successful empty report.
- Treat non-positive `initial_budget` as an unconfigured allowance. Prefer budget pay-as-you-go data when present, with the subscription's Vibe flag as the fallback. Normalize used and remaining percentages to three decimal places to avoid floating-point noise in the report. Round to whole percentages only in terminal display and keep reset times in parentheses alongside the allowance.

## Alternatives

- **Require both billing requests to succeed.** This loses valid plan details when a member lacks permission to see the budget or when the optional request takes too long.
- **Use daily billing usage or the Admin API.** These routes do not provide the same standard-key access and monthly Vibe allowance semantics.

## Verification

The [Mistral query tests](../../packages/pi-usage/test/mistral.test.ts) cover the official origin, route selection, permission failure, required subscription failure, and cancellation. The [adapter tests](../../packages/pi-usage/test/adapters.test.ts) cover normalization, pay-as-you-go precedence, and the terminal display.
