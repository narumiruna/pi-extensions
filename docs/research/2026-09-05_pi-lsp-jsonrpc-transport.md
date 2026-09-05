# Pi LSP JSON-RPC transport evaluation

## Decision

Reject the `vscode-jsonrpc@9.0.2` candidate and retain the handwritten transport. The candidate
removed 90 production lines but introduced an unhandled `write EPIPE` rejection when the server
closed stdin. Catching the returned request promise did not prevent that rejection. The same
subprocess regression passes on the existing client.

No dependency, production-code change, new wrapper, or Changeset is retained. Installation and
startup costs were measured, not accepted. This decision applies to the inspected release and
prototype, not every possible library release or integration.

## Baseline and method

Baseline commit: `0a669038` (after lifecycle PR #1212). The lifecycle refactor's deletions are not
credited here. Experiments ran in a detached worktree outside the repository. Baseline root
`npm test` passed 355 files / 3,579 tests before transport changes.

Production lines count all physical lines in `packages/pi-lsp/src/*.ts`, including comments and
blank lines. Generated output and tests are excluded. Both implementations used the existing build
and package manifest file list. The candidate imported `vscode-jsonrpc/node` externally, deleted
framing/IDs/response dispatch and `JsonRpcMessage`, and kept process ownership, deadlines,
diagnostics, initialization, and server-request policy in `LspClient`.

Package load used ten separate Node v26.5.0 processes on Linux. Each imported the same installed Pi
host before timing `DefaultResourceLoader.reload()` of the built `dist/index.ts`, with a fresh agent
directory and cwd. No LSP server starts during this measurement. The retained harness is
`packages/pi-lsp/test/fixtures/measure-package-load.mjs`; pass a built repository root as its first
argument. The harness does not clear Jiti's filesystem cache or enforce performance thresholds.

Production installation used temporary scopes with `npm install --omit=dev --ignore-scripts`, the
packed extension, and explicit Pi 0.85.0 / typebox 1.3.25 peers. Installed bytes sum regular-file
lengths beneath `node_modules`, excluding symlinks and directory allocation. Identical peers were
retained when swapping tarballs. Unique dependency counts use package-name/version pairs from
`npm ls --omit=dev --all --json`, including the extension and peers.

## Measurements

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Owned production lines | 2,246 | 2,156 | -90 |
| Client source lines | 554 | 473 | -81 |
| Compressed tarball bytes | 63,505 | 61,734 | -1,771 |
| Unpacked extension bytes | 264,742 | 257,217 | -7,525 |
| Direct runtime dependencies | 0 | 1 | +1 |
| Unique packages including peers | 130 | 131 | +1 |
| Dependency-inclusive installed file bytes | 127,011,203 | 127,229,227 | +218,024 |
| Median package-load milliseconds | 9.845 | 19.219 | +9.374 |

The sole added dependency was `vscode-jsonrpc@9.0.2`: 225,125 installed file bytes and no runtime
transitive dependencies. The installed-total delta also includes npm's hidden lockfile changes.
Both extension tarballs contained 17 files. The dependency is MIT licensed and retains Microsoft's
`License.txt`; package-owned output did not embed its implementation.

All load samples, in milliseconds, in execution order:

```text
Baseline:  138.080 11.938 12.190  8.403  7.870  7.699 12.412  7.960 11.287  7.685
Candidate:  19.671 18.969 19.148 14.805 19.290 15.182 18.237 19.451 19.831 19.776
```

The first baseline sample is a cold outlier and is not discarded. Filesystem/Jiti cache state and
host scheduling differ between samples; these results do not establish a universal startup penalty
or measure end-to-end tool latency. Rejection does not depend on the timing difference.

## Implementation findings

Registry metadata declares Node >=14 and a Node export resolving to CommonJS `lib/node/main.js`.
Runtime behavior was inspected in the installed `lib/common/{connection,messageReader,messageWriter,
messageBuffer}.js` and `lib/node/{main,ril}.js`, not inferred from types.

The reader buffers byte fragments, handles multiple frames, normalizes header keys, and serializes
JSON decoding. Missing or nonnumeric lengths and invalid JSON emit errors. Connection dispatch
correlates response IDs, returns `ResponseError` for request failures, ignores unknown notifications,
and responds to unknown requests with -32601. Known LSP request handlers remain extension-owned.

Cancellation sends `$/cancelRequest` but does not settle the response promise. Stream close emits a
close event without rejecting pending requests. Connection disposal rejects pending responses, but
reader disposal does not detach its underlying stream listeners or clear its recurring
partial-message timer. The prototype therefore disabled that timer, kept local deadlines, disposed
the connection on failure/close, detached stdout data dispatch, and retained process termination.
No new source module or reusable transport wrapper was added.

The decisive failure is in `connection.js`'s `sendRequest`: an async Promise executor catches writer
failure, rejects the returned request promise, then throws again from the executor. Closing fd 0 in
the fake server triggers both the caught request error and an unhandled rejection. Merely calling
`process.stdin.destroy()` did not reliably close the fd, so the regression uses `closeSync(0)`.
The hardened candidate run passed all 3,595 assertions but failed the root test gate with one Vitest
unhandled `write EPIPE` error. This is not reported as a passing candidate.

## Compatibility and lifecycle evidence

`packages/pi-lsp/test/transport.test.ts` retains 19 real-subprocess cases. Each client request
sequence starts after a server-observable readiness record. Tests remain under the repository's
5,000 ms hard timeout and dispose clients repeatedly before asserting that child PIDs are gone.

| Contract | Evidence |
| --- | --- |
| Split headers/bodies and multibyte UTF-8 | Fragmented writes split a code point; exact action titles round-trip |
| Multiple frames and response correlation | Coalesced messages, unknown notification/response, reversed replies, timeout followed by late/current replies |
| Server requests | String and zero IDs, ty/Ruff configuration objects, workspace folders, register/unregister, unknown-method -32601 |
| Faults and cancellation | Malformed header/JSON, incomplete frame, closed stdout, real stdin EPIPE, child exit/stderr, request timeout, concurrent request/push-waiter rejection, repeated disposal |
| Diagnostics policy | Existing client suite: supported/error pull, empty pull with earlier/later push, grace fallback, push-only silence, repeated publications, equivalent URI encoding, all files opened first |
| Actions and edits | Existing client/runner/helper suites: capability-gated resolve, resolve errors, target-file edits, overlap rejection, preview/write, abort before write |
| Session ownership | Existing runner/session/generated lifecycle suites: startup failures, abort at await boundaries, replacement, reload, shutdown, child exit and status/context cleanup |
| Settings and launch | Existing settings/launch suite: missing/invalid files, canonical/legacy precedence, trust, effective env/PATH, Windows shim resolution |

The generated-entry test now loads the package directory through Pi's `DefaultResourceLoader`,
checks the declared `dist/index.ts` path and command/hooks, and exercises shutdown before startup,
startup, and repeated shutdown through `ExtensionRunner`. Existing builder Jiti and generated
active-work lifecycle tests remain in place. The current generated runtime has no lazy chunks.

Semantic review used `docs/extension-conventions.md`, `docs/extension-settings.md`, and
`packages/pi-lsp/AGENTS.md`, plus installed Pi extension/package/RPC documentation, the hello example,
and the actual Jiti loader. Factory/process ownership, cancellation, post-await guards, diagnostic
waiter timers, shutdown escalation, settings reads/writes, output bounds, edit policy, and same-path
mutation behavior were audited. No Pi action-at-load, prompt/tool-prefix, settings, status, or file
mutation policy change is retained.

Existing baseline dispositions remain unchanged: runner tests explicitly defer B1 (one completion
clears a sibling's status), B2 (same-path mutations are not queued), and B3 (output is unbounded).
This evaluation neither fixes nor newly approves those deviations. They are not hidden by passing
regression tests and must be addressed separately from transport adoption.

## Final verification

`npm run check` passes build, Biome, boundaries, and workspace typechecks. An initial Biome import
ordering error in the new benchmark harness was corrected before rerunning the gate. Final
`npm test` passes 356 files / 3,598 tests with no unhandled errors.

`npm run package:pack -- lsp` and the workspace `npm pack --dry-run --json` pass. The final tarball
contains the expected source, generated runtime/map, settings documentation, README, manifest, and
license; it excludes tests. Its SHA-1 is `8c03b4fb46054f23e3a8886814335667a7d54b20`, identical to
the measured baseline tarball. Production sources, manifest, and lockfile were restored through
path-scoped Git recovery in the experimental worktree, followed by root `npm install` and rebuild.

`packages/pi-lsp/test/fixtures/package-smoke.mjs` passes with the built local package directory and
with the production-only packed baseline install. It invokes non-interactive Pi RPC with `-e`, an
isolated agent directory, a loopback-only scripted provider, and real fake LSP subprocesses. Both
smokes verify diagnostics, preview without mutation, write, cancellation, reload, shutdown, and the
exit of all five server processes (nine loopback provider requests). A missing Pi executable was
also injected: the smoke fails with exit 1 and cleans up instead of hanging on a missing exit event.
The retained benchmark harness completes its ten-process baseline load smoke. The candidate packed install
also passed this normal/cancellation smoke; that does not override its failing EPIPE regression.

No live provider, real language server, or Windows host smoke was run; Windows launch behavior is
covered deterministically and unchanged. No package was published, version tagged, visibility
changed, or release workflow dispatched.
