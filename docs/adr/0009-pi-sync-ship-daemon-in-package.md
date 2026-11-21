# ADR: Ship the Pi Sync daemon inside the Pi Sync package

## Status

Proposed. The current published design still installs `@narumitw/pi-sync-daemon` as a runtime dependency of `@narumitw/pi-sync`.

## Context

Pi Sync launches or connects to a separate Node.js daemon. In the [first attempt of release run 44897769052](https://github.com/narumiruna/pi-extensions/actions/runs/44897769052/attempts/1), the daemon published successfully, but npm returned `E404` until the 30-second artifact-readiness budget expired. This blocked Pi Sync publication. A later attempt succeeded. A successful publish does not guarantee immediate registry availability.

The daemon client launches a sibling `cli.js` and reads its installed daemon version from module-relative metadata. The client and server use that version to decide how to handle an existing daemon. Copying only `cli.js` or advertising the Pi Sync version would not preserve this behavior.

## Decision

Ship the exact daemon build selected by Pi Sync inside the `@narumitw/pi-sync` tarball under `dist/daemon/`, without an npm runtime dependency on `@narumitw/pi-sync-daemon`. Keep the daemon a separate Node.js process with the same authenticated IPC, ownership checks, consent, and upgrade rules. Keep `@narumitw/pi-sync-daemon` independently versioned, publishable, and installable with its existing CLI.

- **Build from one source.** Keep the daemon as a workspace build dependency of Pi Sync. Repository and Git source installs continue to use documented workspace exports. The packaged Pi Sync runtime maps those same exports to a staged native ESM copy. Reuse the daemon build and preserve its relative module layout, CLI, license, and original version metadata. Validate all generated static and lazy imports before replacing `dist`.
- **Keep the two runtimes separate.** Pi still loads the extension through its Jiti entrypoint and supplies its host peers. The Node child must resolve its own required SDK and runtime dependencies even when Pi installs the extension with `--omit=peer`. Before committing to a dependency mapping, prove a packaged prototype can load both runtimes and exercise a late daemon SDK import without importing a second Pi host runtime. Do not narrow host compatibility or add a user install step to make the prototype pass.
- **Remove only the daemon registry dependency.** Keep `@narumitw/pi-tui-kit` a normal runtime dependency with the existing compatibility floor and artifact check. Keep the release guard unchanged. Do not add a second global CLI command or use a globally installed daemon as a fallback. Reuse an already running daemon only after the existing authenticated identity and compatibility checks.
- **Keep packaging separate from behavior.** This change does not change settings, UI, protocol, state layout, consent, or daemon lifetime. Document how to invoke the bundled CLI with Node for users who install only Pi Sync; the standalone CLI remains available.

## Alternatives

- **Keep the runtime dependency and extend the retry budget.** This avoids relocation work but leaves the release and clean install dependent on a separately available daemon artifact. A longer wait still cannot guarantee propagation.
- **Run the daemon inside Pi.** This removes the separate startup boundary but changes lifetime and ownership semantics. The release problem does not require that change.

## Consequences

A clean install of the Pi Sync npm tarball no longer queries npm for the daemon package or requires a separately installed copy. Pi Sync still depends on registry availability for Kit and other declared dependencies. The package must carry and verify the embedded build. A standalone daemon release does not update the build shipped inside an existing Pi Sync tarball; fixes intended for that artifact require a new Pi Sync release that embeds them.

If the dependency or compatibility contract cannot be met, do not ship the packaging change. After release, use a corrective Pi Sync version rather than overwriting a published version. Preserve sync state and recovery evidence and use the existing safe daemon handover flow.

## Verification for implementation

1. Install the actual Pi Sync tarball outside the repository with `--omit=peer` and a registry fixture that rejects requests for `@narumitw/pi-sync-daemon`. Exercise the Pi Jiti entrypoint, a lazy `/sync` route, daemon startup and IPC, and a late SDK import in the Node child without a model call.
2. Check exact generated imports, deterministic staged builds, and failure recovery. Confirm the child advertises the selected daemon build version rather than the Pi Sync version. Verify compatible owner reuse and upgrade, and refusal of incompatible or ambiguous owners.
3. Smoke both the standalone daemon tarball and the production Git source-entry install. Use release fixtures to prove daemon-first local build order, independent package versioning, no daemon registry wait for Sync, and unchanged Kit verification.

## Related decisions

- [Daemon ownership and safety contract](../../packages/pi-sync-daemon/docs/architecture.md)
- [Coordinated releases and artifact readiness](../coordinated-releases.md)
