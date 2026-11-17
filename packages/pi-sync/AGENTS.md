# Pi Sync Guidelines

## Settings and migration

- Propose settings changes through the public daemon authority instead of adding an independent Pi-side writer.
- Queue complete client mutations before prerequisite awaits so rapid commands retain invocation order.
- Do not treat an absent operation lock as proof that no idle older process exists during state-directory migration.
- Require explicit migration confirmation, serialize upgraded state and cache users against the guard, keep legacy state active until migration, and fail closed when old and new roots coexist.

## Engine boundary

- Use documented `@narumitw/pi-sync-daemon` exports and keep engine safety rules in `packages/pi-sync-daemon/AGENTS.md` with their implementation.

## Interaction model

- Collect credentials in a masked TUI and review one exact backend path during setup.
- Expose storage connections and sync setups as the only managed user concepts.
