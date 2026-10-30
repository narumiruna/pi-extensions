# OpenAI native ChatGPT OAuth

[Provider guides](./README.md) · [Package README](../../README.md)

- Provider ID: `openai`
- Source: verified native OAuth status by default; optional Codex companion OAuth for distinct shared plan and app windows
- Display: plan percentages and plan/app resets; app used/remaining percentages are hidden
- Disabled/missing-companion fallback: **Connected (native OAuth)**, same-account login guidance, and [ChatGPT usage settings](https://chatgpt.com/settings/usage)
- Fallback statusline: `chatgpt usage: web only`

## Native authentication

Use `/login openai` in a Pi runtime that supports native Sign in with ChatGPT, then select an official `https://api.openai.com` model.
Run `/usage` for authentication status and the ChatGPT usage-settings link.
Authentication requires Pi's freshly resolved provider source to be `OAuth`, matching effective model and provider authorization, and a complete matching credential with `clientId` and the `chatgpt.tokens.use.direct` scope.
Equivalent duplicate candidates are accepted; conflicting, incomplete, or mismatched native grants fail closed.
Stored OAuth alone and Pi's cached OAuth flag do not establish the active runtime account.
Runtime/API-key overrides, model-level Authorization replacements or removals, and custom/proxy origins cannot inherit native subscription status.
OpenAI API-key usage reporting remains unsupported. This extension has no verified native-token numerical quota API.

Without companion credentials, the report verifies authentication, not the plan tier, allowance, remaining quota, or reset time.
With companion usage enabled and valid companion credentials, queries and automatic refreshes read both companion endpoints; otherwise no usage request is made.
The settings link is guidance, not an automatically opened browser or a promise that the browser is signed into Pi's account.
Native tokens are never sent to `/backend-api/wham`, and opaque native metadata is not decoded as a legacy Codex account ID.
Legacy Fast payload rewriting, pricing correction, and earned reset redemption do not apply to native `openai`.
Independent [OpenAI Codex](./openai-codex.md) behavior is unchanged.

## Companion setup and settings

**Experimental source:** this read-only feature uses undocumented ChatGPT backend endpoints that may change without notice.
One user observed the plan weekly remaining percentage and reset time matching the ChatGPT overview; app percentages and broader account/window agreement remain unverified.

**Off by default:** native `openai` queries do not resolve Codex credentials, wait for Codex readiness, or make companion requests.
They show native authentication status and the ChatGPT usage-settings link.
Keep this setting Off if the two provider logins use different accounts or workspaces.

To opt in, keep `/login openai` for native inference, run `/login openai-codex` with the **same ChatGPT account and workspace**, then turn **Use Codex login for OpenAI usage** On in `/usage` → **Settings**.
The extension cannot verify that the two logins identify the same account or workspace.
In RPC mode, set `"openaiUseCodexUsage": true` in the user settings file and run `/reload`; the field accepts only a boolean and defaults to `false` when absent.
See [shared settings](../../README.md#-settings) for the file path, scope, validation, and save behavior.
When enabled, native queries and scheduled refreshes use the validated Codex companion login; there is no reverse fallback to native OpenAI credentials.

Settings-screen changes apply without `/reload`. Disabling cancels pending companion requests and clears old native quota reports and status immediately after a successful save; late responses cannot restore them.
A request already sent to ChatGPT cannot be recalled. Manual file edits apply at the next session start or `/reload`.

**Upgrade:** automatic companion queries are disabled unless `openaiUseCodexUsage` is explicitly `true`.
Historical `openaiCompanionUsage` values, including `true`, do not enable the feature and remain preserved during other settings saves; reads do not rewrite the file.
Users who want to retain numerical native reporting must opt in again.

## Companion authentication and endpoints

Fresh companion OAuth must match a complete grant with its own account ID; custom origins, API-key overrides, conflicting grants, and effective Authorization overrides fail closed.
Only the independently validated companion bearer and matching `ChatGPT-Account-Id` reach these fixed, redirect-rejecting GET routes:

- `https://chatgpt.com/backend-api/wham/usage/chatpass/apps`
- `https://chatgpt.com/backend-api/wham/usage`

Response sizes and request time are bounded.
The extension sends neither the native token nor a refresh token to these endpoints.
Both credential identities and native registration metadata bind cache identity and request-boundary revalidation.
No native token, refresh token, app name, or account ID is rendered or persisted by this feature.
An exact registration match is **not independent proof of shared identity**; users must choose the same account/workspace for both logins.

## Optional companion quotas

The app list must be complete and bounded to 128 registrations, with a readable nonempty string `id` on every entry, exactly one `id` equal to the native grant's `clientId`, and 1–32 valid windows on that matched entry.
Unknown envelope fields or pagination markers fail closed rather than assuming uniqueness on one page.
Only plan primary/secondary windows are used; Codex model-specific limits are not native app quotas.
Each window requires a finite 0–100 used percentage and positive whole-second duration; optional remaining percentages must agree within one percentage point, and reset timestamps must be valid nonnegative epoch seconds.

The statusline shows only shared **plan limits**, with percentages and reset times/window labels, for example `chatgpt plan 70% ↻ 2h30m`.
Detailed reports also show **app limits** with reset times/window labels only.
App used/remaining percentages are validated internally but hidden from display.
`allowed_usage_percent` is **App allowance**, a separately labeled cap on shared plan usage, not remaining quota or a reserved pool.
Reports keep plan/app windows and reset boundaries separate. Codex percentage/countdown preferences do not change this native report.
Expired returned resets retain the existing `↻ 0m` display.
No reset tickets are listed or redeemed, and no allowance is changed.

Disabled and missing-companion paths remain web-only without requests; refreshes revalidate native auth without calling a usage endpoint.
Other failures, including invalid credentials, missing/duplicate registrations, unsupported pagination, malformed responses, and endpoint failures, invalidate numerical data and report unavailable data instead of guessed or stale quota.
Removing the companion login restores web-only reporting without changing native inference.
OpenAI API-key auth clears the statusline item.

## Contract evidence and live verification

The native boundary is verified against Pi's [`openai-chatgpt.ts`](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/auth/oauth/openai-chatgpt.ts) at `d86654abb8862e201933517d6f1fce9f88dd117f` and OpenAI's [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), and [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines).
These contracts establish the public inference and authentication boundary, not a numerical usage API.
Deterministic verification uses synthetic credentials with Pi's real auth resolver. Browser login and broader live coverage remain unverified.

Companion contract fixtures derive from [Specode's pinned implementation](https://github.com/specode/pi-subscription-usage/blob/1015f9f419dfef9ac27c9845ec2318394928fa38/src/providers/openai.ts) and [OpenAI's shared-plan/app-limit explanation](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites), not a public native quota API.
The endpoints remain experimental after explicit opt-in. The user-reported plan weekly comparison does not establish app numerical agreement or broader live availability.
