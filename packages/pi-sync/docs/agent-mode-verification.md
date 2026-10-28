# Agent mode implementation verification

This record describes the experimental implementation and its verification scope. The [settings reference](settings.md#experimental-agent-mode) is authoritative for user behavior, limits, privacy, and recovery.

Later recovery, cancellation, confirmed-refusal retry, and diagnostics changes are documented in [Agent and Continuous sync recovery boundaries](agent-continuous-hardening.md). The [synthetic quality corpus](agent-quality-verification.md) adds structural tests without claiming measured model accuracy. Historical verification below describes the original implementation.

## Boundaries and semantic review

- The implementation changes pi-sync only, plus its Changeset and matching bundled-Pi peer declarations in the manifest/lockfile. It does not modify Pi core or depend on another extension.
- Each agent directory is one replica. The existing operation lock protects pi-sync transfers; the separate resolver claim prevents duplicate local inference without holding that operation lock during provider work.
- Candidate keys bind accepted ancestors, ordered local/remote evidence, baseline, destination/policies, model identity and contract version. Validation runs before disclosure and again before commit. Cached output crosses the same validation boundary as fresh output.
- The child SDK session and its Pi-provided credential store are in memory, use an explicit empty resource loader, and have no tools. Provider requests delegate through the initiating context's public Pi model registry. No parent conversation, tool activation, prompt prefix or provider state is rewritten.
- Model identity is rechecked through the final merged-sync authorization path, including changes after candidate acceptance. Disclosure scanning checks raw base/local/remote strings before JSON escaping.
- Model-writable text consists only of overlapping hunks. Code assembles unchanged bytes and independent edits. Settings resolution selects complete existing atomic units, including coupled fields; it cannot synthesize unknown fields or replace machine-local values.
- Unsupported, unsafe, refused, malformed, truncated, oversized, stale and secret-bearing inputs fail closed. Detected local edits are not blindly restored. Explicit partial-sync policy alone permits independent progress around withheld groups.
- Remote revision checks and the existing publication/apply/baseline journal remain authoritative. A committed but uncertain publication is reconciled without another inference or blind republishing.
- Cancellation, foreground interruption, repeated shutdown, replacement, claim successor ownership and unrelated-session shutdown were reviewed and tested. Resolver timers, stream subscriptions and SDK sessions are released; UI cancellation clears the owned status without publishing from a stale continuation.
- Settings use the existing ordered cross-process writer. Consent binds the reviewed setup/connection. Tests cover cancellation, stale consent, invalid files, failed atomic save, retry, unknown-field preservation, Off defaults, schema compatibility and non-default cancellation bindings.

Applicable guides: root and package `AGENTS.md`, `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`. Review covered the touched-area/MUST checklist, settings read/write ordering, lifecycle ownership, prompt-prefix stability, terminal sanitization, generated import boundaries, package independence and recovery.

## Deterministic verification

The `test/agent-*.test.ts` suite covers the SDK boundary, eligibility/candidate validation, settings, cross-process claims, merged-sync integration, lifecycle and generated Jiti loading. Each test uses the repository's normal 5,000 ms timeout. Concurrent-process tests wait for child readiness; provider and lifecycle races use explicit callbacks rather than sleeps.

The fixtures assert preserved independent edits and whitespace, atomic coupled settings, unknown fields and machine-local values. Refusal and invalid-candidate tests distinguish an unresolved result from successful completion. These are regression checks, not a measured production model-accuracy benchmark.

Final local verification passed:

| Check | Result |
| --- | --- |
| `npm run check` | Builds, Biome, boundaries and all workspace typechecks passed; eight pre-existing informational lint notices remain. |
| `npm test` | 625 test files passed, one skipped; 9,106 tests passed and two existing tests skipped. |
| Agent-specific deterministic suite | 126 tests across nine files, included in the full gate. |
| README heading audit | All 36 active package READMEs retain the required sections. |
| Package build, Jiti, CLI and pack | Passed as described below. |

Repository gates and runtime smokes are also recorded in the change handoff. The full root test suite includes existing backend contracts, session protection, transaction recovery, settings persistence, command modes and confirmation behavior. The README heading audit ignores fenced code and checks the required sections across 36 active packages.

Generated-runtime tests reject eager resolver inputs and bundled dependencies, validate every emitted relative import and trigger actual resolution through Pi's Jiti loader against a local conditional WebDAV server. Both direct `/sync sync` and Agent-mode-only startup succeed with Automatic sync and Startup transfer left off. Lifecycle tests cover replacement and reload/shutdown ownership.

## PR review regression checks

All four findings in PR #1594 were verified against the implementation and fixed:

| Finding | Fix and evidence |
| --- | --- |
| A committed consent save could be reported as rejected after cancellation. | The atomic writer's success is the commit boundary. The handler retains that result and skips stale UI work. `agent-setting-commit.test.ts` covers enabling/disabling, cancellation, session replacement, notification failure and authoritative Settings reads after save. |
| Ordinary operation-lock contention could strand a completed resolver claim. | Creation and cleanup share a separate short-lived cross-process claim guard. Only creation takes the operation lock first; cleanup never takes it, so there is no reverse lock order. `agent-store.test.ts` holds another operation lock until cleanup finishes, for both committed and failed transfers. Existing tests cover live/dead processes, partial initialization and successor ownership. |
| A fixed output budget could exceed a selected model's limit. | The request uses the smaller positive model limit and resolver cap. Pi's unknown-limit value of zero retains the cap; invalid limits stop before disclosure. `agent-runner.test.ts` covers unknown, smaller, equal, larger and invalid limits. The installed Pi registry forwards explicit budgets on ordinary provider requests and caps routed virtual requests. |
| The new-transfer capability check could block pending journal recovery. | Recovery runs first and never republishes. `agent-recovery.test.ts` covers manual/startup recovery of published, uncertain, apply-only, inactive and already accepted journals on a weak backend. It also proves that newer local edits remain protected and new autonomous transfers remain blocked without model requests or publication. |

Review covered every changed settings publication and notification boundary, claim mutation and cleanup path, model-limit branch and journal recovery branch. Consent, settings ordering, private evidence, session ownership, remote revisions and baseline checks remain unchanged. No new setting, dependency, public API or Pi core change was added. The existing Changeset covers these fixes.

The final gates include these regressions. The generated Jiti/WebDAV tests still exercise the lazy resolver and both command/startup entry paths. The package RPC load smoke was repeated without provider requests. The earlier live-provider result below was reused; no extra paid request was needed for these control-flow fixes. Platform and live-service limits remain as listed below.

## Live provider smoke

One explicitly enabled request used `openai-codex/gpt-6.1-sol` with synthetic text only:

| Version | Synthetic content |
| --- | --- |
| Base | `Use blue.` |
| Local | `Use green.` |
| Remote | `Use blue. Keep replies short.` |
| Accepted result | `Use green. Keep replies short.` |

The real SDK runner delegated to Pi-managed authentication, produced a valid candidate, and preserved both tested changes. The request completed in 2,104 ms with 223 reported tokens. For this single case: one attempted completion, one accepted completion, zero refusals and zero observed semantic errors. This is not a statistical reliability claim. No personal files or real remote sync storage were involved.

The smoke invoked the emitted runner and candidate parser under `node --input-type=module`, used the selected model from Pi runtime metadata, and applied a 25-second outer signal in addition to the runner's own deadline. No provider retry or second live request was made.

## CLI, package and load checks

A disposable agent directory loaded the built package with:

```sh
pi --mode rpc --no-session --no-extensions --no-skills --no-context-files -e ./packages/pi-sync
```

A pipe client waited for successful `get_commands`, verified the registered `sync` command, sent `/sync help`, verified its observable notification, then closed stdin for orderly shutdown. The subprocess exited zero without model work. Resolution and reload ownership are additionally covered by the generated-Jiti and lifecycle harnesses; no interactive TUI command was opened.

`npm run package:pack -- sync` checks the pack dry run. An actual archive was created with `npm pack --workspace @narumitw/pi-sync --pack-destination <temporary-directory>` and inspected for `dist/index.ts`, lazy resolver chunks, source, documentation and external Pi peers. No credential files, resolver records or `node_modules` were present. No package was published or tagged.

Separate-process warm-load samples compared the main-branch package with Agent mode Off after one discarded warmup:

| Build | Module import samples (ms) | RPC first-response samples (ms) |
| --- | --- | --- |
| Main-branch baseline | 25, 25, 23 | 206, 215, 202 |
| Agent mode Off | 26, 26, 24 | 209, 210, 204 |

Both builds used the same installed Pi/dependencies, disposable agent directories and RPC command-discovery request. These host-specific samples establish no timing threshold or performance improvement. Builder tests separately prove that the resolver stays outside the eager graph.

## Remaining limits

- JSON parsing, hunk confinement and source selection do not prove semantic correctness. The feature remains default-off and experimental.
- Operation locks and process-local file queues do not exclude arbitrary cross-process file writers. The implementation does not claim atomic local compare-and-swap or lossless live session synchronization.
- Session histories, executable code, deletion conflicts, path collisions and missing ancestors are not model-resolved. Initial-source/policy changes retain reviewed flows.
- Provider disclosure and billing can occur before cancellation; exactly-once billing is not guaranteed. Candidate records are private but retained without automatic pruning.
- Live evidence covers one provider/model and one synthetic conflict, not all model APIs, proxies, production storage services or network environments. Git/S3 and failure branches have deterministic contract/regression coverage, not new live-service smokes.
- Windows and Android were not live-tested in this change. Existing platform behavior remains, and new candidate publication uses temporary files plus rename rather than adding a hard-link requirement.
- `npm install` reported five existing repository audit advisories (three high, two critical). No dependency versions or audit overrides were added; the lockfile change is limited to bundled-Pi peer declarations, with no dependency resolution changes. Dependency remediation is outside this change.
