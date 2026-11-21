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

This audit excludes generic Pi API use, generic rendering covered by the
[status display policy](../extension-conventions.md#status-and-persistent-ui), and documentation-only
comparisons or migration instructions. It counts private status grammars and predecessor schemas as
runtime coupling; this does not approve removing the Accounts or Goal compatibility paths.

The boundary validator checks package imports and manifests, not private message grammars or legacy
schemas. Relevant regression coverage is in `packages/pi-statusline/test/statusline.test.ts`,
`packages/pi-accounts/test/accounts-storage.test.ts`, `packages/pi-caffeinate/test/caffeinate.test.ts`,
and `packages/pi-goal/test/persistence.test.ts`.

Removing these gaps may change published compatibility behavior, especially settings migration and
status rendering. Review and verify each package independently rather than combining the cleanup into
this guidance change.
