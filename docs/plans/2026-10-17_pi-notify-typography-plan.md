# Pi Notify Telegram typography plan

## Goal

Make Telegram notifications easier to scan with bold headings and inline monospace technical values. Preserve notification timing, disclosed metadata, and the plain-text confirmation preview.

## Context

`packages/pi-notify/src/metadata.ts` builds a title and a newline-delimited body. `src/telegram.ts` concatenates and clips them to 4,096 UTF-16 code units, with no parse mode or entities. `src/provider.ts` defines the shared notification contract. `src/menu.ts` previews title and body and replaces the title for test delivery. Entity offsets must therefore be computed from the final title, not stored against an earlier title.

The current provider tests cover clipping, transport safety, cancellation, and failures. Metadata tests cover sanitization, missing Git data, linked worktrees, and detached HEAD.

## Non-Goals

Do not change settings, notification frequency, inactivity policy, lifecycle hooks, or command routes. Do not remove fields, shorten session IDs, alter timestamps or durations, or deduplicate paths in this change. The earlier compact-layout suggestion is separate from typography. Do not add font settings, MarkdownV2, HTML parsing, code blocks, or dependencies.

## Architecture

Keep semantic formatting in the metadata producer and Telegram entity serialization in the Telegram provider. Retain `Notification.title` and `Notification.body` as readable text for existing previews and fixtures. Add only the minimal optional, provider-neutral body emphasis data needed for bold and inline code; do not infer field meaning by parsing display labels in the transport.

Format the final title as bold in the Telegram provider. Format the repository value as bold and branch, workspace/worktree paths, and session ID as inline code. Keep labels, computer, session name, elapsed time, and timestamp in regular text. Retain the existing field order for this typography-only change. Do not use simulated Unicode fonts or ANSI styles.

Generate offsets and lengths from sanitized display text in UTF-16 code units. Translate body-relative ranges after joining the final title and body, then reconcile all ranges with the final clipped text. Exclude the truncation ellipsis from formatting ranges, omit empty or removed ranges, and never split a surrogate pair. Messages without optional emphasis data must remain valid.

## Applicable Rules and Verification

- Metadata and transport safety: preserve terminal-control removal, mention replacement, bounded output, disabled link previews, fixed HTTPS endpoint, redirect rejection, credential redaction, and cancellation. Verify with metadata/provider tests and semantic diff review.
- Preview and command compatibility: preserve the existing TUI-only confirmation path, non-TUI behavior, and explicit external-send confirmation. Verify with menu tests and non-interactive preview assertions. Capture custom-callback evidence inside the callback and assert after command completion.
- Documentation: follow `docs/extension-conventions.md` and `docs/readme-conventions.md`; retain README sections and privacy warnings, and replace the plain-text-only claim with the actual entity-based behavior. Verify by documentation review.
- Published behavior: add a patch Changeset for `@narumitw/pi-notify`, without publishing or changing package metadata. Verify by Changeset review.
- Verification gates: run `npm run check` and `npm test` separately. Rebuild Kit before consumer tests and do not run root gates concurrently with Kit builds. Review the final diff against the guides' touched-area checklist.
- Settings, persistence, model-visible context, and runtime loading are unchanged. If implementation expands into one of these areas, read its applicable guide and revise this plan before editing.

## Plan

- [x] Confirm Telegram Bot API requirements for `sendMessage.entities`, UTF-16 offsets, inline code, and message limits from the official documentation. Verified https://core.telegram.org/bots/api#sendmessage and https://core.telegram.org/bots/api#messageentity: entities replace parse mode; offsets/lengths use UTF-16 units; `code` is a monowidth string; text allows 1–4,096 characters after entity parsing. Retain the existing conservative 4,096-unit cap; explicit entities do not add markup characters to the text.
- [x] Extend the notification contract and metadata builder with minimal body emphasis ranges. `activity-metadata.test.ts` verifies sanitized substrings for ordinary repositories, linked worktrees, detached HEAD, missing Git data, and named/unnamed Unicode sessions; focused suite passes.
- [x] Serialize bold title and body emphasis into Telegram entities after final text assembly and clipping. `provider.test.ts` verifies ranges, literal punctuation, absent parse mode, and retained transport safety; focused suite passes.
- [x] Add boundary tests for emoji before and inside spans, CJK text, combining characters, Markdown/HTML punctuation, sanitized control characters, exact length limits, partially clipped spans, removed spans, and plain notification fixtures. Provider, metadata, and menu tests pass; assertions check selected substrings, bounds, surrogate integrity, and an unformatted clipping ellipsis.
- [x] Verify the test-delivery title override and confirmation preview in menu tests. The identity-theme static render matches the real mocked Telegram request text, preserves literal punctuation, removes controls, excludes credentials, and sends only after confirmation. Assertions run after menu completion.
- [x] Update the README's formatting description and add a patch Changeset. The diff changes only formatting and clipping documentation; metadata disclosure, timing, settings, and installation claims are unchanged.
- [x] Run `npm run check` and then `npm test`; audit the selected diff for formatting, safety, preview, cancellation, session replacement, and shutdown regressions. Both gates passed; full suite: 644 files passed, 1 file skipped; 9,396 tests passed, 2 skipped. `npm run package:pack -- notify` passed; a real tarball under `/tmp/pi-notify-pack-review/` contains the 14 expected package files, including the updated transport and README. Package manifests and runtime loading are unchanged, so a local Pi loader smoke is not applicable.
- [ ] Blocked: send one confirmed test through `/notify` and inspect Telegram mobile wrapping, bold text, and inline code. No private test destination was supplied for this work, and this environment has no Telegram mobile client access. No live message was sent. Deterministic API tests do not prove client appearance; keep the PR in draft until this check passes or the user explicitly accepts the gap.

## Risks

Invalid entity offsets can cause delivery rejection or format the wrong substring. Sanitization, final-title replacement, Unicode, and clipping tests address this risk. Telegram controls the actual font and wrapping; this feature specifies emphasis, not a selectable font family or size. Live delivery requires credentials and explicit approval because it sends metadata outside the computer.

## Rollback / Recovery

If entity formatting fails validation, remove entity serialization and optional emphasis data to restore the current plain-text payload. No persisted settings or data require migration. Do not add a fallback retry that could send a duplicate message. Publication remains subject to separate explicit approval.

## Verification and Semantic Audit

- Focused verification: rebuilt Kit, then `npx vitest run packages/pi-notify/test`; all 7 files and 230 tests passed. Initial boundary fixtures had a one-unit prefix error; corrected the fixtures and reran successfully before the root gates.
- Documentation review: `docs/extension-conventions.md` and `docs/readme-conventions.md` applied; a fenced-code-aware audit passed for all 36 package READMEs. Formatting is described under Features, clipping under Limitations, and the original privacy and installation warnings remain accessible.
- Correctness and compatibility: emphasis is optional, uses body-relative UTF-16 ranges, and leaves the original title/body text and field order unchanged. Final title replacement and transport clipping are covered. Generated ranges are disjoint; bold and code do not overlap. Invalid bounds and surrogate-splitting ranges are omitted.
- Security: no parse mode, URL entities, new endpoints, credential output, or additional metadata disclosure. Sanitization precedes range creation. Redirect rejection, disabled previews, request/response bounds, safe errors, and one-attempt delivery remain covered by provider tests.
- Lifecycle and regressions: no new asynchronous flow or resource; no changes to menu, settings, coordinator, or lifecycle implementations. Existing cancellation, disposal, session replacement, shutdown, policy, and non-TUI tests passed in the full suite. Preview evidence uses an identity-theme static render; assertions are outside custom callbacks and after menu completion.
- Scope and release: no dependency, manifest, settings, prompt, tool, or loader change. Patch Changeset validated by `npm run changeset:status`; its other listed package is an existing unrelated Changeset. No package was published and no tag or release workflow was created.
- Remaining validation: live Telegram API acceptance and mobile font/wrapping appearance are unverified. Mocked requests and the existing screenshot do not satisfy this check. The plan must remain saved and the PR must remain draft pending verification or explicit acceptance of the gap.

## Review Ledger

- R1 — [Trailing whitespace in entity ranges](https://github.com/narumiruna/pi-extensions/pull/1608#discussion_r4303082131). Severity: P2. Outcome: already addressed in this revision. Before this fix, the formatter retained trailing whitespace in title, bold, and code entities, including whitespace exposed by clipping. The official [entity-length rule](https://core.telegram.org/api/entities#entity-length) says to exclude trailing whitespace and newlines from entity lengths while keeping them in later offsets. This defect is in scope because this PR adds entity formatting. Trim only each retained range, not message text. Before the fix, 14 new regression cases failed in `provider.test.ts`; they cover all styles, whitespace-only spans, later offsets, Unicode, and clipping. The fix uses `trimEnd()` on each retained range after clipping, before empty-range and surrogate checks. It leaves the text and later offsets unchanged. All 17 new cases now pass, including a real workspace path with a trailing space and ranges clipped to whitespace only. The review summary and submitted review contain no separate findings.
- Review validation: all 7 Notify test files and 247 tests passed. `npm run check` passed. `npm test` passed with 644 files passed, 1 file skipped, 9,413 tests passed, and 2 tests skipped. The full diff audit found no other occurrence: metadata ranges remain body-relative; only the Telegram formatter converts them into outbound entity lengths. Title, bold, and code ranges share the same fix. No text, preview, settings, lifecycle, retry, or security policy changed. The existing patch Changeset covers this correction.
- Existing acceptance gap: the PR is now marked ready on GitHub, but there is no new evidence of a live Telegram test or mobile appearance. This review fix does not close that open plan requirement. No separate review item was deferred, and no review item needs clarification.

## Completion Checklist

- [x] Official API requirements are recorded and all formatting/clipping tests pass.
- [x] Preview, test-title replacement, transport safety, and unchanged timing have acceptance evidence.
- [x] README and patch Changeset accurately describe the implemented behavior.
- [x] Both root gates pass and the semantic audit is recorded, including deviations and unverified paths.
- [ ] Telegram client appearance is verified, or the user explicitly accepts that validation gap.
- [ ] Handoff is complete; delete this plan only after all tasks and completion checks have evidence or an explicitly accepted disposition.
