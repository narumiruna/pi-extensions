# Pi runtime upgrade and Goal gate retest

## Outcome

**The repository now uses published Pi 1.3.0 development packages. The native and tested Host-candidate safety gate still fails.**
The user explicitly approved this runtime upgrade and retest after the earlier experiments stopped on Pi 1.2.0.
No acceptance condition was relaxed, no Pi upstream code was changed, and no full durable Goal API was implemented.

The same five native/Host suites pass all 40 characterization tests on the new runtime.
That includes the assertions which demonstrate the unresolved native admission boundary, SDK retry coverage, and unrelated deferred-routing failures.
Passing these tests is evidence of the observed behavior, not a passing Goal safety gate.

## Dependency scope

Root and workspace development pins for Chord, Pi AI, agent-core, coding-agent, durable, and TUI move together from 1.2.0 to 1.3.0.
Pi's codemode and MCP runtime dependencies follow their published parent dependencies.
`pi-server` remains at its published 1.1.0 release; no 1.3.0 release exists for that package.
The lockfile and `npm ls` confirm the intended development runtime resolution without mixed versions of those six direct packages.

Langfuse's optional durable peer previously accepted only 1.2.0.
Its peer alternatives now retain that release and add exactly 1.3.0, rather than removing old-host support or permitting untested future versions.
The package's experimental warning remains, long-lived compatibility instructions point to the manifest, and a patch Changeset records the additive compatibility change.

## Retested behavior

| Area | Published 1.3.0 result |
| --- | --- |
| Native request admission | `beforeRequest` still returns only replacement messages; notification errors are reported and skipped, not request denial. |
| Deferred and compaction paths | Polling still receives only a cancellation signal and bypasses the generation request hook; compaction still dispatches separately. |
| Native tool recovery | Replay-safe execution still bypasses `beforeTool`; execute-time guards remain necessary. |
| Host-owned primitives | Persisted task/session binding, reservations, receipt-before-terminal ordering, limit denial, handle recovery, and foreground terminal reconciliation remain feasible in the existing prototypes. |
| Bedrock SDK attempts | One Host admission with `maxRetries: 0` still produces two scripted loopback HTTP attempts when the SDK test configuration permits two. The injected fetch function is not called. |
| Unrelated deferred routing | The unchanged Goal-only candidate still rejects another conversation's deferred poll as `Unknown deferred handle`. This is a candidate routing defect, not fixed by upgrading Pi. |

Source review against the published releases confirms that the relevant hook contracts, ordinary hook-error handling, deferred polling, and Bedrock retry/fetch handling did not acquire the missing controls.
The source review also identifies useful 1.3.0 improvements: baseline system messages lead compacted context correctly, and malformed completed tool arguments preserve an error marker for validation.
Those improvements do not establish the missing Goal safety guarantees.

As before, the SDK probe demonstrates unguarded internal attempts, not requests after known token exhaustion or a demonstrated dollar-budget overrun.
The provider is the real installed adapter, but its endpoint is a local scripted 503 responder with dummy credentials; it never contacts AWS.

## Upgrade compatibility adjustment

The complete suite initially exposed one outdated Accounts test assumption: Kimi Coding's default catalog API is now `openai-completions`, not `anthropic-messages`.
The test now checks the native `api-key` alias, retains explicit custom-Anthropic `x-api-key` conflict coverage, and adds two actual mocked OpenAI-compatible request cases for Kimi.
All 47 tests in that file pass without changing production authentication policy or removing the older API branch.

Langfuse's 127 focused tests pass on the new host, including packed JavaScript/declaration consumers and the no-coding-agent durable boundary.
The packed consumer was also compiled and executed in an isolated temporary install containing durable, Pi AI, and Chord 1.2.0; it passed without loading coding-agent or TUI Kit.
Package-directory RPC smokes for Goal and Langfuse pass using the local Pi 1.3.0 CLI and fresh agent directories; Goal status is handled without starting an agent request.
Only documented RPC inspection/status commands were sent. No live or paid model requests or Langfuse exports were used.

## Final verification

- `npm install` completed. `npm ls --all` confirms all 136 occurrences of the six intended direct runtime packages resolve to 1.3.0; the published server pin remains unchanged.
- `npm run check` passed builds, Biome, package boundaries, and all workspace typechecks.
- The initial complete run exposed the Kimi catalog fixture failure described above; after preserving both API cases and adding request coverage, the final `npm test` run passed 11,192 tests with two skipped across 670 files. No failing check was suppressed.
- Focused suites passed: 40 Goal/native/Host probes, 127 Langfuse tests, and 47 Accounts authentication tests.
- Web builds passed. Dry-run packing passed for all 36 workspaces; canonical Goal and Langfuse pack commands also passed and their inventories were inspected.
- The current packed Langfuse consumer passed on the 1.3.0 host. The same packed public declarations and runtime also passed in a temporary isolated 1.2.0 durable/AI/Chord host, without coding-agent registration.
- Goal and Langfuse package-directory RPC smokes passed through the local Pi 1.3.0 CLI with fresh agent directories, orderly shutdown, and zero agent starts. The packed Langfuse tests exercise its lazy runtime boundary.
- The fenced-code-aware README foundation audit passed for all 36 packages. Changes preserve experimental warnings and supported old-host peer alternatives.

Verification used Linux and Node v26.11.1. Other supported Node/OS combinations were not independently smoked. The three existing high-severity npm advisories remain outside this targeted upgrade; no forced audit fixes, publications, version tags, or release workflow dispatch were used.

## Remaining gate

The upgrade is an explicitly approved baseline retest, not a way to hide the failed experiment.
The [native audit](durable-safety-audit.md) and [Host audit](durable-host-audit.md) retain the diagnostic evidence.
The active plan stays open; the full API, complete provider/profile coverage, safe unrelated deferred routing, integrated accounting/ownership, waits, tools, contracts, and end-to-end host acceptance remain unimplemented or unproved.
Do not claim the Host design is universally impossible, silently narrow compatibility, modify Pi upstream, or mark the safety gate passed on this retest.
