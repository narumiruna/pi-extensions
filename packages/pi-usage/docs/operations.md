# Usage queries and provider targets

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

For credentials, endpoints, and provider-specific meanings, see the [provider guides](./providers/README.md).
For selection storage, see [Settings](../README.md#-settings); the [Fireworks guide](./providers/fireworks.md#account-selection-and-migration) covers its legacy-field migration.

## Codex Fast mode

See [Codex Fast mode](./providers/openai-codex.md#codex-fast-mode) for eligibility, routing, settings, and fallback behavior.

## Redeem a Codex usage reset

See [Codex reset redemption](./providers/openai-codex.md#redeem-a-codex-usage-reset) for confirmation, cancellation, and safe retry behavior.
