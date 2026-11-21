# Pi 1.6 upgrade verification

## Dependency review

A normal resolution from the previous lock rejected Pi 1.6.0 under npm's
three-day release-age rule. The maintainer approved a temporary exception for
lockfile generation. The resolver was given ten exact package names: `chord`,
`pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-coding-agent`, `pi-durable`,
`pi-mcp`, `pi-schema`, `pi-telemetry`, and `pi-tui`, all under
`@earendil-works`. The committed lock resolves each to 1.6.0. The latest of
these publications was `chord` on November 20, 2026 at 11:21:57 UTC. The
repository and CI configuration retain the original release-age and strict
script policy; clean installs use the reviewed lock and no exception flags.

The ten registry artifacts identify the upstream Pi repository, declare MIT
licenses, have SHA-512 integrity, and declare no install lifecycle scripts.
The changed non-Pi resolutions are upstream's `@google/genai` and `openai`
requirements and the `undici@8` override. The existing script denials for
`@google/genai` and `protobufjs` still apply. The root and both Docker fixture
locks resolve [patched Undici 8.12.4](https://github.com/nodejs/undici/releases/tag/v8.12.4),
which addresses the redirect, cache, and integrity issues listed upstream.
The existing root Undici 7 resolution is unchanged. The Sync daemon pins its
three direct Pi SDK dependencies to the same version because independently
installed copies of those dependencies must agree on the model catalog.

## Runtime checks

- **SDK and RPC:** stock `find` passed all four glob forms (`src/*.ts`,
  `./src/*.ts`, `**/src/*.ts`, and `*.ts`) from the project and an explicit
  subdirectory under a misleading parent named `src`. The root tests cover
  nonzero POSIX signal exit, timeout, abort, output overflow, exact RPC trust
  startup counts, and empty-binding SDK reload.
- **Session and request boundaries:** Pi 1.6 releases navigation ownership
  before `session_tree`. Tests distinguish that idle hook from busy
  preparation; the first user cycle after navigation remains eligible for
  widget compaction. Explicit tool loadout changes can rebuild the leading
  prompt, but must preserve the rest of the message prefix. Ordinary turns
  still preserve the full prefix and ordered tool definitions.
- **Sync and Codex:** built and installed the daemon tarball in an isolated
  npm root. The 1.6.0 SDK dispatched one authorized request to a synthetic
  loopback resolver. An independently installed baseline tarball using Pi
  1.5.2 refused both mismatched Codex bindings without inference. Repository
  RPC tests also verify conflict evidence and the non-Agent control. Codex
  tests exercise native Pi's developer and effort items, ordered tools, and
  opaque checkpoint replay through a fake transport.
- **Packaging and CLI:** inspected Sync daemon and OTel package contents.
  Both the installed npm CLI and checksum-verified Linux x64 standalone Pi
  loaded Sync and OTel by package directory. RPC exercised lazy `/sync help`
  and a deferred bare `yaml` import through Jiti without invoking a provider.
- **Docker:** the Caffeinate D-Bus smoke and the LSP `rust-analyzer` profile
  passed with their independent locks. They do not verify a native desktop
  compositor, other language-server profiles, macOS, or Windows.

Hosted Codex acceptance and cache hits are not established by these tests.
No production Sync store, paid inference, publication, or release workflow
was used.
