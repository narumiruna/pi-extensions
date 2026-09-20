# Internal standalone error reporting

`src/interaction-error.ts` shares reporting mechanics, not lifecycle policy or public API. Its callback and notification phases stay separate so runners can check mutable ownership after awaiting `onError`, before notifying, and before constructing their result. Do not pass lifecycle predicates into the reporter.

## Compatibility matrix

All seven runners call `onError(ctx, originalError)` only after their local pre-report checks. They await a provided callback, suppress fallback when it succeeds, and use the original error when it throws synchronously or rejects. Without a callback, notification does not introduce an await. A missing UI suppresses notification, not the callback. Pi's `notify()` is synchronous (`void`); a thrown notification is suppressed. Sanitization applies only to display text, never to the callback argument or typed error payload.

| Runner | Fallback eligibility after callback | Sanitizer | Exact prefix | Result after reporting |
| --- | --- | --- | --- | --- |
| Confirmation | `hasUI`, current owner, owner signal not aborted | `safeMenuText` | `Confirmation failed: ` | Recheck current owner and signal; otherwise original `error` |
| Questionnaire | `hasUI`, current owner, owner signal not aborted | `sanitizeTerminalText` | `Questionnaire failed: ` | Recheck current owner and signal; otherwise original `error` |
| Document review | `hasUI`, current owner, owner signal not aborted | `safeMenuText` | `Document review failed: ` | Recheck current owner and signal; otherwise original `error` |
| Multi-select | `hasUI`, current owner, owner signal not aborted | `safeMenuText` | `Multi-select failed: ` | Recheck current owner and signal; otherwise original `error` |
| Live choice | `hasUI`, current owner, owner signal not aborted | `safeMenuText` | `Live choice failed: ` | Recheck current owner and signal; otherwise original `error` |
| Custom interaction | `hasUI` only | `safeMenuText` | `Custom interaction failed: ` | Recheck current owner and signal; otherwise original `error` |
| Task | `hasUI` only | `safeMenuText` | `Task failed: ` | Execution failure rechecks owner, signal, external disposal, and user cancellation; custom-UI failure rechecks owner and signal |

These differences are intentional compatibility constraints. In particular, custom interaction and task may notify after ownership changes during a failed callback, then return `stale`; do not normalize them to the other five runners. A task cancelled by the user during reporting returns `cancelled` unless owner staleness takes precedence.

`safeMenuText` replaces C0/C1 controls, collapses whitespace, and trims; it leaves printable escape-sequence remnants and bidirectional characters. `sanitizeTerminalText` removes complete or unterminated escape sequences and bidirectional controls, replaces line separators, and retains other printable whitespace. Keep these existing display policies distinct.

## Lifecycle boundary

The five dialog runners guard error reporting before and after its await. In TUI mode they delegate disposal and pending-work draining to custom interaction, while providing their own reporting callback. Custom interaction aborts and disposes its component, drains pending work, then checks stale ownership before reporting. Task separately owns user cancellation, external disposal, work draining, and custom-UI failures. Session replacement and shutdown are represented by the caller's owner signal or `isCurrent()` predicate; the reporter owns no session, component, timer, listener, or background task.

## Verification

The baseline seven interaction suites passed 93 tests before extraction. `test/interaction-error.test.ts` covers shared reporting mechanics, and `test/interaction-error-routing.test.ts` locks the matrix through public runners. The original interaction suites cover Back/Close, remapped keys, non-interactive modes, rendering, editor/paste behavior, aborts, disposal, and pending-work draining. The human-operated terminal smoke remains documented in [the API reference](api.md#-supported-testing-entrypoint).
