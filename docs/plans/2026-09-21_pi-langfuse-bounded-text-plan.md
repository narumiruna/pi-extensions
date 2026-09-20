# Share pi-langfuse bounded-text truncation

## Goal

Use one package-internal UTF-8 byte-bounded truncation implementation for sanitized content and allowlisted response headers without changing suffixes, byte limits, Unicode handling, metadata, or redaction.

## Context

`packages/pi-langfuse/src/sanitizer.ts` and `packages/pi-langfuse/src/tracing.ts` contain the same `truncateString` and UTF-8 byte-length logic. Sanitization uses one copy for bounded content; response metadata uses the other for allowlisted header values.

The implementations represent the same concept and should evolve together, but redaction policy and response-header allowlisting remain distinct responsibilities.

## Non-Goals

- Do not merge sanitization and tracing modules.
- Do not change redaction, base64 data-URI omission, collection budgets, header allowlists, or metadata keys.
- Do not create a cross-package text utility.
- Do not change the `… [truncated]` suffix or existing small-budget behavior.

## Risks

- Unicode code-unit or code-point changes can alter byte boundaries.
- Reordering truncation and redaction can leak sensitive content or change telemetry.
- Header tests currently prove allowlisting but need explicit multibyte truncation coverage.

## Plan

- [ ] Run sanitizer and recorder tests and capture baseline outputs for ASCII, multibyte Unicode, values below and above the byte limit, very small limits, base64 data URIs, and allowlisted response headers.
- [ ] Add one focused package-internal bounded-text module containing the exact current suffix, prefix bound, code-point iteration, and `Buffer.byteLength(..., "utf8")` behavior.
- [ ] Replace the duplicate sanitizer helper with the internal module while preserving redaction and budget ordering.
- [ ] Replace the duplicate tracing helper with the internal module while preserving header normalization, allowlisting, metadata keys, and maximum header value length.
- [ ] Add focused tests proving multibyte response headers are truncated to the same byte boundary and suffix as sanitized strings, while disallowed and sensitive headers remain absent.
- [ ] Audit the diff for secret redaction, bounded work, hostile input, terminal-independent metadata, and unchanged provider-response recording.
- [ ] Run `npx vitest run packages/pi-langfuse/test/sanitizer.test.ts packages/pi-langfuse/test/recorder.test.ts packages/pi-langfuse/test/runtime.test.ts packages/pi-langfuse/test/extension.test.ts`.
- [ ] Build pi-langfuse, run `npm run check` and plain `npm test`, and verify no tracked generated output differs unexpectedly.
- [ ] Smoke pi-langfuse through Pi's Jiti loader without making a live provider request and record focused tests, build, and loader evidence in the handoff.

## Rollback / Recovery

No user data or public API is migrated. If any byte boundary, suffix, redaction order, allowlist behavior, or metadata output differs, restore both local helper copies before removing the shared module.

## Completion Checklist

- [ ] One package-internal helper owns UTF-8 byte-bounded truncation.
- [ ] Sanitization and tracing retain separate redaction and metadata policy.
- [ ] Existing and multibyte outputs match the baseline exactly.
- [ ] Sensitive or disallowed headers remain absent.
- [ ] Focused tests, package build, root checks, tests, and Pi loader smoke pass.
- [ ] No public API, dependency, or unrelated file changed.
