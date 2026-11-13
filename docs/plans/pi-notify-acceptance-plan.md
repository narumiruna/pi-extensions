# Pi Notify acceptance plan

Status: Telegram, typography, Teams, and LINE implementations are merged. External delivery,
client appearance, and physical-terminal acceptance remain open. Consolidation does not satisfy
those checks or authorize live messages, credential access, publication, or release actions.

## Goal

Close the remaining acceptance requirements for the existing Notify implementations without
changing notification policy, settings, provider contracts, or runtime behavior.

## Context

This plan replaces the three Telegram, typography, and Teams/LINE implementation plans.
Their full records remain in Git history at `b0baee93`; completed implementation tasks are not
repeated here. Merged pull requests do not establish live interoperability or user acceptance.

| Implemented area | Retained evidence | Historical verification |
| --- | --- | --- |
| Telegram and notification lifecycle | [PR #1588](https://github.com/narumiruna/pi-extensions/pull/1588), merge `080bec29`, review fixes `23a47dda` | 205 package tests; root check/test, pack inspection, isolated RPC package loading, and lazy Jiti menu loading passed. Invalid-file protection and installed-runtime input routing received regressions. |
| Telegram typography | [PR #1608](https://github.com/narumiruna/pi-extensions/pull/1608), merge `c5f7d943`, entity-whitespace fix `d4188a59` | 247 package tests; root check/test and pack inspection passed. Tests cover final-title replacement, UTF-16 entity offsets, Unicode clipping, trailing whitespace, and plain-text previews. |
| LINE | [PR #1616](https://github.com/narumiruna/pi-extensions/pull/1616), merge `b65d8a6e` | 1,409 package tests; root check/test, pack inspection, and isolated offline package loading passed. |
| Teams | [PR #1620](https://github.com/narumiruna/pi-extensions/pull/1620), merge `47eb4434`, implementation `bf9de4fd` | 1,791 package tests, including 360 Teams cases; root check/test, pack inspection, and isolated offline package loading passed. |

These counts describe separate implementation checkpoints, not current-HEAD totals or live
service results. The original Changesets are recorded in the package changelog; do not add
replacement Changesets for this repository-only consolidation. Current entrypoints, defaults,
provider inventory, and installation instructions come from the
[package README](../../packages/pi-notify/README.md) and manifest, not the old plans.

Relevant regression suites remain under `packages/pi-notify/test/`: `provider.test.ts`,
`activity-metadata.test.ts`, `teams.test.ts`, `line.test.ts`, `http.test.ts`, `settings.test.ts`,
`settings-providers.test.ts`, `menu.test.ts`, `menu-providers.test.ts`, `input-routing.test.ts`,
`coordinator.test.ts`, `lifecycle.test.ts`, and `build-runtime.test.ts`.

## Plan

- [x] Consolidate implementation evidence and every unresolved acceptance area into this plan.
  Evidence: the table above and the four external handoffs below retain delivery, appearance,
  interoperability, and physical-input limits without treating mocked requests as live evidence.
- [x] Retain the existing safety, approval, and recovery boundaries. Evidence: the rules below
  keep secrets outside chat, require confirmed sends, distinguish acceptance from receipt,
  preserve rollback prerequisites, and prohibit unapproved publication.
- [ ] Record sanitized external results or explicit acceptance of the original gaps, then
  prepare the final handoff. Acceptance: record the tested environment, permission scope,
  service acceptance, downstream receipt where applicable, safe Status, remaining limitations,
  and any release restriction; do not infer acceptance from a merged PR or missing credentials.

## External Handoff

### Telegram delivery

Responsible role: bot/chat owner. Prerequisites: approved disposable credentials and destinations
prepared outside chat, permission to disclose the previewed metadata, and approval for each
confirmed test. Use `/notify` to test the intended private, group/supergroup, and forum-topic
variants; record exactly which variants were exercised and their bot/chat permissions.

Expected result: the intended destination receives the metadata-only notification, and Status
reports the corresponding safe result. Real token/chat permissions and all untested destination
variants remain unverified. Record results or explicit user acceptance of the precise delivery
gap before closing the original live-smoke requirement; service acceptance does not prove reading.

### Telegram mobile appearance

Responsible role: Telegram mobile tester, with the bot/chat owner's send approval. Use an
approved test from the delivery handoff where possible; do not send another message without
permission. Inspect bold titles and repository names, inline code for technical values, literal
punctuation, Unicode, clipping, and wrapping. Record the client and environment.

Expected result: readable emphasis, unchanged text, and no rejected entities. Actual mobile
font and wrapping remain unverified; deterministic entity tests and plain-text previews cannot
establish client appearance. The original appearance check requires results or explicit user
acceptance of the gap before plan closure. Telegram controls fonts; no font setting is proposed.

### Teams interoperability and LINE receipt

Responsible roles: Teams workflow owner and LINE account owner. Each must prepare an authorized
disposable destination outside chat and approve the metadata-bearing test separately.

- Teams: use the current generated URL for an Anyone-authenticated commercial Workflows trigger,
  with a configured downstream chat/channel action and appropriate workflow ownership/co-owners.
  Compare it with the [supported client policy](../../packages/pi-notify/docs/settings.md#microsoft-teams).
  Do not reconstruct a signature or broaden validation to force a URL to match. Send one confirmed
  test, then inspect trigger acceptance, workflow/action success, target receipt, card rendering,
  and safe Status. HTTP 202 alone proves none of the downstream results; local URL/payload bounds
  are not a universal Microsoft contract or a downstream rendering guarantee. Client automatic
  links are not guaranteed to be suppressed. Generated-URL interoperability and delivery remain
  unverified until tested or explicitly accepted as gaps.
- LINE: prepare an eligible user/group/room recipient and check the account's regional plan,
  allowance, recipient eligibility, and group/room participation. Use the
  [documented setup](../../packages/pi-notify/docs/settings.md#line-setup-and-revocation), send one
  confirmed test, and compare actual receipt with safe Status. HTTP acceptance can occur without
  delivery, including for blocked or ineligible users. Untested recipient variants remain
  unverified. LINE Notify, recipient discovery, and an extension-owned event receiver are not
  part of this work.

Expected result: receipt at each intended destination, with the supported payload and matching
safe Status. Missing credentials, permission, entitlement, or recipient access leaves the
original acceptance requirement open unless the user explicitly accepts the unverified path.
Stop after one clear external or entitlement failure and retain sanitized evidence; do not retry
or bypass the supported service policy. No universal compatibility or quota claim is permitted.

### Physical terminal behavior

Responsible role: terminal tester. Prerequisites: a built package and synthetic settings, with
separate send approval if a test needs a real destination. Exercise regular/fullscreen modes,
configured keys, editing/paste, cancellation, focus/mouse input, and SSH/tmux where applicable.
Use the [documented inactivity limits](../../packages/pi-notify/docs/settings.md#inactivity-timing).

Expected result: only activity forwarded by Pi cancels a pending reminder. Fullscreen Pi consumes
some focus, mouse, viewport, and search events before extension listeners; terminal support alone
does not prove forwarding. Headless modes cannot observe terminal inactivity and use settlement
instead. Reading, continuous focus, screen locks, and user attention are not detected.
Physical key delivery and multiplexer behavior remain unverified. Retain these limits in the
release handoff; any discovered correctness or safety defect blocks the affected release.

## Safety and verification rules

| Touched area | Applicable MUST rules | Named verification |
| --- | --- | --- |
| Documentation | Preserve implemented/proposed distinctions, exact approval limits, unresolved acceptance, and valid evidence references. | `Review` of all three source plans, the final diff, and local links/anchors. |
| Credentials and external tests | Keep tokens, complete signed URLs, and raw recipient IDs out of chat, Project files, source control, previews, logs, and evidence; confirm the disclosed metadata before sending. | Secret-path `Review`; existing redaction `Test`; separately authorized provider `Smoke` only. |
| Verification and scope | Run both repository gates; do not race a Kit build with root checks or consumer tests; keep historical smoke results distinct from new evidence. | `Validator`: `npm run check`; `Test`: `npm test`; `Review` that only repository planning documents change. |

Apply `docs/extension-conventions.md` and the writing-plans skill to this consolidation.
Settings and README implementations are unchanged; any later change must first adopt
`docs/extension-settings.md` and `docs/readme-conventions.md` where applicable.
No new package, loader, or interactive smoke is required by this documentation-only change.
No live provider smoke, credential lookup, or private settings read is authorized here.
Approved tests must retain the existing one-attempt policy, redirect refusal, 10-second
request/response deadline, 65,536-byte response bound, and secret-safe results. Stop after one
clear external or entitlement failure for any service; use deterministic evidence rather than
retries or alternate credential routes.
The current shared [service references](../../packages/pi-notify/docs/settings.md#authoritative-references)
and Telegram's [message entities](https://core.telegram.org/bots/api#messageentity) and
[entity-length rule](https://core.telegram.org/api/entities#entity-length) retain the API evidence;
recheck relevant contracts before any later implementation change.

## Rollback / Recovery

Disable notifications in the effective scope, including trusted Project overrides, to stop
pending reminders. Cancelling a request or unloading the extension cannot recall an accepted
message. Revoke exposed credentials through BotFather, the owning Teams workflow, or LINE
administration before saving replacements; removing a destination does not revoke credentials.
For Teams, ensure the old endpoint is no longer usable. For LINE, follow the token-type-specific
revocation or expiry rules.

Before reverting to a version without Teams or LINE, remove their IDs from explicit Project
selections in every affected project, then from User selections, and delete all saved unsupported
destinations while the capable version remains installed. Unsupported destinations can disable
older routing even when unselected. Preserve unrelated fields, previous disk/runtime state on
save failure, and invalid-file protection. See the retained
[persistence and recovery guidance](../../packages/pi-notify/docs/settings.md#persistence-and-recovery).
No settings migration or runtime rollback is part of this consolidation.

## Completion Checklist

- [x] Merged implementations, historical tests, pack/load results, and current package guidance
  have retained references; unresolved service assumptions are not described as verified facts.
- [x] Each external handoff names its owner, prerequisites, expected result, unverified behavior,
  and acceptance or release restriction. Credentials and external-operation approval remain separate.
- [ ] The original Telegram delivery/appearance and Teams/LINE receipt requirements have recorded
  results or explicit user-accepted gaps; physical-terminal limits remain in the final handoff.
- [x] Consolidation verification passed: `npm run check`, full `npm test` (21,379 passed,
  34 skipped, 947 files, no unhandled errors), semantic review, and all six local links/anchors.
  Only repository planning documents changed; no new live or interactive smoke was performed.
- [ ] The final acceptance handoff names applicable guides, changed files, historical/new smokes,
  deviations, accepted limitations, and open paths.

Retain this plan while acceptance is open. Before deleting it, preserve unresolved external items
and release restrictions in retained package guidance. Plan closure is not publication approval;
publication, visibility changes, version tags, and release workflow dispatch each require separate
explicit approval.
