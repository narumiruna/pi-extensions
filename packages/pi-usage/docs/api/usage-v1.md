# Read-only usage API v1

**Status: Implemented.** This document defines the process-local `pi.events` protocol for reading provider usage. `pi-usage` registers these channels but does not export a client helper.

A consumer can read a cached report, request a read-only refresh, inspect provider capabilities, and receive invalidation notifications. Consumers do not need to import or depend on the `pi-usage` extension.

## Scope

Usage means provider allowance, balance, or spend, not Pi session token totals, session cost, or context-window usage. Different providers, currencies, quota windows, and billing targets must remain separate.

The protocol does not change settings, select accounts or billing targets, enable Fast mode, redeem resets, or make other provider mutations. It does not expose credentials, raw provider responses, or internal cache keys. Refresh permits provider read requests and normal Pi-owned authentication refresh; it does not authorize a change of account or authentication policy.

The channel names are extension-neutral. Any service can implement this contract without identifying another extension or depending on its private state. An absent service must not prevent either extension from operating independently.

## Channels

| Channel | Direction | Purpose |
| --- | --- | --- |
| `usage:query:v1` | Consumer to service | Read one provider report, with optional refresh |
| `usage:capabilities:v1` | Consumer to service | Read support information without network requests |
| `usage:changed:v1` | Service to consumers | Notify consumers that a previous result may no longer apply |

These channels use Pi's public `pi.events.on()` and `pi.events.emit()` APIs. They are not slash commands, model tools, RPC methods, or an HTTP API. They work without a UI in TUI, RPC, JSON, and print sessions.

## Shared types

The terms **must**, **should**, and **may** state requirements, recommendations, and permitted behavior. The definitions below specify the protocol, not package exports. A consumer can declare these structural types locally. A future shared client library must be a reusable library, not a dependency on an extension entrypoint.

```typescript
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type UsageScopeV1 = {
  session: ExtensionContext["sessionManager"];
  sessionId: string;
};

type UsageRequestV1<T> = UsageScopeV1 & {
  providerId?: string;
  signal: AbortSignal;
  respond(result: T | Promise<T>): boolean;
};

type UsageUnavailableReasonV1 =
  | "not-ready"
  | "no-model"
  | "unsupported"
  | "auth-unavailable"
  | "selection-required"
  | "cache-miss"
  | "query-failed"
  | "cancelled"
  | "timeout"
  | "stale-context";

type UsageUnavailableV1 = {
  status: "unavailable";
  providerId?: string;
  reason: UsageUnavailableReasonV1;
  message?: string;
};
```

`session` is the exact `ctx.sessionManager` object, not `ctx.ui`. `sessionId` is the value of `ctx.sessionManager.getSessionId()` at dispatch. Both must match the service's active session. The ID is also required because a session manager can switch sessions without changing object identity.

`providerId` is a Pi provider ID, such as `openai-codex`, not a display name or model ID. If omitted, the service captures the current model's provider when it accepts the request. An explicit ID selects that provider's current configured runtime auth, not a different named account. Each request addresses one provider and its existing selected billing target; there is no all-provider or target-selection operation.

The service must validate incoming `unknown` payloads before using them. It must ignore malformed payloads and requests for another session. A matching, valid request received before initialization completes returns `not-ready`.

## Request and response transport

Pi's `emit()` returns `void`. It does not await asynchronous handlers or return their results. Both request channels therefore use a synchronous response offer that can contain a promise:

1. The consumer creates a fresh request and an abort signal with a deadline, then calls `emit()`.
2. A matching service calls `respond(result)` exactly once, **before its event handler first awaits**. For asynchronous work, it offers the pending promise immediately.
3. `respond()` accepts only the first offer during that synchronous dispatch and returns `true` for it. It returns `false` for later offers or calls made after `emit()` returns.
4. After dispatch, the consumer closes the offer window. With no accepted offer, it returns a local `no-service` outcome immediately. This means no matching v1 service answered, not proof that a particular package is uninstalled.
5. With an accepted offer, the consumer waits for its value, bounded by cancellation and its own deadline. The service must settle within 15 seconds of acceptance, including authentication and target validation. An expired deadline returns `timeout`; caller cancellation returns `cancelled`.

Only one service should own these channels for a session. Consumers must not merge multiple offers. A service whose offer is rejected must release work it started only for that request. Consumers must observe rejections from ignored promises to prevent unhandled rejections.

Services must resolve expected failures as typed results, not throw them through the event bus. A consumer must handle an unexpected rejection or malformed result as a local `protocol-error`. `no-service` and `protocol-error` are client outcomes, not service response variants. Human-readable `message` text is not a machine-readable discriminator.

If the signal is already aborted, the consumer must return `cancelled` without dispatch. A consumer deadline must abort the request signal, not only stop waiting. The consumer must stop waiting promptly on abort, ignore late completion, and remove abort listeners and deadline timers on every exit path. The service must propagate cancellation to owned work. When work is shared, cancelling one waiter must not cancel work still needed by other waiters; the underlying task must be released when it has no remaining owners.

The service offers the promise during dispatch, but the provider result arrives later:

```mermaid
sequenceDiagram
    participant C as Consumer
    participant B as pi.events
    participant S as Usage service
    C->>B: emit usage:query:v1
    B->>S: Dispatch request
    alt Matching service
        S->>C: respond(pending promise)
        B-->>C: emit returns
        alt Query completes
            S-->>C: Resolve ready or unavailable
        else Abort, deadline, or session change
            S-->>C: Resolve unavailable; release owned work
            Note over C: Ignore late results
        end
    else No matching service
        B-->>C: emit returns without an offer
        Note over C: Return local no-service
    end
```

## Query: `usage:query:v1`

```typescript
type UsageQueryRequestV1 = UsageRequestV1<UsageQueryResultV1> & {
  refresh?: boolean; // Default: false
};

type UsageQueryResultV1 =
  | {
      status: "ready";
      providerId: string;
      source: "cache" | "refresh";
      expiresAt: number;
      report: UsageReportV1;
    }
  | UsageUnavailableV1;

type UsageReportV1 = {
  providerId: string;
  providerName: string;
  capturedAt: number;
  source: string;
  semantics: {
    kind: "consumer-subscription" | "api-key" | "project";
    label: string;
  };
  accountLabel?: string;
  buckets: UsageBucketV1[];
  metrics: UsageMetricV1[];
  notes?: string[];
};

type UsageUnitV1 = "percent" | "usd" | "currency" | "count";

type UsageBucketV1 = {
  id: string;
  label: string;
  groupId?: string;
  groupLabel?: string;
  modelKeys?: string[];
  used?: number;
  remaining?: number;
  limit?: number;
  unit: UsageUnitV1;
  period?: string;
  windowMinutes?: number;
  resetsAt?: number;
};

type UsageMetricV1 = {
  id: string;
  label: string;
  value: number | string;
  unit?: UsageUnitV1;
  currency?: string;
};
```

`UsageReportV1` follows the normalized report fields from `src/types.ts`, without importing that internal module. All protocol timestamps are Unix epoch milliseconds. Internal bucket reset times use seconds; the API converts `resetsAt` to milliseconds on a detached copy. Numeric measurements must be finite. Omitted measurements mean unknown, not zero; an absent limit must not be interpreted as unlimited. Currency codes belong to individual metrics. Consumers must preserve provider semantics and must not combine unrelated buckets or infer token totals from percentages.

The outer `source` states how the request was satisfied. `report.source` identifies the provider data source. `providerId` must agree with `report.providerId` and the accepted provider. `capturedAt` is the local report capture time, not a guarantee that the provider's accounting is current. `expiresAt` is the service's cache validity deadline, not a quota reset time. A result is no longer fresh when `Date.now() >= expiresAt`.

### Cache reads

**Current compatibility:** cache-only queries return `cache-miss` for all supported providers, even after a successful refresh. Pi does not expose a network-free proof of the full effective runtime auth identity. Use `refresh: true` to obtain a report; see the [auth identity audit](./auth-identity.md) for the branch matrix and capability measurements.

With `refresh` absent or `false`, the service must not issue network requests, including authentication refresh or target discovery. It may use local runtime-auth information to validate an existing cache entry. If it cannot establish the current identity without network work, or if the matching entry is absent or expired, it returns `cache-miss`, without starting a refresh.

A cached report must match the active session, provider, credential identity, effective origin, selected target, and relevant policy. The service must not fall back to another identity's report. A ready result contains an unexpired detached copy; consumer mutation must not change the service cache. No stale-report fallback is included in v1.

### Refresh

With `refresh: true`, the service revalidates runtime auth and the selected target through its existing guarded read-only query path. It must not satisfy the request with an older cached report. It may join an in-flight query only when that query has the same validated identity and policy. Ready results use `source: "refresh"`.

An API refresh waits for already-running status and menu queries for the same provider before starting its own guarded read. It does not reuse their reports or cancel their work. Waiting uses the original 15-second API deadline; cancellation stops only the API waiter. Queries for other providers do not block it. A newer presentation query can still supersede API work so the user-facing flow retains ownership.

Refresh respects provider support, explicit opt-ins, request limits, and failure backoff. It cannot enable an experimental source or bypass authentication and origin checks. If a target needs user selection, it returns `selection-required`; it must not open UI, persist a choice, or query every visible target. A failed refresh returns `query-failed`, not an older ready report.

The API must not change the statusline, open menus, send notifications, append session messages, or activate tools. A successful refresh may update the shared in-memory cache and emit `usage:changed:v1`.

### Unavailable reasons

| Reason | Meaning |
| --- | --- |
| `not-ready` | The matching service has not completed session initialization |
| `no-model` | No provider was specified and no model is selected |
| `unsupported` | The selected provider or auth mode has no supported report source |
| `auth-unavailable` | Current runtime auth cannot safely authorize the read |
| `selection-required` | A billing target must be selected outside this API |
| `cache-miss` | No unexpired report can be safely returned without network work |
| `query-failed` | Refresh failed or an existing failure backoff prevents a request |
| `cancelled` | The caller aborted the request |
| `timeout` | The service or consumer deadline expired |
| `stale-context` | Session, model, auth, target, or relevant policy changed during the request |

After provider selection, unavailable results must include `providerId`. It may be absent for `no-model` or a failure before provider selection. Diagnostic messages must redact secrets and must not include raw response bodies.

## Capabilities: `usage:capabilities:v1`

```typescript
type UsageCapabilitiesRequestV1 = UsageRequestV1<UsageCapabilitiesResultV1>;

type UsageCapabilitiesResultV1 =
  | {
      status: "ready";
      providerId: string;
      supported: boolean;
      measurements: Array<"quota" | "balance" | "spend" | "reset-time">;
      supportsRefresh: boolean;
    }
  | UsageUnavailableV1;
```

This request uses the same provider selection and response-offer rules as query. It must not issue network requests, resolve secrets, discover targets, or change state. It reports the implementation's potential capabilities for that provider, not current account entitlement or data availability.

An unknown provider returns `status: "ready"`, `supported: false`, `measurements: []`, and `supportsRefresh: false`. A supported provider can still return `auth-unavailable`, `selection-required`, or another unavailable result from a later query. Measurements list possible normalized fields; a specific account or response can omit them. Provider support does not imply numerical reporting for every auth mode or that an optional source is enabled.

`no-model`, `not-ready`, cancellation, timeout, and stale context use the shared unavailable envelope. An absent service remains the client's distinct `no-service` outcome.

## Notifications: `usage:changed:v1`

```typescript
type UsageChangedV1 = UsageScopeV1 & {
  providerId: string;
  changedAt: number;
  reason: "updated" | "invalidated" | "query-failed";
};
```

This is an invalidation hint, not a report or an instruction to refresh. `updated` means a validated report was published to the cache. `invalidated` means previously observed data may no longer apply, including expiry or an observed identity, target, policy, model, or session change. `query-failed` means a refresh failed, whether or not an older cache entry remains valid under the service's existing policy.

The service must publish the cache update or invalidation before emitting the notification. It must notify for affected previously exposed providers when it observes invalidation, including session shutdown, and must not publish a late update from an obsolete request. An invalidation caused by session replacement carries the old session scope so its consumers can clear old data. `changedAt` records local observation time; it is not an ordering token or an account identifier.

Events carry no quota payload, credential fingerprint, or account label. Consumers filter by session object, session ID, and provider, discard obsolete displayed results, and can issue a cache-only query. They must not refresh automatically on every notification: that would create a refresh-notification loop. A cache read must not emit `changed` merely because it was read.

Notifications have no replay or delivery guarantee. Subscribe before the initial query to reduce missed-update races. If a notification arrives during a query, mark that query obsolete and query the cache again after it settles. Consumers must also expire their local view at `expiresAt` and clear it on their own session or model changes. Pi does not expose every account change immediately; notifications occur only when the service observes a change.

## Bounded consumer example

Place this transport function in the consuming extension. It returns `unknown` deliberately: validate the result against the types above before using it. Keep unknown fields compatible, reject invalid required fields and non-finite measurements, and sanitize strings only at the terminal display boundary. The independently tested client fixture covers these validation rules; no client helper is exported by this package.

Call from `session_start` or later. The caller must abort on disposal, session or model change, and request supersession, then revalidate its own generation after awaiting. The function also checks the captured session ID and model snapshot. Use cache-only queries, not automatic refreshes, when processing `changed` hints.

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function readCurrentUsage(
  pi: Pick<ExtensionAPI, "events">,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<unknown> {
  const session = ctx.sessionManager;
  const sessionId = session.getSessionId();
  const model = JSON.stringify(ctx.model);
  const unavailable = (reason: string) => ({ status: "unavailable", reason });
  if (signal.aborted) return Promise.resolve(unavailable("cancelled"));
  return new Promise((resolve) => {
    const controller = new AbortController();
    let open = true;
    let offered = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: unknown) => {
      if (done) return;
      done = true;
      open = false;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(result);
      controller.abort();
    };
    const cancel = () => finish(unavailable("cancelled"));
    timer = setTimeout(() => finish(unavailable("timeout")), 15_000);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      pi.events.emit("usage:query:v1", {
        session, sessionId, refresh: true, signal: controller.signal,
        respond(result: unknown) {
          const accepted = open && !offered && !done;
          if (accepted) offered = true;
          // Observe rejected promises even when the offer is late or duplicated.
          void Promise.resolve(result).then((value) => {
            if (!accepted || done) return;
            try {
              const current = ctx.sessionManager === session && session.getSessionId() === sessionId &&
                JSON.stringify(ctx.model) === model;
              finish(current ? value : unavailable("stale-context"));
            } catch { finish(unavailable("stale-context")); }
          }, () => {
            if (accepted && !done) finish(unavailable("protocol-error"));
          });
          return accepted;
        },
      });
    } catch { finish(unavailable("protocol-error")); }
    finally { open = false; }
    if (!offered) finish(unavailable("no-service"));
  });
}
```

## Lifecycle and safety

Register event handlers in the extension factory, but start session-owned work only after `session_start`. Consumers must issue requests from `session_start` or later and tolerate `not-ready` when extension initialization order differs. Event subscriptions alone must not start polling or network work. On shutdown or reload, release subscriptions, deadlines, abort listeners, and owned tasks. Consumer UI disposal must cancel its pending requests.

For every request, the service must capture session object, session ID, session generation, selected model, and relevant auth, target, and policy identity. After each await and before publishing a report or notification, it must revalidate anything that could have changed. A mismatch must return `stale-context` and must not repopulate an invalidated cache. The consumer must also revalidate its session, selected provider, and request generation after awaiting a result.

Read-only API traffic must not modify model-visible prompts, messages, tool definitions, or active tool selection. Automatic authentication maintenance remains owned by Pi. Provider routing, warning thresholds, model switching, and other consumer decisions remain outside this protocol.

The event bus is not a security boundary: installed extensions share process privileges. Services must still validate payloads, redact errors, and return detached plain report data. Consumers must validate result shapes and sanitize untrusted strings before terminal display without changing the raw report.

## Compatibility and implementation verification

The `v1` suffix versions the protocol independently of the npm package. Compatible additions may add optional fields; consumers must ignore unknown fields. Removing fields, changing their meaning, adding required request fields, or expanding closed discriminator unions requires a new channel version. New provider IDs and report bucket or metric IDs do not require a new version.

The implementation verifies these cases with deterministic tests:

- No service, initialization order, unknown provider, no model, malformed payload, duplicate offers, and unexpected promise rejection.
- Cache hit, expired or missing cache, locally unverifiable auth, and no network calls during cache or capability reads.
- Successful refresh, auth failure, target selection, failure backoff, and no stale fallback after failure.
- Caller cancellation, deadlines, consumer disposal, shared-request cancellation, and cleanup after reload or shutdown.
- Session replacement with the same manager object, model change, auth change, target change, and policy change during each asynchronous phase.
- Notification publication order, old-session invalidation, query-notification races, missed events, expiry, and prevention of refresh loops.
- Detached report data, error redaction, non-interactive operation, and unchanged model-visible context and tools.

Named verification coverage lives under `packages/pi-usage/test/`:

| Test file | Evidence |
| --- | --- |
| `usage-api.test.ts` | Payload validation, capabilities, synchronous offers, scoped lifecycle, deadlines, notifications, and report projection |
| `core.test.ts` | Exact cache expiry, bounded storage, metadata, post-mutation notifications, and synchronous reentry |
| `usage-api-runtime.test.ts` | Guarded refresh, backoff, no-network cache reads, opt-in preservation, target selection rejection, settings ordering, and all four modes |
| `usage-api-lifecycle.test.ts` | Cancellation and session/model/auth/target/policy replacement across asynchronous phases |
| `usage-api-ownership.test.ts` | Obsolete auth/discovery/transport cannot erase successor reports or backoff; serialized API reads preserve presentation failures and backoff; internal guard errors preserve stale-context; unsupported exposure stays bounded |
| `usage-api-presentation.test.ts` | API waits preserve status polling and menus, remain provider-scoped, retain the original deadline, and release correctly across cancellation, recursive auth retry, and session replacement |
| `usage-client.test.ts` | Independent structural consumer, malformed responses, absent service, notification races, local expiry, and disposal |
| `usage-api-example.test.ts` | The bounded example above is compiled and executed, including deadline cleanup |
| `usage-api-prefix.test.ts` | Consecutive real Pi requests preserve the normalized model-visible prefix and ordered tool definitions |
| `build-runtime.test.ts` | Generated-runtime loading through Pi's Jiti loader, first-use companion boundaries through API refresh, millisecond reset projection, and cleanup |

Repository verification also includes `npm run check`, `npm test`, package content inspection, and a non-interactive package-directory load. A load smoke alone does not establish request correctness.

Live provider accounting delay, entitlement, and agreement with an account's web console are not established by deterministic tests. An account owner must prepare an authenticated local setup and approve provider traffic before an optional live comparison; credentials must not be supplied in chat. No package publication or release action is part of this API verification.
