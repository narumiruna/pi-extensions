# ADR: Ship the Pi Sync daemon inside the Pi Sync package

## Status

Accepted and implemented in the workspace. This record does not establish publication or production readiness.

## Context

Pi Sync launches or connects to a separate Node.js daemon. In the [first attempt of release run 44897769052](https://github.com/narumiruna/pi-extensions/actions/runs/44897769052/attempts/1), the daemon published successfully, but npm returned `E404` until the 30-second artifact-readiness budget expired. This blocked Pi Sync publication. A later attempt succeeded. A successful publish does not guarantee immediate registry availability.

The daemon client launches a sibling `cli.js` and reads its installed daemon version from module-relative metadata. The client and server use that version to decide how to handle an existing daemon. Copying only `cli.js` or advertising the Pi Sync version would not preserve this behavior.

## Decision

Ship the exact daemon build selected by Pi Sync inside the `@narumitw/pi-sync` tarball under `dist/daemon/`, without an npm runtime dependency on `@narumitw/pi-sync-daemon`. Keep the daemon a separate Node.js process with the same authenticated IPC, ownership checks, consent, and upgrade rules. Keep `@narumitw/pi-sync-daemon` independently versioned, publishable, and installable with its existing CLI.

- **Build from one source.** Pi Sync lists the daemon in `devDependencies`. The package build requires a complete local daemon build and verifies its [build record](../runtime-builder.md#pi-syncs-embedded-daemon) before staging; Git preparation alone is not enough. Repository and Git source installs still use the daemon's documented workspace exports. The generated Jiti runtime uses private `#pi-sync-daemon` imports mapped by `dist/package.json` to the staged native files. The staged tree preserves the daemon's relative layout, license, and build version. Both import graphs are validated before replacing `dist`.
- **Keep the two runtimes separate.** Pi supplies host peers through Jiti. The staged `dist/daemon/package.json` has daemon version metadata but no `type` field: Jiti applies Pi's host peer aliases, while Node detects ESM from syntax when it runs `dist/daemon/dist/cli.js`. A direct Node run from a checkout can warn that the module type is missing; adding `type: module` would bypass Jiti's host aliases. The embedded CLI alone loads a child-side `registerHooks` bootstrap. It resolves `@earendil-works/pi-coding-agent` through the exact `@narumitw/sync-node-sdk` npm alias and resolves Pi AI and Pi TUI from that SDK's dependency root. The child therefore does not depend on Pi's peers being installed, including with `--omit=peer`. The Pi peer floor and the daemon's Node.js minimum (22.19.0) are unchanged.
- **Remove only the daemon registry dependency.** Keep `@narumitw/pi-tui-kit` a normal runtime dependency with the existing compatibility floor and artifact check. Keep the release guard unchanged. Do not add a second global CLI command or use a globally installed daemon as a fallback. Reuse an already running daemon only after the existing authenticated identity and compatibility checks.
- **Keep packaging separate from behavior.** Settings, UI, protocol, state layout, consent, and daemon lifetime are unchanged. The standalone runtime and packed file layout remain unchanged. Users who install only Pi Sync can [run the bundled CLI with Node](../../packages/pi-sync/docs/daemon-migration.md#daemon-cli).

## Alternatives

- **Keep the runtime dependency and extend the retry budget.** This avoids relocation work but leaves the release and clean install dependent on a separately available daemon artifact. A longer wait still cannot guarantee propagation.
- **Run the daemon inside Pi.** This removes the separate startup boundary but changes lifetime and ownership semantics. The release problem does not require that change.

## Consequences

A clean install of the Pi Sync npm tarball does not query npm for the standalone daemon package or require a separately installed copy. Pi Sync still depends on registry availability for Kit and other declared dependencies. A standalone daemon release does not update an existing Pi Sync tarball. Add an explicit Pi Sync Changeset to adopt a daemon build, including security or correctness fixes intended for the embedded copy.

If the dependency or compatibility contract cannot be met, do not ship the packaging change. After release, use a corrective Pi Sync version rather than overwriting a published version. Preserve sync state and recovery evidence and use the existing safe daemon handover flow.

## Verification for implementation

1. Install the actual Pi Sync tarball outside the repository with `--omit=peer` and a registry fixture that rejects requests for `@narumitw/pi-sync-daemon`. Exercise the Pi Jiti entrypoint, a lazy `/sync` route, daemon startup and IPC, and a late SDK import in the Node child without a model call.
2. Check exact generated imports, deterministic staged builds, and failure recovery. Confirm the child advertises the selected daemon build version rather than the Pi Sync version. Verify compatible owner reuse and upgrade, and refusal of incompatible or ambiguous owners.
3. Smoke both the standalone daemon tarball and the production Git source-entry install. Use release fixtures to prove daemon-first local build order, independent package versioning, no daemon registry wait for Sync, and unchanged Kit verification.

## Related decisions

- [Daemon ownership and safety contract](../../packages/pi-sync-daemon/docs/architecture.md)
- [Coordinated releases and artifact readiness](../coordinated-releases.md)
