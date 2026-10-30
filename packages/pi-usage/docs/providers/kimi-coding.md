# Kimi For Coding

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `kimi-coding`
- Semantics: Kimi Coding Plan request windows plus a separate Extra Usage booster wallet
- Source: `GET https://api.kimi.com/coding/v1/usages` using Pi's freshly resolved runtime Bearer credential
- Displayed plan data: count-based weekly summaries and returned sub-windows, plus reported ratio-based five-hour, weekly, or monthly quotas and valid reset times
- Displayed wallet data: balance, monthly spend, and monthly charge limit when the wallet supplies consistent currency and amounts
- Statusline examples: `kimi 77% ↻ 2h52m · 87% ↻ 29d20h`, `kimi 77% ↻ 2h52m · mo:87%`, or static fallback `kimi 1d:95%`

This provider-owned managed-usage endpoint may change without notice.
Both Pi API-key credentials and Pi OAuth credentials are accepted because current Pi resolves each form as Bearer authorization for the same official Kimi inference origin.
The extension queries the fixed usage endpoint only when both the selected model origin and the effective resolved-auth origin are `https://api.kimi.com`.
Custom and proxy origins fail before network access, redirects are rejected, and the credential is never sent to an override from Kimi Code's environment-specific development path.

Count-based plan buckets remain integer request counts and are rendered with their source-defined windows.
Live responses omit both `used` and `remaining` on untouched rows and may report only `remaining` once usage starts, so a row with a positive `limit` and no counters means zero usage, and when only one counter is present the other is derived from `limit`.
A monthly-plan response reported in [issue #1390](https://github.com/narumiruna/pi-extensions/issues/1390) supplies `usages.limit_month_total.used_ratio` without a count-based monthly row; the extension shows its remaining percentage and `reset_time` as a monthly bucket without inventing a fixed month duration.
Monthly ratio support is verified with sanitized fixtures, not an authenticated live-account check. A maintainer with an eligible Kimi account can compare `/usage` and the statusline with the account's monthly quota; live response and wallet behavior remain unverified by these fixtures.
The same map can supply `limit_5h` and `limit_week` when those windows are not present in `limits` or `usage`; `limit_month_code` is not a second total quota.
Explicit count-based windows with identifiable durations take precedence, including duplicate or malformed count rows, so ratio rows cannot mask their unavailable state.
Ratios must be finite numbers between zero and one; unknown map keys, malformed rows, invalid timestamps, and unknown count-based units do not receive guessed semantics.
The top-level wallet may be `boosterWallet` or `booster_wallet` (the former takes precedence when both are present); its nested fields retain their existing camelCase validation.
Booster-wallet `amount` and `amountLeft` values use Kimi's first-party conversion of 1,000,000 fixed-point units per cent, while monthly values already arrive in cents.
Wallet values retain their currency and stay separate from plan requests and percentages in reports and the statusline.
Wallet fields remain unavailable unless the response supplies one consistent currency; missing monthly values are omitted, and an enabled zero cap is shown as zero.

The contract was revalidated on 2026-08-27 against [Pi `c49906ec77788625aacbdc53ebca6fbe65bd20f5`](https://github.com/earendil-works/pi/tree/c49906ec77788625aacbdc53ebca6fbe65bd20f5), including [`kimi-coding.ts`](https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/providers/kimi-coding.ts) and [`auth/oauth/kimi-coding.ts`](https://github.com/earendil-works/pi/blob/c49906ec77788625aacbdc53ebca6fbe65bd20f5/packages/ai/src/auth/oauth/kimi-coding.ts).
It was also revalidated against [Kimi Code `676e4d82240855044fe809fea89ce1dbe8e512cf`](https://github.com/MoonshotAI/kimi-code/tree/676e4d82240855044fe809fea89ce1dbe8e512cf), including [`managed-usage.ts`](https://github.com/MoonshotAI/kimi-code/blob/676e4d82240855044fe809fea89ce1dbe8e512cf/packages/oauth/src/managed-usage.ts) and its [tests](https://github.com/MoonshotAI/kimi-code/blob/676e4d82240855044fe809fea89ce1dbe8e512cf/packages/oauth/test/managed-usage.test.ts).
The pinned Pi source at `e86823096c5bad39e1ca282ec24bc5eb9bec745b` has no changes in either reviewed Kimi file at the selected revision.
The pinned Kimi managed-usage source at `cd7c97b377a77f7ae1b9d541cafe314e986ec074` is an ancestor of that selected revision and has no changes in the reviewed source or tests.
