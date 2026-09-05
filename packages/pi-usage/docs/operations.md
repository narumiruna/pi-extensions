# Usage queries and reset redemption

[Back to README](../README.md#-commands)

## Choose a provider target

A target is the provider-owned account, organization, project, team, or workspace used for one usage query.
Providers without target discovery query immediately; a single returned target is selected automatically without saving settings.
When several targets exist, `/usage` remembers an explicit selection by provider and reuses it only while it remains in a fresh listing.
A missing remembered target reports **Selection required** instead of querying another target silently.
Use **Select <target>…** for the current provider or **Change <target>…** for a ready current or individually viewed provider.

Viewing another provider may open one target prompt after that provider is queried lazily.
Cancelling changes nothing.
Authentication and target membership are revalidated before saving an explicit selection, then resolved again before billing is queried.
**View all configured providers…** never opens nested target prompts; view an unresolved provider individually to select its target.
Background refresh also remains non-interactive and reports `selection required` until `/usage` completes the choice.
Fireworks accounts are the first implementation of this provider-neutral flow.

For credentials, endpoints, and provider-specific meanings, see the [provider reference](./providers.md).
For selection storage and migration, see [Settings](../README.md#-settings).

## Redeem a Codex usage reset

For the current OpenAI Codex OAuth account, **Redeem usage limit reset…** checks fresh earned-reset details, lets you choose a reset, and previews its exact effect before confirmation.
Custom or proxy origins are rejected before mutation.
**No, go back** is the safe default, and cancellation before confirmation sends no mutation.

After confirmation, the reset cannot be cancelled from its progress view; session replacement or shutdown still aborts owned work.
A transport failure offers **Try again** with the same redemption request ID so the backend can handle an uncertain retry idempotently.
Successful, already-completed, not-needed, and no-credit outcomes are reported separately, then usage and the statusline refresh for the still-current account.
