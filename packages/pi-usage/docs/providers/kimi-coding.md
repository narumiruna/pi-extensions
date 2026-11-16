# Kimi For Coding

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `kimi-coding`
- Semantics: Kimi Coding Plan request windows plus a separate Extra Usage booster wallet
- Source: `GET https://api.kimi.com/coding/v1/usages` using Pi's freshly resolved runtime Bearer credential for official direct selections, or an explicit dedicated credential for the current proxy selection
- Displayed plan data: count-based weekly summaries and returned sub-windows, plus reported ratio-based five-hour, weekly, or monthly quotas and valid reset times
- Displayed wallet data: balance, monthly spend, and monthly charge limit when the wallet supplies consistent currency and amounts
- Statusline examples: `kimi 77% ↻ 2h52m · 87% ↻ 29d20h`, `kimi 77% ↻ 2h52m · mo:87%`, or static fallback `kimi 1d:95%`

This provider-owned managed-usage endpoint may change without notice.
Both Pi API-key credentials and Pi OAuth credentials are accepted because current Pi resolves each form as Bearer authorization for the same official Kimi inference origin.
Official direct selections require both the selected model origin and the effective resolved-auth origin to be `https://api.kimi.com`.
Without an explicit dedicated credential, custom and proxy selections fail closed before network access.
All usage queries use the fixed endpoint above, reject redirects, and ignore custom usage URLs, including Kimi Code's environment-specific development override.

### Using a local inference proxy

Inference routing and usage authentication can be separated explicitly. Supply the **official Kimi Coding credential for the account whose plan should be displayed**, never the proxy's caller key.
This deliberate account exception applies only while Pi's **currently selected** model uses provider ID `kimi-coding` with a nonofficial inference origin, including a local proxy.
`Current` then means the dedicated official Kimi account, not the proxy's caller account; the extension cannot prove that they represent the same account.
It does not enable dedicated-auth queries while another provider is selected. Official direct Kimi selections ignore both dedicated credential sources and continue using Pi auth; other providers are unchanged.
The usage query never reads or sends the proxy caller credential and never changes inference authentication or routing.

#### Set or clear the key

In TUI mode, open `/usage` → **Settings** → **Kimi proxy usage key**.
Set or update the key through masked input, or use the explicit clear action to remove the saved key.
The screen shows only credential presence and the effective source (`environment`, `settings file`, or `missing`), never the existing key.
Successful saves apply immediately and clear stale reports and cancel old queries; closing the screen does not undo a completed save.
RPC mode reports the manual settings path only and never requests plaintext secret input.

For manual setup, edit the user file `<getAgentDir()>/pi-usage.json`, normally `~/.pi/agent/pi-usage.json`, and add the optional field to its top-level JSON object:

```json
{
  "kimiCodingUsageApiKey": "replace-with-official-kimi-coding-key"
}
```

There is no project credential setting. The value is a literal string: it is not expanded as an environment-variable reference or command.
An absent field or an empty or whitespace-only string means unset. Surrounding whitespace is trimmed; a nonblank token must contain only printable ASCII characters without whitespace.
Non-string or malformed values invalidate the file. Invalid files block writes until repaired and reloaded, and error messages never include file snippets or credential values.
Settings documents are limited to 64 KiB of serialized UTF-8 JSON; oversized saves leave the prior file and runtime settings unchanged.
Run `/reload` after manual JSON edits.

This file contains a **plaintext secret**. Extension saves use a private temporary file plus atomic rename and preserve `0600` permissions on POSIX.
For a manually created credential file, set the same permissions, adjusting the path if Pi uses another agent directory:

```bash
chmod 600 ~/.pi/agent/pi-usage.json
```

#### Environment precedence and refresh

The existing `PI_USAGE_KIMI_CODING_API_KEY` environment variable remains supported for compatibility:

- A nonblank environment value overrides the JSON field and uses the same token validation.
- An absent, empty, or whitespace-only environment value falls back to the JSON field.
- A malformed nonblank environment value fails closed instead of using the file credential.
- Clearing the saved JSON key does not disable an active environment override. With neither source set, proxy usage fails closed.

Restart Pi after changing its shell environment so the new value reaches the process.
Both sources are read again after credential readiness settles and at request-boundary checks.
The effective credential and its source determine the auth fingerprint, so changing either cannot reuse the prior account's cached report.

### Reported usage

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
