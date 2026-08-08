# Edge-case checklist

Use this as a prompt library, not a requirement to test every item. Select domains supported by the change.

## Inputs and representation

- Empty, singleton, maximum-size, malformed, duplicate, unsorted, missing, null, undefined, NaN, wrong-type, and partially valid input
- Leading/trailing whitespace, blank lines, mixed newline forms, and embedded NUL/control bytes
- Equivalent delimiter forms, nesting, escaping, quoting, casing, and normalization
- UTF-8 byte limits versus code units, code points, grapheme clusters, and display cells
- Combining marks, variation selectors, emoji modifiers, ZWJ sequences, CJK, and invalid byte sequences
- Lossy parse/serialize/parse or normalize/store/read round trips

## Ranges and collections

- Start/end boundaries, reversed endpoints, zero-length ranges, and one-past-the-end positions
- Cross-line or cross-record selections, especially an endpoint at the next item's start
- Inclusive versus half-open semantics and separators that belong between items
- Overflow, underflow, divide-by-zero, precision loss, and invalid numeric conversions
- Empty collections, duplicate identities, unstable ordering, and mutation during iteration
- Clamping after the underlying collection shrinks or changes

## State and UI

- Every action in initial, active, completed, failed, and cancelled states
- Back versus close, cancel versus confirm, retry versus duplicate submission
- Mode switches with an existing selection, draft, cursor, or pending operation
- Configured keybindings, focus ownership, narrow viewports, resize, and scroll anchoring
- Raw source position versus wrapped rows; cursor visibility by terminal-cell width
- Preservation of drafts, expanded paste content, and edits made while dialogs are open

## Async and lifecycle

- Cancellation before start, while waiting, after side effects, and during cleanup
- State captured before `await` and changed before continuation resumes
- Concurrent updates, lost writes, duplicate callbacks, retries, reconnects, disconnects, and out-of-order completion
- Session, component, request, or generation replacement while work is in flight
- Teardown after partial initialization and cleanup when one disposer fails
- Timeouts where descendants, file handles, sockets, locks, transactions, subscriptions, or inherited streams outlive their owner
- Memory or retained-state growth across retries, replacements, and long-lived sessions

## Files, processes, network, and trust boundaries

- HTTP, WebSocket, CLI, file, environment, database, and external-API inputs validated at the boundary
- Authentication, authorization, tenant ownership, unsafe deserialization, and sensitive logging
- Absolute paths, `..`, symlink escapes/swaps, broken links, and containment after realpath
- File identity changes between validation and use; bounded reads and partial writes
- Argument boundaries, shell expansion, environment/config helpers, and terminal injection
- Partial protocol messages, malformed success responses, truncation, and retry classification
- Idempotency when a response is lost; only settled work may be evicted from deduplication state
- Secret redaction in errors, logs, diagnostics, and persisted state

## Time, consistency, and compatibility

- Time zones, DST transitions, clock skew, expiry boundaries, and wall-clock versus monotonic time
- Ordering assumptions, eventual consistency, stale reads, and partial failure across stores or services
- Response-shape and schema evolution, backward compatibility, and mixed-version readers or writers
- Packaging, runtime, platform, architecture, and configuration mismatches

## Framing and trust boundaries

- User-controlled opening and closing delimiters, including whitespace and nested variants
- Content crossing from display-only text into prompts, markup, terminals, shells, or URLs
- Escaping at the final sink rather than assuming an earlier representation remains safe
- Role, provenance, and trust labels preserved through concatenation and serialization
- Untrusted content unable to terminate, reopen, or append outside its intended frame

## Test quality

- Regression fails on the unfixed code for the claimed reason
- Assertion captures the contract rather than the current implementation shape
- Both directions or symmetric boundaries are covered where behavior is directional
- Representative Unicode and control cases are literal enough to explain the invariant
- Deterministic tests replace timing guesses; concurrency tests control ordering explicitly
- A nearby equivalent variant would not bypass the fix
