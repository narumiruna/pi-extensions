# OAuth Credential Source Protocol v1

- **Status:** Implemented process-local protocol.
- **Transport:** Pi's process-local `pi.events` bus.
- **Purpose:** Let a credential consumer verify the OAuth credential that produced the active runtime authentication without depending on a credential owner's storage.

## Scope

This protocol is an anonymous, synchronous request-and-offer exchange between trusted Pi extensions in one process.

It does not identify credential owners, select or switch accounts, expose account labels, read another extension's files, synchronize credentials across processes, or authorize a credential without provider-specific verification.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Contract

The v1 channel is:

```text
oauth:credential-source:v1
```

The channel identifies the version, so the payload does not repeat it.

The v1 request is:

```ts
interface OAuthCredentialSourceRequestV1 {
	session: object;
	provider: string;
	offer: (credential: OAuthCredentialV1) => void;
}

interface OAuthCredentialV1 {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	[key: string]: unknown;
}
```

| Field | Meaning |
| --- | --- |
| `session` | The current `ctx.sessionManager` object, compared by JavaScript identity. |
| `provider` | The requested Pi provider ID, compared by exact string equality. |
| `offer` | A synchronous callback that receives one defensive credential clone. |

Unknown request properties have no protocol meaning.

A conforming request MUST NOT include an extension name, account name, account label, file path, or persistence identifier.

## Credential owner behavior

A credential owner MUST register one listener during extension factory registration.

The listener MUST be synchronous, return `void`, perform no asynchronous work, and contain no `await`.

The listener MUST use guarded property reads and ignore malformed requests without throwing.

A request is relevant only when all of these conditions hold:

1. The payload is a non-null, non-array object.
2. `session` is the exact object currently bound to the owner.
3. `provider` is a non-empty string and exactly matches the retained credential's provider.
4. `offer` is a function.
5. The retained OAuth credential successfully produced and verified the currently active runtime authentication.
6. No activation, replacement, invalidation, default-auth transition, or shutdown has made that retained state stale.

For a relevant request, the owner MUST pass a fresh defensive clone to `offer`.

The owner MUST catch an exception thrown by `offer` and MUST NOT let it interrupt sibling event listeners or runtime authentication.

The owner MUST NOT emit another credential-source event, read storage, refresh OAuth, start work, persist data, show UI, log credential material, or mutate account state while answering.

The owner MUST retain no credential before successful runtime verification and MUST clear retained credentials before beginning replacement, switching to default authentication, invalidation, failed-closed activation, session replacement, reload, or shutdown.

A stale asynchronous task MUST NOT republish an older credential after a newer task clears or replaces it.

## Credential consumer behavior

A consumer MUST create a fresh request for the current `ctx.sessionManager` and exact provider ID.

The consumer MUST collect offers synchronously during `pi.events.emit()` and MUST finish collection when `emit()` returns.

The consumer MUST catch an `emit()` failure and fail closed.

The offer callback MUST validate and defensively clone candidate objects without throwing.

Candidates are ephemeral.

A consumer MUST NOT cache, persist, log, format, display, or append offered credential material to a session entry.

A consumer MAY add Pi's stored `auth.json` OAuth credential as a standalone fallback after event collection.

The fallback has no precedence over protocol offers.

The provider-specific consumer MUST freshly resolve active runtime authentication and accept only credentials whose access token and required provider metadata exactly match it.

Equivalent matching candidates MAY be deduplicated.

If more than one non-equivalent credential matches, selection MUST fail closed and MUST NOT depend on event-listener order.

Malformed, incomplete, mismatched, unsupported-origin, or irrelevant-provider candidates MUST NOT authorize a provider request.

The consumer MUST revalidate mutable session, model, provider, account, and runtime-auth state after every `await` required by its flow and immediately before an external mutation.

## Lifecycle

Credential state is process-local and session-bound.

The owner binds the exact current `ctx.sessionManager` object on `session_start` and clears that binding on `session_shutdown` or replacement.

Pi removes tracked `pi.events` listeners when an extension runtime becomes stale, but owners MUST still clear retained credentials explicitly.

A replacement runtime starts with no retained credential and must verify active runtime authentication again before offering one.

A consumer request for a different session object receives no conforming offer even when the underlying session data is otherwise equivalent.

## Security and privacy

Pi extensions run with the user's process privileges, and `pi.events` is not a security boundary between installed extensions.

Users must install only trusted extensions.

This protocol reduces accidental coupling and disclosure; it does not sandbox a malicious extension that can already read user files and process memory.

Credential offers contain no protocol-level owner identity or account label.

Provider-specific consumers MUST send secrets only to validated official origins and MUST redact secrets from errors, reports, logs, status text, UI, and test output.

## Standalone and compatibility behavior

A credential owner remains independently functional when no consumer is installed because unanswered protocol support has no account behavior.

A consumer remains independently functional when no owner is installed by using its existing Pi `auth.json` fallback.

An absent, older, or incompatible participant degrades to the consumer's existing fail-closed authentication-unavailable behavior.

A participant MUST NOT import, name, detect, or require a specific extension package.

Production implementations remain package-local and communicate only through this protocol and Pi's public APIs.

## Guarantees

When conforming participants share one characterized Pi runtime and one session:

- A verified active OAuth credential can be offered without exposing credential-owner storage.
- A stale, pending, default, failed, replaced, or shut-down owner offers nothing.
- Exact provider and session identity isolate unrelated requests.
- Provider-specific exact runtime-auth matching prevents an unrelated credential from authorizing usage or mutation.
- Listener order cannot choose between conflicting matching credentials.
- Installing either participant alone preserves its standalone behavior.

## Non-guarantees

The protocol does not provide:

- A sandbox or security boundary between installed extensions.
- Cross-process delivery, persistence, account synchronization, discovery, or switching.
- Credential-owner identity, priority, fairness, precedence, or freshness beyond participant verification.
- Support for unknown providers, proxy endpoints, or GitHub Enterprise usage.
- Compatibility with uncharacterized Pi event-bus timing or separately loaded Pi runtimes.

## Versioning

The versioned channel MUST change for a breaking change.

Changing field meaning, callback timing, session identity, cloning requirements, conflict handling, or lifecycle invalidation is breaking.

V1 participants MUST NOT infer compatibility with an unknown channel version.

A future version may coexist on a separate channel only when its specification defines deterministic multi-version offer and conflict behavior.

## Required Pi behavior

The deterministic characterization in [`test/oauth-credential-source-runtime.test.ts`](../../test/oauth-credential-source-runtime.test.ts) covers the repository's pinned `@earendil-works/pi-coding-agent@0.84.3` runtime through public package-root APIs.

V1 depends on these Pi runtime properties:

1. Loaded extensions share one process-local event bus.
2. `pi.events.emit()` starts every registered listener synchronously before returning.
3. All extension contexts for one active session expose the same `sessionManager` object identity.
4. Stale extension runtimes unsubscribe their tracked event-bus listeners.

Only offers made before a listener first yields are visible during synchronous collection.

If a supported Pi version stops satisfying any property, participants MUST fail safe and withdraw the v1 compatibility claim until the protocol or runtime support is revised.

## Product conformance

A conforming credential owner must test successful publication, defensive cloning, pending and stale suppression, replacement, default authentication, failed activation, session replacement, shutdown, malformed requests, throwing callbacks, and stale asynchronous completion.

A conforming consumer must test no listener, fallback, one match, duplicate equivalence, conflicts in both listener orders, malformed and mismatched candidates, listener failure, exact provider metadata, official origins, redaction, cancellation, account changes after each await, replacement, and shutdown.

Cross-extension conformance must test both load orders, standalone behavior, account switching, generated entries, and absence of production imports between participants.
