# @narumitw/pi-usage

## 0.64.3

### Patch Changes

- d752df0: Enable Codex Fast priority routing for official `gpt-6-astra` and `gpt-6-luna` requests.

## 0.64.2

### Patch Changes

- 5cf3ee2: Recognize `gpt-6.1-sol` for Codex Fast mode on the official OpenAI Codex endpoint.

## 0.64.1

### Patch Changes

- 69b4499: Remove app reset windows from the ChatGPT statusline while retaining them in detailed usage reports.
- Updated dependencies [178e2e4]
  - @narumitw/pi-tui-kit@0.65.3

## 0.64.0

### Minor Changes

- 12c03d4: Add Command Code (`command-code`) usage reporting for the official `@commandcode/pi-commandcode-provider` extension.

### Patch Changes

- ca8477b: Preserve available Command Code usage sections when an optional endpoint exhausts its transport deadline, reserve time within the overall deadline for mandatory credential revalidation, and preserve caller cancellation even when it races a timeout.

## 0.63.1

### Patch Changes

- 6d1150e: Hide ChatGPT app reset windows from the statusline while preserving plan percentages and resets and the detailed app report.

## 0.63.0

### Minor Changes

- 224e586: Automatically query ChatGPT plan usage through a validated same-account Codex companion login after native OpenAI OAuth verification. Remove the experimental companion setting and confirmation: stored `openaiCompanionUsage: false` no longer disables read-only requests, and obsolete values remain preserved on disk. Remove the companion login to restore web-only reporting; native inference is unchanged.
  
  Hide app used/remaining percentages in reports and the statusline while retaining app reset/window information, allowance caps, and registration validation. Keep safe web-only guidance for missing companion credentials and fail closed without stale quotas on invalid credentials or backend failures.
  
  This intentionally replaces the default-off opt-in with automatic behavior. The source remains experimental and uses undocumented endpoints; only one user-reported plan weekly comparison matched the web, not app values or broader live behavior.

## 0.62.0

### Minor Changes

- 504f6d8: Add default-off experimental native ChatGPT plan/app quota reporting through a separately validated same-account Codex companion login. Keep plan and app limits distinct, fail closed on invalid or ambiguous registration data, and preserve web-only reporting when disabled or the companion login is absent. Native inference, legacy Codex behavior, and reset restrictions are unchanged.

### Patch Changes

- e32b7e7: Fix experimental ChatGPT companion usage confirmation leaving Settings unfinished and the usage footer blank. Return to Settings after confirmation and refresh usage when the screen closes, without requiring a reload.

## 0.61.2

### Patch Changes

- c0dbf79: Recognize native OpenAI ChatGPT OAuth and show verified authentication status with a ChatGPT usage-settings link. Missing credentials remain authentication unavailable, and native auth failures are revalidated before display. Numerical quotas and reset times remain unavailable; OpenAI API-key usage reporting remains unsupported, and legacy Codex usage, Fast mode, and reset redemption are unchanged.

## 0.61.1

### Patch Changes

- 55b6a8f: Report DeepSeek balances that went slightly negative instead of failing the whole usage query.

## 0.61.0

### Minor Changes

- d6aea79: Add a Codex statusline preference for showing used quota percentages while keeping remaining quota as the default.

### Patch Changes

- 89b1a87: Enable Codex Fast routing for official `gpt-6-sol` requests.
- 56a1635: Display Kimi Coding monthly ratio quotas in usage reports and the statusline, and accept the top-level snake-case booster wallet.

## 0.60.11

### Patch Changes

- 751a296: Start Pi sessions without waiting for account-file locks or provider activation, while preserving fail-closed authentication by gating each provider's first use, allowing compatible usage queries to await pending activation, and cancelling stale startup work.
- Updated dependencies [e6db042]
  - @narumitw/pi-tui-kit@0.65.1

## 0.60.10

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.60.9

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.60.8

### Patch Changes

- 721ec0a: Accept Kimi Coding usage responses that omit `used`/`remaining` counters when the quota is untouched, deriving missing counters from `limit` instead of reporting usage as unavailable.

## 0.60.7

### Patch Changes

- 0ece6da: Reuse pi-tui-kit's bounded frame renderer for the Usage settings screen while retaining the focused setting on short terminals.

## 0.60.6

### Patch Changes

- 157e6f8: Show fixed English hints for documented Z.AI business error codes, with HTTP-status and unknown-code fallbacks. Use the top-level code when the nested code is absent. Stop classifying credentials from provider message text or echoing error bodies. Z.AI quota failures now retain the error statusline, request backoff, and scheduled recovery instead of being reported as unsupported. Invalidate the matching cached Z.AI report on query failure so expired backoff retries do not restore stale usage.

## 0.60.5

### Patch Changes

- 81327a2: Report the explicit Z.AI no-GLM-Coding-Plan response as unsupported instead of publishing a usage error to the statusline. Invalidate previously cached usage when a credential becomes unsupported. Preserve query failures and scheduled retries for malformed quota responses, and omit provider error messages to avoid exposing echoed credentials.

## 0.60.4

### Patch Changes

- 306b481: Report a Z.AI credential with no GLM Coding Plan as unsupported instead of publishing a usage error to the statusline.

## 0.60.3

### Patch Changes

- cb85e77: Keep the Settings frame from hiding interactive rows in short terminals.
- 96ab4db: Render the standard horizontal frame around the pi-usage Settings screen.
- 4cf2daa: Render the usage menu with the standard horizontal frame used by other Pi extension menus.

## 0.60.2

### Patch Changes

- a5c4a61: Render consistent MiniMax Token Plan rows with zero countable quota as percent-based buckets, reject contradictory zero-total counts, fall back to the general group in the status chip, and show query-failed messages in the chip.

## 0.60.1

### Patch Changes

- cd0ee28: Add a provider-neutral usage target picker, starting with Fireworks accounts, and remove the free-form Fireworks account setting.

## 0.60.0

### Minor Changes

- bf71c9b: Add Z.AI plan support: query the undocumented `GET {origin}/api/biz/subscription/list` plan endpoint after the quota windows and report the GLM Coding Plan name and renewal date, falling back to the quota response's plan level when the plan endpoint is unavailable. Z.AI percentage windows now render usage bars in `/usage`, matching the Codex report. OpenCode Zen and xAI percentage windows now use the same shared usage bars. Z.AI window lengths and the session label derive from the payload's `(unit, number)` window pair instead of hardcoded constants, with the previous 5-hour and weekly values as fallbacks.

### Patch Changes

- c988f0a: Select the current valid Z.AI subscription instead of reporting an earlier expired plan.

## 0.59.0

### Minor Changes

- ed425e0: Add MiniMax Global and China Token Plan quota and pay-as-you-go balance reporting with deterministic credential routing.
- db89cb1: Add Vercel AI Gateway credit reporting with exact remaining balance and lifetime spend from the official credits endpoint.
- 6a23d01: Add Moonshot AI Global and China API balance reporting with region-bound credentials, shared environment-key safeguards, and native USD or CNY semantics.
- 0400845: Add trailing 30-day Baseten organization Model APIs spend reporting with credits and net subtotal.

### Patch Changes

- c3947f7: Prevent Codex reset countdown timers from crashing Pi when their captured extension context becomes stale during session replacement.

## 0.58.0

### Minor Changes

- 42d650a: Add Fireworks rated API spend reporting for the official fireworks provider, summarizing the trailing 30 days of rated costs per currency with serverless, dedicated-deployment, and training subtotals from the documented billing summary endpoint.
  
  The account slug is discovered through the documented account listing when exactly one account is visible; keys that can see several accounts set `fireworksAccountId` in `pi-usage.json`. Fireworks exposes no credit-balance or spend-cap endpoint, so the report claims only rated spend.

### Patch Changes

- Updated dependencies [fc6fab5]
- Updated dependencies [636fd3c]
  - @narumitw/pi-tui-kit@0.60.0

## 0.57.0

### Minor Changes

- 5c4f8ec: Remove the xAI usage setting and always offer xAI OAuth subscription reporting through explicit `/usage` actions without background or statusline requests.
- ac72cb1: Show compact Codex reset countdowns in the statusline by default, with a setting to restore the legacy window labels.

## 0.56.0

### Minor Changes

- bcb8197: Add exact DeepSeek API balance reporting for official runtime API keys.

## 0.55.0

### Minor Changes

- 948affd: Publish Z.AI remaining five-hour and weekly plan percentages in the statusline.

## 0.54.0

### Minor Changes

- c00bcfe: Add source-backed Kimi For Coding plan-window and booster-wallet usage reporting.
- 2681749: Add default-enabled xAI OAuth subscription usage reporting based on the official Grok Build implementation.
  
  xAI API-key accounts remain unsupported and are directed to the xAI console.

## 0.53.0

### Minor Changes

- bfb415e: Add Z.AI (GLM Coding Plan) usage support for the official zai and zai-coding-cn providers, reporting explicit used and remaining values for the rolling 5-hour and weekly plan windows, monthly MCP allowance with per-tool details, reset times, and the plan level.

## 0.52.3

### Patch Changes

- d74a181: Use the canonical OpenCode Go usage endpoint regardless of the selected model's base URL.

## 0.52.2

### Patch Changes

- 42e8940: Allow current-account consumers to verify named OAuth credentials through a process-local protocol, including GitHub Copilot usage and OpenAI Codex reset flows.

## 0.52.1

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.52.0

### Minor Changes

- ab49f5b: Add OpenCode Go Zen usage reporting for rolling, weekly, and monthly quota windows.

## 0.51.0

### Minor Changes

- e71cf31: Add persistent OpenAI Codex Fast routing with a `/fast` shortcut, a contextual `/usage` toggle, explicit usage guidance, and effective statusline labeling.

## 0.50.0

### Minor Changes

- a5b0feb: Add safe redemption of earned OpenAI Codex usage-limit resets for the current matching Pi OAuth account.

### Patch Changes

- Updated dependencies [2d79365]
  - @narumitw/pi-tui-kit@0.50.0
