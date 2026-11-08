# Extension status metadata v1

This optional protocol supplies semantic activity for compact footer rendering. Publishers keep their readable `ctx.ui.setStatus(key, value)` output. Consumers choose presentation without parsing another extension's private messages. A missing publisher or consumer does not change extension behavior.

The protocol uses Pi's public `pi.events` bus. It does not authorize work, change settings, carry model context, or provide a security boundary between installed extensions.

## Channels and payloads

`extension-status:v1:update` carries an update or withdrawal:

```ts
interface StatusUpdateV1 {
  version: 1;
  sessionManager: object;
  key: string;
  value: string | undefined;
  activity?:
    | "idle"
    | "checking"
    | "working"
    | "pushing"
    | "pulling"
    | "resolving"
    | "retry"
    | "blocked"
    | "local-change"
    | "remote-change"
    | "review";
  reason?: string;
  requestId?: object;
}
```

`sessionManager` is the public context's object identity, used only as a local session key. Do not inspect or serialize it. `key` is the exact nonempty raw status key, not an installed-package alias. For a presentation update, `value` is the exact nonempty raw value supplied to `setStatus()`. It must match the current raw status before the metadata is used.

The `value` property must be present. An explicit `undefined` withdraws metadata for the key; it does not clear or otherwise change Pi's raw status. A withdrawal omits `activity` and `reason`. A publisher clearing raw status must also withdraw its metadata. An unannotated raw value withdraws previous metadata rather than inheriting a previous activity.

An activity is required for a presentation update. `retry` and `blocked` also require the entire reason string to match `[a-z][a-z0-9-]{0,31}`. A trailing line terminator or any other control is invalid; a JavaScript `$` regex test alone is not a full-string check. Other activities omit a reason. Reasons are safe plain labels, not provider errors, file content, credentials, or free-form diagnostic messages. A consumer must not infer a diagnosis from unrecognized data.

`extension-status:v1:request` asks for a read-only snapshot:

```ts
interface StatusRequestV1 {
  version: 1;
  sessionManager: object;
  requestId: object;
}
```

Top-level payloads must be non-array objects. An opaque identity must be a non-null value with `typeof value === "object"`; arrays and class instances are valid identities, while functions and primitives are not. The requester creates a new opaque `requestId` object for its current session/render generation. A publisher responds on the update channel with its current metadata or withdrawal and the same request object. Requests never start a transfer, inspection, model call, timer, or settings read. Publishers respond only for an identity-equal session manager they currently own.

Normal live updates omit `requestId`. Snapshot replies include it. A consumer accepts replies only for its current request object and rejects replies for a key that received a live update or withdrawal after the request. A delayed snapshot must not replace a newer activity, review, or clear even if the raw text happens to match.

## Publication and lifecycle

Publish raw text first, then metadata. Use synchronous handlers without awaiting a response. Pi's public bus starts handlers synchronously, does not await asynchronous handlers, and returns an unsubscribe function from `on()`. Consumers cannot require a particular listener order.

Register session-owned listeners at session start or first use. Release or replace them on session replacement, shutdown, reload, and failed initialization. Scope resources by `sessionManager`, not `ctx.ui`; headless runners can share a no-op UI object. Do not retain a replaced context or create background work for metadata delivery.

Publishers keep only their current presentation and isolate metadata-delivery failures from domain work. Capture request fields once and revalidate ownership after validation. Reserve first-use binding before cleanup callbacks and revalidate ownership after every release callback. Retire local ownership before optional cleanup or withdrawal callbacks; only an explicit lifecycle start can reactivate a released publisher. An older activation must not replace a newer binding or receive its cleanup function. Show/hide preferences owned by a publisher apply to both raw publication and metadata. Re-enabling does not restore stale metadata before a new valid update.

Consumers request a snapshot after subscribing and use existing render invalidation for later updates. Clear consumer state on footer disposal or session replacement. Reconcile cached records against the current raw status map so cleared or replaced values cannot reuse stale metadata. Raw status-key collisions retain Pi's existing last-writer behavior; the protocol does not establish package ownership or authentication. Pi exposes no raw-status change hook: a nonparticipant's clear-and-replace with the same value between observations cannot be detected. Participating publishers must therefore send a withdrawal or new metadata for every raw change.

## Validation and fallback

Accept only version 1, an identity-equal current session manager, an exact raw key, supported activity, valid reason, and a matching raw value. A reply must also pass current-request and newer-live-update checks. Check fields without mutating the supplied payload.

Field access and raw-map reads can run callbacks synchronously. Capture public fields once, then revalidate the current key's accepted update and disposal state before changing the cache. Read the current raw map after field validation. A newer same-key event, withdrawal, observed raw replacement, or disposal must prevent an older handler from setting or deleting records, including through error paths. Ignored packets and unrelated keys must not cancel a valid update. An unstable raw-map read must not retain an older hidden presentation or erase another key's metadata.

For a matching current-session key, invalid or unsupported live metadata withdraws a prior compact presentation so the raw value remains visible. Invalid snapshots must not erase a newer live presentation. Ignore data that cannot identify a current-session key. Unknown versions and absent participants use the existing raw-text path, not hidden status.

Sanitize terminal input at the display boundary without changing raw keys, values, or identity comparisons. Do not use metadata to invoke commands, write settings, or change model-visible state. Consumers must remain extension-neutral; no extension-name branches, private error imports, or private-message matching are permitted.

## Quiet presentation

Pi Statusline applies these defaults to valid participants. The feature identifier uses the existing configured icon precedence, including an empty icon override. Activities are static markers; the protocol does not supply glyphs or hide instructions.

| Activity | Compact body |
| --- | --- |
| `idle` | Hidden |
| `checking` | `…` |
| `working` | `↻` |
| `pushing` / `pulling` | `↑` / `↓` |
| `resolving` | `AI` |
| `retry` | `retry: <reason>` |
| `blocked` | `! <reason>` |
| `local-change` / `remote-change` | `⇡` / `⇣` |
| `review` | `⇕` |

Filter hidden entries before applying the footer's visible-item limit and separators. Retrying and blocked activities retain their reason and an appropriate warning role. A compact view must not erase another current activity or review merely because a sibling publisher is idle.

Other footers and RPC observers continue to receive the readable raw value. This display protocol does not change retry policy, request limits, transfer authorization, or recovery requirements.
