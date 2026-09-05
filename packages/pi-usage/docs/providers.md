# Pi Usage provider reference

[Back to README](../README.md)

This reference preserves each provider's endpoint, authentication boundary, billing semantics, and contract evidence.
The README contains the capability overview and shared security requirements.

- [OpenAI Codex](#openai-codex)
- [Kimi For Coding](#kimi-for-coding)
- [Moonshot AI](#moonshot-ai-api-balance)
- [MiniMax](#minimax-token-plan-and-api-balance)
- [GitHub Copilot](#github-copilot)
- [OpenRouter](#openrouter)
- [DeepSeek](#deepseek-api-balance)
- [Fireworks](#fireworks-api-spend)
- [Vercel AI Gateway](#vercel-ai-gateway-credits)
- [Baseten](#baseten-model-apis-spend)
- [OpenCode Go](#opencode-go-zen)
- [xAI](#xai-consumer-subscriptions)
- [Z.AI](#zai-glm-coding-plan)

## 📋 Provider semantics

### OpenAI Codex

- Provider ID: `openai-codex`
- Semantics: ChatGPT consumer subscription limits
- Source: the Codex usage and earned-reset endpoints using Pi's resolved runtime authorization
- Displayed data: returned duration-based windows, resets, credits, earned usage-limit resets, and additional model buckets
- Reset mutation: `POST /wham/rate-limit-reset-credits/consume` with a unique redemption request ID and, when available, the selected opaque credit ID
- Statusline examples: `codex 59% ↻ 2h30m 61% ↻ 2d15m`, `codex fast 59% ↻ 2h30m`, or `codex spark 100% ↻ 2h30m`. Set `codexStatusResetCountdown` to `false` for the legacy `5h` and `wk` labels.

The statusline selects a returned bucket that matches the current Codex model when one is available.
Unlike `pi-codex-usage`, this successor intentionally has no Codex CLI fallback because the CLI may be logged into a different account than Pi's active runtime account.

Reset redemption is available only when Codex is the current provider.
Pi's freshly resolved access token must exactly match an OAuth credential from Pi's stored login or a compatible credential source.
`pi-usage` forwards only the bearer authorization and matching `chatgpt-account-id` to the official ChatGPT origin.
API-key credentials, configured-but-not-current Codex accounts, account changes during the flow, and custom/proxy origins fail before mutation.
Backend-provided titles and descriptions are sanitized for terminal display.
Opaque credit and account IDs are never shown or persisted by the extension.

### Kimi For Coding

- Provider ID: `kimi-coding`
- Semantics: Kimi Coding Plan request windows plus a separate Extra Usage booster wallet
- Source: `GET https://api.kimi.com/coding/v1/usages` using Pi's freshly resolved runtime Bearer credential
- Displayed plan data: the weekly summary, returned sub-windows, used and remaining request percentages, and valid reset times
- Displayed wallet data: balance, monthly spend, and monthly charge limit
- Statusline examples: `kimi 99% 5h 96% wk` or `kimi 95% 1d`

Both Pi API-key credentials and Pi OAuth credentials are accepted because current Pi resolves each form as Bearer authorization for the same official Kimi inference origin.
The extension queries the fixed usage endpoint only when both the selected model origin and the effective resolved-auth origin are `https://api.kimi.com`.
Custom and proxy origins fail before network access, redirects are rejected, and the credential is never sent to an override from Kimi Code's environment-specific development path.

Plan buckets remain integer request counts and are rendered with their source-defined windows.
Unknown units, duplicate windows, missing counts, invalid timestamps, and malformed rows remain unavailable rather than receiving guessed semantics.
Booster-wallet `amount` and `amountLeft` values use Kimi's first-party conversion of 1,000,000 fixed-point units per cent, while monthly values already arrive in cents.
Wallet values retain their currency and stay separate from plan requests and percentages in reports and the statusline.
Wallet fields remain unavailable unless the response supplies one consistent currency; missing monthly values are omitted, and an enabled zero cap is shown as zero.

The contract was revalidated on 2026-08-27 against [Pi `c49906ec77788625aacbdc53ebca6fbe65bd20f5`](https://github.com/earendil-works/pi/tree/c49906ec77788625aacbdc53ebca6fbe65bd20f5), including [`kimi-coding.ts`](https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/providers/kimi-coding.ts) and [`auth/oauth/kimi-coding.ts`](https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/auth/oauth/kimi-coding.ts).
It was also revalidated against [Kimi Code `676e4d82240855044fe809fea89ce1dbe8e512cf`](https://github.com/MoonshotAI/kimi-code/tree/676e4d82240855044fe809fea89ce1dbe8e512cf), including [`managed-usage.ts`](https://github.com/MoonshotAI/kimi-code/blob/676e4d82240855044fe809fea89ce1dbe8e512cf/packages/oauth/src/managed-usage.ts) and its [tests](https://github.com/MoonshotAI/kimi-code/blob/676e4d82240855044fe809fea89ce1dbe8e512cf/packages/oauth/test/managed-usage.test.ts).
The pinned Pi source at `e86823096c5bad39e1ca282ec24bc5eb9bec745b` has no changes in either reviewed Kimi file at the selected revision.
The pinned Kimi managed-usage source at `cd7c97b377a77f7ae1b9d541cafe314e986ec074` is an ancestor of that selected revision and has no changes in the reviewed source or tests.

### Moonshot AI API balance

- Provider IDs: `moonshotai` and `moonshotai-cn`
- Semantics: current API account balance, not Kimi For Coding subscription usage
- Global source: `GET https://api.moonshot.ai/v1/users/me/balance`
- China source: `GET https://api.moonshot.cn/v1/users/me/balance`
- Displayed data: available, voucher, and cash balance in USD for Global or CNY for China
- Statusline examples: `moonshot USD 49.58894` or `moonshot CNY 49.58894`

Each endpoint uses Pi's resolved inference Bearer key for the matching region.
Pi maps both built-in providers to `MOONSHOT_API_KEY`, so that shared environment credential is eligible only for the currently selected region.
Querying the sibling region requires a provider-specific stored, runtime, or `models.json` credential.
The extension rejects custom, proxy, and cross-region origins before network access and refuses redirects.
Available and voucher balances must be nonnegative, while cash balance may be negative when the account owes money.
The endpoint does not provide historical spend, token totals, quota windows, or reset times.
These API-platform balances are independent from the `kimi-coding` subscription and booster wallet.

The contracts were verified on 2026-08-30 against the official [Global balance reference](https://platform.kimi.ai/docs/api/balance), [China balance reference](https://platform.moonshot.cn/docs/api/balance), and first-party [`MoonshotAI-Cookbook` balance client and DTO](https://github.com/MoonshotAI/MoonshotAI-Cookbook/tree/25a9e46d2391dd4817d28ab980dac69eb59b582c/examples/golang_demo).

### MiniMax Token Plan and API balance

- Provider IDs: `minimax` and `minimax-cn`
- Token Plan source: `GET {region-api-root}/v1/token_plan/remains`
- Pay-as-you-go source: `GET {region-api-root}/account/query_balance`
- Region API roots: `https://api.minimax.io` and `https://api.minimaxi.com`
- Statusline examples: `minimax 15% 5h 80% wk` or `minimax USD 98.00001`

Pi's resolved MiniMax API key selects exactly one endpoint before network access.
Keys with the first-party `sk-api-` prefix query pay-as-you-go balance; other MiniMax API keys query Token Plan quota.
The extension never probes both endpoints with one credential.
Token Plan reports preserve provider rows, rolling and weekly windows, counts, reset times, unlimited status, and first-party handling for legacy versus current `*_usage_count` semantics.
Pay-as-you-go reports keep available, cash, voucher, credit, and owed amounts separate in USD for Global or CNY for China.
Custom, proxy, and cross-region origins fail before network access, and redirects are rejected.

The contract was verified on 2026-08-30 against MiniMax's [Token Plan FAQ](https://platform.minimax.io/docs/token-plan/faq#how-to-check-token-plan-usage) and the first-party [`MiniMax-AI/cli`](https://github.com/MiniMax-AI/cli/tree/b78eccea80a0f9692e186d98906cff26931464f3), including endpoint selection, response types, quota normalization, and SDK tests.

### GitHub Copilot

- Provider ID: `github-copilot`
- Semantics: the allowance reported for the active Copilot plan
- Allowance labels: AI credits for usage-based billing, premium requests for legacy annual billing, or chat requests for Copilot Free
- Source: GitHub's undocumented `GET /copilot_internal/user` endpoint
- Displayed data: entitlement, remaining allowance, percentage, reset time, plan, and any additional usage beyond the included allowance
- Statusline examples: `copilot credits 1200/1500 80%`, `copilot 245/300 82%`, or `copilot chat 40/50 80%`

GitHub's quota endpoint requires the original GitHub OAuth token rather than the short-lived Copilot inference token exposed by runtime auth.
`pi-usage` supports Copilot accounts created through Pi's `/login` flow and named accounts offered by a compatible `oauth:credential-source:v1` owner.
It uses a candidate only when its short-lived access token exactly matches the freshly resolved active runtime credential.
Duplicate equivalent candidates are harmless, while conflicting matches fail closed without choosing by extension load order.
API-key credentials, account mismatches, GitHub Enterprise accounts, and proxy/custom provider origins fail closed.
The detailed report follows the endpoint's `token_based_billing` marker so AI credits are not mislabeled as legacy premium requests.
It reports overage without treating a negative included balance as malformed.

### OpenRouter

- Provider ID: `openrouter`
- Semantics: API-key spend and per-key credit limits—not consumer subscription quota
- Source: OpenRouter's documented [`GET /api/v1/key`](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) endpoint using Pi's resolved inference API key
- Displayed data: key label when safely returned, optional per-key limit and remaining amount, reset period, and daily/weekly/monthly/all-time spend
- Statusline examples: `openrouter $74.50 left` or `openrouter $25.50 used`

The extension does not call OpenRouter's account-level `/credits` endpoint because that operation requires a separate management key.
OpenRouter documents the distinction between credit and rate limits in its [API limits guide](https://openrouter.ai/docs/api_reference/limits).

### DeepSeek API balance

- Provider ID: `deepseek`
- Semantics: current API account balance, not historical usage or quota
- Source: documented `GET https://api.deepseek.com/user/balance` using Pi's freshly resolved runtime API key
- Displayed data: whether API calls are available plus separate total, granted, and topped-up balances for each returned CNY or USD currency
- Statusline examples: `deepseek CNY 110.00` or `deepseek CNY 110.00 · USD 20.00`

The extension queries the fixed balance endpoint only when the selected model origin is `https://api.deepseek.com` and any resolved-auth origin override, when present, has the same official origin.
Pi's built-in DeepSeek API-key resolver does not attach a redundant auth origin, so the validated model origin remains authoritative when no override exists.
Custom and proxy origins fail before network access, redirects are rejected, and only the resolved Bearer credential is forwarded from Pi's runtime auth.
Monetary decimal strings remain exact from the response through display.
CNY and USD stay separate and are never converted or added together.
The balance endpoint does not provide historical spend, request windows, reset times, or aggregate token usage, so `pi-usage` does not claim those DeepSeek capabilities.

The contract was verified on 2026-08-28 against [DeepSeek's Get User Balance documentation](https://api-docs.deepseek.com/api/get-user-balance) and Pi's [`deepseek.ts`](https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/providers/deepseek.ts) at `c49906ec77788625aacbdc53ebca6fbe65bd20f5`.
DeepSeek Harness `cd5ef8148158c3a752a658978873241fdf8e2bbc` reports only per-request model token usage and does not provide account balance data.

### Fireworks API spend

- Provider ID: `fireworks`
- Semantics: rated 30-day account spend, not credit balance or spend-cap quota
- Source: documented `GET https://api.fireworks.ai/v1/accounts` account discovery and `GET https://api.fireworks.ai/v1/accounts/{account_id}/billing/summary` rated costs using Pi's resolved inference API key
- Displayed data: exact rated spend per currency with serverless, dedicated-deployment, and training subtotals for the trailing 30 days
- Statusline example: `fireworks USD 12.345678901`

The extension queries the fixed endpoints only when the selected model origin is `https://api.fireworks.ai` and any resolved-auth origin override, when present, has the same official origin.
The account slug is discovered through the documented account listing.
One visible account is selected automatically; several visible accounts use the remembered selection or ask through `/usage`, and a disappeared selection returns **Selection required** without a billing request.
Monetary `units` and `nanos` values are summed exactly with integer arithmetic and stay exact through display.
Fireworks does not expose credit balance, spend caps, per-window quota, or reset times through its API, so `pi-usage` does not claim those Fireworks capabilities; the web console remains the authoritative balance source.
Rated line items may differ from the final invoice once credits or adjustments are applied.

The contract was verified on 2026-07-31 against Fireworks' [Usage & Cost Breakdown](https://docs.fireworks.ai/accounts/exporting-usage-and-costs), [Get billing summary](https://docs.fireworks.ai/api-reference/get-billing-summary), and [List Accounts](https://docs.fireworks.ai/api-reference/list-accounts) API references.

### Vercel AI Gateway credits

- Provider ID: `vercel-ai-gateway`
- Semantics: current team credit balance and lifetime spend, not rate-limit quota
- Source: documented `GET https://ai-gateway.vercel.sh/v1/credits` using Pi's resolved AI Gateway API key
- Displayed data: exact decimal-string credit balance and lifetime spend in USD
- Statusline example: `vercel USD 95.50 left`

The extension queries the fixed endpoint only when the selected model origin and any resolved-auth origin are `https://ai-gateway.vercel.sh`.
Custom and proxy origins fail before network access, redirects are rejected, and only the resolved Bearer credential is forwarded.
The credits endpoint does not provide reset times, request-rate counters, or date-window usage, so `pi-usage` does not claim those capabilities.
Vercel's separate Custom Reporting API is limited to eligible paid plans and is intentionally outside this first integration.

The contract was verified on 2026-08-30 against Vercel's [REST API Reference](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance) and the first-party [`vercel/ai` Gateway implementation](https://github.com/vercel/ai/blob/69428b1f8b037e4d118fb4853428d5c4e620493c/packages/gateway/src/gateway-fetch-metadata.ts).

### Baseten Model APIs spend

- Provider ID: `baseten`
- Semantics: organization-wide Model APIs spend, not per-key quota or account balance
- Source: `GET https://api.baseten.co/v1/billing/usage_summary` using Pi's resolved Baseten API key
- Displayed data: trailing 30-day gross usage, credits used, and net subtotal in USD
- Statusline example: `baseten USD 166.15 net`

The extension intentionally ignores Dedicated deployment and Training categories because they do not represent Pi's Model APIs provider usage.
The query window is a precise trailing 30 days and stays below the endpoint's 31-day maximum.
The fixed Management API endpoint is queried only for an official `https://inference.baseten.co` model and an official resolved-auth origin.
Custom and proxy origins fail before network access, redirects are rejected, and only the resolved Bearer credential is forwarded.
An empty `model_apis_usage` result is reported as no Model APIs usage rather than zero account-wide spend.

The contract was verified on 2026-08-30 against Baseten's [Billing and usage](https://docs.baseten.co/organization/billing#view-usage), [Model APIs usage](https://docs.baseten.co/inference/model-apis/pricing-and-limits#usage), first-party [`baseten-go` Management OpenAPI](https://github.com/basetenlabs/baseten-go/blob/f028e27beb4bde106d984833313c055ddd6fefa4/internal/tools/apigen/specs/management.json), and [`baseten-cli` billing behavior](https://github.com/basetenlabs/baseten-cli/blob/e3d002b465f49a7295ea44b5988dbfeb8197896d/internal/cmd/command.org.go).

### OpenCode Go (Zen)

- Provider ID: `opencode-go`
- Semantics: OpenCode Zen plan usage windows—rolling, weekly, and monthly
- Source: `GET https://opencode.ai/zen/go/v1/usage` using Pi's resolved inference API key
- Displayed data: used percentage and reset time for each window
- Status handling: `rate-limited` windows remain visible, while unknown statuses become unavailable notes
- Statusline examples: `zen 0% r 4% w 2% m`

The fixed endpoint is queried only when the OpenCode Go model uses the official `https://opencode.ai` origin.
When resolved provider auth includes a base URL, that URL must use the same origin.
Other origins fail before the credential is sent.

### xAI consumer subscriptions

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

### Z.AI (GLM Coding Plan)

- Provider ID: `zai` and `zai-coding-cn`
- Semantics: GLM Coding Plan quota windows—the rolling 5-hour and weekly plan-usage windows plus the monthly MCP allowance
- Source: the undocumented `GET {origin}/api/monitor/usage/quota/limit` endpoint also used by Z.AI's official coding plugin, plus the undocumented `GET {origin}/api/biz/subscription/list` plan endpoint
- Allowed origins: the model base URL must resolve to `https://api.z.ai` or `https://open.bigmodel.cn`
- Displayed data: explicit used and remaining values, reset times, provider-reported per-tool MCP details, and the plan name with its renewal date
- Percentage-only windows remain percent-based
- Statusline: publishes remaining plan percentages such as `zai 87% 5h 76% wk`; monthly MCP details remain available through `/usage`

The monitor endpoint is not a published API contract and may return legacy `TOKENS_LIMIT` or newer `CREDIT_LIMIT` window names.
The extension classifies both forms by the provider's window unit and does not label provider-reported counts as tokens or calls.
The quota monitor expects a raw API key without a `Bearer` prefix.
The extension removes that prefix from resolved authorization before sending it to the monitor endpoint.
Fingerprinting and redaction keep using the original resolved credential.
The plan endpoint only contributes the plan name and renewal date; when it is unavailable or fails, the quota windows remain reported and the plan note falls back to the quota response's plan level.
Only the official `api.z.ai` and `open.bigmodel.cn` origins are queried; other origins fail before sending the credential.
