# Named Account Protocols v1

- **Status:** Implemented process-local protocols.
- **Transport:** Pi's in-process `pi.events` bus.
- **Purpose:** Discover configured named accounts and explicitly select or restore authentication for one Pi session without importing a credential owner's package or reading its files.

These channels are not Pi `pi.on()` lifecycle events or a security boundary. `pi.events.emit(channel, request)` begins listeners synchronously and returns `void`; the `reply` callbacks below run **asynchronously** after the listener has started its work. The channel suffix carries the version, so requests do not repeat it.

## Account topology: `accounts:topology:v1`

```ts
pi.events.emit("accounts:topology:v1", {
  reply(topology) {
    // Read configured accounts; do not infer remote validity.
  },
});
```

A request needs a callable `reply`. A successful reply has this shape:

```ts
type AccountTopology = {
  providers: Array<{
    providerId: string;
    displayName: string;
    accounts: Array<{ name: string; kind: "oauth" | "api-key" }>;
    defaultAccount?: string;
  }>;
};
```

Each supported provider appears even when it has no named accounts. Names are user-defined identifiers, not credentials; treat them as untrusted display text. `defaultAccount` appears only for a configured user-wide named default, not the current session selection. The reply waits for queued writes in the responder's credential store; a read failure produces **no reply**. Inventory means configured, not remotely authenticated. This channel provides no model catalog, health, or quota information.

## Explicit activation: `accounts:activation:v1`

Emit after `session_start` for the exact session whose authentication should change:

```ts
pi.events.emit("accounts:activation:v1", {
  session: ctx.sessionManager, // exact object identity, not a session ID string
  provider: "openai",        // Pi provider ID
  account: "work",           // null restores Pi auth, not the named default
  model: "gpt-4o",           // optional account-specific availability check
  signal: controller.signal, // optional AbortSignal
  reply(result) {
    // Check status and code before dependent work.
  },
});
```

`session` must be the current `ctx.sessionManager` object. `provider` must be a nonempty string, `account` a valid exact account name or `null`, `model` (if present) a nonempty string, and `reply` callable. Malformed requests, including invalid signals, receive no reply. A well-formed request for an unmanaged provider receives `provider_unsupported`. The optional model check happens after named activation, using that account's availability; Pi's ModelRegistry remains authoritative for models in general. Restoring Pi auth does not check the optional model.

The callback receives exactly one of:

```ts
type AccountActivationResult =
  | { status: "active"; providerId: string; accountName: string }
  | { status: "inactive"; providerId: string; accountName: null }
  | {
      status: "error";
      providerId: string;
      accountName: string | null;
      code: AccountActivationErrorCode;
    };

type AccountActivationErrorCode =
  | "account_not_found"
  | "authentication_failed"
  | "store_unavailable"
  | "effective_auth_conflict"
  | "model_unavailable"
  | "activation_superseded"
  | "session_unavailable"
  | "provider_unsupported"
  | "cancelled"
  | "activation_failed";
```

`active` means the named credential was applied and its effective runtime authentication was verified, not that a remote request succeeded. `inactive` means the package-owned override was removed, not that Pi's restored credentials are valid remotely. Error replies include the requested `providerId` and `accountName` and a code, never raw provider or storage exception text.

| Error code | Meaning |
| --- | --- |
| `account_not_found` | Invalid or missing named account. |
| `authentication_failed` | Credential refresh, conversion, or default-auth restoration failed. |
| `store_unavailable` | Credential storage could not be read or the selection could not be persisted. |
| `effective_auth_conflict` | Configured runtime auth prevents the selected credential from taking effect. |
| `model_unavailable` | The optional model is not available to the selected account. |
| `activation_superseded` | A newer explicit selection changed the request's ownership. |
| `session_unavailable` | The supplied session has no current owner or was replaced or shut down. |
| `provider_unsupported` | This responder does not manage that provider. |
| `cancelled` | The request's signal was aborted. |
| `activation_failed` | Another activation failure not classified above, including a request rejected while `PI_ACCOUNT` owns the session selection. |

When `PI_ACCOUNT` is set (even to an invalid value), activation requests cannot change or restore the session selection and return `activation_failed`; topology still lists configured accounts. Unset the variable and restart Pi before requesting explicit activation. A pre-aborted request changes no selection. A valid request can persist the session selection **before** runtime activation succeeds; failure or cancellation afterward does not roll it back. Failed authentication may leave that provider fail-closed instead of falling back to another account. A newer explicit selection supersedes pending work, but a routine model/turn sync of the same selection does not. Cancelling a consumer's wait for a replacement sync does not cancel that session-owned sync. Revalidate session, account, and request ownership after every await before starting dependent work.

## Selection notification: `accounts:selection-committed:v1`

After an explicit selection is persisted for a session, the owner emits this notification:

```ts
pi.events.on("accounts:selection-committed:v1", (event) => {
  // Invalidate session-scoped data for event.providerId.
});
```

The payload contains only the exact `session` object, its `sessionId`, and `providerId`. It contains no account name or credential. The notification is deferred until the selecting flow has started its session-owned activation sync; it does not report that authentication succeeded. Consumers must match both session fields, clear account-derived data that may belong to the previous selection, and wait for [OAuth Credential Readiness v1](oauth-credential-readiness-v1.md) before resolving the new authentication. Stale or superseded selections are not published.

## Consumer safety and compatibility

Without a compatible responder, neither channel replies. Bound each wait and abort unneeded requests; a timeout is **not** proof that activation did not happen. Never start dependent work without a confirmed result. Late replies must not authorize work in a replacement session. Only one account infrastructure responder should own these channels; a first reply is not proof of exclusivity, so treat detected duplicate replies as a conflict. A callback that throws is ignored by this responder, but consumers should handle callbacks safely.

These channels expose identifiers but no credential material. They do not automatically rotate accounts, fail over, route requests, or report usage. To wait for verified OAuth auth and collect credential material, use [OAuth Credential Readiness v1](oauth-credential-readiness-v1.md) and [OAuth Credential Source v1](oauth-credential-source-v1.md). The latter deliberately offers secrets and requires provider-specific verification.

Pi extensions already share process permissions, including access to user files and memory: install only trusted extensions. Unknown channel versions have no implied compatibility. Pi removes listeners of a stale extension runtime, while the responder invalidates session-owned state on replacement and shutdown.
