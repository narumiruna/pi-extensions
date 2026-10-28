# pi-notify Teams and LINE implementation plan

## Goal

Add Microsoft Teams Workflows and LINE Messaging API destinations to `@narumitw/pi-notify`. Users can create, edit, select, remove, and test both through `/notify`, including mixed selections with the eight existing providers. Preserve existing notification policy, settings behavior, privacy boundaries, and cancellation.

This document authorizes no publication or external test messages. LINE was merged in PR #1616 at `b65d8a6e`. Teams implementation continues on `narumi/feat/notify-teams`, based on that updated `origin/main`. The full plan remains open until external acceptance evidence is available.

## Execution status

The user requested Teams implementation first, before supplying live test credentials. Proceed with an explicit, conservative offline client policy and deterministic tests; this staged request does not waive actual receipt verification or establish universal Microsoft URL/response behavior. Current Microsoft documentation establishes the Workflows trigger, Anyone authentication, Adaptive Card envelope, literal `RichTextBlock`/`TextRun` rendering, and URL migration. It does not specify every signed-URL or response variant. Do not describe a local supported subset as the complete service contract or infer Teams behavior from a different Logic Apps trigger.

A controlled disposable Teams workflow sample remains required for live interoperability and receipt validation, not for implementing the explicit local subset. A private local test-settings path was requested; no credentials were requested in chat or searched in existing private files. LINE live-recipient verification also needs an authorized disposable destination. No external message has been sent. Keep the external smoke and full completion criteria open until verified or explicitly accepted by the user.

Verified Teams references on 2026-10-18: the trigger troubleshooting guide documents both `/direct/workflows/...` and the newer `/direct/cu/20/workflows/...` paths; the Teams connector reference requires omission of Authorization for Anyone; the Microsoft Adaptive Cards `TextRun` schema explicitly excludes Markdown. The connector action limit is approximately 28 KB, including rendered elements; a local JSON budget is not proof of downstream rendering size. `postJson()` currently conflates empty/non-JSON bodies as `undefined`, so an empty-body-only acceptance policy would require an explicit tested transport change.

The LINE implementation checkpoint passes local gates without changing the eight existing provider implementations. Its current official OpenAPI/reference use `sentMessages` responses; the official Node SDK also tests legacy `{}` push acceptance. The token has no documented fixed length, so the provider uses a documented local safety bound and Bearer syntax rather than inventing a service length. The current character-count reference is `https://developers.line.biz/en/docs/messaging-api/text-character-count/`.

### LINE checkpoint evidence

- `npm run check` passed after the final source/test changes: builds, Biome, package boundaries, and all workspace typechecks.
- `npm test` passed: 658 test files passed, one skipped; 10,656 tests passed, two skipped. Focused `pi-notify` tests passed: 18 files, 1,409 tests. The initial affected-test selection skipped uncommitted changes, so it was not counted as evidence; direct focused and full runs replaced it.
- `npm run package:pack -- notify` passed. An actual temporary tarball contained 25 intended files, including LINE source and installed documentation, without tests, settings, or credential fixtures. The package build command completed; this source-loaded package has no build script.
- An isolated offline Pi RPC smoke loaded the package directory, found `/notify`, exercised its non-TUI setup response, and shut down cleanly. No model request or notification request was sent. Interactive physical-terminal behavior and downstream LINE receipt remain unverified; deterministic menu/lifecycle tests cover the new TUI flow.
- The fenced-code-aware README foundation/order audit passed for 36 active packages; npm badge is not applicable to the private showcase. Local README links resolve. An initial audit incorrectly required that private package's npm badge; correcting applicability did not change repository files.
- The semantic audit covered correctness, secret output, asynchronous ownership, persistence ordering/failure recovery, compatibility, retained existing-provider rollback coverage, and scope. Review removed an inferred C/R hexadecimal alphabet in favor of explicitly bounded opaque printable-ASCII suffixes, and added initial-setup/token-edit recovery tests. No shared transport, coordinator, lifecycle implementation, prompt, tool, or entrypoint changed. The menu remains below 1,000 lines.
- `npm install` reported three existing high-severity advisories (`@earendil-works/pi-coding-agent`, `brace-expansion`, `minimatch`); manifests' dependency ranges and the lockfile were not changed. Dependency remediation is outside this feature.

These are LINE checkpoint results, not completion evidence for Teams. Repeat affected gates, packing, and smokes after Teams implementation. Keep this plan and the full completion checklist open.

### Teams staged implementation policy

The supported client subset uses current commercial `.environment.api.powerplatform.com` endpoints, explicit direct and `direct/cu/{route}` workflow paths, and exactly one of each documented SAS parameter (`api-version=1`, `sp=/triggers/manual/run`, `sv=1.0`, `sig`). Preserve signed URL bytes and allow explicit default HTTPS port 443. URL/identifier/signature bounds and accepted spelling are local validation policy, not inferred universal service limits.

Only HTTP 202 is supported trigger acceptance after a bounded response read; the bounded empty/text/JSON body is not interpreted. This follows HTTP 202 semantics, not an undocumented Teams response-body schema. It does not prove that a workflow ran successfully or posted to Teams. Reject other success statuses rather than claiming arbitrary 2xx compatibility. Live compatibility with this subset remains unverified.

Use fixed Adaptive Card 1.2 `RichTextBlock`/`TextRun` content and a 24,000-byte encoded-envelope local budget. Do not claim suppression of client automatic links. Keep transport cancellation, deadline, response bound, safe errors, and the other nine providers unchanged.

### Teams offline implementation evidence

- `npm run format` and `npm run check` passed after the Teams implementation: builds, Biome, boundaries, and all workspace typechecks. `npm test` passed: 659 files passed and one skipped; 11,038 tests passed and two skipped.
- Focused notify verification passed: 19 files and 1,791 tests, including 360 Teams provider cases. The integration subset independently passed 285 tests before the combined run.
- `npm run package:pack -- notify`, the optional package build command, and Changesets status passed. An actual tarball contained 26 intended files; packed Teams source matched the working tree, without tests, settings, or credential fixtures.
- An isolated offline Pi RPC package-directory/Jiti smoke loaded the extension, found `/notify`, exercised the non-TUI setup response, and shut down cleanly. No model request or notification request was sent. Existing menu/lifecycle harnesses exercise the lazy command/menu path; physical-terminal behavior remains unverified.
- A fenced-code-aware README foundation/order/applicable-badge audit passed for 36 active packages; package-owned local links and anchors resolve. The current Microsoft TextRun/RichTextBlock schema links return HTTP 200.
- The final semantic audit covered correctness, security, lifecycle safety, compatibility, regressions, and scope against all three guides. It found no remaining concrete defects. A decoded-signature trailing-newline regex class was fixed and tested across encoded controls. The other nine provider implementations, shared HTTP transport, settings persistence implementation, coordinator, lifecycle, and model-visible prefix remain unchanged.
- The menu is 983 lines, below the 1,000-line threshold; no responsibility split was necessary. No dependency, lockfile, SDK, environment option, template, retry, or publication change was introduced.

This completes the authorized offline Teams implementation stage, not the full plan. Real generated-URL compatibility, workflow execution, Teams/LINE downstream receipt, and physical-terminal behavior have not been verified. The live-smoke task and dependent completion criteria stay open; retain this plan.

## Original context

- `packages/pi-notify/src/provider.ts` owns destination types and the provider contract; `src/providers.ts` registers eight built-in providers.
- `src/providers/http.ts` provides injected-fetch JSON POST transport with a 10-second total deadline, a 65,536-byte response limit, redirect rejection, one attempt, and safe errors. Its `normalizeHttpUrl()` rejects queries and is not suitable for signed Teams workflow URLs.
- `src/destination-ui.ts` owns provider labels and redacted summaries. `src/menu.ts` owns transactional destination drafts, masked credentials, selection, confirmed tests, and Help. The menu is already 904 lines; avoid taking it over 1,000 lines without a responsibility-based split.
- `src/settings.ts` validates through the provider registry and preserves unknown destination fields. Invalid or unsupported destinations disable automatic routing, even when unselected.
- `src/notify.ts` already scopes resources by `sessionManager`, loads the menu lazily, and cancels owned work on replacement and shutdown. No new lifecycle resources or model-visible tools are needed.
- Existing test owners include `test/http.test.ts`, `test/menu-providers.test.ts`, `test/settings-providers.test.ts`, `test/coordinator.test.ts`, and `test/lifecycle.test.ts` under the package.

## Scope and architecture

### Teams

Use provider ID `teams` and label `Microsoft Teams`. A destination contains `provider`, `label`, and `webhookUrl`. Treat the complete URL, including path and query, as a credential.

Support the documented Teams Workflows trigger, **When a Teams webhook request is received**, with **Anyone** authentication. Do not send an Authorization header for this mode. The workflow owns its target chat/channel; the extension does not override it.

Use one fixed Adaptive Card message envelope with sanitized title and metadata. Resolve the literal-text rendering strategy before implementation: Adaptive Card `TextBlock` supports Markdown and must not be assumed to display arbitrary paths and session names literally. Do not include actions, images, mention entities, or user-defined templates.

Require HTTPS and a provider-owned validator for current commercial workflow endpoints. Preserve signed URL bytes instead of rebuilding query strings. Resolve supported host/path/query families from current Microsoft documentation and credential-free structural fixtures before coding. Reject legacy Office connectors and obsolete workflow URLs rather than adding a second Teams transport.

### LINE

Use provider ID `line` and label `LINE`. A destination contains `provider`, `label`, `channelAccessToken`, and `recipientId`.

Send one text message through `POST https://api.line.me/v2/bot/message/push` with Bearer authentication. Accept documented user, group, and room IDs, not a display name or public LINE ID. Keep the token in a header, never in the URL. Treat recipient IDs as private account identifiers and hide their raw values from summaries and status.

Combine title and metadata into plain text. Bound it to LINE's 5,000-character limit using the documented counting method without splitting Unicode code points; include an ellipsis within the budget when clipped. Keep normal notification behavior. Do not add silent delivery, interactive messages, automatic recipient lookup, or an inbound webhook server.

### Shared behavior

Reuse `postJson()` where its result preserves the verified service contract. It permits empty/non-JSON successful bodies, but provider adapters must decide which statuses and bodies mean acceptance. A Teams trigger acceptance does not prove a downstream Teams post; LINE HTTP 200 does not prove receipt by an eligible, unblocked user.

Keep providers limited to validation, payload construction, and transport. Retain existing settlement timing, inactivity behavior, multi-destination delivery, metadata-only disclosure, and one-attempt policy. Add no SDK, dependency, environment variable, configuration flag, or cross-extension protocol.

## Applicable MUST rules and verification

Apply `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md` to these touched areas before implementation.

| Touched area | Required rules | Named verification |
| --- | --- | --- |
| Provider contract and transport | Honor cancellation; bound response work; keep failure output observable and secret-free; add deterministic tests for changed behavior. | **Test:** new `teams.test.ts` and `line.test.ts`, shared HTTP regressions. **Review:** every endpoint, status branch, payload field, error, timer, and listener. |
| Settings and persistence | Read the settings guide; use private User settings for secrets; preserve unknown fields; block invalid-file overwrite; serialize mutation and dependent reads; retain previous state on failure; publish atomically with private permissions. | **Test:** extend `settings-providers.test.ts` and relevant `settings.test.ts` cases. **Review:** reads and writes together, trust gating, failure recovery, and rollback. |
| Menus and asynchronous UI | Keep custom UI TUI-only; preserve mode-safe command behavior; bound rendering and use callback theme/keybindings; cancel tasks on user cancellation and disposal; reject stale-session continuations. | **Test:** provider menu flows, non-default keys, paste/editing, narrow rendering, RPC/print/JSON, cancellation/disposal/replacement/shutdown. **Review:** each changed `await` and ownership check. |
| Package and runtime | Preserve the thin source entrypoint and independent installation; record published behavior through a Changeset; align published contents with the manifest. | **Validator:** boundary checks and workspace typechecks through `npm run check`. **Smoke:** pack inspection and package loading. **Review:** dependency and release scope. |
| Documentation and handoff | Keep setup/security warnings and supported interfaces accurate; preserve README foundation; run both root gates and report skipped checks and deviations. | **Review:** README checklist, fenced-code-aware heading audit, links, setup and revocation. **Validator:** `npm run check`. **Test:** `npm test`. **Smoke:** applicable Pi and provider paths. |

Preserve factory/lifecycle and model-prefix contracts by making no changes to registration, prompts, tools, or settlement policy. Review the final diff to confirm this remains true; retain existing lifecycle regressions.

## Plan

### 1. Resolve external API contracts before implementation

- [ ] Record the Teams workflow endpoint contract in package-owned comments/docs: verify current host, path, signature query, URL length, and authentication requirements from the Microsoft references below; add synthetic valid/invalid fixtures that enumerate each supported URL family and rejected normalization class.
- [x] Define and test the explicit Teams client policy for statuses, empty/text/JSON response handling, card compatibility, encoded payload budget, Markdown/link behavior, and workflow-owned targets using the staged scope above. Distinguish authoritative HTTP/card contracts from the locally supported URL/status subset. Keep live interoperability validation open pending a controlled sample; do not copy Slack's `200`/`ok` contract, assume every 2xx proves delivery, or claim the complete service contract is resolved.
- [x] Define the LINE contract from the current API reference: record token/header bounds, recipient ID formats, text counting, successful response variants, recipient eligibility, group participation, monthly quotas, HTTP 429 behavior, and revocation. Resolve differences between documented response examples before writing strict response validation.

Acceptance evidence: dated authoritative references plus table-driven contract fixtures; unresolved assumptions are explicit blockers, not inferred behavior.

### 2. Implement provider contracts and transports

- [x] Add `TeamsDestination` and `LineDestination` to `src/provider.ts` and register both in `src/providers.ts`; TypeScript exhaustiveness identifies every affected UI branch, and all existing provider IDs keep their behavior.
- [x] Add `src/providers/teams.ts` with injected fetch, strict signed-URL validation, a fixed bounded card payload, literal metadata handling, and the verified acceptance mapping; `test/teams.test.ts` covers the complete URL/payload/response matrix without credentials or network access.
- [x] Add `src/providers/line.ts` with injected fetch, bounded validated credentials/recipient IDs, fixed endpoint and Bearer header, one clipped plain-text message, and verified response mapping; `test/line.test.ts` proves user/group/room routing and Unicode boundaries.
- [x] Reuse `src/providers/http.ts` without broadening existing URL or success policies; if a shared transport change is necessary, test every existing consumer and enumerate its affected response branches before accepting the change.

Provider tests must cover pre-abort, abort during fetch and body read, timeout, stalled injected fetch/streams, response size limits, redirects, HTTP errors, 429 with valid/invalid Retry-After, malformed/unexpected success responses, and safe result output. Verify one request per attempt and cleanup of owned timers/listeners. For Teams, include host suffix attacks, userinfo, ports, fragments, controls, backslashes, malformed encoding, duplicate/ambiguous signature parameters, and path normalization. For both, include hostile mentions, links, markup, terminal controls, emoji, and clipping at the exact boundary.

### 3. Integrate private settings and destination management

- [x] Extend `test/settings-providers.test.ts` with both destinations: prove round trips, mixed selections across ten providers, trusted Project selection without Project credentials, fail-closed invalid destinations, private permissions, unknown-field preservation, invalid-file protection, ordered load/write behavior, save failure recovery, and unchanged saved Off/Project selections.
- [x] Extend `src/destination-ui.ts` with labels, credential descriptions, and redacted review/status lines; tests must prove that Teams URL components, LINE tokens, and raw recipient IDs never appear in summaries, previews, notifications, or error output.
- [x] Add both providers to `src/menu.ts` through the existing add/review/save/edit/test flow; use masked input for webhook URLs, tokens, and private recipient IDs, and do not prefill secrets in visible fields. Preserve Save and use, Save only, selection-preserving edits, cancellation, and confirmed external sends.
- [x] Keep menu responsibilities clear and source files at or below 1,000 lines: if the new flows exceed the limit, extract the cohesive destination setup/edit responsibility into a package-owned module, retain menu/session ownership in its existing owner, and run existing menu tests unchanged before adding provider cases.
- [x] Extend menu/input/lifecycle tests for both providers: verify add/edit/remove, invalid-input recovery, transactional cancellation, secret replacement, recipient replacement, test preview and confirmation, failed saves, non-default keybindings, input/paste behavior, narrow and non-interactive rendering, and cancellation/disposal/session replacement/shutdown during pending input or delivery. Capture custom-UI evidence inside callbacks and assert after command completion.

### 4. Document and prepare the package change

- [x] Update `packages/pi-notify/README.md` and `docs/settings.md` with the two supported services, exact fields and limits, manual examples, metadata disclosure, setup/test/revocation, eligibility and quota constraints, and rollback instructions; verify all existing guidance remains accessible and update provider counts/references throughout active package documentation.
- [x] Document Teams Workflows creation with Anyone authentication, the current generated URL, workflow ownership/co-owners, supported target/card scope, and the distinction between trigger acceptance and channel delivery; document the chosen literal-text/link behavior without claiming unsupported suppression.
- [x] Document LINE Official Account and Messaging API setup, channel token creation, developer-console user ID or official event-based group/room ID acquisition without adding an extension server, recipient eligibility, token revocation, and acceptance versus receipt. State explicitly that LINE Notify is unsupported and that account plans/quotas vary rather than hard-coding a universal free allowance.
- [x] Update `packages/pi-notify/package.json` discovery keywords if appropriate, retain its existing entrypoint/dependencies, and add a dedicated minor Changeset for Teams and LINE; inspect Changesets status without changing versions or publishing.

### 5. Verify and hand off

- [x] Run `npm run format`, inspect the complete intended diff, and run `npm run check` followed by `npm test` from the repository root; record results and keep every test within the configured 5,000 ms timeout. Do not run root checks concurrently with a separate Kit build/check; the root test script rebuilds workspace output before consumer tests.
- [x] Run the README guide's fenced-code-aware heading audit and semantic touched-area review; audit secret paths, URL equivalence classes, provider response branches, asynchronous ownership after every changed `await`, settings ordering/recovery, and all eight existing providers. Record deviations near their owner and in the handoff.
- [x] Run `npm run package:pack -- notify` and inspect the tarball for new source/docs and absence of tests, settings, credentials, and unrelated files; run `npm --workspace @narumitw/pi-notify run build --if-present` and an isolated, finite non-interactive Pi package-load smoke using `pi -e ./packages/pi-notify`. Exercise the lazy menu registration path through the existing loader/test harness; record any TUI-only runtime path that cannot be smoked in the available environment.
- [ ] With explicit permission and disposable credentials entered outside chat, send one confirmed test to a Teams workflow and one eligible LINE recipient; verify downstream receipt and matching safe Status results. Record credentials, entitlement, or recipient-access blockers without exposing values; stop after one clear external/entitlement failure and use deterministic tests rather than retrying. Missing permission/credentials leave this smoke open and identified as blocked unless the user explicitly accepts the unverified path.
- [ ] Hand off the changed files, applicable guides, semantic audit results, root gates, pack/load/provider smoke evidence, and any accepted limitations; do not publish, create version tags, or dispatch releases.

## Non-goals

No old Teams Office connectors, obsolete `logic.azure.com` endpoints, Graph API, Entra/OAuth token flow, government cloud endpoints, arbitrary card templates, channel override, LINE Notify, inbound event receiver, automatic account/recipient discovery, reply/multicast/broadcast, message history, retries, queue, SDK, or notification-policy change.

## Rollback / Recovery

Existing settings need no migration. Keep the eight existing providers compatible and preserve unknown fields.

Before installing a version without Teams/LINE, remove their IDs from explicit Project selections in every affected project, then from User selections, and remove the saved destinations while the new version remains installed. Removing selections alone does not restore older routing because unsupported saved destinations also fail closed. Test this with a registry that omits `teams` and `line`.

Removing a destination does not revoke its credential. Revoke/replace a leaked Teams workflow URL through its owning workflow and revoke/replace a LINE channel token through LINE administration before saving replacements. Workflow acceptance or HTTP cancellation cannot recall an already accepted message. Keep previous disk/runtime settings on save failure and repair malformed files before retrying.

## Completion Checklist

- [ ] API discovery tasks have evidence; no material URL, payload, rendering, or acceptance assumption remains unresolved.
- [ ] Both providers work through manual settings, `/notify` management, confirmed tests, and mixed automatic routing without changing existing provider or policy behavior.
- [x] Transport, secret redaction, persistence, lifecycle, input, and mode tests pass; final semantic audit covers all applicable guide requirements.
- [ ] `npm run check`, `npm test`, README audit, pack inspection, and Pi load smoke pass; external delivery smokes pass or have explicit user-accepted limitations.
- [ ] Package documentation, rollback steps, minor Changeset, and handoff are complete; no publication or release action was performed.
- [ ] After implementation and all checks above are complete, delete this plan and report its path in the implementation handoff; retain it while any required evidence is missing.

## Authoritative references

Consulted on 2026-10-18; recheck service contracts during the first implementation tasks.

- [Teams connector: Microsoft Teams Webhook](https://learn.microsoft.com/en-us/connectors/teams/#microsoft-teams-webhook): authentication modes and Adaptive Card envelope; does not establish a complete response contract.
- [Create webhooks using Workflows](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook): setup and payload examples; distinguish Workflows guidance from deprecated connector guidance on the same page.
- [Teams card formatting](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-format): Markdown and mention behavior; follow the linked Adaptive Cards element documentation for the selected rendering strategy.
- [Power Automate trigger troubleshooting](https://learn.microsoft.com/en-us/power-automate/triggers-troubleshoot): HTTP/Teams trigger URL migration and obtaining the current URL.
- [LINE push API](https://developers.line.biz/en/reference/messaging-api/#send-push-message) and [non-JavaScript reference](https://developers.line.biz/en/reference/messaging-api/nojs/): endpoint, authentication, recipients, limits, and responses.
- [LINE sending messages](https://developers.line.biz/en/docs/messaging-api/sending-messages/): prerequisites and delivery conditions.
- [LINE text character count](https://developers.line.biz/en/docs/messaging-api/text-character-count/): UTF-16 counting; the older message-quantities character-count URL no longer resolves.
- [LINE OpenAPI](https://github.com/line/line-openapi/blob/main/messaging-api.yml) and [official Node SDK legacy push tests](https://github.com/line/line-bot-sdk-nodejs/blob/master/test/line-bot-client.spec.ts): current response schema and legacy empty-object acceptance.
- [LINE channel access tokens](https://developers.line.biz/en/docs/basics/channel-access-token/): token management and revocation.
