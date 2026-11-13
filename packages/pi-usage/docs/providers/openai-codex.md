# OpenAI Codex

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `openai-codex` (legacy; not an alias for native `openai`)
- Semantics: ChatGPT consumer subscription limits
- Source: the Codex usage and earned-reset endpoints using Pi's resolved runtime authorization
- Displayed data: returned duration-based windows, resets, credits, earned usage-limit resets, and additional model buckets
- Reset mutation: `POST /wham/rate-limit-reset-credits/consume` with a unique redemption request ID and, when available, the selected opaque credit ID
- Statusline examples: `codex 59% ↻ 2h30m · 61% ↻ 2d15m`, `codex fast 59% ↻ 2h30m`, or `codex spark 100% ↻ 2h30m`

The statusline selects a returned bucket that matches the current Codex model when one is available.
`pi-usage` has no Codex CLI fallback because the CLI may be logged into a different account than Pi's active runtime account.
The provider-owned reset endpoints may change without notice.

## Included allowance evidence

The [read-only usage API](../api/usage-v1.md#optional-included-allowance-evidence) can attach optional evidence for the base ordinary included allowance. The initial exact scope is **`openai-codex` / `gpt-5.6-sol`**, using `openai-codex-responses` at the official `https://chatgpt.com` origin. This is an included-allowance measurement, not proof that a request will fail. Purchased credits or paid usage can remain available. The usage API never enables billing or chooses an account.

A runtime-bound report requires Pi's resolved `apiKey` to contain a valid ChatGPT account claim and its usage bearer header to be the exact same token. The official usage GET then receives the same account header derived from that token. The token, account ID, fingerprint, and any named-account association remain private. A compatible consumer must verify its own effective authentication and selection generation before and after the fresh query. A JWT claim alone is not a stored-account identity proof; the successful guarded read binds the usage response to the same runtime token and account as inference.

Only valid, unexpired root `rate_limit.primary_window` and `secondary_window` percentage constraints enter `allowance.bucketIds`. Their internal reset seconds become API milliseconds. An explicit `null` window means no constraint; an omitted or malformed window makes coverage partial. A numeric string or an out-of-range, contradictory, non-finite, or expired value remains display-only. Unrecognized root constraint fields also prevent complete coverage. An absent, null, or empty `additional_rate_limits` contributes no additional constraint; any nonempty or malformed additional group makes coverage partial. Additional groups remain displayable but are never treated as exact model evidence from `metered_feature`, `limit_name`, or `modelKeys`.

| Path or response | Evidence behavior |
| --- | --- |
| Exact model/API, official model and effective auth origins, same token, valid account claim | Runtime-bound ordinary included allowance |
| Both root windows explicitly valid or null, at least one valid window, no unproven additional constraints | Complete coverage |
| A valid root window plus missing, malformed, expired, or unproven constraints | Partial coverage; not evidence of adequate allowance |
| Credits only, no valid root window, other models, `gpt-reserve`, other APIs, non-JWT keys, or mismatched/ambiguous auth headers | No allowance metadata; existing display behavior remains |
| Custom/proxy origin | Existing official-endpoint auth rejection remains; no additional network path |
| Native `openai` companion source | Unbound when metadata is valid; otherwise metadata is omitted without changing the report; never authorizes an account decision |

The exact model list is intentionally narrow. It does not cover all installed Codex models, model aliases, Reserve, or opaque additional metered features. Normal statusline matching is unchanged and is not policy evidence.

### Contract evidence and verification

This scope combines the installed Pi provider implementation with the clean OpenAI Codex source at [`d4bdafd378a8e328a67a4cd3557b5fe634af378c`](https://github.com/openai/codex/tree/d4bdafd378a8e328a67a4cd3557b5fe634af378c):

- [`backend-client/src/types.rs`](https://github.com/openai/codex/blob/d4bdafd378a8e328a67a4cd3557b5fe634af378c/codex-rs/backend-client/src/types.rs#L45-L74) identifies ordinary included usage separately from additional metered features.
- [`backend-client/src/client.rs`](https://github.com/openai/codex/blob/d4bdafd378a8e328a67a4cd3557b5fe634af378c/codex-rs/backend-client/src/client.rs#L641-L682) maps root quota to `codex` and additional groups to their opaque metered feature IDs. [`client/rate_limit_resets.rs`](https://github.com/openai/codex/blob/d4bdafd378a8e328a67a4cd3557b5fe634af378c/codex-rs/backend-client/src/client/rate_limit_resets.rs#L33-L68) reads the ordinary allowance decision from the root quota and uses the existing `/wham/usage` route.
- [`tui/src/chatwidget/rate_limits.rs`](https://github.com/openai/codex/blob/d4bdafd378a8e328a67a4cd3557b5fe634af378c/codex-rs/tui/src/chatwidget/rate_limits.rs#L191-L205) monitors ordinary usage plus the selected model's bucket. [`backend_banners.rs`](https://github.com/openai/codex/blob/d4bdafd378a8e328a67a4cd3557b5fe634af378c/codex-rs/tui/src/chatwidget/backend_banners.rs#L61-L75) and its ordinary-recovery branches distinguish the exceptional Reserve model from ordinary models. The production [model catalog](https://github.com/openai/codex/blob/d4bdafd378a8e328a67a4cd3557b5fe634af378c/codex-rs/models-manager/models.json) includes the exact ordinary model `gpt-5.6-sol`.
- The repository-resolved `@earendil-works/pi-ai/dist/providers/data/openai-codex.json` includes this exact model and API. `dist/api/openai-codex-responses.js`, in `extractAccountId()` and `buildBaseCodexHeaders()`, derives the account from `apiKey` and sets the final bearer and account headers after model/caller overrides, for both SSE and WebSocket requests. Missing or invalid token claims fail before inference. `pi-usage` does not infer identity from the auth source label.

`test/codex-allowance.test.ts` verifies normalizer coverage, auth/model/origin branches, the synthetic official GET, companion exclusion, detached data, malformed metadata, milliseconds, and older-client compatibility. `test/usage-allowance-runtime.test.ts` verifies fresh evidence through the extension factory, network-free cache misses, and rejection after an auth or model change during transport. Existing API lifecycle tests verify deadlines, cancellation, and stale-auth rejection. These deterministic checks do not establish live accounting, entitlement, or provider enforcement.

Optional live verification belongs to the authenticated account owner. It requires local supported-model authentication and explicit approval for provider traffic. Compare reported windows and resets with the provider console; verify included allowance independently of credits and paid usage. Live accounting delay, entitlement, paid-extra behavior, and real account-switch continuity remain unverified. Do not supply credentials in chat. Publication, tags, and release workflows require separate approval.

## Statusline settings

Choose **Settings** in `/usage` to edit these user-scoped preferences in TUI mode.
For manual JSON edits, use the [shared settings file](../../README.md#-settings) and run `/reload`.
These settings change only Codex statusline formatting, not provider data or the detailed `/usage` report, and do not control other providers' countdowns.
For shared window formatting, see [display templates](../statusline-display.md).

### Percentage

The `codexStatusPercentage` preference accepts `"remaining"` or `"used"` and defaults to `"remaining"`.
Choose **Codex percentage** in the TUI Settings screen, or set:

```json
{
  "codexStatusPercentage": "used"
}
```

With `"used"`, a limit with 70% remaining appears as `30%`; its reset countdown or window label stays unchanged.

### Reset countdown

The `codexStatusResetCountdown` preference accepts a boolean and defaults to `true`.
It replaces window labels with the time remaining until each returned limit resets; expired returned resets show `↻ 0m`.
Turn **Codex reset countdown** Off in the TUI Settings screen, or set:

```json
{
  "codexStatusResetCountdown": false
}
```

The static result is, for example, `codex 5h:59% · wk:61%`.

## Codex Fast mode

Run `/fast` without arguments to toggle Fast for the active supported Codex model, or use **Turn Fast mode on/off** in `/usage`.
The boolean `codexFastMode` preference defaults to Off. Fast requests priority routing and uses more plan allowance.
The `fast` label indicates requested routing, not a measured speedup; actual availability and speed depend on the service.

Fast applies to official `openai-codex-responses` requests at `https://chatgpt.com` when the current account's Codex model directory advertises a `priority` service tier or the legacy `fast` speed tier.
Discovery validates the active OAuth account and caches its model capabilities for five minutes, with background refresh on session and model changes.
`/fast` and `/usage` can refresh capability information before enabling Fast or displaying its controls, while provider request hooks use the account-validated cache and leave directory refresh in the background.

Fast sends `service_tier: "priority"` while enabled and supported, and explicit `service_tier: "default"` otherwise.
The statusline adds `fast` only while the preference is effective, for example `codex fast 59% ↻ 2h30m` with the default reset countdown.
A missing model, incomplete capability information, or first directory failure displays **Unknown** and uses standard routing, with `codex (Fast unknown)` shown when the preference remains enabled.
Temporary network failures reuse successful discovery for the same account, while authentication rejection or malformed directory data invalidates that account's capability information.
The preference can still be turned off while capability information is unknown.
Other providers, APIs, and custom or proxy origins retain their own request payloads.
Model support is intentionally conservative and may require an extension update when Codex adds or removes service tiers.

A toggle affects provider requests whose payload hook starts after the save; a request already sent is unchanged.
Repair or remove an invalid settings file, then run `/reload` before trying the toggle again.
A later-loaded extension can replace the final provider payload; arbitrary third-party payload-rewrite conflicts cannot be prevented.

## Reset authentication

Reset redemption is available only when Codex is the current provider.
Pi's freshly resolved access token must exactly match an OAuth credential from Pi's stored login or a compatible credential source.
`pi-usage` forwards only the bearer authorization and matching `chatgpt-account-id` to the official ChatGPT origin.
API-key credentials, configured-but-not-current Codex accounts, account changes during the flow, and custom/proxy origins fail before mutation.
Backend-provided titles and descriptions are sanitized for terminal display.
Opaque credit and account IDs are never shown or persisted by the extension.

## Redeem a Codex usage reset

For the current OpenAI Codex OAuth account, **Redeem usage limit reset…** checks fresh earned-reset details, lets you choose a reset, and previews its exact effect before confirmation.
**No, go back** is the safe default, and cancellation before confirmation sends no mutation.

**After confirmation, the reset cannot be cancelled from its progress view**; session replacement or shutdown still aborts owned work.
A transport failure offers **Try again** with the same redemption request ID so the backend can handle an uncertain retry idempotently.
Successful, already-completed, not-needed, and no-credit outcomes are reported separately, then usage and the statusline refresh for the still-current account.
