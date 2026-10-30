# xAI consumer subscriptions

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `xai`
- Semantics: consumer subscription allowance and credits, not xAI API-team billing
- Identity route: `GET https://cli-chat-proxy.grok.com/v1/user?include=subscription`
- Billing route: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
- Displayed data: included allowance or legacy monetary limit, period and reset, on-demand spend and cap, prepaid balance, and a sanitized optional plan tier
- Statusline: not published; xAI is queried only through an explicit `/usage` action

The adapter accepts only the official Pi inference origin `https://api.x.ai` and a freshly resolved bearer that exactly matches one complete Pi OAuth credential.
Pi's reviewed OAuth scope is `openid profile email offline_access grok-cli:access api:access`.
The adapter rejects `XAI_API_KEY`, duplicate or conflicting OAuth candidates, account mismatches, and incomplete OAuth records.
It also rejects custom or proxy-resolved origins before consumer-proxy access.
API-key users can review API-team spend through [console.x.ai](https://console.x.ai/) instead.
The public Management API requires a separate management key and team ID and is intentionally outside this runtime-credential integration.

The identity response supplies a transient proxy-canonical `userId` that is validated and sent as `x-userid` only on the billing request.
The extension sends the matched bearer as `Authorization` plus Grok Build's source-defined non-secret `X-XAI-Token-Auth`, client-version, and interactive client-mode headers.
It does not read Grok Build files, device state, names, email, or other profile fields.
Responses are body-bounded, redirects are rejected, raw identity and billing payloads are not retained, and secrets are redacted from errors.
Included allowance, on-demand usage, and prepaid balance remain distinct because they represent different billing concepts.

The current official Grok Build implementation is the ground truth for the xAI integration contract.
The implementation contract was verified against these first-party revisions:

- Pi [`providers/xai.ts`](https://github.com/earendil-works/pi/blob/e86823096c5bad39e1ca282ec24bc5eb9bec745b/packages/ai/src/providers/xai.ts) and [`auth/oauth/xai.ts`](https://github.com/earendil-works/pi/blob/e86823096c5bad39e1ca282ec24bc5eb9bec745b/packages/ai/src/auth/oauth/xai.ts) at `e868230`, revalidated byte-for-byte for those files at [`ccfe79e`](https://github.com/earendil-works/pi/tree/ccfe79ed238674f760c986e3a61493aab794000a).
- Grok Build [`UserInfo`](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-shell/src/auth/model.rs), [`subscription_check.rs`](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-shell/src/agent/subscription_check.rs), [`billing.rs`](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-shell/src/extensions/billing.rs), [`auth/config.rs`](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-shell/src/auth/config.rs), [`xai-grok-http`](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-http/src/lib.rs), and [`xai-grok-version`](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-version/Cargo.toml) at `9684fa3`.
- [xAI Management API team billing boundary at `723dd2a`](https://github.com/xai-org/xai-proto/blob/723dd2aa22d17be35617463837dc47cda008d90e/proto/xai/management_api/v1/billing.proto).

The approved 2026-08-27 protocol smoke used only Pi's OAuth bearer and read no Grok-local files.
A disposable or maintainer account received HTTP 200 without redirects from both routes.
The implementation also sends the non-secret client headers present on both routes in current Grok Build source, with `x-userid` added only for billing.
The sanitized identity shape contained a string `userId` and nullable `subscriptionTier`.
The billing shape contained a `config` object with period and distinct on-demand and prepaid wrappers, without retaining field values.

xAI identity and billing requests occur only after an explicit current, configured-provider, or all-provider `/usage` action.
