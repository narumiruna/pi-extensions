# OAuth Credential Readiness Protocol v1

- **Status:** Implemented process-local protocol.
- **Transport:** Pi's in-process `pi.events` bus.
- **Purpose:** Let a trusted credential consumer wait for the current session's provider authentication sync before requesting a verified OAuth credential.

The versioned channel is `oauth:credential-readiness:v1`. The request does not repeat the version:

```ts
pi.events.emit("oauth:credential-readiness:v1", {
  session: ctx.sessionManager,
  provider: "openai",
  waitUntil(pending: Promise<unknown>) {
    // Retain and await pending before collecting credential offers.
  },
});
```

`session` is the **exact** current `ctx.sessionManager` object (not its ID string), `provider` is the Pi provider ID, and `waitUntil` is a synchronous callback. A matching owner calls `waitUntil` during `pi.events.emit()` with a promise for that provider's current session-owned sync. The promise may start a sync if none is pending and follows a newer sync that replaces an earlier task. It settles later and can reject. Invalid envelopes and requests without a matching session or provider owner get no callback.

Collect promises during `emit()`; do not await `emit()` itself because it returns `void`. If no owner responds, follow the consumer's existing standalone or fail-closed policy. Bound the wait, handle rejections privately (their text is not a credential-safe diagnostic), and revalidate session and runtime state after awaiting. The promise is **not** a credential, proof of successful authentication, or a request to switch accounts. A consumer-owned timeout does not cancel the session's shared sync.

After readiness, request an offer through [OAuth Credential Source Protocol v1](oauth-credential-source-v1.md); collect offers synchronously and verify them against freshly resolved provider authentication as that specification requires. For explicit account discovery or activation, use [Named Account Protocols v1](accounts-v1.md) instead. All channels are process-local, not cross-process coordination or a trust boundary between installed extensions.
