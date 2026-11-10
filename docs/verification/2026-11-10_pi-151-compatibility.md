# Pi patch-release compatibility verification

## Scope

Resolve the account-continuation and test-host findings from the Pi 1.5.1 and 1.5.2 review. Repository development dependencies remain at 1.5.0. The already-installed global Pi 1.5.2 is available for isolated runtime checks; this does not authorize a fresh dependency-age exception.

## Findings and disposition

| Finding | Disposition |
| --- | --- |
| Anthropic thread state survives an account change | Built-in adapters use public `cleanupSessionResources(sessionId)` when the applied account identity changes. This also covers explicitly enabled message threads on compatible gateway transports. The explicit Codex override is preserved. |
| Session-wide cleanup can close a busy Codex socket | Background authentication records pending invalidation. Cleanup runs only for the current provider while idle, or at the awaited `turn_start` boundary before its next request. Other providers' background activation cannot interrupt an active stream. Pending work is discarded on session replacement and shutdown. |
| A later lifecycle handler changes authentication after the request boundary | A known current identity change outside initial run preparation cancels the active run instead of closing a busy socket or sending another identity's continuation. Selecting a busy provider with pending cleanup also cancels that run. The next run drains the pending invalidation. |
| Cleanup also resets strict-tool fallback | This is an intentional account-identity transition. Repeated requests with unchanged authentication retain thread and strict-tool state. No prompt, message, tool definition, or payload transformation is added. |
| Test hosts omit the overlay registry used by newer Pi reset logic | Initialize `extensionOverlays` in the two constructor-bypassing hosts that call reset. Keep all disposal, settlement, and replacement-draft assertions. The third host, in Usage, does not call reset. |
| Full-suite compaction fixture sometimes skips automatic recovery | The unchanged fixture could create a response in the same millisecond as its seeded compaction boundary. Pi correctly treats that usage as stale. Mock only `Date` and advance it before each provider response; keep every recovery assertion and real I/O timer. No compaction implementation changes. |
| Idle warming changes costs and provider-hook traffic | Existing cache-monitor, Inspector, Analytics, and Langfuse tests cover usage accounting and provider-only warming. Keep the existing behavior and do not introduce a new setting. |
| Busy reload, missing-folder fork, grep callbacks, and optional classifier/Markdown features | No new implementation is required by this fix. Files already handles reload failure; no custom GrepOperations callback is used. Upstream example fixes do not replace the independent Plan or Subagents implementations. |

## Semantic audit

Applicable guides: `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and the Accounts, Files, and TUI Kit package guidelines.

Account cleanup uses the existing local identity contract: default authentication, account name plus applied key/access token, and fail-closed account identity. An initial default observation and ordinary unchanged authentication do not invalidate resources. Named/default transitions and key replacement do. The existing credential-refresh, shared-replacement, stale-task, and failure-recovery tests remain required.

The scheduling audit includes detached startup, a delayed non-current provider while Codex is active, model selection during a run, pre-request cleanup failure, superseding synchronization, cancellation while storage is blocked, late protocol activation, credential replacement during active work, stale cleanup completion, session replacement, and shutdown. Pi's agent loop awaits `turn_start`; `before_agent_start` is not an idle boundary. Request preparation rechecks the live provider, latest task, session owner, and run signal after each await. Initial authentication can finish during the owning run-preparation hook without cancelling the run. Later current-account changes cancel active work, as documented in the package README and protocol reference.

No private provider state is accessed by production code. Credential storage, permissions, settings precedence, and public protocol payloads are unchanged.

## Verification results

- Installation policy preflight and `npm install`: passed; no manifest or lockfile changes.
- Regression before the adapter fix: six of seven new checks failed, including Anthropic and gateway identity transitions; the Codex override check passed.
- `npm run format` and `npm run check`: passed; builds, Biome, package boundaries, and workspace typechecks passed. Existing Biome schema-version and unrelated Sync lint diagnostics were informational and did not fail the gate.
- Focused account integration and protocol checks: 145 tests passed, including 16 session-resource cases. Test-source compilation passed after correcting optional-signal assertions.
- Installed-runtime focused checks: 194 tests passed across Accounts integration, session resources, Kit inline reset, and Files settings, with the already-installed Pi 1.5.2 AI, coding-agent, and TUI peers selected by a temporary Vitest alias configuration. This is not a full dependency-tree upgrade.
- Native Pi AI 1.5.2 thread smoke: injected fetch only, no provider network calls. Both Anthropic and an explicitly enabled OpenRouter-compatible transport produced create/continue, a fresh create after account cleanup, and continuation in the untouched second session.
- Native strict-tool/prefix smoke: an injected strict-limit rejection downgraded the first account's tools once; ordinary normalized system, tool definitions, and ordered message prefixes remained stable. Account cleanup deliberately restored strict preference and started a new thread, then ordinary requests remained stable again.
- Global Pi 1.5.2 package-directory RPC smoke: offline, isolated agent directory, no other resources; loaded the built package, opened and cancelled the lazy Accounts menu, and exited cleanly after stdin EOF without assistant output or provider requests. No interactive TUI was opened.
- `npm run package:pack -- accounts` and actual tarball inspection: passed; 25 declared files include the generated runtime, lazy chunks, source, API docs, README, changelog, license, and manifest, with no tests or repository-only verification files.
- Fenced-code-aware README heading audit: passed for all 37 packages. Changesets status identifies the intended Accounts patch; the existing BTW changeset was not changed.
- Compaction fixture investigation: the failing overflow response and its compaction boundary both had timestamp `1794320674966`. A full run failed at `assert.ok(preparation)` and isolated reruns reproduced threshold/overflow failures. After controlling the fixture clock, ten consecutive isolated runs passed all four cases; no assertion or timeout was weakened.
- Final full `npm test`: passed, 943 files and 20,751 tests, with 34 unchanged skips and no unhandled errors. The run includes late-activation cancellation and deterministic compaction timing.

## External handoff and restrictions

### Dependency upgrade

Responsible role: dependency maintainer. Prerequisite: every required Pi patch artifact meets the repository's three-day release age, or a separately reviewed targeted exception has explicit maintainer approval. Action: update the coordinated root/workspace Pi development pins and lockfile, then run both root gates and the runtime regressions. Expected result: a policy-compliant upgrade. Unverified behavior: the full repository suite under Pi 1.5.2. Restriction: this pull request does not upgrade dependencies or claim full-suite patch-release readiness.

The coding-agent artifacts were published at 2026-11-09T23:45:13.428Z for 1.5.1 and 2026-11-10T12:24:55.226Z for 1.5.2. Check each companion package's publication time instead of assuming the coding-agent timestamp covers the full package family.

### Live account switch

Responsible role: account owner. Prerequisite: two authorized Anthropic accounts and approval for provider requests. Action: switch accounts and send the next request. Expected result: the new account starts without the old account's continuation. Unverified behavior: server-side cross-account thread handling and subscription entitlement. Restriction: deterministic client checks do not establish live-provider acceptance; no real credentials or paid provider requests are used by this change.
