# Extension Independence Audit

Last reviewed: 2026-10-26.

This is a small snapshot of known gaps against the repository rule that extension packages remain
independently installable and semantically self-contained. It records existing behavior; fixes belong
in separate, package-focused changes.

## Summary

The package/import boundary is healthy: `npm run check:boundaries` passes for every active package.
No active extension directly imports or declares a dependency on another extension package.

The following runtime couplings remain in the reviewed implementations. This list is not an exhaustive semantic audit of every extension:

| Extension | Existing coupling |
| --- | --- |
| `pi-statusline` | `src/render.ts` parses the `github-pr` producer's status text and hyperlink format to place PR state beside the branch and suppress its duplicate raw status. |
| `pi-accounts` | `src/account-store.ts` reads and migrates the predecessor's `pi-codex-accounts.json` and `codex-accounts.json` settings. |
| `pi-caffeinate` | Its deprecated-icon warning names `pi-statusline` and describes that extension's settings shape. This is message-only coupling. |
| `pi-goal` | `src/persistence.ts` reads the former standalone `pi-goals` experiment's `goals-state` schema to restore one ordinary unfinished goal. |

## Audit Boundary

Generic use of Pi-owned surfaces—such as enumerating tools, rendering arbitrary status keys, or
observing lifecycle events without package-specific branching—is not a violation. Documentation-only
comparisons and migration instructions are also excluded here because they do not change runtime
behavior.

Generic raw-key icon mapping, documented aliases, and suppression follow the
[status display policy](../extension-conventions.md#status-and-persistent-ui) and are not themselves
independence violations. Parsing another producer's private status grammar is a separate coupling.
Predecessor-schema migrations are counted consistently for Accounts and Goal; this note does not
approve removing either compatibility path.

The boundary validator checks package imports and manifests, not private message grammars or legacy
schemas. Relevant regression coverage is in `packages/pi-statusline/test/statusline.test.ts`,
`packages/pi-accounts/test/accounts-storage.test.ts`, `packages/pi-caffeinate/test/caffeinate.test.ts`,
and `packages/pi-goal/test/persistence.test.ts`.

Removing these gaps may change published compatibility behavior, especially settings migration and
status rendering. Review and verify each package independently rather than combining the cleanup into
this guidance change.
